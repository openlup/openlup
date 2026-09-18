/**
 * ⛔ THE ONLY `navigator.userAgent` READ IN `src/`, on purpose: a user agent is a
 * fingerprinting surface, so it is sniffed in one place for one decision and the
 * string is never stored, reported, or returned to a caller.
 */

/**
 * Markers every embedded webview we have measured puts in its user agent.
 * Vendor-neutral prose everywhere else; these three tokens ARE the signal, so
 * they are literals rather than a description of literals.
 */
const IN_APP_BROWSER_MARKERS = ["FBAN/", "FB_IAB/", "Instagram"] as const;

/**
 * Is this page running inside another application's embedded browser rather
 * than a real one? True is a hint, never an authorization: the only thing it
 * decides is whether the buyer is offered a way out to a real browser.
 */
export function isInAppBrowser(
  userAgent = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  return IN_APP_BROWSER_MARKERS.some((marker) => userAgent.includes(marker));
}
