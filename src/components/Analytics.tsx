import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";
import { trackDeploymentEvent } from "#deployment-analytics";

import {
  configuredGtmId,
  hasAnalyticsConsent,
  markAnalyticsLoaderReady,
  pushAnalyticsConsentDefault,
  pushAnalyticsConsentUpdate,
  pushAnalyticsEvent,
  readCookieConsent,
  resetAnalyticsLoaderReadiness,
  subscribeToAnalyticsConsent,
} from "@/lib/analytics/dataLayer";
import { isGtmAnalyticsRouteEligible } from "@/lib/analytics/routePolicy";

/**
 * Single public analytics owner.
 *
 * GTM is injected only on a public route after explicit analytics-cookie
 * consent. Product events observed before consent are discarded by the shared
 * dataLayer seam and are never replayed. Consent changes are propagated to the
 * already loaded container so native measurements stop on private routes and
 * after revocation.
 */

type WindowWithDataLayer = Window & {
  dataLayer?: unknown[];
};

const GTM_MAX_LOAD_ATTEMPTS = 3;
const GTM_RETRY_DELAYS_MS = [250, 1_000];

type GtmLoadState = "idle" | "loading" | "ready" | "failed";

interface GtmLoader {
  gtmId: string | null;
  state: GtmLoadState;
  attempts: number;
  script: HTMLScriptElement | null;
  retryTimer: number | null;
}

function createGtmLoader(): GtmLoader {
  return {
    gtmId: null,
    state: "idle",
    attempts: 0,
    script: null,
    retryTimer: null,
  };
}

function loadGtm(loader: GtmLoader, gtmId: string, canLoad: () => boolean): void {
  if (!canLoad()) return;
  if (loader.gtmId && loader.gtmId !== gtmId) cancelGtmLoading(loader);
  loader.gtmId = gtmId;

  if (loader.state === "ready") {
    pushAnalyticsConsentUpdate(true);
    markAnalyticsLoaderReady();
    return;
  }
  if (loader.state === "loading" || loader.retryTimer !== null) return;
  if (loader.state === "failed" && loader.attempts >= GTM_MAX_LOAD_ATTEMPTS) return;

  const existingScript = findGtmScript(gtmId);
  if (existingScript) {
    if (existingScript.dataset.gtmReady === "true") {
      loader.script = existingScript;
      loader.state = "ready";
      pushAnalyticsConsentUpdate(true);
      markAnalyticsLoaderReady();
    }
    return;
  }

  const w = window as WindowWithDataLayer;
  w.dataLayer = w.dataLayer || [];
  if (!w.dataLayer.some(isGtagConsentDefaultMessage)) pushAnalyticsConsentDefault();
  pushAnalyticsConsentUpdate(true);
  if (!w.dataLayer.some(isGtmStartMessage)) {
    w.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
  }

  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${gtmId}`;
  loader.state = "loading";
  loader.attempts += 1;
  loader.script = script;
  resetAnalyticsLoaderReadiness();
  script.onload = () => {
    if (loader.script !== script) return;
    if (!canLoad()) {
      cancelGtmLoading(loader);
      return;
    }
    script.dataset.gtmReady = "true";
    loader.state = "ready";
    markAnalyticsLoaderReady();
  };
  script.onerror = () => {
    if (loader.script !== script) return;
    script.remove();
    loader.script = null;
    loader.state = "failed";
    resetAnalyticsLoaderReadiness();
    if (!canLoad() || loader.attempts >= GTM_MAX_LOAD_ATTEMPTS) return;
    const retryDelay = GTM_RETRY_DELAYS_MS[loader.attempts - 1] ??
      GTM_RETRY_DELAYS_MS[GTM_RETRY_DELAYS_MS.length - 1] ?? 0;
    loader.retryTimer = window.setTimeout(() => {
      loader.retryTimer = null;
      if (!canLoad()) return;
      loader.state = "idle";
      loadGtm(loader, gtmId, canLoad);
    }, retryDelay);
  };
  document.head.appendChild(script);
}

function cancelGtmLoading(loader: GtmLoader): void {
  if (loader.retryTimer !== null) window.clearTimeout(loader.retryTimer);
  loader.retryTimer = null;
  if (loader.state === "loading" && loader.script) {
    loader.script.onload = null;
    loader.script.onerror = null;
    loader.script.remove();
    loader.script = null;
  }
  if (loader.state !== "ready") {
    loader.state = "idle";
    loader.attempts = 0;
  }
  resetAnalyticsLoaderReadiness();
}

function findGtmScript(gtmId: string): HTMLScriptElement | null {
  return document.querySelector<HTMLScriptElement>(
    `script[src*="googletagmanager.com/gtm.js?id=${gtmId}"]`,
  );
}

function isGtmStartMessage(value: unknown): boolean {
  return Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { event?: unknown }).event === "gtm.js";
}

function isGtagConsentDefaultMessage(value: unknown): boolean {
  if (!value || typeof value !== "object" || !("length" in value)) return false;
  const command = Array.from(value as ArrayLike<unknown>);
  return command[0] === "consent" && command[1] === "default";
}

const Analytics = () => {
  const { pathname } = useLocation();
  const excludedPath = !isGtmAnalyticsRouteEligible(pathname);
  const lastPageViewPathRef = useRef<string | null>(null);
  const loaderRef = useRef<GtmLoader | null>(null);
  const canLoadRef = useRef<() => boolean>(() => false);
  if (!loaderRef.current) loaderRef.current = createGtmLoader();
  canLoadRef.current = () => !excludedPath && hasAnalyticsConsent(readCookieConsent());

  useEffect(() => () => cancelGtmLoading(loaderRef.current!), []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    const loader = loaderRef.current!;

    const pushCurrentPageView = () => {
      if (
        !excludedPath &&
        lastPageViewPathRef.current !== pathname &&
        pushAnalyticsEvent("page_view", { page_path: pathname })
      ) {
        lastPageViewPathRef.current = pathname;
      }
    };
    const syncConsent = () => {
      const granted = !excludedPath && hasAnalyticsConsent(readCookieConsent());
      const w = window as WindowWithDataLayer;
      if (!granted) {
        lastPageViewPathRef.current = null;
        cancelGtmLoading(loader);
        if (w.dataLayer) pushAnalyticsConsentUpdate(false);
        return;
      }
      const gtmId = configuredGtmId();
      if (!gtmId) {
        cancelGtmLoading(loader);
        return;
      }
      loadGtm(loader, gtmId, () => canLoadRef.current() && configuredGtmId() === gtmId);
      // Consent observes the page currently on screen; this is not a replay of
      // a pre-consent navigation and provides the funnel's landing denominator.
      pushCurrentPageView();
    };

    syncConsent();
    return subscribeToAnalyticsConsent(syncConsent);
  }, [pathname, excludedPath]);

  return null;
};

export default Analytics;

export function DeploymentAnalyticsRouteObserver() {
  const location = useLocation();
  const latestLocationRef = useRef(location);
  latestLocationRef.current = location;
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      const { pathname, search, hash } = latestLocationRef.current;
      const capturedUrl = new URL(`${pathname}${search}${hash}`, window.location.origin).href;
      trackDeploymentEvent("page_view", { page_path: capturedUrl });
    } catch {
      // Deployment analytics must never interrupt routing.
    }
  }, [location.pathname]);
  return null;
}
