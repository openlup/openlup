import type { AnalyticsEventMap, AnalyticsEventName } from "../contracts/analytics.js";
export type { AnalyticsStepName, AnalyticsCheckoutItem, AnalyticsPurchaseItem, AnalyticsCheckoutMode, AnalyticsPaymentWaitOutcome, AnalyticsEventMap, AnalyticsEventName } from "../contracts/analytics.js";
import type { AnalyticsPort } from "@openlup/core/platform-runtime";

export function initializeDeploymentAnalytics(): void {}
export function trackDeploymentEvent<K extends AnalyticsEventName>(
  _event: K, _properties: AnalyticsEventMap[K],
): boolean { return false; }
export function syncAdvertisingConsent(): void {}
export function trackAdvertisingPurchase(_payload: AnalyticsEventMap["purchase"]): boolean { return false; }
/** Inert composition satisfies the existing platform runtime port. */
export function createNoopAnalytics(): AnalyticsPort {
  return { trackPageView() {}, trackEvent() {} };
}
