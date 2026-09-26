import siteRoutesManifest from "../../../config/site-routes.json" with { type: "json" };

export const TPAY_SANDBOX_OPEN_API_BASE_URL = "https://openapi.sandbox.tpay.com";
export const TPAY_PRODUCTION_OPEN_API_BASE_URL = "https://api.tpay.com";
export const TPAY_SANDBOX_JWS_ROOT_CERT_URL = "https://secure.sandbox.tpay.com/x509/tpay-jws-root.pem";
export const TPAY_SANDBOX_JWS_CERT_PREFIX = "https://secure.sandbox.tpay.com/";
export const TPAY_PRODUCTION_JWS_ROOT_CERT_URL = "https://secure.tpay.com/x509/tpay-jws-root.pem";
export const TPAY_PRODUCTION_JWS_CERT_PREFIX = "https://secure.tpay.com/";

export function isTpaySandboxOpenApiBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "openapi.sandbox.tpay.com";
  } catch {
    return false;
  }
}

export function isTpayProductionOpenApiBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === "https:" && url.hostname === "api.tpay.com";
  } catch {
    return false;
  }
}

/**
 * Canonical production callback host allow-list for live Tpay settlement.
 *
 * Real Tpay notification/success/error URLs must resolve directly to a canonical
 * production host over HTTPS — never a preview hostname and never a host that
 * 301/302-redirects, because Tpay POSTs the JWS-signed notification and a redirect
 * would drop the body (the settlement would silently never arrive). The operator
 * configures productionHosts in config/site-routes.json and confirms each
 * registered callback host does not redirect. An empty allow-list refuses all URLs.
 */
export function isCanonicalTpayProductionCallbackUrl(
  value: string,
  productionHosts: readonly string[] = siteRoutesManifest.productionHosts,
): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password
      && productionHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase());
  } catch {
    return false;
  }
}
