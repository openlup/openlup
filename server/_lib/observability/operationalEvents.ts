export type OperationalEventName =
  | "public_tester_signup_consent_rejected"
  | "customer_self_service_idempotency_replay"
  | "customer_self_service_unique_violation_replay"
  | "commerce_promotion_acceptance_outcome"
  | "provider_payment_unmatched_out_of_band"
  | "provider_payment_result_after_terminal_intent"
  | "provider_payment_result_attempt_mismatch"
  | "payment_decline_terminal"
  | "checkout_client_event";

export interface OperationalEvent {
  name: OperationalEventName;
  domain: "clients" | "commerce" | "customers" | "payment";
  surface: "public" | "hidden" | "customer" | "webhook";
  details?: Record<string, string | number | boolean | null | undefined>;
}

export type OperationalEventRecorder = (event: OperationalEvent) => void;

// Allowlist of safe, non-PII detail keys. `provider`, `providerPaymentId`,
// `resultStatus`, `amountMinor`, `currency`, and `occurredAt` carry the
// out-of-band reconciliation signal — all opaque/scalar, never customer PII.
//
// `failureClass` and `failureReason` carry the terminal-decline signal. Both are
// codes from closed vocabularies — the neutral failure taxonomy and the stable
// reason keys in `finalizeDeclinedAttempt` — never the provider's own prose,
// which is free-form text that can name the payer.
//
// `clientEventCode` pairs with the already-present `stage` to carry
// `checkout_client_event`: two values from the closed enums in
// `server/bff/commerce/checkout-client-event.ts`, and nothing else. That route is
// public and unauthenticated, so this allowlist is the second lock on a payload
// the schema has already refused to widen.
//
// ⛔ It is NOT spelled `code`, and the ugliness is the point. This allowlist is
// GLOBAL across every event name, and `commerce_promotion_acceptance_outcome`
// relies on `code` being absent from it: for that event `code` is the raw
// promotion code a customer typed, which is exactly what must never reach a log
// drain. Allowing the bare key here to spare this one event a longer name would
// silently open that door for the other. The route still accepts `code` on the
// wire; only the recorded key is qualified.
const OPERATIONAL_EVENT_DETAIL_KEYS = new Set([
  "eventType",
  "reason",
  "clientEventCode",
  "provider",
  "providerPaymentId",
  "resultStatus",
  "failureClass",
  "failureReason",
  "amountMinor",
  "currency",
  "occurredAt",
  "stage",
  "outcome",
  "keySlot",
  "purchaseScope",
  "expiryBucket",
  "promotionEngineVersion",
  "mismatchField",
]);

// A few allowlisted keys carry a closed vocabulary rather than any scalar. The
// key alone is not enough for them: `mismatchField` names which section of the
// bound promotion money projection diverged, and a caller that ever passed a
// free-form string there would put quote content into a log drain. Values
// outside the set are dropped exactly like a non-allowlisted key.
//
// ⛔ The literals are duplicated from PROMOTION_QUOTE_MISMATCH_FIELDS in
// server/domains/commerce/promotionQuoteBinding.ts on purpose — this module is
// the platform observability floor and must not import a commerce domain — and
// operationalEvents.test.ts pins the two lists equal.
const OPERATIONAL_EVENT_DETAIL_VALUES = new Map<string, ReadonlySet<string>>([
  ["mismatchField", new Set(["lines", "discounts", "shipping", "totals", "currency", "other"])],
]);

export const noopOperationalEventRecorder: OperationalEventRecorder = () => undefined;

export const consoleOperationalEventRecorder: OperationalEventRecorder = (event) => {
  console.info(JSON.stringify(sanitizeOperationalEvent(event)));
};

export function sanitizeOperationalEvent(event: OperationalEvent) {
  return {
    event: "operational_event",
    name: event.name,
    domain: event.domain,
    surface: event.surface,
    details: sanitizeDetails(event.details ?? {}),
  };
}

function sanitizeDetails(details: Record<string, string | number | boolean | null | undefined>) {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details)) {
    if (!OPERATIONAL_EVENT_DETAIL_KEYS.has(key) || value === undefined) continue;
    const allowedValues = OPERATIONAL_EVENT_DETAIL_VALUES.get(key);
    if (allowedValues && (typeof value !== "string" || !allowedValues.has(value))) continue;
    safe[key] = sanitizeValue(value);
  }
  return safe;
}

function sanitizeValue(value: string | number | boolean | null): string | number | boolean | null {
  if (typeof value !== "string") return value;
  if (value.includes("@")) return "redacted";
  return value.slice(0, 120);
}
