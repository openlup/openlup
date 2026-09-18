import { describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createCheckoutPaymentLinkHandler } from "./checkout-payment-link.js";
import { createCheckoutPaymentContinuationCodec } from "../../domains/commerce/checkoutPaymentContinuationCredential.js";
import type { CheckoutRecoveryOrderSnapshot } from "../../domains/commerce/checkoutRecoveryOrderPort.js";
import type { BuyerCheckoutRecoveryOutboxRow } from "../../adapters/managed/commerce/checkoutPaymentLinkTokenStore.js";

// A REAL codec over a real secret, not a stubbed claim reader. The whole authority
// of this route is "the cookie verifies", so a test that hands the handler claims
// directly would prove nothing about the thing that guards it.
const SECRET = "checkout-payment-link-test-secret-0123456789";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const JOURNEY_ID = "checkout:33333333-3333-4333-8333-333333333333";
const INTENT_ID = "44444444-4444-4444-8444-444444444444";
const ATTEMPT_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = "2026-09-03T08:00:00.000Z";

function cookieHeader(overrides: { orderId?: string; clientId?: string } = {}): string {
  const codec = createCheckoutPaymentContinuationCodec(SECRET);
  if (!codec) throw new Error("codec unavailable");
  const { setCookie } = codec.issue({
    journeyId: JOURNEY_ID,
    orderId: overrides.orderId ?? ORDER_ID,
    clientId: overrides.clientId ?? CLIENT_ID,
    paymentIntentId: INTENT_ID,
    paymentAttemptId: ATTEMPT_ID,
    executionRail: "stripe",
  });
  return setCookie.split(";")[0];
}

function orderSnapshot(
  overrides: Partial<CheckoutRecoveryOrderSnapshot> = {},
): CheckoutRecoveryOrderSnapshot {
  return {
    orderId: ORDER_ID,
    orderRef: `order_${ORDER_ID}`,
    orderNumber: "ORD-0001",
    clientId: CLIENT_ID,
    status: "pending_payment",
    mode: "one_time_order",
    totalMinor: 12900,
    currency: "PLN",
    petName: null,
    cadenceDays: null,
    createdAt: CREATED_AT,
    customerEmail: "a@b.test",
    customerName: "Ala",
    paymentIntentId: INTENT_ID,
    paymentIntentStatus: null,
    subscriptionId: null,
    subscriptionCycleId: null,
    ...overrides,
  };
}

function makeHandler(overrides: {
  order?: CheckoutRecoveryOrderSnapshot | null;
  issue?: () => Promise<string>;
  now?: () => Date;
  tokens?: string[];
} = {}) {
  const issued: Array<{ orderId: string; rawToken: string; expiresAt: string }> = [];
  const rows: BuyerCheckoutRecoveryOutboxRow[] = [];
  const minted = overrides.tokens ?? ["rcv_first", "rcv_second"];
  let mintIndex = 0;
  const handler = createCheckoutPaymentLinkHandler({
    readClaims: (header) => {
      const codec = createCheckoutPaymentContinuationCodec(SECRET);
      return codec ? codec.verifyCookieHeader(header) : null;
    },
    orderPort: {
      getRecoveryOrder: async () =>
        overrides.order === undefined ? orderSnapshot() : overrides.order,
    },
    tokenPort: {
      issue: async (input) => {
        if (overrides.issue) return overrides.issue();
        issued.push(input);
        return `token-row-${issued.length}`;
      },
    },
    enqueue: async (row) => {
      rows.push(row);
    },
    generateToken: () => minted[Math.min(mintIndex++, minted.length - 1)],
    now: overrides.now ?? (() => new Date("2026-09-03T09:04:00.000Z")),
  });
  return { handler, issued, rows };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
    end: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function request(method: string, cookie?: string): VercelRequest {
  return {
    method,
    body: undefined,
    query: {},
    headers: cookie ? { cookie } : {},
  } as unknown as VercelRequest;
}

function body(res: VercelResponse): Record<string, unknown> {
  return vi.mocked(res.json).mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("commerce checkout-payment-link handler", () => {
  it("refuses anything but POST", async () => {
    const { handler } = makeHandler();
    const res = createResponse();
    await handler(request("GET", cookieHeader()), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("answers 401 without a continuation cookie and reads nothing", async () => {
    const { handler, issued, rows } = makeHandler();
    const res = createResponse();
    await handler(request("POST"), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(body(res)).toMatchObject({
      error: { code: "UNAUTHORIZED", details: { reason: "continuation_missing" } },
    });
    expect(issued).toHaveLength(0);
    expect(rows).toHaveLength(0);
  });

  it("answers 401 when the cookie signature does not verify", async () => {
    const { handler, rows } = makeHandler();
    const res = createResponse();
    const tampered = `${cookieHeader().slice(0, -3)}xyz`;
    await handler(request("POST", tampered), res);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(rows).toHaveLength(0);
  });

  it("mints one token and enqueues one bucketed buyer row for a pending order", async () => {
    const { handler, issued, rows } = makeHandler();
    const res = createResponse();
    await handler(request("POST", cookieHeader()), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(body(res)).toMatchObject({ ok: true, data: { sent: true } });
    expect(issued).toEqual([
      {
        orderId: ORDER_ID,
        rawToken: "rcv_first",
        // order.createdAt + 24h, the rail's own TTL rather than a fresh window.
        expiresAt: "2026-09-04T08:00:00.000Z",
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      aggregate_type: "commerce_order",
      aggregate_id: ORDER_ID,
      event_type: "commerce.checkout_recovery",
      // 2026-09-03T09:04:00Z floored to its ten-minute bucket.
      idempotency_key: `checkout_recovery:buyer:${ORDER_ID}:2980710`,
      payload: {
        orderId: ORDER_ID,
        recoveryToken: "rcv_first",
        mode: "one_time",
        buyerRequested: true,
      },
      metadata: { source: "buyer_payment_link" },
    });
  });

  it("reads the subscription vocabulary off the order for a cycle order", async () => {
    const { handler, rows } = makeHandler({
      order: orderSnapshot({ subscriptionCycleId: "66666666-6666-4666-8666-666666666666" }),
    });
    await handler(request("POST", cookieHeader()), createResponse());
    expect(rows[0].payload.mode).toBe("subscription_cycle");
  });

  it("mints twice inside one bucket but under a SINGLE key, so the table dedupes the send", async () => {
    const { handler, issued, rows } = makeHandler({
      now: () => new Date("2026-09-03T09:04:00.000Z"),
      tokens: ["rcv_first", "rcv_second"],
    });
    await handler(request("POST", cookieHeader()), createResponse());
    await handler(request("POST", cookieHeader()), createResponse());

    // Two mints on purpose: the customer rail never revokes, so the FIRST email's
    // link keeps working. Only the send is deduped, and by the table's uniqueness
    // rather than by this route.
    expect(issued.map((entry) => entry.rawToken)).toEqual(["rcv_first", "rcv_second"]);
    expect(rows).toHaveLength(2);
    expect(rows[0].idempotency_key).toBe(rows[1].idempotency_key);
  });

  it("moves to a new key in the next ten-minute bucket", async () => {
    const first = makeHandler({ now: () => new Date("2026-09-03T09:04:00.000Z") });
    await first.handler(request("POST", cookieHeader()), createResponse());
    const later = makeHandler({ now: () => new Date("2026-09-03T09:14:00.000Z") });
    await later.handler(request("POST", cookieHeader()), createResponse());
    expect(first.rows[0].idempotency_key).not.toBe(later.rows[0].idempotency_key);
  });

  it("answers 409 when the mint reports the order is no longer recoverable", async () => {
    const { handler, rows } = makeHandler({
      issue: async () => {
        throw new Error("commerce_checkout_recovery_token_issue failed: order_not_recoverable");
      },
    });
    const res = createResponse();
    await handler(request("POST", cookieHeader()), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(body(res)).toMatchObject({
      error: { code: "CONFLICT", details: { reason: "order_not_recoverable" } },
    });
    expect(rows).toHaveLength(0);
  });

  it("answers 409 when the order row is gone", async () => {
    const { handler } = makeHandler({ order: null });
    const res = createResponse();
    await handler(request("POST", cookieHeader()), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("answers 409 when the order now belongs to another client", async () => {
    const { handler, issued } = makeHandler({
      order: orderSnapshot({ clientId: "77777777-7777-4777-8777-777777777777" }),
    });
    const res = createResponse();
    await handler(request("POST", cookieHeader()), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(issued).toHaveLength(0);
  });

  it("answers 503 on an unexpected mint failure and never echoes the message", async () => {
    const { handler, rows } = makeHandler({
      issue: async () => {
        throw new Error("connection to 10.0.0.4 refused for commerce_checkout_recovery_tokens");
      },
    });
    const res = createResponse();
    await handler(request("POST", cookieHeader()), res);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(JSON.stringify(body(res))).not.toContain("10.0.0.4");
    expect(body(res)).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE" } });
    expect(rows).toHaveLength(0);
  });
});
