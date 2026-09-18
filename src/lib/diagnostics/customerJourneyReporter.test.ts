import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createCustomerJourneyDiagnosticActionKey,
  readCustomerJourneyDiagnosticReporterStatus,
  reportCustomerJourneyDiagnostic,
  resetCustomerJourneyDiagnosticReporterForTests,
} from "./customerJourneyReporter";
import { setCustomerJourneyAuthContext } from "./customerJourneyAuthContext";

const CREDENTIAL = "A".repeat(43);

describe("customer journey diagnostic reporter", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED", "true");
    resetCustomerJourneyDiagnosticReporterForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetCustomerJourneyDiagnosticReporterForTests();
  });

  it("keeps the auth token from emission while serially draining later observations", async () => {
    const first = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(committed(CREDENTIAL));
    vi.stubGlobal("fetch", fetcher);
    const firstAction = createCustomerJourneyDiagnosticActionKey();
    const secondAction = createCustomerJourneyDiagnosticActionKey();

    setCustomerJourneyAuthContext("token-a");
    reportCustomerJourneyDiagnostic({ action: "auth_magic_link", phase: "attempted", code: "observed", clientActionKey: firstAction });
    setCustomerJourneyAuthContext("token-b");
    reportCustomerJourneyDiagnostic({ action: "auth_otp", phase: "attempted", code: "observed", clientActionKey: secondAction });

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer token-a" }) });
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ body: expect.stringContaining('"coverageVersion":"purchase-auth-account.v2"') });
    first.resolve(committed(CREDENTIAL));

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: expect.objectContaining({ Authorization: "Bearer token-b" }) });
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ body: expect.stringContaining(CREDENTIAL) });
  });

  it("uses a committed capability for later observations and never retries a failed delivery", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("network"))
      .mockResolvedValueOnce(committed(CREDENTIAL));
    vi.stubGlobal("fetch", fetcher);
    const firstAction = createCustomerJourneyDiagnosticActionKey();
    const secondAction = createCustomerJourneyDiagnosticActionKey();

    reportCustomerJourneyDiagnostic({ action: "checkout_submit", phase: "attempted", code: "observed", clientActionKey: firstAction });
    reportCustomerJourneyDiagnostic({ action: "checkout_submit", phase: "settled", code: "unknown", clientActionKey: firstAction });

    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ body: expect.not.stringContaining("segmentCredential") });
    reportCustomerJourneyDiagnostic({ action: "auth_otp", phase: "attempted", code: "observed", clientActionKey: secondAction });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ body: expect.stringContaining(CREDENTIAL) });
  });

  it("is inert while the default-off flag is disabled", async () => {
    vi.stubEnv("VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED", "false");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);

    reportCustomerJourneyDiagnostic({ action: "entry_boot", phase: "entered", code: "observed" });

    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("uses the neutral live test override even when the diagnostic env flag is off", async () => {
    vi.stubEnv("VITE_COMMERCE_CUSTOMER_DIAGNOSTIC_HISTORY_ENABLED", "false");
    vi.stubGlobal("__TEST_CUSTOMER_DIAGNOSTIC_HISTORY__", true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 409 })));

    reportCustomerJourneyDiagnostic({ action: "entry_boot", phase: "entered", code: "observed" });

    await vi.waitFor(() => expect(readCustomerJourneyDiagnosticReporterStatus().deliveryRejected).toBe(1));
  });

  it("creates a valid anonymous key when Web Crypto rejects access", () => {
    vi.stubGlobal("crypto", {
      randomUUID: () => { throw new DOMException("denied", "SecurityError"); },
      getRandomValues: () => { throw new DOMException("denied", "SecurityError"); },
    });

    expect(createCustomerJourneyDiagnosticActionKey()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it("keeps server uncertainty distinct from a known rejected delivery", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 409 })));
    const action = createCustomerJourneyDiagnosticActionKey();
    reportCustomerJourneyDiagnostic({ action: "checkout_submit", phase: "attempted", code: "observed", clientActionKey: action });
    reportCustomerJourneyDiagnostic({ action: "checkout_submit", phase: "settled", code: "unknown", clientActionKey: action });

    await vi.waitFor(() => expect(readCustomerJourneyDiagnosticReporterStatus()).toMatchObject({ deliveryUnknown: 1, deliveryRejected: 1 }));
  });

  it("abandons a hung delivery and reports its bounded local status", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockImplementationOnce((_: string, init: RequestInit) => new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }))
      .mockResolvedValueOnce(committed(CREDENTIAL));
    vi.stubGlobal("fetch", fetcher);
    const firstAction = createCustomerJourneyDiagnosticActionKey();
    const secondAction = createCustomerJourneyDiagnosticActionKey();

    reportCustomerJourneyDiagnostic({ action: "checkout_submit", phase: "attempted", code: "observed", clientActionKey: firstAction });
    reportCustomerJourneyDiagnostic({ action: "checkout_submit", phase: "settled", code: "unknown", clientActionKey: secondAction });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(readCustomerJourneyDiagnosticReporterStatus()).toMatchObject({ deliveryUnknown: 1, queued: 0 });
    vi.useRealTimers();
  });

  it("counts queue overflow without recursively reporting it", () => {
    const first = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValue(first.promise));
    const action = createCustomerJourneyDiagnosticActionKey();

    for (let index = 0; index < 18; index += 1) {
      reportCustomerJourneyDiagnostic({ action: "checkout_submit", phase: "attempted", code: "observed", clientActionKey: action });
    }

    expect(readCustomerJourneyDiagnosticReporterStatus()).toMatchObject({ queued: 16, overflowDropped: 1, deliveryUnknown: 0 });
  });

  it("keeps the committed capability in memory when storage methods deny access", async () => {
    vi.stubGlobal("window", { sessionStorage: deniedStorage("B".repeat(43)) });
    await expectCapabilitySurvivesStorageDenial();
  });

  it("uses the memory fallback when obtaining session storage itself is denied", async () => {
    const browser = {};
    Object.defineProperty(browser, "sessionStorage", { get: () => { throw new DOMException("denied", "SecurityError"); } });
    vi.stubGlobal("window", browser);
    await expectCapabilitySurvivesStorageDenial();
  });
});

async function expectCapabilitySurvivesStorageDenial(): Promise<void> {
  const fetcher = vi.fn().mockResolvedValueOnce(committed(CREDENTIAL)).mockResolvedValueOnce(committed(CREDENTIAL));
  vi.stubGlobal("fetch", fetcher);
  const firstAction = createCustomerJourneyDiagnosticActionKey();
  const secondAction = createCustomerJourneyDiagnosticActionKey();
  reportCustomerJourneyDiagnostic({ action: "checkout_submit", phase: "attempted", code: "observed", clientActionKey: firstAction });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
  reportCustomerJourneyDiagnostic({ action: "auth_otp", phase: "attempted", code: "observed", clientActionKey: secondAction });
  await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ body: expect.stringContaining(CREDENTIAL) });
}

function deniedStorage(previousCredential: string): Storage {
  return {
    getItem: () => previousCredential,
    setItem: () => { throw new DOMException("denied", "SecurityError"); },
  } as unknown as Storage;
}

function committed(segmentCredential: string): Response {
  return new Response(JSON.stringify({
    ok: true,
    data: {
      contractVersion: "customer-diagnostic-ingest.v1",
      persistence: "committed",
      segmentCredential,
      deduplicated: false,
    },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
