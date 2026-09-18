/**
 * Fire-and-forget report of a checkout dead end the browser can see and the
 * server cannot, and of the cookie consent prompt being shown and answered.
 *
 * PRIVACY — this module sends NO PERSONAL DATA and needs no cookie consent.
 * The entire payload is two enum values from the lists below: 203 possible
 * requests in total (7 stages x 29 codes). No order id, client id, visitor id, session id, email,
 * address, message, stack, or user agent is read, derived, or transmitted, and
 * no cookie or storage key is written. That is why it may run before any
 * consent decision has been made — there is nothing to consent to. Adding a
 * field that identifies a person or a session changes that answer completely
 * and is an OWNER decision, not a code change (see
 * `docs/platform/RUNTIME_AND_SELF_HOSTING.md`).
 *
 * ⛔ TELEMETRY MUST NEVER BREAK THE CHECKOUT. Every call site here fires while
 * the purchase is ALREADY failing — the moment with the least margin left. So
 * nothing here throws, nothing rejects, nothing is awaited, and this file has
 * NO IMPORTS AT ALL, so it cannot drag a failing dependency onto the payment
 * path. A transport that is missing, blocked by a content policy, or refused by
 * a webview is indistinguishable from success, deliberately: the buyer's
 * checkout is worth more than the report about it.
 */

/**
 * Where in the checkout the browser gave up, or which consent prompt form the
 * visitor saw (`consent_mobile` below Tailwind `md`, `consent_desktop` from it).
 * Vendor-neutral by design.
 */
export const CHECKOUT_CLIENT_EVENT_STAGES = [
  "psp_loader",
  "payment_form",
  "quote_gate",
  "route_error",
  "escape_hatch",
  "consent_mobile",
  "consent_desktop",
] as const;

/**
 * What the browser saw. Every value has exactly one producer.
 *
 * ⛔ THE ORDER AND THE MEMBERS ARE PINNED against the server's copy by
 * `server/bff/commerce/checkout-client-event.test.ts`, in both directions. Drift
 * makes the browser POST something the route 400s, the client swallows the
 * refusal exactly as designed, and the report vanishes without a trace — the
 * same silence this whole module exists to end. Add to BOTH lists or neither.
 *
 * `payment_step_abandoned` .. `psp_confirm_no_response` answer the question the
 * 2026-08-27 card dead-end report could not: the buyer reached the payment step
 * and left, and every server-side row looked healthy. Two of them describe the
 * shape of the departure (the tab went away; the buyer went backwards), one
 * describes a submit we refused ourselves with a 409, and one describes a
 * confirmation call that came back with nothing.
 *
 * The next thirteen answer the 2026-09-02 report, which was worse: nine card
 * checkouts failed and NOT ONE of them reached the provider — no payment method
 * attached, no error, nothing to reconcile from. Everything before
 * `wallet_row_shown` brackets that seam step by step (the fields painted, the
 * confirm call started, the confirm call came back), and the `escape_hatch`
 * codes count the way out we now offer the buyers it happened to, from the offer
 * to the payment finished somewhere else. None of them can carry who it was —
 * see the privacy note above.
 *
 * The last four are the cookie consent prompt (`CookieBanner`, the sole
 * producer): shown once per document, and which of the three answers closed it.
 * Aggregate counts only; they cannot say who answered.
 */
export const CHECKOUT_CLIENT_EVENT_CODES = [
  "psp_js_load_failed",
  "psp_js_load_timeout",
  "payment_element_not_ready",
  "submit_blocked_quote_refreshing",
  "forced_return_to_summary",
  "render_crash",
  "payment_step_abandoned",
  "payment_step_exited_back",
  "submit_rejected_conflict",
  "psp_confirm_no_response",
  "element_ready",
  "confirm_started",
  "confirm_returned_error",
  "confirm_returned_status",
  "wallet_row_shown",
  "wallet_row_hidden",
  "submit_disabled_tap",
  "psp_js_load_ok",
  "shown",
  "requested",
  "sent",
  "landed_in_browser",
  "paid_in_browser",
  "recommendation_shown",
  "recommendation_selected",
  "prompt_shown",
  "accepted_all",
  "rejected_non_essential",
  "preferences_saved",
] as const;

export type CheckoutClientEventStage = (typeof CHECKOUT_CLIENT_EVENT_STAGES)[number];
export type CheckoutClientEventCode = (typeof CHECKOUT_CLIENT_EVENT_CODES)[number];

export const CHECKOUT_CLIENT_EVENT_PATH = "/api/bff/commerce/checkout-client-event";

/**
 * One report per `(stage, code)` per page session.
 *
 * Without it a React error boundary that re-renders, or a loader whose status
 * effect re-runs, turns one dead end into a request loop — from a browser that
 * is already in trouble, aimed at an unauthenticated endpoint. The dedup is
 * module-level rather than per-hook precisely because the failing surfaces
 * remount: a per-component guard would reset with them and report nothing about
 * the second mount except that it happened again.
 */
const reported = new Set<string>();

/** Test-only reset of the per-session dedup. */
export function resetCheckoutClientEventDedupForTests(): void {
  reported.clear();
}

export function reportCheckoutClientEvent(
  stage: CheckoutClientEventStage,
  code: CheckoutClientEventCode,
): void {
  try {
    const key = `${stage}:${code}`;
    if (reported.has(key)) return;
    reported.add(key);
    send(JSON.stringify({ stage, code }));
  } catch {
    // See the module docblock: silence is the contract.
  }
}

function send(body: string): void {
  // `sendBeacon` first because it is the only transport that survives the page
  // going away — and "the buyer gave up and closed the tab" is one of the
  // outcomes worth counting. It reports refusal by RETURNING FALSE rather than
  // throwing, so the return value has to be read for the fallback to exist.
  if (typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
    const blob = new Blob([body], { type: "application/json" });
    if (navigator.sendBeacon(CHECKOUT_CLIENT_EVENT_PATH, blob)) return;
  }

  if (typeof fetch !== "function") return;
  // `keepalive` buys the fallback the one property `sendBeacon` had: the request
  // outlives the document. `.catch` is not optional — an unhandled rejection
  // from a telemetry call is exactly the kind of noise that gets blamed on the
  // checkout it was reporting about.
  void fetch(CHECKOUT_CLIENT_EVENT_PATH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined);
}
