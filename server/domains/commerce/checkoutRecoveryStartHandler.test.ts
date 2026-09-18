import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  createCheckoutRecoveryStartHandler,
  type CheckoutRecoveryStartAuthResult,
} from "./checkoutRecoveryStartHandler.js";
import type {
  CheckoutRecoveryOwnedOrderContext,
  CheckoutRecoveryPendingOrder,
} from "./checkoutRecoveryStartPort.js";

const USER_ID = "44444444-4444-4444-8444-444444444444";
const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const SUBSCRIPTION_ID = "55555555-5555-4555-8555-555555555555";

function pendingOrder(overrides: Partial<CheckoutRecoveryPendingOrder> = {}): CheckoutRecoveryPendingOrder {
  return {
    orderId: ORDER_ID,
    createdAt: "2026-06-25T10:00:00.000Z",
    mode: "subscription_cycle",
    subscriptionId: SUBSCRIPTION_ID,
    clientHasLiveOrPendingSubscription: true,
    ...overrides,
  };
}

function deps(opts: {
  auth?: CheckoutRecoveryStartAuthResult;
  order?: CheckoutRecoveryPendingOrder | null;
  orderById?: CheckoutRecoveryPendingOrder | null;
  orderContextById?: CheckoutRecoveryOwnedOrderContext | null;
  clientHasLiveOrPendingSubscription?: boolean;
  enabled?: boolean;
  issue?: () => Promise<string>;
}) {
  return {
    authenticateUser: vi.fn(async () => opts.auth ?? ({ ok: true, userId: USER_ID } as const)),
    readPort: {
      findRecoverableOrder: vi.fn(async () => opts.order ?? null),
      findRecoverableOrderById: vi.fn(async () => opts.orderById ?? null),
      findOwnedOrderContextById: vi.fn(async () => opts.orderContextById ?? null),
      clientHasLiveOrPendingSubscription: vi.fn(async () => opts.clientHasLiveOrPendingSubscription ?? false),
    },
    tokenPort: {
      issue: vi.fn(opts.issue ?? (async () => "token-row-1")),
      validate: vi.fn(async () => null),
      inspect: vi.fn(async () => null),
    },
    recoveryEnabled: () => opts.enabled ?? true,
    generateToken: () => "raw-token-xyz",
  };
}

function request(body: unknown = { subscriptionId: SUBSCRIPTION_ID }, method = "POST"): VercelRequest {
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

describe("checkout-recovery start handler (W5)", () => {
  it("rejects non-POST", async () => {
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(deps({}))(request(undefined, "GET"), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("fails closed when the flag is off", async () => {
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(deps({ enabled: false }))(request(), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns BAD_REQUEST on a missing subscriptionId", async () => {
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(deps({}))(request({}), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("returns UNAUTHORIZED when there is no customer session", async () => {
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(deps({ auth: { ok: false } }))(request(), res);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("mints a fresh token (TTL = order.created_at + 24h) for the owner's pending order", async () => {
    const d = deps({ order: pendingOrder() });
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(d)(request(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    const body = payload(res);
    expect(body.ok).toBe(true);
    expect(body.data).toMatchObject({
      recoverable: true,
      token: "raw-token-xyz",
      mode: "subscription_cycle",
    });
    expect(d.readPort.findRecoverableOrder).toHaveBeenCalledWith({
      userId: USER_ID,
      subscriptionId: SUBSCRIPTION_ID,
    });
    expect(d.tokenPort.issue).toHaveBeenCalledWith({
      orderId: ORDER_ID,
      rawToken: "raw-token-xyz",
      // 2026-06-25T10:00:00Z + 24h
      expiresAt: "2026-06-26T10:00:00.000Z",
    });
  });

  it("mints a token for an order-id request (orders-list CTA) and resolves by order", async () => {
    const d = deps({ orderById: pendingOrder({ mode: "one_time_order" }) });
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(d)(request({ orderId: ORDER_ID }), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({
      recoverable: true,
      token: "raw-token-xyz",
      mode: "one_time_order",
    });
    expect(d.readPort.findRecoverableOrderById).toHaveBeenCalledWith({
      userId: USER_ID,
      orderId: ORDER_ID,
    });
    // The subscription path must not run for an order-id request.
    expect(d.readPort.findRecoverableOrder).not.toHaveBeenCalled();
  });

  it("falls back to fresh_checkout when an order-id request is not recoverable and has no subscription context", async () => {
    const d = deps({
      orderById: null,
      orderContextById: {
        orderId: ORDER_ID,
        mode: "one_time_order",
        subscriptionId: null,
        clientHasLiveOrPendingSubscription: false,
      },
    });
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(d)(request({ orderId: ORDER_ID }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "fresh_checkout" });
    expect(d.tokenPort.issue).not.toHaveBeenCalled();
  });

  it("falls back to customer_account when an order-id request is a dead subscription first-cycle order", async () => {
    const d = deps({
      orderById: null,
      orderContextById: {
        orderId: ORDER_ID,
        mode: "subscription_cycle",
        subscriptionId: SUBSCRIPTION_ID,
        clientHasLiveOrPendingSubscription: true,
      },
    });
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(d)(request({ orderId: ORDER_ID }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "customer_account" });
    expect(d.readPort.findOwnedOrderContextById).toHaveBeenCalledWith({
      userId: USER_ID,
      orderId: ORDER_ID,
    });
  });

  it("falls back to customer_account when a dead one-time-looking order belongs to a subscriber", async () => {
    const d = deps({
      orderById: null,
      orderContextById: {
        orderId: ORDER_ID,
        mode: "one_time_order",
        subscriptionId: null,
        clientHasLiveOrPendingSubscription: true,
      },
    });
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(d)(request({ orderId: ORDER_ID }), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "customer_account" });
  });

  it("falls back to customer_account when the order is missing but the customer has a subscription", async () => {
    const d = deps({
      orderById: null,
      orderContextById: null,
      clientHasLiveOrPendingSubscription: true,
    });
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(d)(request({ orderId: ORDER_ID }), res);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "customer_account" });
    expect(d.readPort.clientHasLiveOrPendingSubscription).toHaveBeenCalledWith({ userId: USER_ID });
  });

  it("returns BAD_REQUEST when both subscriptionId and orderId are present", async () => {
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(deps({}))(
      request({ subscriptionId: SUBSCRIPTION_ID, orderId: ORDER_ID }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("falls back to customer_account when a subscription-panel CTA has no recoverable order", async () => {
    const d = deps({ order: null });
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(d)(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "customer_account" });
    expect(d.tokenPort.issue).not.toHaveBeenCalled();
  });

  it("falls back to customer_account when a subscriber order races to non-recoverable during mint", async () => {
    const d = deps({
      order: pendingOrder({ mode: "one_time_order", subscriptionId: null, clientHasLiveOrPendingSubscription: true }),
      issue: async () => {
        throw new Error("commerce_checkout_recovery_token_issue failed: order_not_recoverable");
      },
    });
    const res = createResponse();
    await createCheckoutRecoveryStartHandler(d)(request(), res);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({ recoverable: false, fallback: "customer_account" });
  });

  it("rethrows unexpected mint errors (not a 200 fallback)", async () => {
    const d = deps({
      order: pendingOrder(),
      issue: async () => {
        throw new Error("connection reset");
      },
    });
    const res = createResponse();
    await expect(
      createCheckoutRecoveryStartHandler(d)(request(), res),
    ).rejects.toThrow(/connection reset/);
  });
});
