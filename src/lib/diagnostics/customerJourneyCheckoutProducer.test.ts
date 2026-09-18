import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetCustomerJourneyDiagnosticReporterForTests } from "./customerJourneyReporter";
import { startCheckoutDiagnostic } from "./customerJourneyCheckoutProducer";
import { reportCustomerJourneyPayment } from "./customerJourneyPaymentProducer";
import { setCustomerJourneyAuthContext } from "./customerJourneyAuthContext";
import { createCustomerDiagnosticActionKeyWhenEnabled, loadCustomerDiagnosticReporterWhenEnabled } from "@/lib/flags";
import type { CustomerDiagnosticReporter } from "@/lib/flags";
import { BffClientError } from "@/lib/bff/client";

describe("customer journey diagnostic producers", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED", "true");
    resetCustomerJourneyDiagnosticReporterForTests();
  });

  afterEach(() => {
    setCustomerJourneyAuthContext(null);
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetCustomerJourneyDiagnosticReporterForTests();
  });

  it("keeps one action key and the submit-time bearer token across settlement", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    const diagnostic = startCheckoutDiagnostic(
      new Headers({ Authorization: "Bearer customer-at-submit" }),
      loadCustomerDiagnosticReporterWhenEnabled!(),
      createCustomerDiagnosticActionKeyWhenEnabled!()!,
    );
    diagnostic.settle("succeeded");

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const attempt = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body));
    const settled = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer customer-at-submit" }) });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer customer-at-submit" }) });
    expect(attempt).toMatchObject({ action: "checkout_submit", phase: "attempted", code: "observed" });
    expect(settled).toMatchObject({ action: "checkout_submit", phase: "settled", code: "succeeded", clientActionKey: attempt.clientActionKey });
  });

  it("forwards only a real BFF request reference while preserving the original failure", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    const diagnostic = startCheckoutDiagnostic(
      undefined,
      loadCustomerDiagnosticReporterWhenEnabled!(),
      createCustomerDiagnosticActionKeyWhenEnabled!()!,
    );
    const bffError = new BffClientError(
      { code: "UPSTREAM_UNAVAILABLE", message: "checkout unavailable" },
      503,
      "checkout-request",
    );

    expect(diagnostic.failure(bffError, "unknown")).toBe(bffError);

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    const settled = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body));
    expect(settled).toMatchObject({
      action: "checkout_submit", phase: "settled", code: "unknown", relatedRequestId: "checkout-request",
    });

    const localDiagnostic = startCheckoutDiagnostic(
      undefined,
      loadCustomerDiagnosticReporterWhenEnabled!(),
      createCustomerDiagnosticActionKeyWhenEnabled!()!,
    );
    const localError = { reason: "local" };
    expect(localDiagnostic.failure(localError, "rejected")).toBe(localError);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(4));
    expect(JSON.parse(String(fetcher.mock.calls[3]?.[1]?.body))).not.toHaveProperty("relatedRequestId");
  });

  it("keeps the payment observation token while the reporter loads", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    const reporter = await import("./customerJourneyReporter");
    const delayedReporter = deferred<typeof reporter | null>();

    setCustomerJourneyAuthContext("customer-at-observation");
    reportCustomerJourneyPayment(
      "payment_confirm",
      "succeeded",
      delayedReporter.promise,
      "11111111-1111-4111-8111-111111111111",
    );
    setCustomerJourneyAuthContext("customer-after-observation");
    delayedReporter.resolve(reporter);

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer customer-at-observation" }) });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: "payment_confirm",
      phase: "settled",
      code: "succeeded",
      clientActionKey: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("reports a payment-status settlement with its observation token and action key", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 409 }));
    vi.stubGlobal("fetch", fetcher);
    const reporter = await import("./customerJourneyReporter");
    const delayedReporter = deferred<typeof reporter | null>();
    const actionKey = "22222222-2222-4222-8222-222222222222";

    setCustomerJourneyAuthContext("customer-at-status-observation");
    reportCustomerJourneyPayment("payment_status", "timeout", delayedReporter.promise, actionKey);
    setCustomerJourneyAuthContext("customer-after-status-observation");
    delayedReporter.resolve(reporter);

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer customer-at-status-observation" }) });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toMatchObject({
      action: "payment_status", phase: "settled", code: "timeout", clientActionKey: actionKey,
    });
  });

  /**
   * The reporter is a lazily imported chunk: its promise can reject (offline, a
   * purged deploy) and the loaded module can throw. Neither may reach the
   * checkout or payment path, and neither may leave an unhandled rejection —
   * vitest fails the file on one, which is what pins the `.catch` guard.
   */
  it("stays inert and preserves the failure identity when the reporter promise rejects", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const rejected = Promise.reject<CustomerDiagnosticReporter | null>(new Error("reporter chunk unavailable"));

    const diagnostic = startCheckoutDiagnostic(
      new Headers({ Authorization: "Bearer customer-at-submit" }),
      rejected,
      "33333333-3333-4333-8333-333333333333",
    );
    const localError = { reason: "local" };
    expect(diagnostic.failure(localError, "rejected")).toBe(localError);
    expect(() => reportCustomerJourneyPayment(
      "payment_confirm",
      "succeeded",
      rejected,
      "44444444-4444-4444-8444-444444444444",
    )).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("stays inert and preserves the failure identity when the loaded reporter throws", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    const throwingReporter = {
      reportCustomerJourneyDiagnostic: () => { throw new Error("reporter exploded"); },
    } as unknown as CustomerDiagnosticReporter;

    const diagnostic = startCheckoutDiagnostic(
      undefined,
      Promise.resolve(throwingReporter),
      "55555555-5555-4555-8555-555555555555",
    );
    const bffError = new BffClientError(
      { code: "UPSTREAM_UNAVAILABLE", message: "checkout unavailable" },
      503,
      "checkout-request",
    );
    expect(diagnostic.failure(bffError, "unknown")).toBe(bffError);
    expect(() => reportCustomerJourneyPayment(
      "payment_status",
      "timeout",
      Promise.resolve(throwingReporter),
      "66666666-6666-4666-8666-666666666666",
    )).not.toThrow();

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is inert when the payment reporter is unavailable", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    expect(() => reportCustomerJourneyPayment(
      "payment_status",
      "unknown",
      Promise.resolve(null),
      "22222222-2222-4222-8222-222222222222",
    )).not.toThrow();

    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve };
}
