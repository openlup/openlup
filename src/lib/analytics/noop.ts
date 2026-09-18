import type { AnalyticsPort } from "../../domains/platform-runtime/ports.js";
import type { PlatformCurrency } from "../currency/platformCurrency.js";

// Public analytics contract and inert default implementation. Keeping the
// browser-independent event vocabulary here lets node-only seam checks consume
// it without loading dataLayer.ts or any private browser collector.
export type AnalyticsStepName =
  | "pet"
  | "your_data"
  | "allergies"
  | "flavors"
  | "package_size"
  | "summary"
  | "payment";

export interface AnalyticsCheckoutItem {
  item_id: string;
  quantity: number;
}

export interface AnalyticsPurchaseItem extends AnalyticsCheckoutItem {
  item_variant?: string;
  price: number;
  discount: number;
}

/**
 * How an in-place payment wait ended.
 *
 * ⚠️ `no_answer` is NOT a failure. At the wait cap the payment may well have
 * been taken and no confirmation has reached us yet; what ended there is our
 * ability to answer the buyer where they stand. That is the moment this funnel
 * exists to count, so it is named for what it is rather than folded into
 * `refused`, which is a verdict a provider actually attested.
 */
export type AnalyticsCheckoutMode = "one_time" | "subscription";
export type AnalyticsPaymentWaitOutcome = "confirmed" | "refused" | "no_answer";

export interface AnalyticsEventMap {
  page_view: { page_path: string };
  configurator_start: { entry_view: "hero" | "configurator" };
  configurator_step_view: { step_number: number; step_name: AnalyticsStepName };
  begin_checkout: {
    checkout_mode: "one_time" | "subscription";
    items: AnalyticsCheckoutItem[];
  };
  purchase: {
    transaction_id: string;
    // Carried straight through from the order recap, which no longer types its
    // currency as a one-member union (src/lib/currency/platformCurrency.ts).
    // GA4 wants an ISO-4217 code here, not a specific one.
    currency: PlatformCurrency;
    value: number;
    shipping: number;
    tax: number;
    checkout_mode: "one_time" | "subscription";
    items: AnalyticsPurchaseItem[];
  };
  // The gap between `begin_checkout` and `purchase` on a rail the buyer
  // confirms in another application: one event on entering the wait, one on how
  // it ended.
  //
  // ⛔ The payload is deliberately this thin. A payment surface is the worst
  // place in the product to leak, so neither event carries an order id, an order
  // reference, a payment-intent id, a client id, an address, an amount, a
  // currency, a method name or anything derived from one. Volume and outcome are
  // what a funnel needs; everything else is re-identification risk shipped to a
  // third-party tag manager. There is also nothing here to widen by accident —
  // the emitter never reads the wait's identity object at all.
  payment_wait_start: { checkoutMode: AnalyticsCheckoutMode };
  payment_wait_end: { outcome: AnalyticsPaymentWaitOutcome; checkoutMode: AnalyticsCheckoutMode };
  configurator_draft_restored: { draft_context: "public" };
  configurator_draft_save_failed: {
    draft_context: "public";
    reason: "unavailable" | "quota" | "conflict";
  };
  configurator_draft_reset: { draft_context: "public" };
}

export type AnalyticsEventName = keyof AnalyticsEventMap;

/** Public/default composition never initializes a browser collector. */
export function initializeDeploymentAnalytics(): void {}

export function trackDeploymentEvent<K extends AnalyticsEventName>(
  _event: K,
  _properties: AnalyticsEventMap[K],
): boolean {
  return false;
}

/**
 * Analytics no-op adapter. The OSS-default / self-host fallback: satisfies the
 * `AnalyticsPort` contract without emitting any telemetry or loading vendor
 * scripts. Safe in SSR, tests, and consent-denied contexts.
 */
export function createNoopAnalytics(): AnalyticsPort {
  return {
    trackPageView() {
      // intentionally empty
    },
    trackEvent() {
      // intentionally empty
    },
  };
}
