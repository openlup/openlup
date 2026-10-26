/** The host supplies its own literal step vocabulary. */
export type AnalyticsStepName<StepName extends string = string> = StepName;
export interface AnalyticsCheckoutItem { item_id: string; quantity: number }
export interface AnalyticsPurchaseItem extends AnalyticsCheckoutItem {
  item_variant?: string;
  price: number;
  discount: number;
}
export type AnalyticsCheckoutMode = "one_time" | "subscription";
/** No answer describes an ended wait, without asserting payment failure. */
export type AnalyticsPaymentWaitOutcome = "confirmed" | "refused" | "no_answer";
export interface AnalyticsEventMap<StepName extends string = string> {
  page_view: { page_path: string };
  configurator_start: { entry_view: "hero" | "configurator" };
  configurator_step_view: { step_number: number; step_name: AnalyticsStepName<StepName> };
  begin_checkout: { checkout_mode: AnalyticsCheckoutMode; items: AnalyticsCheckoutItem[] };
  purchase: {
    transaction_id: string;
    currency: string;
    value: number;
    shipping: number;
    tax: number;
    checkout_mode: AnalyticsCheckoutMode;
    items: AnalyticsPurchaseItem[];
  };
  // Wait observations carry no identity, amount, currency or payment method.
  payment_wait_start: { checkoutMode: AnalyticsCheckoutMode };
  payment_wait_end: { outcome: AnalyticsPaymentWaitOutcome; checkoutMode: AnalyticsCheckoutMode };
  configurator_draft_restored: { draft_context: "public" };
  configurator_draft_save_failed: { draft_context: "public"; reason: "unavailable" | "quota" | "conflict" };
  configurator_draft_reset: { draft_context: "public" };
}
export type AnalyticsEventName = keyof AnalyticsEventMap;

export interface AnalyticsSinkAttemptMask { deployment: boolean; optional: boolean }
/** Synchronous local acceptance only; never transport delivery or business acknowledgement. */
export interface AnalyticsSinkAdmission { deployment: boolean; optional: boolean }
export interface AnalyticsCookieConsent {
  necessary: boolean; functional: boolean; analytics: boolean; marketing: boolean;
}
export type AnalyticsBrowserWindow = Pick<Window, "localStorage" | "addEventListener" | "removeEventListener"> & {
  dataLayer?: unknown[];
};
export interface AnalyticsDataLayerOptions<StepName extends string = string> {
  consentStorageKey?: string;
  consentChangeEvent?: string;
  eventPrefix?: string;
  readContainerId?: () => string | null;
  trackDeploymentEvent?: <K extends AnalyticsEventName>(event: K, properties: AnalyticsEventMap<StepName>[K]) => boolean;
  getWindow?: () => AnalyticsBrowserWindow | undefined;
}

export interface AnalyticsRoutePolicyInput {
  publicPaths: readonly string[];
  redirectSources: readonly string[];
  privatePathPrefixes: readonly string[];
  privateAuthPaths: readonly string[];
  capabilityPathPrefixes: readonly string[];
}

/** Only paid recap facts read by the projection; money remains the host's truth. */
export interface PurchaseOrder {
  orderId: string;
  status: string;
  paymentStatus: string | null;
  checkoutKind: "one_time" | "subscription_initial" | "subscription_renewal" | null;
  moneyReconciled: boolean;
  items: Array<{ sku: string | null; variantCode: string | null; quantity: number;
    catalogTotalGross: number; effectiveNet: number; vatRateBps: number }>;
  totals: { tax: { amountMinor: number }; total: { amountMinor: number; currency: string } };
}
export type PurchaseSuppressionReason = "order_not_paid" | "payment_not_succeeded"
  | "checkout_kind_unsupported" | "money_unreconciled" | "items_empty" | "sku_missing"
  | "quantity_invalid" | "line_money_invalid" | "net_discount_invalid"
  | "item_limit_exceeded" | "shipping_net_invalid";

export interface MarketingHistoricalConsentCommand { consentedAt: string | null; listId: string | null }
/** Native state literals are compatibility inputs supplied by the host adapter. */
export interface MarketingHistoricalConsentState {
  consent: "SUBSCRIBED" | "UNSUBSCRIBED" | "NEVER_SUBSCRIBED" | "unknown";
  nativeConsentAt?: string | null;
  suppressions: Array<{ reason: "UNSUBSCRIBE" | "SPAM_REPORT" | "USER_SUPPRESSED" | "HARD_BOUNCE" | "INVALID_EMAIL" | "unknown";
    listId: string | null }>;
}
export type MarketingHistoricalConsentResult = { kind: "ready"; providerConsentedAt: string }
  | { kind: "defer"; retryAt: string } | { kind: "hold"; reason: string };
