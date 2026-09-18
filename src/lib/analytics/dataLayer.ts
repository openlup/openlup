// The shared browser-event seam. Private deployment admission is independent;
// the optional tag-manager projection remains consent-gated and never replays.

import { trackDeploymentEvent } from "#deployment-analytics";

import type { AnalyticsEventMap, AnalyticsEventName } from "./noop.js";

export type {
  AnalyticsCheckoutItem,
  AnalyticsCheckoutMode,
  AnalyticsEventMap,
  AnalyticsEventName,
  AnalyticsPaymentWaitOutcome,
  AnalyticsPurchaseItem,
  AnalyticsStepName,
} from "./noop.js";

export const ANALYTICS_CONSENT_STORAGE_KEY = "cookie-consent";
export const ANALYTICS_CONSENT_EVENT = "cookie-consent-changed";
const TRANSPORT_PREFIX = "openlup_ga4_v1_";
const GTM_ID_PATTERN = /^GTM-[A-Z0-9]+$/;
let analyticsLoaderReady = false;
const analyticsLoaderReadyListeners = new Set<() => void>();

export interface AnalyticsSinkAttemptMask {
  deployment: boolean;
  optional: boolean;
}

export interface AnalyticsSinkAdmission {
  deployment: boolean;
  optional: boolean;
}

type WindowWithDataLayer = Window & {
  dataLayer?: unknown[];
};

type ConsentState = "granted" | "denied";

interface CookieConsent {
  necessary: boolean;
  functional: boolean;
  analytics: boolean;
  marketing: boolean;
}

export function readCookieConsent(): CookieConsent | null {
  if (typeof window === "undefined") return null;
  try {
    const parsed: unknown = JSON.parse(
      window.localStorage.getItem(ANALYTICS_CONSENT_STORAGE_KEY) ?? "",
    );
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const value = parsed as Record<string, unknown>;
    if (
      typeof value.necessary !== "boolean" ||
      typeof value.functional !== "boolean" ||
      typeof value.analytics !== "boolean" ||
      typeof value.marketing !== "boolean"
    ) {
      return null;
    }
    return {
      necessary: value.necessary,
      functional: value.functional,
      analytics: value.analytics,
      marketing: value.marketing,
    };
  } catch {
    return null;
  }
}

export function hasAnalyticsConsent(consent = readCookieConsent()): boolean {
  return consent?.analytics === true;
}

export function configuredGtmId(): string | null {
  const value = (import.meta.env.VITE_GTM_ID as string | undefined)?.trim();
  return value && GTM_ID_PATTERN.test(value) ? value : null;
}

export function subscribeToAnalyticsConsent(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onStorage = (event: StorageEvent) => {
    if (event.key === ANALYTICS_CONSENT_STORAGE_KEY) listener();
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(ANALYTICS_CONSENT_EVENT, listener);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(ANALYTICS_CONSENT_EVENT, listener);
  };
}

/**
 * The GTM loader uses this narrow signal so purchase can wait until its script
 * resource has loaded. It is deliberately not a GA4 delivery acknowledgement.
 */
export function isAnalyticsLoaderReady(): boolean {
  return analyticsLoaderReady;
}

export function subscribeToAnalyticsLoaderReadiness(listener: () => void): () => void {
  analyticsLoaderReadyListeners.add(listener);
  return () => analyticsLoaderReadyListeners.delete(listener);
}

export function markAnalyticsLoaderReady(): void {
  if (analyticsLoaderReady) return;
  analyticsLoaderReady = true;
  for (const listener of analyticsLoaderReadyListeners) listener();
}

export function resetAnalyticsLoaderReadiness(): void {
  analyticsLoaderReady = false;
}

export function pushAnalyticsConsentDefault(): void {
  pushGtagConsentCommand("default", {
    analytics_storage: "denied",
    ad_storage: "denied",
    ad_user_data: "denied",
    ad_personalization: "denied",
  });
}

export function pushAnalyticsConsentUpdate(granted: boolean): void {
  const analyticsState: ConsentState = granted ? "granted" : "denied";
  // Ad signals follow the banner's separate marketing consent, read at push
  // time so a preference change between updates can never leak a stale grant.
  // A revoked/private-route update (granted=false) always denies all four.
  const adState: ConsentState =
    granted && readCookieConsent()?.marketing === true ? "granted" : "denied";
  pushGtagConsentCommand("update", {
    analytics_storage: analyticsState,
    ad_storage: adState,
    ad_user_data: adState,
    ad_personalization: adState,
  });
}

export function pushAnalyticsEvent<K extends AnalyticsEventName>(
  event: K,
  properties: AnalyticsEventMap[K],
): boolean {
  if (
    typeof window === "undefined" ||
    !configuredGtmId() ||
    !hasAnalyticsConsent()
  ) {
    return false;
  }

  const w = window as WindowWithDataLayer;
  if (!w.dataLayer) {
    w.dataLayer = [];
    // A product effect may run before the global loader effect. Seed consent
    // ahead of that event so GTM can never process it under an implicit state.
    pushAnalyticsConsentDefault();
    pushAnalyticsConsentUpdate(true);
  }
  w.dataLayer.push({
    event: `${TRANSPORT_PREFIX}${event}`,
    ...properties,
  });
  // This confirms only synchronous acceptance by the local dataLayer array.
  // It does not confirm that GTM, GA4, or the network delivered the event.
  return true;
}

/**
 * Attempt the private deployment projection and the optional consent-gated
 * projection independently. The booleans confirm synchronous local admission
 * only; neither is a transport or business acknowledgement.
 */
export function emitAnalyticsEvent<K extends AnalyticsEventName>(
  event: K,
  properties: AnalyticsEventMap[K],
  attempts: AnalyticsSinkAttemptMask = { deployment: true, optional: true },
): AnalyticsSinkAdmission {
  let deployment = false;
  let optional = false;

  if (attempts.deployment) {
    try {
      deployment = trackDeploymentEvent(event, properties);
    } catch {
      // One analytics sink must never suppress another sink or product action.
    }
  }

  if (attempts.optional) {
    try {
      optional = pushAnalyticsEvent(event, properties);
    } catch {
      // Local analytics admission is best-effort and fail-open for the product.
    }
  }

  return { deployment, optional };
}

function pushGtagConsentCommand(
  action: "default" | "update",
  settings: Record<string, ConsentState>,
): void {
  const w = window as WindowWithDataLayer;
  if (!w.dataLayer) return;
  function gtag(..._args: unknown[]) {
    // Google Tag/Consent Mode consumes the array-like `arguments` object used
    // by the canonical gtag snippet, not an ordinary product-event object.
    // eslint-disable-next-line prefer-rest-params
    w.dataLayer?.push(arguments);
  }
  gtag("consent", action, settings);
}
