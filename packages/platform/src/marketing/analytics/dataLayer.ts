import type { AnalyticsSinkAttemptMask, AnalyticsSinkAdmission, AnalyticsCookieConsent, AnalyticsDataLayerOptions } from "../contracts/analytics.js";
export type { AnalyticsSinkAttemptMask, AnalyticsSinkAdmission, AnalyticsCookieConsent, AnalyticsBrowserWindow, AnalyticsDataLayerOptions } from "../contracts/analytics.js";
import { trackDeploymentEvent } from "./noop.js";
import type { AnalyticsEventMap, AnalyticsEventName } from "./noop.js";

type ConsentState = "granted" | "denied";

/** Each instance owns loader state; the host supplies browser and deployment policy. */
export function createAnalyticsDataLayer<StepName extends string = string>(options: AnalyticsDataLayerOptions<StepName> = {}) {
  const { consentStorageKey = "", consentChangeEvent = "", eventPrefix = "",
    readContainerId = () => null, getWindow = () => undefined } = options;
  const deploymentSink = options.trackDeploymentEvent ?? trackDeploymentEvent;
  let analyticsLoaderReady = false;
  const readinessListeners = new Set<() => void>();
  function readCookieConsent(): AnalyticsCookieConsent | null {
    const browser = getWindow();
    if (!browser) return null;
    try {
      const parsed: unknown = JSON.parse(browser.localStorage.getItem(consentStorageKey) ?? "");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const value = parsed as Record<string, unknown>;
      if (typeof value.necessary !== "boolean" || typeof value.functional !== "boolean"
        || typeof value.analytics !== "boolean" || typeof value.marketing !== "boolean") return null;
      return { necessary: value.necessary, functional: value.functional,
        analytics: value.analytics, marketing: value.marketing };
    } catch { return null; }
  }
  function hasAnalyticsConsent(consent = readCookieConsent()): boolean { return consent?.analytics === true; }
  function configuredContainerId(): string | null { return readContainerId(); }
  function subscribeToAnalyticsConsent(listener: () => void): () => void {
    const browser = getWindow();
    if (!browser) return () => undefined;
    const onStorage = (event: StorageEvent) => { if (event.key === consentStorageKey) listener(); };
    browser.addEventListener("storage", onStorage);
    browser.addEventListener(consentChangeEvent, listener);
    return () => {
      browser.removeEventListener("storage", onStorage);
      browser.removeEventListener(consentChangeEvent, listener);
    };
  }
  function isAnalyticsLoaderReady(): boolean { return analyticsLoaderReady; }
  function subscribeToAnalyticsLoaderReadiness(listener: () => void): () => void {
    readinessListeners.add(listener);
    return () => readinessListeners.delete(listener);
  }
  function markAnalyticsLoaderReady(): void {
    if (analyticsLoaderReady) return;
    analyticsLoaderReady = true;
    for (const listener of readinessListeners) listener();
  }
  function resetAnalyticsLoaderReadiness(): void { analyticsLoaderReady = false; }
  function pushAnalyticsConsentDefault(): void {
    pushConsentCommand("default", { analytics_storage: "denied", ad_storage: "denied",
      ad_user_data: "denied", ad_personalization: "denied" });
  }
  function pushAnalyticsConsentUpdate(granted: boolean): void {
    const analyticsState: ConsentState = granted ? "granted" : "denied";
    // Read the separate advertising grant at push time; revocation denies all signals.
    const adState: ConsentState = granted && readCookieConsent()?.marketing === true ? "granted" : "denied";
    pushConsentCommand("update", { analytics_storage: analyticsState, ad_storage: adState,
      ad_user_data: adState, ad_personalization: adState });
  }
  function pushAnalyticsEvent<K extends AnalyticsEventName>(event: K, properties: AnalyticsEventMap<StepName>[K]): boolean {
    const browser = getWindow();
    if (!browser || !configuredContainerId() || !hasAnalyticsConsent()) return false;
    if (!browser.dataLayer) {
      browser.dataLayer = [];
      pushAnalyticsConsentDefault();
      pushAnalyticsConsentUpdate(true);
    }
    browser.dataLayer.push({ event: `${eventPrefix}${event}`, ...properties });
    return true;
  }
  function emitAnalyticsEvent<K extends AnalyticsEventName>(event: K, properties: AnalyticsEventMap<StepName>[K],
    attempts: AnalyticsSinkAttemptMask = { deployment: true, optional: true }): AnalyticsSinkAdmission {
    let deployment = false;
    let optional = false;
    if (attempts.deployment) {
      try { deployment = deploymentSink(event, properties); } catch { /* Sink failure never gates the product. */ }
    }
    if (attempts.optional) {
      try { optional = pushAnalyticsEvent(event, properties); } catch { /* Independent best-effort admission. */ }
    }
    return { deployment, optional };
  }
  function pushConsentCommand(action: "default" | "update", settings: Record<string, ConsentState>): void {
    const browser = getWindow();
    if (!browser?.dataLayer) return;
    function consentCommand(..._args: unknown[]) {
      // Consent commands use the array-like arguments object, not an event object.
      // eslint-disable-next-line prefer-rest-params
      browser?.dataLayer?.push(arguments);
    }
    consentCommand("consent", action, settings);
  }
  return { readCookieConsent, hasAnalyticsConsent, configuredContainerId, subscribeToAnalyticsConsent,
    isAnalyticsLoaderReady, subscribeToAnalyticsLoaderReadiness, markAnalyticsLoaderReady,
    resetAnalyticsLoaderReadiness, pushAnalyticsConsentDefault, pushAnalyticsConsentUpdate,
    pushAnalyticsEvent, emitAnalyticsEvent };
}
