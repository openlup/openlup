import type {
  CreateQuoteRequest,
  CreateQuoteResponse,
} from "../../../src/domains/commerce/contracts.js";
import type { CheckoutRecoveryTokenInspection } from "./checkoutRecoveryToken.js";
import type { CheckoutRecoveryOrderSnapshot } from "./checkoutRecoveryOrderPort.js";

export const EXPIRED_CHECKOUT_RECOVERY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export type ExpiredRecoveryEligibility =
  | { kind: "eligible" }
  | { kind: "paid" }
  | { kind: "cancelled" }
  | { kind: "unavailable" };

export function classifyExpiredRecovery(input: {
  inspection: CheckoutRecoveryTokenInspection | null;
  order: CheckoutRecoveryOrderSnapshot | null;
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
export function classifyOrderRecoveryEligibility(
  order: CheckoutRecoveryOrderSnapshot | null,
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
  if (order.mode === "subscription_cycle" && (!order.subscriptionId || !order.subscriptionCycleId || !order.petId)) {
    return { kind: "unavailable" };
  }
  return { kind: "eligible" };
}

export function quoteRequestForExpiredRecovery(order: CheckoutRecoveryOrderSnapshot): CreateQuoteRequest {
  if (!order.quoteSnapshot) throw new Error("expired_recovery_quote_snapshot_missing");
  const quote = order.quoteSnapshot.quote;
  const context = quote.context;
  return {
    mode: context?.mode ?? (order.mode === "subscription_cycle" ? "subscription" : "one_time"),
    lines: quote.lines.map((line) => ({
      sku: line.sku,
      quantity: line.quantity,
      modeAtLine: context?.mode ?? (order.mode === "subscription_cycle" ? "subscription" : "one_time"),
    })),
    sizeConstraint: context?.sizeConstraint,
    cadenceDays: context?.cadenceDays ?? order.cadenceDays,
    promoCodes: context?.promoCodes ?? [],
    petId: order.petId,
    petProfileContext: context?.petProfileContext,
    customerEligibilityContext: order.customerEmail ? { email: order.customerEmail } : undefined,
  };
}

export function quotesMatchForRecovery(
  frozen: CreateQuoteResponse,
  fresh: CreateQuoteResponse,
): boolean {
  return JSON.stringify(commercialFingerprint(frozen)) === JSON.stringify(commercialFingerprint(fresh));
}

function commercialFingerprint(snapshot: CreateQuoteResponse) {
  const quote = snapshot.quote;
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
    totalGross: quote.totalGross,
    netTotal: quote.netTotal,
    taxTotal: quote.taxTotal,
    mode: quote.context?.mode ?? null,
    cadenceDays: quote.context?.cadenceDays ?? null,
    sizeConstraint: quote.context?.sizeConstraint ?? null,
  };
}
