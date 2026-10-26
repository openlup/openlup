import { describe, expect, it } from "vitest";

import { CHECKOUT_COMMAND_V1 } from "../../src/commerce/index.js";
import type { CreateQuoteResponse } from "./storeTestFixtures.js";
import type { CheckoutRecoveryTokenInspection } from "../../src/commerce/server/checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderSnapshot as Snapshot } from "../../src/commerce/server/checkoutRecoveryOrderPort.js";
type CheckoutRecoveryOrderSnapshot = Snapshot<CreateQuoteResponse, string, { subjectName: string | null; subjectId?: string | null }>;

import {
  createExpiredCheckoutRecoveryPolicy,
  quotesMatchForRecovery,
} from "../../src/commerce/server/checkoutExpiredRecoveryPolicy.js";

const { classifyExpiredRecovery, classifyOrderRecoveryEligibility } = createExpiredCheckoutRecoveryPolicy<CheckoutRecoveryOrderSnapshot>({ admitsSubscriptionSubject: order => !!order.subjectId || order.runtimeMetadata?.checkoutCommandVersion === CHECKOUT_COMMAND_V1 });

const NOW = new Date("1999-07-21T12:00:00.000Z");
const CLIENT_ID = "10000000-0000-4000-8000-000000000001";
const ORDER_ID = "20000000-0000-4000-8000-000000000001";
const TOKEN_ID = "30000000-0000-4000-8000-000000000001";

describe("checkout expired recovery policy", () => {
  it("allows a technically expired checkout within the 30 day recovery window", () => {
    expect(classifyExpiredRecovery({
      inspection: inspection(),
      order: order(),
      now: NOW,
    })).toEqual({ kind: "eligible" });
  });

  it("rejects a manual OMS cancellation as cancelled, not expired-recoverable", () => {
    expect(classifyExpiredRecovery({
      inspection: inspection({ status: "cancelled", tokenState: "order_not_recoverable" }),
      order: order({
        status: "cancelled",
        technicallyExpired: false,
        runtimeMetadata: { manualOrderCancellation: { reason: "operator cancelled" } },
      }),
      now: NOW,
    })).toEqual({ kind: "cancelled" });
  });

  it("fails closed for pending_payment with expired-looking metadata", () => {
    expect(classifyExpiredRecovery({
      inspection: inspection({ status: "pending_payment", tokenState: "active" }),
      order: order({
        status: "pending_payment",
        paymentIntentId: "60000000-0000-4000-8000-000000000001",
        paymentIntentStatus: "processing",
        technicallyExpired: true,
      }),
      now: NOW,
    })).toEqual({ kind: "unavailable" });
  });

  it("classifies paid orders as paid so the UI never offers another charge", () => {
    expect(classifyExpiredRecovery({
      inspection: inspection({ status: "paid", tokenState: "order_not_recoverable" }),
      order: order({ status: "paid", technicallyExpired: false }),
      now: NOW,
    })).toEqual({ kind: "paid" });
  });

  it("rejects missing facts required to safely recreate the order", () => {
    expect(classifyExpiredRecovery({
      inspection: inspection(),
      order: order({ quoteSnapshot: null }),
      now: NOW,
    })).toEqual({ kind: "unavailable" });

    expect(classifyExpiredRecovery({
      inspection: inspection(),
      order: order({ shippingAddressId: null }),
      now: NOW,
    })).toEqual({ kind: "unavailable" });

    expect(classifyExpiredRecovery({
      inspection: inspection({ clientId: "10000000-0000-4000-8000-000000000999" }),
      order: order(),
      now: NOW,
    })).toEqual({ kind: "unavailable" });
  });

  it("detects full commercial drift in the fresh quote fingerprint", () => {
    expect(quotesMatchForRecovery(quote(), quote())).toBe(true);
    expect(quotesMatchForRecovery(
      quote(),
      quote({
        lines: [{ ...line(), sku: "item-b" }],
        totalGross: money(5000),
        netTotal: money(4629),
        taxTotal: money(371),
      }),
    )).toBe(false);
  });

  it("compares numeric shipping agreements including absence, independently of current money", () => {
    const base = quote();
    const terms = { version: "shipping-threshold.v1" as const, currency: "XTS", flatMinor: 1000, freeThresholdMinor: 6000 };
    const frozen = quote({ context: { ...base.quote.context!, shippingTerms: terms } });
    expect(quotesMatchForRecovery(frozen, frozen)).toBe(true);
    expect(quotesMatchForRecovery(frozen, quote({ context: { ...base.quote.context!, shippingTerms: { freeThresholdMinor: 6000, flatMinor: 1000, currency: "XTS", version: "shipping-threshold.v1" } } }))).toBe(true);
    expect(quotesMatchForRecovery(frozen, quote({ context: { ...base.quote.context!, shippingTerms: { ...terms, freeThresholdMinor: 8000 } } }))).toBe(false);
    expect(quotesMatchForRecovery(frozen, base)).toBe(false);
    expect(quotesMatchForRecovery(base, base)).toBe(true);
  });


});

function inspection(overrides: Partial<CheckoutRecoveryTokenInspection> = {}): CheckoutRecoveryTokenInspection {
  return {
    tokenId: TOKEN_ID,
    orderId: ORDER_ID,
    clientId: CLIENT_ID,
    mode: "one_time_order",
    status: "expired",
    subscriptionId: null,
    tokenState: "expired",
    ...overrides,
  };
}

function order(overrides: Partial<CheckoutRecoveryOrderSnapshot> = {}): CheckoutRecoveryOrderSnapshot {
  return {
    orderId: ORDER_ID,
    orderRef: `order_${ORDER_ID}`,
    orderNumber: "EXAMPLE-EXPIRED",
    clientId: CLIENT_ID,
    status: "expired",
    mode: "one_time_order",
    totalMinor: 4998,
    currency: "XTS",
    subjectName: "Example",
    cadenceDays: null,
    createdAt: "1999-07-01T12:00:00.000Z",
    customerEmail: "buyer@example.test",
    customerName: "Buyer",
    paymentIntentId: null,
    paymentIntentStatus: null,
    subscriptionId: null,
    subscriptionCycleId: null,
    shippingAddressId: "40000000-0000-4000-8000-000000000001",
    subjectId: "50000000-0000-4000-8000-000000000001",
    quoteSnapshot: quote(),
    runtimeMetadata: { selectedDelivery: { providerKind: "carrier-a" } },
    invoiceBuyerSnapshot: { email: "buyer@example.test", name: "Buyer" },
    recoveryRootOrderId: ORDER_ID,
    recreatedFromOrderId: null,
    technicallyExpired: true,
    ...overrides,
  };
}

function quote(overrides: Partial<CreateQuoteResponse["quote"]> = {}): CreateQuoteResponse {
  return {
    contractVersion: "commerce.v0",
    quote: {
      currency: "XTS",
      taxIncluded: true,
      lines: [line()],
      discounts: [],
      subtotalGross: money(4998),
      discountTotalGross: money(0),
      shippingGross: money(0),
      shippingDiscountGross: money(0),
      totalGross: money(4998),
      netTotal: money(4628),
      taxTotal: money(370),
      context: {
        mode: "one_time",
        cadenceDays: null,
        promoCodes: [],
      },
      ...overrides,
    },
  };
}

function line(): CreateQuoteResponse["quote"]["lines"][number] {
  return {
    sku: "item-a",
    productSlug: "item-a",
    quantity: 2,
    unitPriceGross: money(2499),
    lineSubtotalGross: money(4998),
    tax: {
      included: true,
      country: "AA",
      category: "standard",
      vatRateBps: 800,
      legalBasis: "synthetic",
      netAmount: money(4628),
      vatAmount: money(370),
      grossAmount: money(4998),
    },
  };
}

function money(amountMinor: number) {
  return { amountMinor, currency: "XTS" as const };
}

/**
 * The order-only half, asked before any token exists. Its verdicts must be the
 * same ones `classifyExpiredRecovery` reaches once the bearer checks have passed;
 * the cases above are the proof for the token side and these are the proof that
 * the extracted predicate did not quietly change what "recoverable" means.
 */
describe("order recovery eligibility without a token", () => {
  it("allows a technically expired order inside the recovery window", () => {
    expect(classifyOrderRecoveryEligibility(order(), NOW)).toEqual({ kind: "eligible" });
  });

  it("reports a missing order as unavailable rather than throwing", () => {
    expect(classifyOrderRecoveryEligibility(null, NOW)).toEqual({ kind: "unavailable" });
  });

  it("reports a paid order as paid", () => {
    expect(classifyOrderRecoveryEligibility(order({ status: "paid" }), NOW))
      .toEqual({ kind: "paid" });
  });

  it("separates a human cancellation from a technical expiry", () => {
    expect(classifyOrderRecoveryEligibility(order({ status: "cancelled", technicallyExpired: false }), NOW))
      .toEqual({ kind: "cancelled" });
    expect(classifyOrderRecoveryEligibility(order({ status: "cancelled", technicallyExpired: true }), NOW))
      .toEqual({ kind: "eligible" });
  });

  it("refuses once the order is older than the recovery window", () => {
    expect(classifyOrderRecoveryEligibility(order({ createdAt: "1999-06-01T12:00:00.000Z" }), NOW))
      .toEqual({ kind: "unavailable" });
  });

  it("refuses an unparseable creation timestamp", () => {
    expect(classifyOrderRecoveryEligibility(order({ createdAt: "not-a-date" }), NOW))
      .toEqual({ kind: "unavailable" });
  });

  it("refuses a status the recovery rail does not recreate from", () => {
    expect(classifyOrderRecoveryEligibility(order({ status: "pending_payment" }), NOW))
      .toEqual({ kind: "unavailable" });
  });

  it("refuses an expired order that was never technically expired", () => {
    expect(classifyOrderRecoveryEligibility(order({ technicallyExpired: false }), NOW))
      .toEqual({ kind: "unavailable" });
  });

  it("refuses when the frozen quote or the shipping address is gone", () => {
    expect(classifyOrderRecoveryEligibility(order({ quoteSnapshot: null }), NOW))
      .toEqual({ kind: "unavailable" });
    expect(classifyOrderRecoveryEligibility(order({ shippingAddressId: null }), NOW))
      .toEqual({ kind: "unavailable" });
  });

  it("refuses a subscription cycle missing the ids its activation needs", () => {
    const cycle = { mode: "subscription_cycle" as const, subscriptionId: "70000000-0000-4000-8000-000000000001", subscriptionCycleId: "80000000-0000-4000-8000-000000000001" };
    expect(classifyOrderRecoveryEligibility(order(cycle), NOW)).toEqual({ kind: "eligible" });
    expect(classifyOrderRecoveryEligibility(order({ ...cycle, subscriptionCycleId: null }), NOW))
      .toEqual({ kind: "unavailable" });
    expect(classifyOrderRecoveryEligibility(order({ ...cycle, subscriptionId: null }), NOW))
      .toEqual({ kind: "unavailable" });
  });
});


describe("neutral subject-free expired subscription eligibility", () => {
  const linked = { mode: "subscription_cycle" as const, subscriptionId: "70000000-0000-4000-8000-000000000001", subscriptionCycleId: "80000000-0000-4000-8000-000000000001" };
  function neutral(overrides: Partial<CheckoutRecoveryOrderSnapshot> = {}) {
    return order({ ...linked, subjectId: null, quoteSnapshot: quote({ context: { ...quote().quote.context, mode: "subscription", cadenceDays: 21, promoCodes: [] } }),
      runtimeMetadata: { checkoutCommandVersion: CHECKOUT_COMMAND_V1 }, ...overrides });
  }

  it.each([null, undefined])("admits exact persisted provenance with subjectId %s", (subjectId) => {
    expect(classifyOrderRecoveryEligibility(neutral({ subjectId }), NOW)).toEqual({ kind: "eligible" });
  });

  it.each([undefined, null, "", "commerce.checkout_command.v2", ` ${CHECKOUT_COMMAND_V1}`, `${CHECKOUT_COMMAND_V1} `, true, 1, {}, []].map((marker) => [marker] as const))(
    "refuses missing or malformed provenance %j", (checkoutCommandVersion) => {
      expect(classifyOrderRecoveryEligibility(neutral({ runtimeMetadata: { checkoutCommandVersion } }), NOW))
        .toEqual({ kind: "unavailable" });
    },
  );

  it("does not infer provenance from another metadata field or the quote", () => {
    const markedQuote = quote({ context: { ...quote().quote.context, checkoutCommandVersion: CHECKOUT_COMMAND_V1 } as never });
    expect(classifyOrderRecoveryEligibility(neutral({ runtimeMetadata: { nested: { checkoutCommandVersion: CHECKOUT_COMMAND_V1 } }, quoteSnapshot: markedQuote }), NOW))
      .toEqual({ kind: "unavailable" });
    expect(classifyOrderRecoveryEligibility(neutral({ runtimeMetadata: undefined }), NOW))
      .toEqual({ kind: "unavailable" });
  });

  it("keeps subject-backed legacy subscriptions eligible without a marker", () => {
    expect(classifyOrderRecoveryEligibility(order(linked), NOW)).toEqual({ kind: "eligible" });
  });

  it.each([
    { subscriptionId: null }, { subscriptionCycleId: null }, { quoteSnapshot: null }, { shippingAddressId: null },
    { createdAt: "1999-06-01T12:00:00.000Z" }, { status: "pending_payment" }, { technicallyExpired: false },
  ])("never lets provenance rescue missing reconstruction facts %j", (missing) => {
    expect(classifyOrderRecoveryEligibility(neutral(missing), NOW)).toEqual({ kind: "unavailable" });
  });

  it("keeps paid and manually cancelled outcomes terminal", () => {
    expect(classifyOrderRecoveryEligibility(neutral({ status: "paid" }), NOW)).toEqual({ kind: "paid" });
    expect(classifyOrderRecoveryEligibility(neutral({ status: "cancelled", technicallyExpired: false }), NOW)).toEqual({ kind: "cancelled" });
  });

  it.each(["revoked", "used"])("rejects %s authority on the expired classifier path", (tokenState) => {
    expect(classifyExpiredRecovery({ inspection: inspection({ tokenState }), order: neutral(), now: NOW }))
      .toEqual({ kind: "unavailable" });
  });

  it("retains same-client authority and requires inspection", () => {
    expect(classifyExpiredRecovery({ inspection: inspection(), order: neutral(), now: NOW })).toEqual({ kind: "eligible" });
    expect(classifyExpiredRecovery({ inspection: null, order: neutral(), now: NOW })).toEqual({ kind: "unavailable" });
    expect(classifyExpiredRecovery({ inspection: inspection({ clientId: "10000000-0000-4000-8000-000000000999" }), order: neutral(), now: NOW }))
      .toEqual({ kind: "unavailable" });
  });
});
