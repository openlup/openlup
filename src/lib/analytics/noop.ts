import type { AnalyticsEventMap as MarketingAnalyticsEventMap } from "@openlup/platform/marketing/contracts";

export type AnalyticsStepName =
  | "pet"
  | "your_data"
  | "allergies"
  | "flavors"
  | "package_size"
  | "summary"
  | "payment";
export type AnalyticsEventMap = MarketingAnalyticsEventMap<AnalyticsStepName>;
export type AnalyticsEventName = keyof AnalyticsEventMap;
export type { AnalyticsCheckoutItem, AnalyticsCheckoutMode, AnalyticsPaymentWaitOutcome,
  AnalyticsPurchaseItem } from "@openlup/platform/marketing/contracts";
export { initializeDeploymentAnalytics, createNoopAnalytics } from "@openlup/platform/marketing";
import { trackDeploymentEvent as trackEvent } from "@openlup/platform/marketing";

export function trackDeploymentEvent<K extends AnalyticsEventName>(event: K, properties: AnalyticsEventMap[K]): boolean {
  return trackEvent(event, properties);
}
