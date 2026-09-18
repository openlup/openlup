import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createCheckoutRecoveryRedeemHandler,
  type CheckoutRecoveryPaymentResolverPort,
} from "./checkoutRecoveryRedeemHandler.js";
import {
  CHECKOUT_RECOVERY_RECREATE_CAPABILITY,
  CHECKOUT_RECOVERY_RESOLVE_ACTIVE_PAYMENT_CAPABILITY,
} from "../../../src/domains/commerce/checkoutRecoveryContracts.js";
import type {
  CheckoutRecoveryTokenContext,
  CheckoutRecoveryTokenInspection,
} from "./checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import type { ExpiredCheckoutRecoveryService } from "./expiredCheckoutRecoveryService.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";

const TOKEN_CONTEXT: CheckoutRecoveryTokenContext = {
  tokenId: "token-1",
  orderId: ORDER_ID,
  clientId: CLIENT_ID,
  mode: "subscription_cycle",
  status: "pending_payment",
};

function snapshot(overrides: Partial<CheckoutRecoveryOrderSnapshot> = {}): CheckoutRecoveryOrderSnapshot {
  return {
    orderId: ORDER_ID,
    orderRef: `order_${ORDER_ID}`,
    orderNumber: "OPENLUP-11111111",
    clientId: CLIENT_ID,
    status: "pending_payment",
    mode: "subscription_cycle",
    totalMinor: 14900,
    currency: "PLN",
    petName: "Lidka",
    cadenceDays: 30,
    createdAt: "2026-06-25T10:00:00.000Z",
    customerEmail: "anna@example.com",
    customerName: "Anna Kowalska",
    paymentIntentId: INTENT_ID,
    paymentIntentStatus: "failed",
    subscriptionId: "sub-1",
    subscriptionCycleId: "cycle-1",
    ...overrides,
  };
}

function expiredOneTimeSnapshot(overrides: Partial<CheckoutRecoveryOrderSnapshot> = {}): CheckoutRecoveryOrderSnapshot {
  return snapshot({
    status: "cancelled",
    mode: "one_time_order",
    paymentIntentId: null,
    paymentIntentStatus: null,
    subscriptionId: null,
    subscriptionCycleId: null,
    shippingAddressId: "shipping-address-1",
    quoteSnapshot: { quote: { lines: [] } } as never,
    technicallyExpired: true,
    ...overrides,
  });
}

function inspection(overrides: Partial<CheckoutRecoveryTokenInspection> = {}): CheckoutRecoveryTokenInspection {
  return {
    tokenId: "token-1",
    orderId: ORDER_ID,
    clientId: CLIENT_ID,
    mode: "one_time_order",
    status: "expired",
    subscriptionId: null,
    tokenState: "order_not_recoverable",
    ...overrides,
  };
}

function capabilityRequest(): VercelRequest {
  return request({
    token: "raw-token",
    capabilities: [CHECKOUT_RECOVERY_RECREATE_CAPABILITY],
  });
}

function deps(opts: {
  context?: CheckoutRecoveryTokenContext | null;
  inspection?: CheckoutRecoveryTokenInspection | null;
  order?: CheckoutRecoveryOrderSnapshot | null;
  latestOrder?: CheckoutRecoveryOrderSnapshot | null;
  clientHasLiveOrPendingSubscription?: boolean;
  enabled?: boolean;
  expiredRecoveryService?: Partial<ExpiredCheckoutRecoveryService>;
  paymentResolver?: CheckoutRecoveryPaymentResolverPort;
  now?: Date;
}) {
  return {
    tokenPort: {
      issue: vi.fn(async () => "token-1"),
      validate: vi.fn(async () => opts.context ?? null),
      inspect: vi.fn(async () => opts.inspection ?? null),
    },
    orderPort: {
      getRecoveryOrder: vi.fn(async () => opts.order ?? null),
      getLatestRecoveryOrder: vi.fn(async () => opts.latestOrder ?? opts.order ?? null),
    },
    subscriptionContextPort: {
      clientHasLiveOrPendingSubscription: vi.fn(async () => opts.clientHasLiveOrPendingSubscription ?? false),
    },
    recoveryEnabled: () => opts.enabled ?? true,
    expiredRecoveryService: opts.expiredRecoveryService as ExpiredCheckoutRecoveryService | undefined,
    paymentResolver: opts.paymentResolver,
    now: () => opts.now ?? new Date("2026-07-21T12:00:00.000Z"),
  };
}

function request(body: unknown = { token: "raw-token" }, method = "POST"): VercelRequest {
  return { method, body, query: {}, headers: {} } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function payload(res: VercelResponse): { ok: boolean; data?: unknown; error?: { code: string } } {
  return vi.mocked(res.json).mock.calls[0]![0] as never;
}

describe("checkout-recovery redeem handler (W4)", () => {
  it("rejects non-POST", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(deps({}))(request({}, "GET"), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("fails closed when the flag is off", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(deps({ enabled: false }))(request(), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns BAD_REQUEST on a missing token", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(deps({ context: TOKEN_CONTEXT }))(request({}), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns recoverable order summary for a live pending_payment order", async () => {
    const d = deps({ context: TOKEN_CONTEXT, order: snapshot() });
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(d)(request(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = payload(res);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      recoverable: true,
      order: {
        orderId: ORDER_ID,
        paymentIntentId: INTENT_ID,
        clientId: CLIENT_ID,
        mode: "subscription_cycle",
        total: { amountMinor: 14900, currency: "PLN" },
      },
    });
    // Read-only: the token is validated but never consumed (the page mints several attempts).
    expect(d.tokenPort.validate).toHaveBeenCalledWith("raw-token");
  });

  it("adds a transient active-payment resolution only when the client declares the capability", async () => {
    const resolve = vi.fn(async () => ({
      kind: "resume_existing" as const,
      clientAction: { kind: "provider_embedded" as const, provider: "stripe" as const, clientSecret: "pi_secret" },
    }));
    const d = deps({
      context: TOKEN_CONTEXT,
      order: snapshot({ paymentIntentStatus: "processing" }),
      paymentResolver: { resolve },
    });
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(d)(request({
      token: "raw-token",
      capabilities: [CHECKOUT_RECOVERY_RESOLVE_ACTIVE_PAYMENT_CAPABILITY],
    }), res);

    expect(payload(res).data).toMatchObject({
      recoverable: true,
      paymentResolution: {
        kind: "resume_existing",
        clientAction: { kind: "provider_embedded", provider: "stripe", clientSecret: "pi_secret" },
      },
    });
    expect(resolve).toHaveBeenCalledWith({ orderId: ORDER_ID, paymentIntentId: INTENT_ID, intentStatus: "processing" });
  });

  it("does not invoke the resolver for legacy redeem callers", async () => {
    const resolve = vi.fn();
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(deps({
      context: TOKEN_CONTEXT,
      order: snapshot(),
      paymentResolver: { resolve },
    }))(request(), res);
    expect(resolve).not.toHaveBeenCalled();
    expect(payload(res).data).not.toHaveProperty("paymentResolution");
  });

  it("fails closed when a capable client is served without a payment resolver", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(deps({
      context: TOKEN_CONTEXT,
      order: snapshot({ paymentIntentStatus: "processing" }),
    }))(request({
      token: "raw-token",
      capabilities: [CHECKOUT_RECOVERY_RESOLVE_ACTIVE_PAYMENT_CAPABILITY],
    }), res);

    expect(payload(res).data).toMatchObject({
      recoverable: true,
      paymentResolution: { kind: "awaiting_provider" },
    });
  });

  it("falls back to fresh_checkout when the token is dead", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(deps({ context: null }))(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "fresh_checkout" });
  });

  it("marks a dead one-time token as already paid when inspection sees a paid order", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(
      deps({
        context: null,
        inspection: {
          tokenId: "token-1",
          orderId: ORDER_ID,
          clientId: CLIENT_ID,
          mode: "one_time_order",
          status: "paid",
          subscriptionId: null,
          tokenState: "order_not_recoverable",
        },
      }),
    )(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({
      recoverable: false,
      fallback: "fresh_checkout",
      terminalStatus: "paid",
    });
  });

  it("marks a valid token as already paid when the order snapshot became paid", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(
      deps({ context: TOKEN_CONTEXT, order: snapshot({ status: "paid" }) }),
    )(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({
      recoverable: false,
      fallback: "customer_account",
      terminalStatus: "paid",
    });
  });

  it("uses the newest pending descendant when an expired token supports recreation", async () => {
    const descendant = snapshot({
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      orderRef: "order_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      paymentIntentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      mode: "one_time_order",
      subscriptionId: null,
      subscriptionCycleId: null,
    });
    const d = deps({
      context: null,
      inspection: inspection(),
      latestOrder: descendant,
      expiredRecoveryService: { validate: vi.fn(async () => true) },
    });
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(d)(capabilityRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(d.orderPort.getLatestRecoveryOrder).toHaveBeenCalledWith({ orderId: ORDER_ID });
    expect(d.expiredRecoveryService?.validate).not.toHaveBeenCalled();
    expect(payload(res).data).toMatchObject({
      recoverable: true,
      recoveryKind: "retry_existing",
      order: {
        orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        paymentIntentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
    });
  });

  it("fails closed for a technically expired pending intent after token expiry", async () => {
    const validate = vi.fn(async () => true);
    const stalePendingOrder = expiredOneTimeSnapshot({
      status: "pending_payment",
      paymentIntentId: INTENT_ID,
    });
    const res = createResponse();

    await createCheckoutRecoveryRedeemHandler(deps({
      context: null,
      inspection: inspection(),
      latestOrder: stalePendingOrder,
      expiredRecoveryService: { validate },
    }))(capabilityRequest(), res);

    expect(validate).not.toHaveBeenCalled();
    expect(payload(res).data).toMatchObject({
      recoverable: false,
      fallback: "fresh_checkout",
      terminalStatus: "order_changed",
    });
  });

  it("advertises recreate_expired when the expired order is unchanged and eligible", async () => {
    const validate = vi.fn(async () => true);
    const expiredOrder = expiredOneTimeSnapshot();
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(
      deps({
        context: null,
        inspection: inspection(),
        latestOrder: expiredOrder,
        expiredRecoveryService: { validate },
      }),
    )(capabilityRequest(), res);

    expect(validate).toHaveBeenCalledWith(expiredOrder);
    expect(payload(res).data).toMatchObject({
      recoverable: true,
      recoveryKind: "recreate_expired",
      order: {
        orderId: ORDER_ID,
        paymentIntentId: null,
      },
    });
  });

  it("fails closed for non-canonical pending technical expiry even with an active token", async () => {
    const validate = vi.fn(async () => true);
    const stalePendingOrder = expiredOneTimeSnapshot({
      status: "pending_payment",
      paymentIntentId: INTENT_ID,
      paymentIntentStatus: "processing",
    });
    const d = deps({
      context: { ...TOKEN_CONTEXT, mode: "one_time_order" },
      inspection: inspection({ tokenState: "active", status: "pending_payment" }),
      order: stalePendingOrder,
      latestOrder: stalePendingOrder,
      expiredRecoveryService: { validate },
    });
    const res = createResponse();

    await createCheckoutRecoveryRedeemHandler(d)(capabilityRequest(), res);

    expect(d.tokenPort.inspect).toHaveBeenCalledWith("raw-token");
    expect(validate).not.toHaveBeenCalled();
    expect(payload(res).data).toMatchObject({
      recoverable: false,
      fallback: "fresh_checkout",
      terminalStatus: "order_changed",
    });
  });

  it("directs technical expiry with incomplete recreation evidence to a fresh checkout", async () => {
    const validate = vi.fn(async () => true);
    const stalePendingOrder = expiredOneTimeSnapshot({
      status: "pending_payment",
      paymentIntentId: INTENT_ID,
      quoteSnapshot: null,
      shippingAddressId: null,
    });
    const res = createResponse();

    await createCheckoutRecoveryRedeemHandler(deps({
      context: { ...TOKEN_CONTEXT, mode: "one_time_order" },
      inspection: inspection({ tokenState: "active", status: "pending_payment" }),
      order: stalePendingOrder,
      latestOrder: stalePendingOrder,
      expiredRecoveryService: { validate },
    }))(capabilityRequest(), res);

    expect(validate).not.toHaveBeenCalled();
    expect(payload(res).data).toMatchObject({
      recoverable: false,
      fallback: "fresh_checkout",
      terminalStatus: "order_changed",
    });
  });

  it("never advertises an expired intent to a client without recreation capability", async () => {
    const stalePendingOrder = expiredOneTimeSnapshot({
      status: "pending_payment",
      paymentIntentId: INTENT_ID,
    });
    const res = createResponse();

    await createCheckoutRecoveryRedeemHandler(deps({
      context: { ...TOKEN_CONTEXT, mode: "one_time_order" },
      order: stalePendingOrder,
    }))(request(), res);

    expect(payload(res).data).toMatchObject({
      recoverable: false,
      fallback: "fresh_checkout",
      terminalStatus: "order_changed",
    });
  });

  it("returns paid terminal status for an expired-capability link whose latest order is paid", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(
      deps({
        context: null,
        inspection: inspection({ status: "paid" }),
        latestOrder: expiredOneTimeSnapshot({ status: "paid", technicallyExpired: false }),
        expiredRecoveryService: { validate: vi.fn(async () => true) },
      }),
    )(capabilityRequest(), res);

    expect(payload(res).data).toMatchObject({
      recoverable: false,
      fallback: "fresh_checkout",
      terminalStatus: "paid",
    });
  });

  it("returns cancelled terminal status for a genuinely cancelled expired-capability link", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(
      deps({
        context: null,
        inspection: inspection({ status: "cancelled" }),
        latestOrder: expiredOneTimeSnapshot({ status: "cancelled", technicallyExpired: false }),
        expiredRecoveryService: { validate: vi.fn(async () => true) },
      }),
    )(capabilityRequest(), res);

    expect(payload(res).data).toMatchObject({
      recoverable: false,
      fallback: "fresh_checkout",
      terminalStatus: "cancelled",
    });
  });

  it("returns order_changed terminal status when an eligible expired order no longer matches the catalog", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(
      deps({
        context: null,
        inspection: inspection(),
        latestOrder: expiredOneTimeSnapshot(),
        expiredRecoveryService: { validate: vi.fn(async () => false) },
      }),
    )(capabilityRequest(), res);

    expect(payload(res).data).toMatchObject({
      recoverable: false,
      fallback: "fresh_checkout",
      terminalStatus: "order_changed",
    });
  });

  it("falls back to customer_account when a dead token still belongs to subscription context", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(
      deps({
        context: null,
        inspection: {
          tokenId: "token-1",
          orderId: ORDER_ID,
          clientId: CLIENT_ID,
          mode: "subscription_cycle",
          status: "cancelled",
          subscriptionId: "55555555-5555-4555-8555-555555555555",
          tokenState: "order_not_recoverable",
        },
      }),
    )(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "customer_account" });
  });

  it("returns paidOrder when Stripe settles before the 3DS browser return redeems", async () => {
    const inspection: CheckoutRecoveryTokenInspection = {
      tokenId: "token-1",
      orderId: ORDER_ID,
      clientId: CLIENT_ID,
      mode: "subscription_cycle",
      status: "paid",
      subscriptionId: "55555555-5555-4555-8555-555555555555",
      tokenState: "order_not_recoverable",
    };
    const d = deps({
      context: null,
      inspection,
      order: snapshot({ status: "paid", paymentIntentId: null }),
    });
    const res = createResponse();

    await createCheckoutRecoveryRedeemHandler(d)(request(), res);

    expect(payload(res).data).toMatchObject({
      recoverable: false,
      fallback: "customer_account",
      paidOrder: {
        orderId: ORDER_ID,
        orderRef: `order_${ORDER_ID}`,
        clientId: CLIENT_ID,
      },
    });
    expect(d.orderPort.getRecoveryOrder).toHaveBeenCalledWith({ orderId: ORDER_ID });
  });

  it("returns paidOrder when payment settles between token validation and order read", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(
      deps({ context: TOKEN_CONTEXT, order: snapshot({ status: "paid", paymentIntentId: null }) }),
    )(request(), res);

    expect(payload(res).data).toMatchObject({
      recoverable: false,
      paidOrder: { orderId: ORDER_ID, clientId: CLIENT_ID },
    });
  });

  it("falls back to customer_account when a dead one-time-looking token belongs to a subscriber", async () => {
    const d = deps({
      context: null,
      clientHasLiveOrPendingSubscription: true,
      inspection: {
        tokenId: "token-1",
        orderId: ORDER_ID,
        clientId: CLIENT_ID,
        mode: "one_time_order",
        status: "cancelled",
        subscriptionId: null,
        tokenState: "order_not_recoverable",
      },
    });
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(d)(request(), res);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "customer_account" });
    expect(d.subscriptionContextPort.clientHasLiveOrPendingSubscription).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
    });
  });

  it("falls back to customer_account when a subscription order is no longer pending_payment", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(
      deps({ context: TOKEN_CONTEXT, order: snapshot({ status: "cancelled" }) }),
    )(request(), res);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "customer_account" });
  });

  it("falls back to customer_account when a subscription order has no open intent", async () => {
    const res = createResponse();
    await createCheckoutRecoveryRedeemHandler(
      deps({ context: TOKEN_CONTEXT, order: snapshot({ paymentIntentId: null }) }),
    )(request(), res);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "customer_account" });
  });
});
