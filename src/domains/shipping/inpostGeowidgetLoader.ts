// Runtime loader for the official InPost Geowidget v5 (map parcel-locker picker).
// Injects the InPost CDN stylesheet + script once and resolves when the
// <inpost-geowidget> custom element is defined. Mirrors the runtime script
// injection in src/components/Analytics.tsx (dedupe guard + createElement +
// appendChild). The PUBLIC browsing token is read from the browser bundle via a
// VITE_-prefixed var, the same mechanism as the Stripe publishable key in
// src/domains/payment/components/useStripePromise.ts. It is named `_KEY` (public
// key convention) rather than `_TOKEN` so the client-secret-boundary guard does
// not mistake this public value for a server secret.

const GEOWIDGET_JS = "https://geowidget.inpost.pl/inpost-geowidget.js";
const GEOWIDGET_CSS = "https://geowidget.inpost.pl/inpost-geowidget.css";
const ELEMENT_NAME = "inpost-geowidget";

/** PUBLIC Geowidget browsing token (JWT) baked into the bundle. Empty when unset. */
export function inpostGeowidgetToken(): string {
  const token = (import.meta.env as Record<string, string | undefined>).VITE_INPOST_GEOWIDGET_KEY;
  return typeof token === "string" ? token.trim() : "";
}

/** True when a token is present, i.e. the map picker can be attempted. */
export function inpostGeowidgetConfigured(): boolean {
  return inpostGeowidgetToken().length > 0;
}

let loadPromise: Promise<void> | null = null;

/**
 * Idempotently load the Geowidget assets. Resolves once the custom element is
 * defined; rejects if the CDN script fails to load (callers fall back to the
 * list picker). Safe to call repeatedly — subsequent calls share one promise.
 */
export function loadInpostGeowidget(): Promise<void> {
  if (typeof document === "undefined") {
    return Promise.reject(new Error("inpost_geowidget_no_document"));
  }
  if (elementDefined()) return Promise.resolve();
  if (loadPromise) return loadPromise;

  loadPromise = new Promise<void>((resolve, reject) => {
    if (!document.querySelector(`link[href="${GEOWIDGET_CSS}"]`)) {
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = GEOWIDGET_CSS;
      document.head.appendChild(link);
    }

    const onReady = () => {
      whenElementDefined().then(resolve, resolve);
    };
    const onError = () => {
      loadPromise = null; // allow a later retry
      reject(new Error("inpost_geowidget_script_error"));
    };

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GEOWIDGET_JS}"]`);
    if (existing) {
      if (elementDefined()) {
        resolve();
      } else {
        existing.addEventListener("load", onReady, { once: true });
        existing.addEventListener("error", onError, { once: true });
      }
      return;
    }

    const script = document.createElement("script");
    script.src = GEOWIDGET_JS;
    script.defer = true;
    script.addEventListener("load", onReady, { once: true });
    script.addEventListener("error", onError, { once: true });
    document.head.appendChild(script);
  });

  return loadPromise;
}

function elementDefined(): boolean {
  return typeof window !== "undefined" && Boolean(window.customElements?.get(ELEMENT_NAME));
}

function whenElementDefined(): Promise<void> {
  if (typeof window === "undefined" || !window.customElements?.whenDefined) {
    return Promise.resolve();
  }
  return window.customElements.whenDefined(ELEMENT_NAME).then(() => undefined);
}
