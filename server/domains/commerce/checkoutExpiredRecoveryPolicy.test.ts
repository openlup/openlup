import { describe, expect, it } from "vitest";

import type { CreateQuoteResponse } from "../../../src/domains/commerce/contracts.js";
import type { CheckoutRecoveryTokenInspection } from "./checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import {
  classifyExpiredRecovery,
  classifyOrderRecoveryEligibility,
  quoteRequestForExpiredRecovery,
  quotesMatchForRecovery,
} from "./checkoutExpiredRecoveryPolicy.js";

const NOW = new Date("2026-07-21T12:00:00.000Z");
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
        lines: [{ ...line(), sku: "openlup-beef-400g" }],
        totalGross: money(5000),
        netTotal: money(4629),
        taxTotal: money(371),
      }),
    )).toBe(false);
  });

  it("reconstructs a quote request from the frozen expired order facts", () => {
    expect(quoteRequestForExpiredRecovery(order())).toMatchObject({
      mode: "one_time",
      lines: [{ sku: "openlup-lamb-400g", quantity: 2, modeAtLine: "one_time" }],
      cadenceDays: null,
      petId: "50000000-0000-4000-8000-000000000001",
      customerEligibilityContext: { email: "buyer@example.test" },
    });
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
    orderNumber: "OPENLUP-EXPIRED",
    clientId: CLIENT_ID,
    status: "expired",
    mode: "one_time_order",
    totalMinor: 4998,
    currency: "PLN",
    petName: "Lida",
    cadenceDays: null,
    createdAt: "2026-07-01T12:00:00.000Z",
    customerEmail: "buyer@example.test",
    customerName: "Buyer",
    paymentIntentId: null,
    paymentIntentStatus: null,
    subscriptionId: null,
    subscriptionCycleId: null,
    shippingAddressId: "40000000-0000-4000-8000-000000000001",
    petId: "50000000-0000-4000-8000-000000000001",
    quoteSnapshot: quote(),
    runtimeMetadata: { selectedDelivery: { providerKind: "omnipack" } },
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
      currency: "PLN",
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
        petId: "50000000-0000-4000-8000-000000000001",
      },
      ...overrides,
    },
  };
}

function line(): CreateQuoteResponse["quote"]["lines"][number] {
  return {
    sku: "openlup-lamb-400g",
    productSlug: "jagniecina-entopro",
    quantity: 2,
    unitPriceGross: money(2499),
    lineSubtotalGross: money(4998),
    tax: {
      included: true,
      country: "PL",
      category: "pet_food",
      vatRateBps: 800,
      legalBasis: "PL VAT Annex 3 item 10c",
      netAmount: money(4628),
      vatAmount: money(370),
      grossAmount: money(4998),
    },
  };
}

function money(amountMinor: number) {
  return { amountMinor, currency: "PLN" as const };
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
    expect(classifyOrderRecoveryEligibility(order({ createdAt: "2026-06-01T12:00:00.000Z" }), NOW))
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
