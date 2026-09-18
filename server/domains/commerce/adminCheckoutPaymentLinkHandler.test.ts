import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { createAdminCheckoutPaymentLinkHandler } from "./adminCheckoutPaymentLinkHandler.js";
import { hashCheckoutRecoveryToken } from "./checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import type {
  CheckoutPaymentLinkTokenInsert,
  CheckoutRecoveryEmailEnqueue,
} from "../../adapters/managed/commerce/checkoutPaymentLinkTokenStore.js";
import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const CLIENT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-06-20T12:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_ROW_ID = "55555555-5555-4555-8555-555555555555";

/**
 * Only the facts this command and the shared eligibility predicate actually read.
 * The snapshot type carries a good deal more (catalogue and customer detail this
 * surface owns none of), so the narrow object is cast once, here, rather than
 * padded out with values no assertion below depends on.
 */
function order(overrides: Partial<CheckoutRecoveryOrderSnapshot> = {}): CheckoutRecoveryOrderSnapshot {
  return {
    orderId: ORDER_ID,
    orderRef: `order_${ORDER_ID}`,
    orderNumber: "OMS-1001",
    clientId: CLIENT_ID,
    status: "pending_payment",
    mode: "one_time_order",
    totalMinor: 12900,
    currency: "XTS",
    createdAt: new Date(NOW.getTime() - DAY_MS).toISOString(),
    customerEmail: "buyer@example.test",
    customerName: "Buyer",
    paymentIntentId: null,
    paymentIntentStatus: null,
    subscriptionId: null,
    subscriptionCycleId: null,
    ...overrides,
  } as CheckoutRecoveryOrderSnapshot;
}

/** An expired order the redeem rail would still recreate: every fact present. */
function recoverableExpiredOrder(overrides: Partial<CheckoutRecoveryOrderSnapshot> = {}) {
  return order({
    status: "expired",
    technicallyExpired: true,
    quoteSnapshot: {} as CreateQuoteResponse,
    shippingAddressId: "44444444-4444-4444-8444-444444444444",
    ...overrides,
  });
}

function deps(opts: {
  snapshot?: CheckoutRecoveryOrderSnapshot | null;
  authorized?: boolean;
  calls?: string[];
  revokeFails?: boolean;
  enqueueFails?: boolean;
  recreateValid?: boolean;
  withoutValidateRecreate?: boolean;
} = {}) {
  const calls = opts.calls ?? [];
  return {
    authorizeAdmin: vi.fn(async () =>
      opts.authorized === false
        ? ({ ok: false, code: "FORBIDDEN", message: "Admin role required" } as const)
        : ({ ok: true, userId: USER_ID } as const)),
    orderPort: {
      getRecoveryOrder: vi.fn(async () => (opts.snapshot === undefined ? order() : opts.snapshot)),
    },
    tokenStore: {
      revokeActive: vi.fn(async (_orderId: string) => {
        calls.push("revoke");
        if (opts.revokeFails) throw new Error("write failed");
      }),
      insert: vi.fn(async (_input: CheckoutPaymentLinkTokenInsert) => {
        calls.push("insert");
        return TOKEN_ROW_ID;
      }),
      enqueueRecoveryEmail: vi.fn(async (_input: CheckoutRecoveryEmailEnqueue) => {
        calls.push("enqueue");
        if (opts.enqueueFails) throw new Error("write failed");
      }),
    },
    validateRecreate: opts.withoutValidateRecreate
      ? undefined
      : vi.fn(async (_order: CheckoutRecoveryOrderSnapshot) => opts.recreateValid !== false),
    generateToken: () => "rcv_operator_token",
    now: () => NOW,
  };
}

function request(body: unknown = { orderId: ORDER_ID }, method = "POST"): HttpRequest {
  return { method, body, query: {}, headers: {} } as unknown as HttpRequest;
}

function response(): HttpResponse {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

function body(res: HttpResponse) {
  return vi.mocked(res.json).mock.calls.at(-1)?.[0] as {
    ok: boolean;
    data?: { token: string; expiresAt: string; orderRef: string; emailQueued?: boolean };
    error?: { code: string; details?: { reason?: string } };
  };
}

async function run(overrides: Parameters<typeof deps>[0] = {}, req: HttpRequest = request()) {
  const d = deps(overrides);
  const res = response();
  await createAdminCheckoutPaymentLinkHandler(d)(req, res);
  return { deps: d, res, body: body(res) };
}

describe("admin checkout payment-link handler", () => {
  it("refuses anything but POST", async () => {
    const { res } = await run({}, request({ orderId: ORDER_ID }, "GET"));
    expect(res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(body(res).error?.code).toBe("METHOD_NOT_ALLOWED");
  });

  it("refuses an unauthorized operator before reading the order", async () => {
    const { deps: d, body: sent } = await run({ authorized: false });
    expect(sent.error?.code).toBe("FORBIDDEN");
    expect(d.orderPort.getRecoveryOrder).not.toHaveBeenCalled();
  });

  it("rejects a malformed order id", async () => {
    const { body: sent } = await run({}, request({ orderId: "not-a-uuid" }));
    expect(sent.error?.code).toBe("BAD_REQUEST");
  });

  it("names order_not_found when the order is gone", async () => {
    const { body: sent } = await run({ snapshot: null });
    expect(sent.error?.code).toBe("NOT_FOUND");
    expect(sent.error?.details?.reason).toBe("order_not_found");
  });

  it("names order_paid rather than minting a link for money already in", async () => {
    const { deps: d, body: sent } = await run({ snapshot: order({ status: "paid" }) });
    expect(sent.error?.details?.reason).toBe("order_paid");
    expect(d.tokenStore.revokeActive).not.toHaveBeenCalled();
  });

  it("names order_cancelled for an order a human cancelled", async () => {
    const { body: sent } = await run({
      snapshot: order({ status: "cancelled", technicallyExpired: false }),
    });
    expect(sent.error?.details?.reason).toBe("order_cancelled");
  });

  it("names order_not_recoverable when the expired order lost the facts recovery needs", async () => {
    const { body: sent } = await run({
      snapshot: recoverableExpiredOrder({ shippingAddressId: null }),
    });
    expect(sent.error?.details?.reason).toBe("order_not_recoverable");
  });

  it("names order_not_recoverable when the 30-day window has already elapsed", async () => {
    const { body: sent } = await run({
      snapshot: order({ createdAt: new Date(NOW.getTime() - 31 * DAY_MS).toISOString() }),
    });
    expect(sent.error?.details?.reason).toBe("order_not_recoverable");
  });

  it("mints for an order still waiting to be paid", async () => {
    const { body: sent } = await run();
    expect(sent.ok).toBe(true);
    expect(sent.data?.token).toBe("rcv_operator_token");
    expect(sent.data?.orderRef).toBe(`order_${ORDER_ID}`);
  });

  it("mints for a technically expired order the redeem rail would still recreate", async () => {
    const { body: sent } = await run({ snapshot: recoverableExpiredOrder() });
    expect(sent.ok).toBe(true);
  });

  it("expires the link a week out on a fresh order", async () => {
    const { body: sent } = await run();
    expect(sent.data?.expiresAt).toBe(new Date(NOW.getTime() + 7 * DAY_MS).toISOString());
  });

  it("never lets the link outlive the order's own 30-day recovery window", async () => {
    const createdAt = new Date(NOW.getTime() - 27 * DAY_MS).toISOString();
    const { body: sent } = await run({ snapshot: recoverableExpiredOrder({ createdAt }) });
    expect(sent.data?.expiresAt).toBe(new Date(Date.parse(createdAt) + 30 * DAY_MS).toISOString());
  });

  // The owner's requirement: the link must buy the same basket at the same sum.
  // An expired order redeems by RECREATING itself from its frozen quote, so if
  // the commercial facts moved the customer would meet a refusal on a page the
  // operator promised would work.
  it("names order_changed when the order no longer reprices to what was agreed", async () => {
    const { deps: d, body: sent } = await run({
      snapshot: recoverableExpiredOrder(),
      recreateValid: false,
    });
    expect(sent.error?.details?.reason).toBe("order_changed");
    expect(d.tokenStore.revokeActive).not.toHaveBeenCalled();
    expect(d.tokenStore.insert).not.toHaveBeenCalled();
  });

  it("mints an expired order once the recreate still reprices", async () => {
    const { deps: d, body: sent } = await run({
      snapshot: recoverableExpiredOrder(),
      recreateValid: true,
    });
    expect(sent.ok).toBe(true);
    expect(d.validateRecreate).toHaveBeenCalledTimes(1);
  });

  // `pending_payment` redeems as ITSELF, with its own frozen totals, so there is
  // nothing to reprice and asking would only be a chance to refuse wrongly.
  it("does not reprice an order that is still simply waiting to be paid", async () => {
    const { deps: d, body: sent } = await run({ recreateValid: false });
    expect(sent.ok).toBe(true);
    expect(d.validateRecreate).not.toHaveBeenCalled();
  });

  it("mints without the check when no pricing rail is wired in", async () => {
    const { body: sent } = await run({
      snapshot: recoverableExpiredOrder(),
      withoutValidateRecreate: true,
    });
    expect(sent.ok).toBe(true);
  });

  // The safety property of the whole store: a failure between the two writes must
  // leave ZERO live links, never two, so the revoke has to happen first.
  it("revokes the previous link before inserting the new one", async () => {
    const calls: string[] = [];
    await run({ calls });
    expect(calls).toEqual(["revoke", "insert"]);
  });

  it("refuses rather than minting when the revoke fails", async () => {
    const calls: string[] = [];
    const { body: sent } = await run({ calls, revokeFails: true });
    expect(calls).toEqual(["revoke"]);
    expect(sent.error?.code).toBe("UPSTREAM_UNAVAILABLE");
  });

  // The default is the copy flow, and it must stay the copy flow: an operator who
  // asked for nothing must never have caused an email to a customer.
  it("mails nothing when the operator only asked for a link", async () => {
    const { deps: d, body: sent } = await run();
    expect(d.tokenStore.enqueueRecoveryEmail).not.toHaveBeenCalled();
    expect(sent.data?.emailQueued).toBe(false);
  });

  it("hands the minted link to the delivery rail when the operator asks for email", async () => {
    const { deps: d, body: sent } = await run({}, request({ orderId: ORDER_ID, delivery: "email" }));
    expect(sent.ok).toBe(true);
    expect(sent.data?.emailQueued).toBe(true);
    expect(d.tokenStore.enqueueRecoveryEmail).toHaveBeenCalledTimes(1);
    // The token that goes out is the token that was minted and stored, keyed on
    // the row this very mint wrote.
    expect(vi.mocked(d.tokenStore.enqueueRecoveryEmail).mock.calls.at(-1)?.[0]).toEqual({
      orderId: ORDER_ID,
      tokenId: TOKEN_ROW_ID,
      rawToken: sent.data?.token,
      mode: "one_time",
      expiresAt: sent.data?.expiresAt,
    });
  });

  it("names the subscription cycle the recovery rail's own way", async () => {
    const { deps: d } = await run(
      { snapshot: order({ subscriptionCycleId: "66666666-6666-4666-8666-666666666666" }) },
      request({ orderId: ORDER_ID, delivery: "email" }),
    );
    expect(vi.mocked(d.tokenStore.enqueueRecoveryEmail).mock.calls.at(-1)?.[0])
      .toMatchObject({ mode: "subscription_cycle" });
  });

  it("enqueues only after the token exists", async () => {
    const calls: string[] = [];
    await run({ calls }, request({ orderId: ORDER_ID, delivery: "email" }));
    expect(calls).toEqual(["revoke", "insert", "enqueue"]);
  });

  // The failure mode this wave is written against: the operator is told an email
  // is on its way and nothing was ever handed to the rail. A refusal sends them
  // back to click again, which re-mints and enqueues under a fresh key.
  it("refuses rather than promising an email the rail never received", async () => {
    const { body: sent } = await run({ enqueueFails: true }, request({ orderId: ORDER_ID, delivery: "email" }));
    expect(sent.ok).toBe(false);
    expect(sent.error?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(sent.data?.emailQueued).toBeUndefined();
  });

  it("rejects a delivery mode outside the closed pair", async () => {
    const { body: sent } = await run({}, request({ orderId: ORDER_ID, delivery: "sms" }));
    expect(sent.error?.code).toBe("BAD_REQUEST");
  });

  // The failure this wave is written against: a link that does not redeem. The
  // stored digest must be the one the redeem side recomputes from the raw token.
  it("stores the digest of exactly the token it hands over", async () => {
    const { deps: d, body: sent } = await run();
    const [stored] = vi.mocked(d.tokenStore.insert).mock.calls.at(-1) ?? [];
    expect(stored).toMatchObject({
      orderId: ORDER_ID,
      clientId: CLIENT_ID,
      tokenHash: hashCheckoutRecoveryToken(sent.data?.token ?? ""),
      expiresAt: sent.data?.expiresAt,
    });
  });
});
