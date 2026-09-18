import type { PromotionRow } from "../../../src/domains/promo/types.js";

/**
 * Read-only data access for promo evaluation in the commerce quote.
 *
 * Deliberately thin: `listActivePromotions` returns the active candidate rows and
 * leaves ALL eligibility filtering (region, validity window, first_purchase,
 * cart_mode, coupon-code match, stacking) to the pure `evaluatePromos` evaluator —
 * the single source of truth shared by preview and finalize. `countPaidOrders`
 * supplies the server-authoritative `client_orders_count` used for `first_purchase`
 * eligibility; it is resolved from the authenticated clientId (never the client
 * request body), so a discount cannot be forged by spoofing the count.
 */
export interface PromotionRedemptionCount {
  global: number;
  perCustomer: number;
}

/** Paid-order counts split by order mode, for per-mode "first order" eligibility. */
export interface PaidOrdersByMode {
  /** Paid `one_time` (bundle) orders. */
  oneTime: number;
  /** Paid `subscription_cycle` orders (initial activation + every renewal). */
  subscription: number;
}

export interface CommercePromoDataPort {
  listActivePromotions(): Promise<PromotionRow[]>;
  countPaidOrders(clientId: string): Promise<number>;
  /**
   * Paid-order counts split by `commerce_orders.mode`. Drives `first_subscription_purchase`
   * (subscription===0) and `first_onetime_purchase` (oneTime===0) independently, so a
   * prior bundle never blocks a first subscription and vice versa. Server-authoritative
   * (resolved from the clientId, never client input).
   */
  countPaidOrdersByMode(clientId: string): Promise<PaidOrdersByMode>;
  /**
   * Per-promotion redemption counts (global + this client's), keyed by promotion id,
   * for the quote's cap pre-filter. `clientId` null ⇒ perCustomer is 0 (an anonymous
   * preview cannot resolve a per-customer cap; checkout re-evaluates with the real client).
   */
  redemptionCounts(clientId: string | null): Promise<Map<string, PromotionRedemptionCount>>;
  /**
   * True when this device's first-party visitor id already has a PAID first-order redemption. Denies
   * first-order promos to a device that has already completed and paid a first order, even
   * under a fresh email/client. `null`/empty visitorId ⇒ false (no guard).
   */
  deviceFirstOrderRedeemed(visitorId: string | null): Promise<boolean>;
}

export function promotionRedemptionMap(
  value: unknown,
): Map<string, PromotionRedemptionCount> {
  const rows = Array.isArray(value) ? (value as Array<Record<string, unknown>>) : [];
  const map = new Map<string, PromotionRedemptionCount>();
  for (const row of rows) {
    const id = typeof row.promotion_id === "string" ? row.promotion_id : null;
    if (!id) continue;
    map.set(id, {
      global: Number(row.global_count ?? 0),
      perCustomer: Number(row.per_customer_count ?? 0),
    });
  }
  return map;
}
