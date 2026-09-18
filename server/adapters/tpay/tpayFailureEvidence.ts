import type { PaymentRecoveryEvidence, PaymentRecoveryMethod, PaymentRecoveryOperation } from "@openlup/core/payment";
import { serializeFailureEvidence, type FailureObservationSource, type PaymentFailureEvidence } from "../paymentFailureEvidence.js";
import { assertableHints, type AttemptDeclineObservation } from "./tpayDeclineEvidence.js";
import type { DeclineCodeReading } from "./declineFailureHints.js";
import { classifyDecline } from "../../shared/finalizeDeclinedAttempt.js";

/** Known execution construction, never a conclusion drawn from the PSP name. */
function methodFor(flow: string | null): PaymentRecoveryMethod | null {
  if (flow === "blik_one_time" || flow === "blik_recurring_activation") {
    return { kind: "blik", recoveryMethodKey: "blik", interaction: "new_instrument" };
  }
  if (flow === "blik_one_click" || flow === "blik_recurring_saved") {
    return { kind: "blik", recoveryMethodKey: "blik_one_click", interaction: "stored_instrument" };
  }
  return flow === "pbl_one_time"
    ? { kind: "bank_transfer", recoveryMethodKey: "transfer", interaction: "new_instrument" } : null;
}

export function tpayFailureEvidence(input: {
  source: FailureObservationSource;
  providerPaymentId: string | null;
  refusalVerified: boolean;
  flow: string | null;
  observation: AttemptDeclineObservation;
  errorCode?: string | null;
  reading?: DeclineCodeReading;
}): PaymentFailureEvidence {
  const method = methodFor(input.flow);
  const advice = input.observation.identityMismatch ? null : input.reading?.adviceCode ?? null;
  const operation: PaymentRecoveryOperation | null = input.flow === "blik_recurring_activation"
    ? "recurring_setup" : method?.interaction === "stored_instrument"
      ? "stored_method_payment" : method ? "one_time_payment" : null;
  return serializeFailureEvidence({
    version: 1, source: input.source, disposition: input.observation.disposition,
    refusalVerified: input.refusalVerified, providerPaymentId: input.providerPaymentId, providerChargeId: null,
    code: input.errorCode ?? null, declineCode: input.observation.identityMismatch ? null : input.observation.code,
    adviceCode: advice,
    // This table is explicitly inferred; it must never masquerade as issuer advice.
    adviceOrigin: advice ? "inferred" : "unknown",
    operation, method, methodSource: method ? "execution_contract" : "unknown",
  });
}

/** Numeric code hypotheses are not promoted into new customer-facing facts. */
export function normalizeTpayFailureEvidence(input: PaymentFailureEvidence): PaymentRecoveryEvidence {
  const evidence = serializeFailureEvidence(input);
  // The operation is context, not a cause: a mistyped or expired BLIK code is
  // refused inside a mandate registration too. Only the persisted mandate
  // decision (`failure_reason`) may say the agreement itself was refused.
  return {
    refusalVerified: evidence.refusalVerified,
    cause: "generic_decline",
    certainty: "unknown", disclosure: "safe",
    method: evidence.method, operation: evidence.operation, advice: null,
  };
}

/** Existing reconciliation classification; moved intact, never fed new evidence. */
export function refusalCapture(refusal: { code: string; reading: DeclineCodeReading }, failureReasonKey: string): Record<string, unknown> {
  const hints = assertableHints(refusal.reading.hints, null) ?? [];
  const classification = classifyDecline({
    code: refusal.code,
    mandateUnsupported: false,
    declineCode: refusal.code,
    ...(refusal.reading.adviceCode ? { adviceCode: refusal.reading.adviceCode } : {}),
    ...(hints.length > 0 ? { neutralReasonHints: hints } : {}),
  }, { failureReasonKey });
  return {
    declineCode: refusal.code,
    adviceCode: refusal.reading.adviceCode ?? null,
    neutralReasonHints: hints,
    failureClass: classification.failureClass,
    failureClassDecidedBy: classification.decidedBy,
  };
}
