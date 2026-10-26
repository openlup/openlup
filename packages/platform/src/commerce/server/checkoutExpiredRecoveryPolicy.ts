import type { CreateQuoteResponse } from "../../pricing/index.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";
import type { CheckoutRecoveryTokenInspection } from "./checkoutRecoveryToken.js";
type RecoveryQuoteSnapshot = CreateQuoteResponse & { quote: { context?: { sizeConstraint?: unknown; shippingTerms?: {
  version: unknown; currency: string; flatMinor: number; freeThresholdMinor: number | null;
} } } };

export const EXPIRED_CHECKOUT_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type ExpiredRecoveryEligibility =
  | { kind: "eligible" }
  | { kind: "paid" }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

export function createExpiredCheckoutRecoveryPolicy<Order extends CheckoutRecoveryOrderSnapshot<unknown, unknown>>(bindings: {
  admitsSubscriptionSubject(order: Order): boolean;
}) {
  function classifyExpiredRecovery(input: {
    inspection: CheckoutRecoveryTokenInspection | null;
    order: Order | null;
    now: Date;
  }): ExpiredRecoveryEligibility {
    const { inspection, order, now } = input;
    if (!inspection || !order || inspection.clientId !== order.clientId) return { kind: "unavailable" };
    if (order.status === "paid") return { kind: "paid" };
    if (inspection.tokenState === "revoked" || inspection.tokenState === "used") {
      return { kind: "unavailable" };
    }
    return classifyOrderRecoveryEligibility(order, now);
  }

  /**
   * The ORDER half of the same decision, without a token in hand.
   *
   * `classifyExpiredRecovery` answers "may this bearer redeem?"; two of its checks
   * (the token exists, belongs to this order's client, and is neither revoked nor
   * used) are about the bearer and the rest are about the order. Only the second
   * half can be asked BEFORE a token exists, which is exactly the question the
   * operator's mint asks, so it lives here as one function both callers share.
   *
   * ⛔ Do not fork it. Mint-side eligibility drifting from redeem-side eligibility
   * is how support hands a customer a link that the redeem rail then refuses — a
   * dead link is worse than no button at all.
   */
  function classifyOrderRecoveryEligibility(
    order: Order | null,
    now: Date,
  ): ExpiredRecoveryEligibility {
    if (!order) return { kind: "unavailable" };
    if (order.status === "paid") return { kind: "paid" };
    const createdAt = Date.parse(order.createdAt);
    if (!Number.isFinite(createdAt) || now.getTime() - createdAt > EXPIRED_CHECKOUT_RECOVERY_WINDOW_MS) {
      return { kind: "unavailable" };
    }
    if (order.status === "cancelled" && !order.technicallyExpired) return { kind: "cancelled" };
    // Recreation is only safe after a canonical expiry transition has also
    // released the source reservation. `pending_payment` plus expired-looking
    // metadata is an inconsistent/legacy state: keep the technical-expiry fence
    // that prevents retrying its stale intent, but never create a second hold.
    if (order.status !== "expired" && order.status !== "cancelled") return { kind: "unavailable" };
    if (!order.technicallyExpired) return { kind: "unavailable" };
    if (!order.quoteSnapshot || !order.shippingAddressId) return { kind: "unavailable" };
    if (order.mode === "subscription_cycle" && (!order.subscriptionId || !order.subscriptionCycleId || !bindings.admitsSubscriptionSubject(order))) {
      return { kind: "unavailable" };
    }
    return { kind: "eligible" };
  }

  return { classifyExpiredRecovery, classifyOrderRecoveryEligibility };
}

export function quotesMatchForRecovery(
  frozen: RecoveryQuoteSnapshot,
  fresh: RecoveryQuoteSnapshot,
): boolean {
  return JSON.stringify(commercialFingerprint(frozen)) === JSON.stringify(commercialFingerprint(fresh));
}

function commercialFingerprint(snapshot: RecoveryQuoteSnapshot) {
  const quote = snapshot.quote;
  const terms = quote.context?.shippingTerms;
  return {
    currency: quote.currency,
    lines: quote.lines.map((line) => ({
      sku: line.sku,
      productSlug: line.productSlug,
      quantity: line.quantity,
      unitPriceGross: line.unitPriceGross,
      lineSubtotalGross: line.lineSubtotalGross,
      tax: line.tax,
    })),
    discounts: quote.discounts,
    subtotalGross: quote.subtotalGross,
    discountTotalGross: quote.discountTotalGross,
    shippingGross: quote.shippingGross ?? null,
    shippingDiscountGross: quote.shippingDiscountGross ?? null,
    shippingTerms: terms ? { version: terms.version, currency: terms.currency,
      flatMinor: terms.flatMinor, freeThresholdMinor: terms.freeThresholdMinor } : null,
    totalGross: quote.totalGross,
    netTotal: quote.netTotal,
    taxTotal: quote.taxTotal,
    mode: quote.context?.mode ?? null,
    cadenceDays: quote.context?.cadenceDays ?? null,
    sizeConstraint: quote.context?.sizeConstraint ?? null,
  };
}
