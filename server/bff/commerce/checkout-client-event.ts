import { z } from "zod";

import { withObservedRoute } from "../../_lib/observability/route.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError, sendMethodNotAllowed } from "../../_lib/bff/response.js";
import { consoleOperationalEventRecorder } from "../../_lib/observability/operationalEvents.js";

/**
 * The first-party sink for checkout failures the browser can see and we cannot.
 *
 * The 2026-08-26 webview report: a buyer stalled on the payment step inside an
 * in-app webview and NOT ONE REQUEST reached us. The dead end was invisible by
 * construction — every surface that could have reported it was the surface that
 * had failed. Waves P4+P5 gave the buyer something to look at; this route is
 * the other half, so the next occurrence leaves a mark here. The incident ID is
 * in `docs/platform/RUNTIME_AND_SELF_HOSTING.md`, deliberately not here: this file is
 * counted by the OSS brand ratchet and the ticket prefix is a brand token, which
 * is why every P4/P5 site names this incident by date too.
 *
 * ⛔ THE CONTRACT IS CLOSED ON PURPOSE AND MUST STAY CLOSED. The body is exactly
 * two fields, each drawn from a fixed vocabulary — 203 possible request bodies
 * in total (7 stages x 29 codes). There is no order id, client id, visitor id, session id, message,
 * stack, or user agent, and none may be added without an OWNER decision: this is
 * an UNAUTHENTICATED PUBLIC endpoint, so anything it accepts is something anyone
 * can write into our logs, and anything it accepts about a person is something
 * we then hold. The same discipline the runbook states for feedback upload
 * telemetry.
 *
 * Because of that closure there is no rate limiter here, and that is a decision
 * rather than an omission. Every limiter in `server/_lib/rate-limit/` is backed
 * by its own Supabase RPC and table, so reusing one is a schema change, not a
 * lighter mechanism. What an abuser can obtain from this route is log noise from
 * a 40-value cross product: no row is written, no provider is called, no email
 * is sent, no money moves, and no customer record is read. If production ever
 * shows flood volume the answer is an edge control and a monitor threshold, not
 * a table.
 *
 * The 2026-08-27 card report added four codes and no fields. The 2026-09-02 one
 * added thirteen codes and one stage, still no fields: nine card checkouts had
 * failed and NOT ONE of them reached the provider — no payment method attached,
 * no error — so the new vocabulary brackets that seam (the fields painted, the
 * confirm call started, the confirm call came back) and counts the escape hatch
 * offered to the buyers it happened to. That is the shape every future addition
 * must take: the vocabulary may grow, the CONTRACT may not. A widened cross
 * product costs log volume; a new field costs a decision about what we hold
 * about a person.
 */

/**
 * Where in the checkout the browser gave up, or which consent prompt form the
 * visitor saw. Vendor-neutral by design.
 *
 * The 2026-09-14 consent prompt added two stages and four codes, still no
 * fields: how often the prompt is shown and which answer closed it, per form.
 * That makes 203 possible request bodies (7 stages x 29 codes).
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
 * What the browser saw. Every value has exactly one producer in the client.
 *
 * ⛔ Pinned member-for-member and order-for-order against
 * `src/lib/telemetry/checkoutClientEvent.ts` by this route's own test. Adding a
 * code on one side only produces a 400 the browser is designed to swallow —
 * silent loss of exactly the reports this route was built to receive.
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

// `.strict()` is load-bearing, not stylistic: a permissive object would accept
// an extra field, and the very first extra field anyone adds under incident
// pressure is an identifier. Refusing unknown keys is what makes "no identifiers"
// a property of the route rather than a promise about the callers.
const checkoutClientEventSchema = z
  .object({
    stage: z.enum(CHECKOUT_CLIENT_EVENT_STAGES),
    code: z.enum(CHECKOUT_CLIENT_EVENT_CODES),
  })
  .strict();

/**
 * A valid body is under 80 bytes. The cap exists so a raw-string body cannot
 * make us spend parse time on something that could not possibly be valid.
 */
const MAX_BODY_BYTES = 256;

function handler(req: VercelRequest, res: VercelResponse): void {
  if (req.method !== "POST") {
    sendMethodNotAllowed(res, ["POST"]);
    return;
  }

  const parsed = checkoutClientEventSchema.safeParse(readBody(req));
  if (!parsed.success) {
    // ⛔ NO `details`. The route wrapper copies `details.reason` and
    // `details.supportCode` into the structured route log, and Zod's own issue
    // list quotes the offending value. Handing either one over would put the
    // rejected payload — the one thing this route must never retain — into the
    // drain, defeating the closed contract above. The status code is the whole
    // answer a caller gets, and the whole answer we keep.
    sendBffError(res, "BAD_REQUEST", "Unsupported checkout client event");
    return;
  }

  consoleOperationalEventRecorder({
    name: "checkout_client_event",
    domain: "commerce",
    surface: "public",
    // `clientEventCode`, not `code`: the recorder's detail allowlist is global,
    // and `code` is deliberately absent from it because for
    // `commerce_promotion_acceptance_outcome` that key is the raw promotion code
    // a customer typed. See the note in `operationalEvents.ts`.
    details: { stage: parsed.data.stage, clientEventCode: parsed.data.code },
  });

  // 204: there is nothing to say back. A body would only invite a caller to
  // start depending on one, and `sendBeacon` discards the response anyway.
  res.status(204).end();
}

function readBody(req: VercelRequest): unknown {
  const body = req.body;
  if (typeof body !== "string") return body;
  if (body.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

export default withObservedRoute({
  route: "/api/bff/commerce/checkout-client-event",
  domain: "commerce",
  surface: "public",
  risk: "validation_mutation",
}, handler);
