import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { createCheckoutRecoveryPayHandler } from "./checkoutRecoveryPayHandler.js";
import { CHECKOUT_RECOVERY_RECREATE_CAPABILITY } from "../../../src/domains/commerce/checkoutRecoveryContracts.js";
import {
  CheckoutRecoveryPayError,
  type CheckoutRecoveryPayService,
} from "./checkoutRecoveryPayService.js";
import { CommerceRuntimeConflictError } from "../../../src/domains/commerce/runtimePorts.js";
import type {
  CheckoutRecoveryTokenContext,
  CheckoutRecoveryTokenInspection,
} from "./checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import {
  ExpiredCheckoutRecoveryError,
  type ExpiredCheckoutRecoveryService,
} from "./expiredCheckoutRecoveryService.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const INTENT_ID = "22222222-2222-4222-8222-222222222222";
const CLIENT_ID = "33333333-3333-4333-8333-333333333333";
const ATTEMPT_ID = "44444444-4444-4444-8444-444444444444";

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

const PAID_RESULT = {
  orderId: ORDER_ID,
  paymentIntentId: INTENT_ID,
  clientId: CLIENT_ID,
  status: "paid" as const,
  paymentAttemptId: ATTEMPT_ID,
  provider: "hidden_rehearsal",
  providerPaymentId: "rehearsal-attempt",
  clientAction: { kind: "none" as const },
};

function deps(opts: {
  context?: CheckoutRecoveryTokenContext | null;
  inspection?: CheckoutRecoveryTokenInspection | null;
  order?: CheckoutRecoveryOrderSnapshot | null;
  latestOrder?: CheckoutRecoveryOrderSnapshot | null;
  pay?: CheckoutRecoveryPayService["pay"];
  enabled?: boolean;
  expiredRecoveryService?: Partial<ExpiredCheckoutRecoveryService>;
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
    payService: { pay: opts.pay ?? vi.fn(async () => PAID_RESULT) },
    recoveryEnabled: () => opts.enabled ?? true,
    expiredRecoveryService: opts.expiredRecoveryService as ExpiredCheckoutRecoveryService | undefined,
    now: () => opts.now ?? new Date("2026-07-21T12:00:00.000Z"),
  };
}

function request(body: unknown = { token: "raw-token", idempotencyKey: "checkout-recovery-pay-abc12345" }, method = "POST"): VercelRequest {
  return { method, body, query: {}, headers: {} } as unknown as VercelRequest;
}

function capabilityRequest(): VercelRequest {
  return request({
    token: "raw-token",
    idempotencyKey: "checkout-recovery-pay-abc12345",
    capabilities: [CHECKOUT_RECOVERY_RECREATE_CAPABILITY],
  });
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

function payload(res: VercelResponse): {
  ok: boolean;
  data?: unknown;
  error?: { code: string; details?: { reason?: string } };
} {
  return vi.mocked(res.json).mock.calls[0]![0] as never;
}

describe("checkout-recovery pay handler (W4)", () => {
  it("rejects non-POST", async () => {
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({}))(request({}, "GET"), res);
    expect(res.status).toHaveBeenCalledWith(405);
  });

  it("fails closed when the flag is off", async () => {
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({ enabled: false }))(request(), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it("returns BAD_REQUEST on a missing idempotency key", async () => {
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({ context: TOKEN_CONTEXT }))(
      request({ token: "raw-token" }),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("orchestrates a fresh attempt and returns the paid result", async () => {
    const pay = vi.fn(async () => PAID_RESULT);
    const d = deps({ context: TOKEN_CONTEXT, order: snapshot(), pay });
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(d)(request(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({ status: "paid", orderId: ORDER_ID });
    expect(pay).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: CLIENT_ID, order: expect.objectContaining({ orderId: ORDER_ID }) }),
    );
  });

  it("uses the recovery token's canonical order when the buyer switches to Stripe", async () => {
    const stripeResult = {
      ...PAID_RESULT,
      status: "processing" as const,
      provider: "stripe",
      providerPaymentId: "pi_recovery_1",
      clientAction: {
        kind: "provider_embedded" as const,
        provider: "stripe" as const,
        clientSecret: "pi_recovery_1_secret",
      },
    };
    const pay = vi.fn(async () => stripeResult);
    const d = deps({ context: TOKEN_CONTEXT, order: snapshot(), pay });
    const res = createResponse();

    await createCheckoutRecoveryPayHandler(d)(
      request({
        token: "raw-token",
        idempotencyKey: "checkout-recovery-pay-stripe1",
        paymentProvider: "stripe",
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({
      orderId: ORDER_ID,
      paymentIntentId: INTENT_ID,
      clientId: CLIENT_ID,
      provider: "stripe",
      clientAction: { kind: "provider_embedded", provider: "stripe" },
    });
    expect(pay).toHaveBeenCalledWith(expect.objectContaining({
      order: expect.objectContaining({ orderId: ORDER_ID, paymentIntentId: INTENT_ID }),
      paymentProvider: "stripe",
      paymentExecution: undefined,
    }));
  });

  it("preserves the stable decline reason needed for the BLIK-to-card recovery UX", async () => {
    const pay = vi.fn(async () => ({
      ...PAID_RESULT,
      status: "failed" as const,
      provider: "tpay",
      failureReason: "blik_recurring_unsupported_bank",
    }));
    const res = createResponse();

    await createCheckoutRecoveryPayHandler(
      deps({ context: TOKEN_CONTEXT, order: snapshot(), pay }),
    )(request(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(payload(res).data).toMatchObject({
      status: "failed",
      failureReason: "blik_recurring_unsupported_bank",
    });
  });

  it("returns CONFLICT for a dead token (W4a → page re-redeems to fresh checkout)", async () => {
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({ context: null }))(request(), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("uses the newest pending descendant for an expired-capability payment", async () => {
    const descendant = snapshot({
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      orderRef: "order_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      paymentIntentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      mode: "one_time_order",
      subscriptionId: null,
      subscriptionCycleId: null,
    });
    const pay = vi.fn(async () => ({
      ...PAID_RESULT,
      orderId: descendant.orderId,
      paymentIntentId: descendant.paymentIntentId!,
    }));
    const recreate = vi.fn(async () => PAID_RESULT);
    const d = deps({
      context: null,
      inspection: inspection(),
      latestOrder: descendant,
      pay,
      expiredRecoveryService: { recreate },
    });
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(d)(capabilityRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(d.orderPort.getLatestRecoveryOrder).toHaveBeenCalledWith({ orderId: ORDER_ID });
    expect(pay).toHaveBeenCalledWith(expect.objectContaining({
      clientId: CLIENT_ID,
      order: expect.objectContaining({ orderId: descendant.orderId }),
    }));
    expect(recreate).not.toHaveBeenCalled();
    expect(payload(res).data).toMatchObject({ status: "paid", orderId: descendant.orderId });
  });

  it("dispatches the expired recovery service for an eligible expired order", async () => {
    const expiredOrder = expiredOneTimeSnapshot();
    const recreate = vi.fn(async () => ({
      ...PAID_RESULT,
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      paymentIntentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      clientId: CLIENT_ID,
      provider: "hidden_rehearsal",
    }));
    const pay = vi.fn(async () => PAID_RESULT);
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(
      deps({
        context: null,
        inspection: inspection(),
        latestOrder: expiredOrder,
        pay,
        expiredRecoveryService: { recreate },
      }),
    )(capabilityRequest(), res);

    expect(res.status).toHaveBeenCalledWith(200);
    expect(pay).not.toHaveBeenCalled();
    expect(recreate).toHaveBeenCalledWith(expect.objectContaining({
      order: expiredOrder,
      clientId: CLIENT_ID,
      paymentProvider: "hidden_rehearsal",
    }));
    expect(payload(res).data).toMatchObject({
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      paymentIntentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    });
  });

  it("fails closed instead of recreating a pending_payment order with expired-looking metadata", async () => {
    const stalePendingOrder = expiredOneTimeSnapshot({
      status: "pending_payment",
      paymentIntentId: INTENT_ID,
      paymentIntentStatus: "failed",
      technicallyExpired: true,
    });
    const recreate = vi.fn(async () => ({
      ...PAID_RESULT,
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      paymentIntentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      clientId: CLIENT_ID,
      provider: "stripe",
    }));
    const pay = vi.fn(async () => PAID_RESULT);
    const res = createResponse();

    await createCheckoutRecoveryPayHandler(
      deps({
        context: null,
        inspection: inspection(),
        latestOrder: stalePendingOrder,
        pay,
        expiredRecoveryService: { recreate },
      }),
    )({
      ...capabilityRequest(),
      body: {
        token: "raw-token",
        idempotencyKey: "checkout-recovery-pay-stale1",
        paymentProvider: "stripe",
        capabilities: [CHECKOUT_RECOVERY_RECREATE_CAPABILITY],
      },
    } as VercelRequest, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(payload(res).error?.details?.reason).toBe("order_changed");
    expect(pay).not.toHaveBeenCalled();
    expect(recreate).not.toHaveBeenCalled();
  });

  it("also fails closed for pending technical expiry when validate returns an active token context", async () => {
    const stalePendingOrder = expiredOneTimeSnapshot({
      status: "pending_payment",
      paymentIntentId: INTENT_ID,
      paymentIntentStatus: "processing",
      technicallyExpired: true,
    });
    const recreate = vi.fn(async () => ({
      ...PAID_RESULT,
      orderId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      paymentIntentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      clientId: CLIENT_ID,
      provider: "stripe",
    }));
    const pay = vi.fn(async () => PAID_RESULT);
    const d = deps({
      context: { ...TOKEN_CONTEXT, mode: "one_time_order", status: "pending_payment" },
      inspection: inspection({ tokenState: "active", status: "pending_payment" }),
      order: stalePendingOrder,
      latestOrder: stalePendingOrder,
      pay,
      expiredRecoveryService: { recreate },
    });
    const res = createResponse();

    await createCheckoutRecoveryPayHandler(d)({
      ...capabilityRequest(),
      body: {
        token: "raw-token",
        idempotencyKey: "checkout-recovery-pay-active-expired1",
        paymentProvider: "stripe",
        capabilities: [CHECKOUT_RECOVERY_RECREATE_CAPABILITY],
      },
    } as VercelRequest, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(payload(res).error?.details?.reason).toBe("order_changed");
    expect(d.tokenPort.inspect).toHaveBeenCalledWith("raw-token");
    expect(pay).not.toHaveBeenCalled();
    expect(recreate).not.toHaveBeenCalled();
  });

  it("fails closed instead of retrying a technically expired order with incomplete recreation evidence", async () => {
    const stalePendingOrder = expiredOneTimeSnapshot({
      status: "pending_payment",
      paymentIntentId: INTENT_ID,
      paymentIntentStatus: "failed",
      quoteSnapshot: null,
      shippingAddressId: null,
      technicallyExpired: true,
    });
    const pay = vi.fn(async () => PAID_RESULT);
    const recreate = vi.fn(async () => PAID_RESULT);
    const res = createResponse();

    await createCheckoutRecoveryPayHandler(deps({
      context: { ...TOKEN_CONTEXT, mode: "one_time_order" },
      inspection: inspection({ tokenState: "active", status: "pending_payment" }),
      order: stalePendingOrder,
      latestOrder: stalePendingOrder,
      pay,
      expiredRecoveryService: { recreate },
    }))(capabilityRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(payload(res).error?.details?.reason).toBe("order_changed");
    expect(pay).not.toHaveBeenCalled();
    expect(recreate).not.toHaveBeenCalled();
  });

  it("never retries a technically expired intent for a client without recreation capability", async () => {
    const stalePendingOrder = expiredOneTimeSnapshot({
      status: "pending_payment",
      paymentIntentId: INTENT_ID,
    });
    const pay = vi.fn(async () => PAID_RESULT);
    const res = createResponse();

    await createCheckoutRecoveryPayHandler(deps({
      context: { ...TOKEN_CONTEXT, mode: "one_time_order" },
      order: stalePendingOrder,
      pay,
    }))(request(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(payload(res).error?.details?.reason).toBe("order_changed");
    expect(pay).not.toHaveBeenCalled();
  });

  it.each([
    ["paid", expiredOneTimeSnapshot({ status: "paid", technicallyExpired: false })],
    ["cancelled", expiredOneTimeSnapshot({ status: "cancelled", technicallyExpired: false })],
  ])("does not dispatch expired recreation for a %s latest order", async (caseName, latestOrder) => {
    const recreate = vi.fn(async () => PAID_RESULT);
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(
      deps({
        context: null,
        inspection: inspection({ status: latestOrder.status }),
        latestOrder,
        expiredRecoveryService: { recreate },
      }),
    )(capabilityRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(payload(res).error?.details?.reason).toBe(caseName);
    expect(recreate).not.toHaveBeenCalled();
  });

  it("maps expired recovery order_changed failures to CONFLICT", async () => {
    const recreate = vi.fn(async () => {
      throw new ExpiredCheckoutRecoveryError("order_changed");
    });
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(
      deps({
        context: null,
        inspection: inspection(),
        latestOrder: expiredOneTimeSnapshot(),
        expiredRecoveryService: { recreate },
      }),
    )(capabilityRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(payload(res).error?.code).toBe("CONFLICT");
    expect(payload(res).error?.details?.reason).toBe("order_changed");
  });

  it("returns CONFLICT when the order is no longer recoverable", async () => {
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(
      deps({ context: TOKEN_CONTEXT, order: snapshot({ status: "paid", paymentIntentId: null }) }),
    )(request(), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });

  it("maps a CheckoutRecoveryPayError to CONFLICT", async () => {
    const pay = vi.fn(async () => {
      throw new CheckoutRecoveryPayError("no_open_intent", ORDER_ID);
    });
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({ context: TOKEN_CONTEXT, order: snapshot(), pay }))(
      request(),
      res,
    );
    expect(res.status).toHaveBeenCalledWith(409);
    expect(payload(res).error?.code).toBe("CONFLICT");
  });

  it("maps provider execution failures to UPSTREAM_UNAVAILABLE", async () => {
    const pay = vi.fn(async () => {
      throw new CheckoutRecoveryPayError("provider_execution_failed", ORDER_ID);
    });
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({ context: TOKEN_CONTEXT, order: snapshot(), pay }))(
      request(),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(payload(res).error?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(payload(res).error?.details?.reason).toBe("provider_execution_failed");
  });

  it("keeps an in-flight provider attempt on the same recovery flow instead of invalidating the token", async () => {
    const pay = vi.fn(async () => {
      throw new CheckoutRecoveryPayError("provider_attempt_in_flight", ORDER_ID);
    });
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({ context: TOKEN_CONTEXT, order: snapshot(), pay }))(
      request(),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(payload(res).error?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(payload(res).error?.details?.reason).toBe("provider_attempt_in_flight");
  });

  it("keeps an in-flight payment intent on the same recovery flow instead of invalidating the token", async () => {
    const pay = vi.fn(async () => {
      throw new CheckoutRecoveryPayError("payment_intent_in_flight", ORDER_ID);
    });
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({ context: TOKEN_CONTEXT, order: snapshot(), pay }))(
      request(),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(payload(res).error?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(payload(res).error?.details?.reason).toBe("payment_intent_in_flight");
  });

  it("maps malformed Stripe embedded recovery to UPSTREAM_UNAVAILABLE", async () => {
    const pay = vi.fn(async () => {
      throw new CheckoutRecoveryPayError("stripe_client_secret_missing", ORDER_ID);
    });
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({ context: TOKEN_CONTEXT, order: snapshot(), pay }))(
      request(),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(payload(res).error?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(payload(res).error?.details?.reason).toBe("stripe_client_secret_missing");
  });

  it("maps payment-control runtime conflicts to retry-later without burning the recovery token", async () => {
    const pay = vi.fn(async () => {
      throw new CommerceRuntimeConflictError("Payment-control runtime conflict", { code: "23505" });
    });
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({ context: TOKEN_CONTEXT, order: snapshot(), pay }))(
      request(),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(503);
    expect(payload(res).error?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(payload(res).error?.details?.reason).toBe("payment_control_conflict");
  });

  it("maps a terminal subscription admission race to an honest order conflict", async () => {
    const pay = vi.fn(async () => {
      throw new CommerceRuntimeConflictError("Payment-control subscription not chargeable", {
        code: "55000",
        reason: "payment_control_subscription_not_chargeable",
      });
    });
    const res = createResponse();
    await createCheckoutRecoveryPayHandler(deps({ context: TOKEN_CONTEXT, order: snapshot(), pay }))(
      request(),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(409);
    expect(payload(res).error?.code).toBe("CONFLICT");
    expect(payload(res).error?.details?.reason).toBe("order_not_recoverable");
  });

  it("rethrows unexpected errors", async () => {
    const pay = vi.fn(async () => {
      throw new Error("boom");
    });
    const res = createResponse();
    await expect(
      createCheckoutRecoveryPayHandler(deps({ context: TOKEN_CONTEXT, order: snapshot(), pay }))(
        request(),
        res,
      ),
    ).rejects.toThrow("boom");
  });
});
