import { trackDeploymentEvent } from "#deployment-analytics";
import { createAnalyticsDataLayer } from "@openlup/platform/marketing";
import type { AnalyticsStepName } from "./noop.js";

export type { AnalyticsCheckoutItem, AnalyticsCheckoutMode, AnalyticsEventMap, AnalyticsEventName,
  AnalyticsPaymentWaitOutcome, AnalyticsPurchaseItem, AnalyticsStepName } from "./noop.js";
export type { AnalyticsSinkAttemptMask, AnalyticsSinkAdmission } from "@openlup/platform/marketing/contracts";
export const ANALYTICS_CONSENT_STORAGE_KEY = "cookie-consent";
export const ANALYTICS_CONSENT_EVENT = "cookie-consent-changed";
const GTM_ID_PATTERN = /^GTM-[A-Z0-9]+$/;

export function configuredGtmId(): string | null {
  const value = (import.meta.env.VITE_GTM_ID as string | undefined)?.trim();
  return value && GTM_ID_PATTERN.test(value) ? value : null;
}
const analytics = createAnalyticsDataLayer<AnalyticsStepName>({
  consentStorageKey: ANALYTICS_CONSENT_STORAGE_KEY,
  consentChangeEvent: ANALYTICS_CONSENT_EVENT,
  consentSignalNames: { analytics: "analytics_storage", advertising: ["ad_storage", "ad_user_data", "ad_personalization"] },
  eventPrefix: "openlup_ga4_v1_",
  readContainerId: configuredGtmId,
  trackDeploymentEvent,
  getWindow: () => typeof window === "undefined" ? undefined : window,
});
export const { readCookieConsent, hasAnalyticsConsent, subscribeToAnalyticsConsent,
  isAnalyticsLoaderReady, subscribeToAnalyticsLoaderReadiness, markAnalyticsLoaderReady,
  resetAnalyticsLoaderReadiness,
  pushAnalyticsEvent, emitAnalyticsEvent } = analytics;

// These host command entrypoints retain their browser-required calling contract.
export function pushAnalyticsConsentDefault(): void {
  void window;
  analytics.pushAnalyticsConsentDefault();
}
export function pushAnalyticsConsentUpdate(granted: boolean): void {
  void window;
  analytics.pushAnalyticsConsentUpdate(granted);
}
