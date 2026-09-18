import type { AnalyticsPort } from "../../domains/platform-runtime/ports.js";

/**
 * Google Tag Manager adapter for the `AnalyticsPort`. Pushes events onto the GTM
 * `dataLayer`, mirroring the consent-gated dataLayer wiring already shipped in
 * `src/components/Analytics.tsx` (which loads the GTM script). This adapter does
 * NOT load the script or change consent behavior — it is the provider-neutral
 * push seam used once a bundle binds `analytics: gtm`.
 */

type DataLayerEvent = {
  event?: string;
  [key: string]: unknown;
};

type BrowserWithDataLayer = {
  dataLayer?: DataLayerEvent[];
};

function pushDataLayer(event: DataLayerEvent): void {
  const browser = (globalThis as typeof globalThis & { window?: BrowserWithDataLayer }).window;
  if (!browser) return;
  browser.dataLayer = browser.dataLayer || [];
  browser.dataLayer.push(event);
}

export function createGtmAnalytics(): AnalyticsPort {
  return {
    trackPageView(pathname: string) {
      pushDataLayer({ event: "page_view", page_path: pathname });
    },
    trackEvent(name: string, properties?: Record<string, unknown>) {
      pushDataLayer({ event: name, ...(properties ?? {}) });
    },
  };
}
