import http from "node:http";
import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createTpayHttpClient,
  type TpayFetchLike,
} from "../../../src/payments/tpay/tpayHttpClient.js";
import type { TpayTransactionCreateInput } from "../../../src/payments/tpay/tpayTransactionPayload.js";
import { createTpayPaymentExecutionAdapter } from "../../../src/payments/tpay/tpayPaymentExecutionAdapter.js";
import { normalizeTpayTransaction } from "../../../src/payments/tpay/tpayPaymentReconciliationProvider.js";

describe("Tpay HTTP client", () => {
  it("requests OAuth token as form-urlencoded and reuses it until expiry", async () => {
    const fetchImpl = fakeFetch([
      { access_token: "access-1", expires_in: 7200 },
      { channels: [] },
      { channels: [] },
    ]);
    const client = createTpayHttpClient({
      baseUrl: "https://api.tpay.com/",
      clientId: "client",
      clientSecret: "secret",
      fetchImpl,
      now: () => 1_000,
    });

    await client.listPaymentChannels();
    await client.listPaymentChannels();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenNthCalledWith(1, "https://api.tpay.com/oauth/auth", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "client_id=client&client_secret=secret",
      signal: expect.any(AbortSignal),
    }));
    expect(fetchImpl).toHaveBeenNthCalledWith(2, "https://api.tpay.com/transactions/channels", expect.objectContaining({
      method: "GET",
      headers: { Authorization: "Bearer access-1" },
      body: undefined,
      signal: expect.any(AbortSignal),
    }));
  });

  it("creates BLIK Level 0 transaction payloads without logging secrets", async () => {
    const fetchImpl = fakeFetch([
      { access_token: "access-1", expires_in: 7200 },
      {
        transactionId: "01HX",
        title: "TR-123",
        status: "pending",
        transactionPaymentUrl: "https://secure.tpay.com/tx",
        requestId: "req-1",
      },
    ]);
    const client = createTpayHttpClient({
      baseUrl: "https://api.tpay.com",
      clientId: "client",
      clientSecret: "secret",
      fetchImpl,
    });

    const result = await client.createTransaction({
      amount: 49.9,
      currency: "PLN",
      description: "order_123",
      hiddenDescription: "payment-intent-id",
      payer: { email: "anna@example.com", name: "Anna", ip: "127.0.0.1", userAgent: "Vitest" },
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
      groupId: 150,
      blikToken: "123456",
    });

    expect(result).toEqual({
      transactionId: "01HX",
      title: "TR-123",
      status: "pending",
      transactionPaymentUrl: "https://secure.tpay.com/tx",
      requestId: "req-1",
      // A response with no `payments` block carries neither signal; both must
      // degrade to "nothing said" rather than to a false negative.
      payIdEligible: null,
      errors: [],
    });
    const createCall = vi.mocked(fetchImpl).mock.calls[1];
    expect(createCall[0]).toBe("https://api.tpay.com/transactions");
    expect(JSON.parse(createCall[1]?.body ?? "{}")).toMatchObject({
      amount: 49.9,
      hiddenDescription: "payment-intent-id",
      pay: { groupId: 150, blikPaymentData: { blikToken: "123456" } },
    });
  });

  it("serializes saved BLIK PAYID charge fields", async () => {
    const fetchImpl = fakeFetch([
      { access_token: "access-1", expires_in: 7200 },
      {
        transactionId: "01HY",
        title: "TR-456",
        status: "pending",
        transactionPaymentUrl: null,
        requestId: "req-2",
      },
    ]);
    const client = createTpayHttpClient({
      baseUrl: "https://api.tpay.com",
      clientId: "client",
      clientSecret: "secret",
      fetchImpl,
    });

    await client.createTransaction({
      amount: 59.9,
      currency: "PLN",
      description: "order_456",
      hiddenDescription: "payment-intent-id",
      payer: { email: "anna@example.com", name: "Anna" },
      notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
      successUrl: "https://example.test/success",
      errorUrl: "https://example.test/error",
      groupId: 150,
      blikPaymentType: 2,
      alias: { value: "payid_123", type: "PAYID" },
    });

    const createCall = vi.mocked(fetchImpl).mock.calls[1];
    expect(JSON.parse(createCall[1]?.body ?? "{}")).toMatchObject({
      pay: {
        groupId: 150,
        blikPaymentData: {
          type: 2,
          aliases: { value: "payid_123", type: "PAYID" },
        },
      },
    });
  });

  it("maps available payment channels into sanitized channel facts", async () => {
    const fetchImpl = fakeFetch([
      { access_token: "access-1", expires_in: 7200 },
      {
        channels: [
          {
            id: 21,
            name: "PKO",
            fullName: "PKO Bank Polski",
            available: true,
            onlinePayment: true,
            instantRedirection: true,
            groups: [{ id: 108, name: "PKO Bank Polski" }],
          },
        ],
      },
    ]);
    const client = createTpayHttpClient({
      baseUrl: "https://api.tpay.com",
      clientId: "client",
      clientSecret: "secret",
      fetchImpl,
    });

    await expect(client.listPaymentChannels()).resolves.toEqual([
      {
        id: "21",
        name: "PKO",
        fullName: "PKO Bank Polski",
        available: true,
        onlinePayment: true,
        instantRedirection: true,
        groups: [{ id: 108, name: "PKO Bank Polski" }],
      },
    ]);
  });

  it("preserves production transaction fields while normalizing the recovery readback", async () => {
    const fetchImpl = fakeFetch([
      { access_token: "access-1", expires_in: 7200 },
      {
        transactionId: "01HX",
        title: "TR-123",
        status: "pending",
        transactionPaymentUrl: "https://secure.tpay.com/tx",
        amount: "49.90",
        currency: "PLN",
        requestId: "req-1",
        payments: { status: "pending" },
        paidAmount: "12.34",
        date: { creation: "2026-07-26T10:00:00.000Z", realization: "2026-07-26T10:01:00.000Z" },
        providerExtra: { retained: true },
      },
      {
        transactionId: "01HY",
        title: "TR-124",
        status: "pending",
        transactionPaymentUrl: "https://secure.tpay.com/tx-2",
        amount: 49.9,
        currency: "PLN",
        requestId: "req-2",
        payments: { status: "pending" },
      },
    ]);
    const client = createTpayHttpClient({
      baseUrl: "https://api.tpay.com",
      clientId: "client",
      clientSecret: "secret",
      fetchImpl,
    });

    await expect(client.getTransaction("01HX")).resolves.toEqual({
      transactionId: "01HX",
      title: "TR-123",
      status: "pending",
      transactionPaymentUrl: "https://secure.tpay.com/tx",
      amount: 49.9,
      currency: "PLN",
      requestId: "req-1",
      payments: { status: "pending" },
      paidAmount: "12.34",
      date: { creation: "2026-07-26T10:00:00.000Z", realization: "2026-07-26T10:01:00.000Z" },
      providerExtra: { retained: true },
    });
    await expect(client.getTransaction("01HY")).resolves.toMatchObject({ amount: 49.9 });
  });

  it("aborts OAuth requests on timeout", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn((_url: string, init?: Parameters<TpayFetchLike>[1]) => {
      if (init?.signal) signals.push(init.signal);
      return rejectOnAbort(init?.signal);
    }) as unknown as TpayFetchLike;
    const client = createTpayHttpClient({
      baseUrl: "https://api.tpay.com",
      clientId: "client",
      clientSecret: "secret",
      fetchImpl,
      timeoutMs: 5,
    });

    try {
      const rejection = expect(client.listPaymentChannels()).rejects.toMatchObject({
        name: "TpayHttpError",
        code: "tpay_oauth_timeout",
        status: 504,
      });
      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(signals[0]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts transaction requests on timeout after OAuth succeeds", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn((_url: string, init?: Parameters<TpayFetchLike>[1]) => {
      if (init?.signal) signals.push(init.signal);
      if (signals.length === 1) {
        return Promise.resolve({
          ok: true,
          status: 200,
          async json() {
            return { access_token: "access-1", expires_in: 7200 };
          },
          async text() {
            return JSON.stringify({ access_token: "access-1", expires_in: 7200 });
          },
        });
      }
      return rejectOnAbort(init?.signal);
    }) as unknown as TpayFetchLike;
    const client = createTpayHttpClient({
      baseUrl: "https://api.tpay.com",
      clientId: "client",
      clientSecret: "secret",
      fetchImpl,
      timeoutMs: 5,
    });

    try {
      const rejection = expect(client.createTransaction(createInput())).rejects.toMatchObject({
        name: "TpayTransactionDispatchError",
        phase: "transaction_dispatch",
        code: "tpay_request_timeout",
        dispatchState: "unknown",
      });
      await vi.advanceTimersByTimeAsync(5);
      await rejection;
      expect(signals[1]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one timeout budget across OAuth and transaction create", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn((url: string, init?: Parameters<TpayFetchLike>[1]) => {
      if (init?.signal) signals.push(init.signal);
      if (url.endsWith("/oauth/auth")) {
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve({
              ok: true,
              status: 200,
              async json() {
                return { access_token: "access-1", expires_in: 7200 };
              },
              async text() {
                return JSON.stringify({ access_token: "access-1", expires_in: 7200 });
              },
            });
          }, 6);
        }) as ReturnType<TpayFetchLike>;
      }
      return rejectOnAbort(init?.signal);
    }) as unknown as TpayFetchLike;
    const client = createTpayHttpClient({
      baseUrl: "https://api.tpay.com",
      clientId: "client",
      clientSecret: "secret",
      fetchImpl,
      timeoutMs: 10,
    });

    try {
      const rejection = expect(client.createTransaction({
        amount: 49.9,
        currency: "PLN",
        description: "order_123",
        hiddenDescription: "payment-intent-id",
        payer: { email: "anna@example.com", name: "Anna" },
        notificationUrl: "https://example.test/api/bff/payment/webhooks/tpay",
        successUrl: "https://example.test/success",
        errorUrl: "https://example.test/error",
      })).rejects.toMatchObject({
        name: "TpayTransactionDispatchError",
        phase: "transaction_dispatch",
        code: "tpay_request_timeout",
        dispatchState: "unknown",
      });

      await vi.advanceTimersByTimeAsync(6);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(4);
      await rejection;
      expect(signals[0]?.aborted).toBe(false);
      expect(signals[1]?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("proves OAuth refusal is before transaction dispatch", async () => {
    const fetchImpl = vi.fn(async () => httpResponse({}, false, 401)) as unknown as TpayFetchLike;
    const client = makeClient(fetchImpl);

    await expect(client.createTransaction(createInput())).rejects.toMatchObject({
      name: "TpayTransactionDispatchError",
      phase: "oauth",
      code: "tpay_oauth_failed",
      dispatchState: "not_dispatched",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps a malformed OAuth success retryable without invoking transaction dispatch", async () => {
    const fetchImpl = vi.fn(async () => httpResponse({ access_token: "access-1" })) as unknown as TpayFetchLike;

    await expect(makeClient(fetchImpl).createTransaction(createInput())).rejects.toMatchObject({
      name: "TpayTransactionDispatchError",
      phase: "oauth",
      code: "tpay_oauth_invalid_response",
      dispatchState: "not_dispatched",
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("keeps a rejected transaction fetch dispatch-unknown without provider prose", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/oauth/auth")
      ? httpResponse({ access_token: "access-1", expires_in: 7200 })
      : Promise.reject(new Error("provider said buyer@example.com used 123456"))) as unknown as TpayFetchLike;

    await expect(makeClient(fetchImpl).createTransaction(createInput())).rejects.toMatchObject({
      name: "TpayTransactionDispatchError",
      phase: "transaction_dispatch",
      code: "tpay_transport_failed",
      dispatchState: "unknown",
    });
  });

  it("carries only sanitized machine facts from a non-2xx transaction response", async () => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/oauth/auth")
      ? httpResponse({ access_token: "access-1", expires_in: 7200 })
      : httpResponse({
          requestId: "buyer-token",
          errors: [
            { errorCode: "invalid_request_body", fieldName: "payer.email", errorMessage: "buyer@example.com BLIK=123456" },
            { errorCode: "PAYID-secret", fieldName: "customer-token", errorMessage: "token=provider-secret" },
          ],
          paymentUrl: "https://unsafe.test/PAYID-secret",
        }, false, 400)) as unknown as TpayFetchLike;

    const error = await makeClient(fetchImpl).createTransaction(createInput()).catch((failure: unknown) => failure);

    expect(error).toMatchObject({
      name: "TpayTransactionDispatchError",
      phase: "response_decode",
      code: "tpay_request_failed",
      dispatchState: "unknown",
      failureDiagnostic: {
        httpStatus: 400,
        requestId: null,
        providerErrorCodes: ["invalid_request_body"],
        fieldNames: ["payer.email"],
      },
    });
    const serialized = JSON.stringify(error);
    for (const secret of ["buyer@example.com", "buyer-token", "123456", "provider-secret", "https://unsafe.test", "PAYID-secret", "customer-token"]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it.each([
    ["non-2xx", () => httpResponse({}, false, 500), "tpay_request_failed"],
    ["invalid JSON", () => httpResponse(new Error("invalid json")), "tpay_invalid_response"],
    ["missing transaction id", () => httpResponse({ title: "TR-123", status: "pending" }), "tpay_invalid_response"],
  ])("keeps a %s response dispatch-unknown", async (_name, response, code) => {
    const fetchImpl = vi.fn(async (url: string) => url.endsWith("/oauth/auth")
      ? httpResponse({ access_token: "access-1", expires_in: 7200 })
      : response()) as unknown as TpayFetchLike;

    await expect(makeClient(fetchImpl).createTransaction(createInput())).rejects.toMatchObject({
      name: "TpayTransactionDispatchError",
      phase: "response_decode",
      code,
      dispatchState: "unknown",
    });
  });

  it("marks an exhausted pre-dispatch deadline retryable without invoking transaction fetch", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(() => new Promise((resolve) => {
      setTimeout(() => resolve(httpResponse({ access_token: "access-1", expires_in: 7200 })), 6);
    })) as unknown as TpayFetchLike;
    const client = makeClient(fetchImpl, 5);

    try {
      const rejected = expect(client.createTransaction(createInput())).rejects.toMatchObject({
        phase: "transaction_dispatch",
        code: "tpay_request_deadline_exhausted",
        dispatchState: "not_dispatched",
      });
      await vi.advanceTimersByTimeAsync(6);
      await rejected;
      expect(fetchImpl).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Tpay default fetch wire and execution adapter", () => {
  let server: http.Server;
  let port: number;
  let captured: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders; body: string }>;
  const blocked: string[] = [];
  let restoreFence: () => void;
  const base = { idempotencyKey: "checkout:wire", providerIdempotencyKey: "openlup:tpay:intent-wire:attempt-1",
    providerRequestFingerprint: "tpay|intent-wire|2599|PLN|one_time|order-wire",
    paymentIntentId: "11111111-1111-4111-8111-111111111111", amountMinor: 2599, currency: "PLN", mode: "one_time" as const,
    orderRef: "order-wire", customerRef: "wire@example.invalid" };

  beforeAll(async () => {
    server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      captured.push({ method: req.method!, path: req.url!, headers: req.headers, body: Buffer.concat(chunks).toString() });
      const body = req.url === "/oauth/auth" ? { access_token: "synthetic-token", expires_in: 7200 }
        : req.url === "/transactions" ? { transactionId: "session-wire", title: "TR-wire", status: "pending", payments: {} }
          : req.url === "/transactions/session-wire" ? { transactionId: "session-wire", title: "TR-wire", status: "correct",
            amount: "25.99", currency: "PLN", payments: { paidAmount: "25.99" } } : null;
      res.writeHead(body ? 200 : 500, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
    });
    port = (server.address() as net.AddressInfo).port;
    const connect = net.Socket.prototype.connect;
    restoreFence = () => { net.Socket.prototype.connect = connect; expect(net.Socket.prototype.connect).toBe(connect); };
    net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0];
      const options = first as { host?: string; port?: number };
      if (!options || options.host !== "127.0.0.1" || Number(options.port) !== port) {
        const target = `${String(options?.host)}:${String(options?.port)}`;
        blocked.push(target); throw new Error(`TPAY_TEST_EGRESS_BLOCKED:${target}`);
      }
      return connect.apply(this, args as never);
    };
  });
  beforeEach(() => {
    captured = []; blocked.length = 0;
    expect(() => new net.Socket().connect({ host: "tpay-egress-preflight.invalid", port: 443 })).toThrow("TPAY_TEST_EGRESS_BLOCKED");
    blocked.length = 0;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    restoreFence?.();
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  it("captures OAuth, exact major money, readback and recurring mandate shape with one token", async () => {
    // Omit fetchImpl: this is the same Node global fetch branch production uses.
    const client = createTpayHttpClient({ baseUrl: `http://127.0.0.1:${port}`, clientId: "synthetic-client", clientSecret: "synthetic-secret" });
    const adapter = createTpayPaymentExecutionAdapter({ client, notificationUrl: "https://checkout.test/hook",
      successUrl: "https://checkout.test/success", errorUrl: "https://checkout.test/error",
      resolvePayer: () => ({ email: "wire@example.invalid", name: "Synthetic payer", userAgent: "x".repeat(256) }) });
    const interactive = await adapter.execute({ ...base, providerFlow: "blik_one_time",
      transientProviderInput: { provider: "tpay", flow: "blik_one_time", blikToken: "123456" } });
    expect(interactive).toMatchObject({ providerAttemptId: "TR-wire", providerSessionId: "session-wire",
      attemptStatus: "processing", webhookExpected: true, providerDecline: null,
      requestPayload: { providerIdempotencyKey: "openlup:tpay:intent-wire:attempt-1", amountMinor: 2599, currency: "PLN" } });
    const readback = await client.getTransaction("session-wire");
    expect(readback).toMatchObject({ amount: 25.99, currency: "PLN", status: "correct" });
    expect(normalizeTpayTransaction(readback)).toMatchObject({ status: "succeeded", amountMinor: 2599, currency: "PLN" });
    await adapter.execute({ ...base, mode: "subscription_cycle", providerFlow: "recurring_charge", paymentMethodRef: "mandate-wire",
      paymentMethodAliasType: "PAYID", paymentMethodRecurringModel: "O" });

    expect(captured).toHaveLength(4);
    expect(captured.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/oauth/auth"], ["POST", "/transactions"], ["GET", "/transactions/session-wire"], ["POST", "/transactions"],
    ]);
    expect(Object.fromEntries(new URLSearchParams(captured[0].body))).toEqual({ client_id: "synthetic-client", client_secret: "synthetic-secret" });
    expect(captured[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const oneTime = JSON.parse(captured[1].body);
    expect(oneTime).toMatchObject({ amount: 25.99, currency: "PLN", description: "order-wire",
      hiddenDescription: "11111111-1111-4111-8111-111111111111", pay: { groupId: 150, blikPaymentData: { blikToken: "123456" } } });
    expect(oneTime.payer.userAgent).toBe("x".repeat(255));
    expect(oneTime).not.toHaveProperty("simulatorContext");
    expect(JSON.parse(captured[3].body).pay).toEqual({ groupId: 150, blikPaymentData: { type: 2,
      aliases: { value: "mandate-wire", type: "PAYID", noDelay: true, recommendedAuthLevel: "NOCONFREQ" } } });
    for (const request of captured.slice(1)) {
      expect(request.headers.authorization).toBe("Bearer synthetic-token");
      expect(request.headers).not.toHaveProperty("idempotency-key");
    }
    expect(blocked).toEqual([]);
  });

  it("blocks a misbound default-fetch target at the socket boundary before DNS or provider egress", async () => {
    const client = createTpayHttpClient({ baseUrl: "https://api.tpay.com", clientId: "synthetic-client", clientSecret: "synthetic-secret" });
    await expect(client.listPaymentChannels()).rejects.toThrow();
    expect(captured).toHaveLength(0);
    expect(blocked).toEqual(["api.tpay.com:443"]);
  });
});

function fakeFetch(responses: unknown[]): TpayFetchLike {
  return vi.fn(async () => {
    const body = responses.shift();
    return {
      ok: true,
      status: 200,
      async json() {
        return body;
      },
      async text() {
        return JSON.stringify(body);
      },
    };
  }) as unknown as TpayFetchLike;
}

function makeClient(fetchImpl: TpayFetchLike, timeoutMs?: number) {
  return createTpayHttpClient({
    baseUrl: "https://api.tpay.com",
    clientId: "client",
    clientSecret: "secret",
    fetchImpl,
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

function createInput(): TpayTransactionCreateInput {
  return {
    amount: 49.9,
    currency: "PLN",
    description: "order_123",
    hiddenDescription: "payment-intent-id",
    payer: { email: "anna@example.com", name: "Anna" },
    notificationUrl: "https://checkout.test/hook",
    successUrl: "https://checkout.test/success",
    errorUrl: "https://checkout.test/error",
  };
}

function httpResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    async json() {
      if (body instanceof Error) throw body;
      return body;
    },
    async text() {
      return typeof body === "string" ? body : JSON.stringify(body);
    },
  };
}

function rejectOnAbort(signal: AbortSignal | undefined): ReturnType<TpayFetchLike> {
  return new Promise((_resolve, reject) => {
    signal?.addEventListener("abort", () => reject(new Error("aborted")));
  }) as ReturnType<TpayFetchLike>;
}
