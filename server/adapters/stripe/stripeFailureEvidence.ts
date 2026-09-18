import { isPaymentRetryAdviceCode, type PaymentRecoveryEvidence, type PaymentRecoveryMethod,
  type PaymentRecoveryOperation } from "@openlup/core/payment";
import { evidenceRecord, evidenceToken, failureEvidencePayload, serializeFailureEvidence,
  type FailureObservationSource, type PaymentFailureEvidence } from "../paymentFailureEvidence.js";

export interface StripeIntentLike {
  id: string;
  status: string;
  amount?: number | null;
  amount_received?: number | null;
  currency?: string | null;
  client_secret?: string | null;
  customer?: string | null;
  payment_method?: string | null;
  latest_charge?: string | null;
  next_action?: { type?: string | null } | null;
  last_payment_error?: {
    code?: string | null;
    message?: string | null;
    type?: string | null;
    decline_code?: string | null;
    advice_code?: string | null;
  } | null;
  /** Kept separate: populating legacy fine fields would change renewal classification. */
  diagnosticFailureEvidence?: PaymentFailureEvidence;
}

/** Reads only one current PaymentIntent/error, never an arbitrary historical Charge. */
export function stripeFailureEvidence(input: unknown, options: {
  source: FailureObservationSource;
  confirmedFailureEvent?: boolean;
  knownCardOnlyRequest?: boolean;
}): PaymentFailureEvidence | null {
  const object = evidenceRecord(input);
  const thrown = object.type === "StripeCardError";
  const intent = thrown ? evidenceRecord(object.payment_intent) : object;
  const error = thrown ? object : evidenceRecord(intent.last_payment_error);
  if (!thrown && !options.confirmedFailureEvent && Object.keys(error).length === 0) return null;
  const refusalVerified = thrown || options.confirmedFailureEvent === true
    || (intent.status === "requires_payment_method" && Object.keys(error).length > 0
      && (error.type === "card_error" || error.code === "card_declined" || Boolean(intent.latest_charge)));
  const errorMethod = evidenceRecord(error.payment_method);
  const currentMethod = evidenceRecord(intent.payment_method);
  const errorMethodId = typeof error.payment_method === "string" ? error.payment_method : errorMethod.id;
  const currentMethodId = typeof intent.payment_method === "string" ? intent.payment_method : currentMethod.id;
  const conflictingMethod = Boolean(errorMethodId && currentMethodId && errorMethodId !== currentMethodId)
    || Boolean(errorMethod.type && currentMethod.type && errorMethod.type !== currentMethod.type);
  const actualMethod = errorMethod.type ?? currentMethod.type;
  const cardContract = options.knownCardOnlyRequest === true
    || (Array.isArray(intent.payment_method_types) && intent.payment_method_types.length === 1
      && intent.payment_method_types[0] === "card");
  const flow = evidenceRecord(intent.metadata).providerFlow;
  const operation: PaymentRecoveryOperation | null = flow === "off_session_payment" ? "stored_method_payment"
    : intent.setup_future_usage === "off_session" ? "recurring_setup"
      : intent.setup_future_usage === null && flow === "one_time_payment" ? "one_time_payment" : null;
  const methodKind = actualMethod === "card" || actualMethod === "blik" ? actualMethod
    : actualMethod == null && cardContract ? "card" : null;
  const method: PaymentRecoveryMethod | null = methodKind
    ? { kind: methodKind, recoveryMethodKey: methodKind, interaction: operation === "stored_method_payment" ? "stored_instrument" : "new_instrument" } : null;
  const latestCharge = typeof intent.latest_charge === "string" ? intent.latest_charge : evidenceRecord(intent.latest_charge).id;
  const errorCharge = typeof error.charge === "string" ? error.charge : evidenceRecord(error.charge).id;
  // A last error tied to another charge cannot explain the currently observed charge.
  const conflictingEvidence = conflictingMethod || Boolean(latestCharge && errorCharge && latestCharge !== errorCharge);
  return serializeFailureEvidence({
    version: 1, source: options.source,
    disposition: conflictingEvidence ? "unreadable" : Object.keys(error).length ? "present" : "absent",
    refusalVerified: refusalVerified && !conflictingEvidence, providerPaymentId: evidenceToken(intent.id),
    providerChargeId: evidenceToken(errorCharge ?? latestCharge),
    code: conflictingEvidence ? null : evidenceToken(error.code),
    declineCode: conflictingEvidence ? null : evidenceToken(error.decline_code),
    adviceCode: conflictingEvidence ? null : evidenceToken(error.advice_code),
    adviceOrigin: "provider", operation: conflictingEvidence ? null : operation, method: conflictingEvidence ? null : method,
    methodSource: actualMethod != null ? "provider" : cardContract ? "execution_contract" : "unknown",
  });
}

const SAFE_CAUSES: Readonly<Record<string, PaymentRecoveryEvidence["cause"]>> = {
  insufficient_funds: "insufficient_funds", expired_card: "expired_card",
  incorrect_cvc: "invalid_payment_data", invalid_cvc: "invalid_payment_data",
  incorrect_number: "invalid_payment_data", invalid_number: "invalid_payment_data",
  invalid_expiry_month: "invalid_payment_data", invalid_expiry_year: "invalid_payment_data",
  authentication_required: "authentication_required",
  card_not_supported: "operation_unsupported", currency_not_supported: "operation_unsupported",
  transaction_not_allowed: "operation_unsupported",
};
const RESTRICTED = new Set(["fraudulent", "highest_risk_level", "lost_card", "stolen_card", "merchant_blacklist"]);

/** UI evidence only: does not call or alter the shared failure taxonomy. */
export function normalizeStripeFailureEvidence(input: PaymentFailureEvidence): PaymentRecoveryEvidence {
  const evidence = serializeFailureEvidence(input);
  const code = evidence.declineCode ?? evidence.code;
  const restricted = code !== null && RESTRICTED.has(code);
  const readable = evidence.refusalVerified && evidence.disposition === "present";
  // A refused BLIK registration names its operation, not a setup cause: no code
  // read here distinguishes a refused agreement from a mistyped or expired code.
  const cause = readable && !restricted && code && Object.hasOwn(SAFE_CAUSES, code)
    ? SAFE_CAUSES[code]! : "generic_decline";
  return {
    refusalVerified: evidence.refusalVerified, cause,
    certainty: cause === "generic_decline" ? "unknown" : "verified",
    disclosure: restricted ? "restricted" : "safe", method: evidence.method, operation: evidence.operation,
    advice: readable && evidence.adviceOrigin === "provider" && evidence.adviceCode !== null && isPaymentRetryAdviceCode(evidence.adviceCode)
      ? { code: evidence.adviceCode, scope: evidence.method?.kind === "card" ? "instrument" : "unknown" } : null,
  };
}

/** Preserve the existing webhook projection and append only failure diagnostics. */
export function stripeWebhookPayload(input: {
  eventId: string; eventType: string; providerPaymentId: string; amountMinor: number | null; currency: string | null;
}, object: unknown): Record<string, unknown> {
  return { provider: "stripe", ...input,
    ...(input.eventType === "payment_intent.payment_failed"
      ? failureEvidencePayload(stripeFailureEvidence(object, { source: "webhook", confirmedFailureEvent: true })) : {}),
  };
}
