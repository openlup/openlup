import { isLiveAttemptStatus, type PaymentAttemptStatus } from "./paymentControlTypes.js";
import type {
  PaymentRecoveryAction, PaymentRecoveryCandidate, PaymentRecoveryEvidence,
  PaymentRecoveryOperation,
} from "./paymentRecoveryContracts.js";

/** @beta */
export interface PaymentRecoveryAttempt {
  id: string;
  status: PaymentAttemptStatus;
  evidence: PaymentRecoveryEvidence | null;
}
/** @beta */
export interface PaymentRecoveryGuidance extends PaymentRecoveryEvidence {
  version: 1;
  paymentAttemptId: string;
  consecutiveRefusals: 0 | 1 | 2 | null;
  emphasis: "normal" | "recommended";
  actions: readonly PaymentRecoveryAction[];
}

/** Only an authoritative failed attempt can become refusal guidance. @beta */
export function derivePaymentRecoveryGuidance(input: {
  paymentState: "failed" | "paid" | "pending" | "expired";
  activeAttemptId: string | null;
  /** Newest first, ordered by durable creation identity; never browser clicks. */
  attempts: readonly PaymentRecoveryAttempt[];
  historyComplete: boolean;
}): PaymentRecoveryGuidance | null {
  if (input.paymentState !== "failed" || !input.activeAttemptId) return null;
  if (input.attempts.some((attempt) => attempt.status === "succeeded")) return null;
  const current = input.attempts.find((attempt) => attempt.id === input.activeAttemptId);
  if (!current || current.status !== "failed" || !current.evidence?.refusalVerified) return null;
  // A later local attempt makes this a stale observation even if a caller picked it.
  if (input.attempts[0]?.id !== current.id) return null;
  const evidence = safeEvidence(current.evidence);
  const count = evidence.cause !== "generic_decline" ? 0
    : refusalStreak(input.attempts, evidence.method?.recoveryMethodKey, input.historyComplete);
  const actions: PaymentRecoveryAction[] = evidence.cause === "expired_card"
    ? ["change_instrument", "change_method"]
    : evidence.cause === "invalid_payment_data" ? ["correct_data", "change_method"]
    : evidence.cause === "authentication_required" ? ["authenticate", "change_method"]
    : ["change_instrument", "change_method"];
  if (evidence.advice?.code === "do_not_try_again" && evidence.advice.scope === "method") {
    actions.splice(0, actions.length, "change_method");
  }
  return { ...evidence, version: 1, paymentAttemptId: current.id,
    consecutiveRefusals: count, emphasis: count === 2 ? "recommended" : "normal", actions };
}

function safeEvidence(evidence: PaymentRecoveryEvidence): PaymentRecoveryEvidence {
  return evidence.disclosure === "restricted" || evidence.certainty !== "verified"
    ? { ...evidence, cause: "generic_decline", certainty: "unknown" } : evidence;
}

function refusalStreak(
  attempts: readonly PaymentRecoveryAttempt[], methodKey: string | undefined, complete: boolean,
): 1 | 2 | null {
  if (!methodKey) return null;
  let count = 0;
  const seen = new Set<string>();
  for (const attempt of attempts) {
    if (seen.has(attempt.id)) continue;
    seen.add(attempt.id);
    if (isLiveAttemptStatus(attempt.status) || ["blocked_preflight", "cancelled", "expired"].includes(attempt.status)) continue;
    const evidence = attempt.evidence;
    if (!evidence?.refusalVerified || !evidence.method) return null;
    if (safeEvidence(evidence).cause !== "generic_decline" || evidence.method.recoveryMethodKey !== methodKey) {
      return count > 0 ? 1 : null;
    }
    count += 1;
    if (count >= 2) return 2;
  }
  return complete && count === 1 ? 1 : null;
}

/** Filter with currently implemented, eligible choices; this never enables a rail. @beta */
export function availablePaymentRecoveryActions(
  guidance: PaymentRecoveryGuidance,
  candidates: readonly PaymentRecoveryCandidate[],
  operation: PaymentRecoveryOperation,
): PaymentRecoveryAction[] {
  const available = new Set<PaymentRecoveryAction>();
  for (const candidate of candidates) {
    if (candidate.capability !== "supported" || !candidate.available || candidate.operation !== operation) continue;
    for (const action of candidate.actions) {
      if (!guidance.actions.includes(action)) continue;
      const sameChoice = candidate.method.recoveryMethodKey === guidance.method?.recoveryMethodKey;
      if (action === "change_method" && sameChoice) continue;
      if (action === "change_instrument" && (!sameChoice || candidate.method.interaction !== "new_instrument")) continue;
      available.add(action);
    }
  }
  return available.size ? [...available] : ["contact_support"];
}
