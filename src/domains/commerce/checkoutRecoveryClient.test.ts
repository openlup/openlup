import { afterEach, describe, expect, it, vi } from "vitest";
import { BffClientError } from "@/lib/bff/client";
import { payCheckoutInlineRecovery, startCheckoutRecovery } from "./checkoutRecoveryClient";
import { CHECKOUT_RECOVERY_CONTRACT_VERSION } from "./checkoutRecoveryContracts";
import { CHECKOUT_INLINE_RECOVERY_CONTRACT_VERSION } from "./checkoutInlineRecoveryContracts";

const SUBSCRIPTION_ID = "55555555-5555-4555-8555-555555555555";

function createFetcher(data: unknown) {
  return vi.fn().mockResolvedValue({
    status: 200,
    json: () => Promise.resolve({ ok: true, data }),
  } as Response);
}

describe("startCheckoutRecovery (W5 client)", () => {
  it("posts the subscriptionId with the customer bearer and returns the minted token", async () => {
    const fetcher = createFetcher({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: true,
      token: "raw-token-xyz",
      mode: "subscription_cycle",
    });

    const result = await startCheckoutRecovery(
      "session-token",
      { subscriptionId: SUBSCRIPTION_ID },
      { fetcher },
    );

    expect(result).toMatchObject({ recoverable: true, token: "raw-token-xyz" });
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/bff/customers/checkout-recovery/start");
    expect(init.method).toBe("POST");
    expect(init.headers.get("Authorization")).toBe("Bearer session-token");
    expect(JSON.parse(init.body)).toEqual({ subscriptionId: SUBSCRIPTION_ID });
  });

  it("parses an unrecoverable fallback response", async () => {
    const fetcher = createFetcher({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: false,
      fallback: "customer_account",
    });

    const result = await startCheckoutRecovery(
      "session-token",
      { subscriptionId: SUBSCRIPTION_ID },
      { fetcher },
    );

    expect(result).toEqual({
      contractVersion: CHECKOUT_RECOVERY_CONTRACT_VERSION,
      recoverable: false,
      fallback: "customer_account",
    });
  });
});

describe("payCheckoutInlineRecovery", () => {
  afterEach(() => vi.useRealTimers());
  it("posts exact identity without bearer or a raw recovery token", async () => {
    const request = {
      orderId: "11111111-1111-4111-8111-111111111111",
      clientId: "22222222-2222-4222-8222-222222222222",
      paymentIntentId: "33333333-3333-4333-8333-333333333333",
      journeyId: "checkout:44444444-4444-4444-8444-444444444444",
      expectedPaymentAttemptId: "55555555-5555-4555-8555-555555555555",
      retryRequestId: "66666666-6666-4666-8666-666666666666",
      paymentMethod: "card" as const,
      paymentProvider: "stripe" as const,
    };
    const fetcher = createFetcher({
      contractVersion: CHECKOUT_INLINE_RECOVERY_CONTRACT_VERSION,
      orderId: request.orderId,
      orderRef: `order_${request.orderId}`,
      paymentIntentId: request.paymentIntentId,
      clientId: request.clientId,
      status: "processing",
      paymentAttemptId: "77777777-7777-4777-8777-777777777777",
      provider: "stripe",
      providerPaymentId: "pi_next",
      clientAction: { kind: "none" },
    });

    await payCheckoutInlineRecovery(request, { fetcher });

    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe("/api/bff/commerce/checkout-recovery/inline-pay");
    expect(init.method).toBe("POST");
    expect(init.headers.get("Authorization")).toBeNull();
    expect(JSON.parse(init.body)).toEqual(request);
    expect(init.body).not.toContain("recoveryToken");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("aborts a hung inline mutation after the checkout timeout", async () => {
    vi.useFakeTimers();
    const request = {
      orderId: "11111111-1111-4111-8111-111111111111", clientId: "22222222-2222-4222-8222-222222222222",
      paymentIntentId: "33333333-3333-4333-8333-333333333333", journeyId: "checkout:44444444-4444-4444-8444-444444444444",
      expectedPaymentAttemptId: "55555555-5555-4555-8555-555555555555", retryRequestId: "66666666-6666-4666-8666-666666666666",
      paymentMethod: "card" as const, paymentProvider: "stripe" as const,
    };
    const fetcher = vi.fn((_path: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = payCheckoutInlineRecovery(request, { fetcher });
    const rejection = expect(pending).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      status: 0,
    } satisfies Partial<BffClientError>);
    await vi.advanceTimersByTimeAsync(25_000);
    await rejection;
  });
});
