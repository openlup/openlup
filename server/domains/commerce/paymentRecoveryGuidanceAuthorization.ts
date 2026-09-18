import { derivePaymentRecoveryGuidance, type PaymentRecoveryAttempt } from "@openlup/core/payment";
import { deriveAsyncCheckoutStatus } from "../../../src/domains/commerce/paymentStatus.js";
import type { PaymentStatusContinuationRequest } from "../../../src/domains/commerce/paymentContinuationContracts.js";
import type { CheckoutPaymentRecoveryGuidance } from "../../../src/domains/commerce/paymentRecoveryGuidanceContracts.js";
import type { PaymentStatusSnapshot } from "./commercePaymentStatusHandler.js";
import type { CheckoutPaymentContinuationClaims } from "./checkoutPaymentContinuationCredential.js";
import type { CheckoutRecoveryTokenPort } from "./checkoutRecoveryToken.js";
import { displayReasonFor } from "../../adapters/paymentFailureDisplay.js";

interface PaymentRecoverySnapshotAttempt extends PaymentRecoveryAttempt {
  /** Exact server-owned execution provenance for conservative legacy fallback. */
  provider?: string;
  providerFlow?: string | null;
}

export interface PaymentRecoverySnapshot extends PaymentStatusSnapshot {
  eligible: boolean;
  purchaseContext: "one_time" | "subscription_initial" | null;
  /** Raw lifecycle state from the same atomic snapshot; mutation gates must not infer it from presentation state. */
  subscriptionStatus: string | null;
  tokenAuthorized: boolean;
  historyComplete: boolean;
  /** Durable provider success exists anywhere on this exact payment aggregate. */
  observedSuccess: boolean;
  attempts: PaymentRecoverySnapshotAttempt[];
}
export interface PaymentRecoverySnapshotPort {
  getGuidanceSnapshot(input: { orderId: string; paymentIntentId: string; recoveryTokenId?: string }): Promise<PaymentRecoverySnapshot | null>;
}
export interface PaymentRecoveryReadDeps {
  port: PaymentRecoverySnapshotPort;
  tokenPort?: Pick<CheckoutRecoveryTokenPort, "validate">;
}

/** Missing optional infrastructure fails back to the old reader, never mixed reads. */
export async function readAuthorizedPaymentRecovery(input: {
  request: PaymentStatusContinuationRequest;
  claims: CheckoutPaymentContinuationClaims | null;
  authorization: unknown;
  deps: PaymentRecoveryReadDeps;
  now?: number;
}): Promise<{ snapshot: PaymentRecoverySnapshot; guidance: CheckoutPaymentRecoveryGuidance | null } | null> {
  const { request, claims, deps } = input;
  const cookieBound = Boolean(claims && claims.expiresAt > (input.now ?? Date.now()) / 1000
    && claims.orderId === request.orderId && claims.clientId === request.clientId
    && claims.paymentIntentId === request.paymentIntentId && claims.journeyId === request.journeyId);
  try {
    const raw = typeof input.authorization === "string" && input.authorization.length <= 2048
      ? /^Bearer (\S+)$/i.exec(input.authorization)?.[1] : undefined;
    const token = raw && deps.tokenPort ? await deps.tokenPort.validate(raw) : null;
    const tokenBound = token?.orderId === request.orderId && token?.clientId === request.clientId;
    if (!cookieBound && !tokenBound) return null;
    const snapshot = await deps.port.getGuidanceSnapshot({
      orderId: request.orderId, paymentIntentId: request.paymentIntentId,
      ...(tokenBound && token ? { recoveryTokenId: token.tokenId } : {}),
    });
    if (!snapshot) return null;
    const exact = snapshot.orderId === request.orderId && snapshot.paymentIntentId === request.paymentIntentId
      && snapshot.clientId === request.clientId;
    if (!exact) return null;
    const authorized = (cookieBound && snapshot.paymentAttemptId === claims?.paymentAttemptId
      && snapshot.provider === claims?.executionRail) || (tokenBound && snapshot.tokenAuthorized);
    if (!authorized || !snapshot.eligible || !snapshot.purchaseContext) return { snapshot, guidance: null };
    const status = deriveAsyncCheckoutStatus({ intentStatus: snapshot.intentStatus,
      attemptStatus: snapshot.attemptStatus, orderStatus: snapshot.orderStatus });
    const exactDisplay = exactFailureDisplayGuidance(snapshot, status);
    const projected = derivePaymentRecoveryGuidance({
      paymentState: status === "paid" || status === "failed" || status === "expired" ? status : "pending",
      activeAttemptId: snapshot.paymentAttemptId, attempts: snapshot.attempts, historyComplete: snapshot.historyComplete,
    });
    // A durable unsupported recurring-method refusal is more specific than a
    // conservative normalized projection. Keep the exact server-owned display,
    // provider, flow and purchase-context proof even when evidence exists but
    // was reduced to generic_decline because its provider advice is absent.
    if (exactDisplay?.cause === "recurring_setup_failed") return { snapshot, guidance: exactDisplay };
    if (!projected) return { snapshot, guidance: exactDisplay };
    // The persisted mandate decision is the only authority for "this agreement
    // cannot be registered": normalized evidence names the operation, never that
    // cause. When the exact display cannot prove it, the projection still must
    // not offer the refused BLIK agreement again — only another method.
    const mandateRefused = displayReasonFor(snapshot.failureReason) === "blik_recurring_unsupported_bank"
      && projected.method?.kind === "blik";
    const restriction = mandateRefused ? "method"
      : projected.advice?.code === "do_not_try_again" && projected.advice.scope !== "unknown"
        ? projected.advice.scope : null;
    return { snapshot, guidance: { version: 1, paymentAttemptId: projected.paymentAttemptId,
      purchaseContext: snapshot.purchaseContext,
      cause: !mandateRefused ? projected.cause
        : projected.operation === "recurring_setup" ? "recurring_setup_failed" : "generic_decline",
      methodKind: projected.method?.kind ?? null, methodKey: projected.method?.recoveryMethodKey ?? null,
      operation: projected.operation, restriction,
      actions: mandateRefused ? ["change_method"] : [...projected.actions],
      consecutiveRefusals: projected.consecutiveRefusals, emphasis: projected.emphasis } };
  } catch {
    return null;
  }
}

/**
 * Some legacy terminal failures predate normalized recovery evidence. Restore
 * only the two exact display buckets that were already public behavior, using
 * provider/flow facts from the signed active-attempt snapshot. Unknown Tpay
 * flows remain non-actionable because a provider name alone cannot distinguish
 * fresh BLIK from PBL or a saved instrument.
 */
function exactFailureDisplayGuidance(
  snapshot: PaymentRecoverySnapshot,
  status: ReturnType<typeof deriveAsyncCheckoutStatus>,
): CheckoutPaymentRecoveryGuidance | null {
  if (status !== "failed" || snapshot.intentStatus !== "failed" || snapshot.attemptStatus !== "failed"
    || !snapshot.paymentAttemptId || !snapshot.purchaseContext || !snapshot.historyComplete
    || snapshot.observedSuccess || snapshot.attempts[0]?.id !== snapshot.paymentAttemptId
    || snapshot.attempts.some(({ status: attemptStatus }) => attemptStatus === "succeeded")) return null;
  const active = snapshot.attempts.find(({ id }) => id === snapshot.paymentAttemptId);
  const display = displayReasonFor(snapshot.failureReason);
  const provider = active?.provider ?? snapshot.provider;
  const flow = active?.providerFlow ?? null;
  const recurringBlik = display === "blik_recurring_unsupported_bank" && provider === "tpay"
    && flow === "blik_recurring_activation" && snapshot.purchaseContext === "subscription_initial";
  const card = display === "provider_declined" && provider === "stripe"
    && flow === "one_time_payment";
  const freshBlik = display === "provider_declined" && provider === "tpay"
    && ((flow === "blik_one_time" && snapshot.purchaseContext === "one_time")
      || (flow === "blik_recurring_activation" && snapshot.purchaseContext === "subscription_initial"));
  if (!recurringBlik && !card && !freshBlik) return null;
  const methodKey = card ? "card" : "blik";
  return {
    version: 1,
    paymentAttemptId: snapshot.paymentAttemptId,
    purchaseContext: snapshot.purchaseContext,
    cause: recurringBlik ? "recurring_setup_failed" : "generic_decline",
    methodKind: methodKey,
    methodKey,
    operation: snapshot.purchaseContext === "subscription_initial" ? "recurring_setup" : "one_time_payment",
    restriction: recurringBlik ? "method" : null,
    actions: recurringBlik ? ["change_method"] : ["change_instrument", "change_method"],
    consecutiveRefusals: 0,
    emphasis: "normal",
  };
}
