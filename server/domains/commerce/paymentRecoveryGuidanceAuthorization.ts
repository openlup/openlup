import { readAuthorizedPaymentRecovery as readPackagedRecovery, type PaymentRecoverySnapshot, type PaymentRecoverySnapshotPort, type CheckoutPaymentRecoveryGuidance as PackagedGuidance } from "@openlup/platform/commerce/server";
export type { PaymentRecoverySnapshot, PaymentRecoverySnapshotPort } from "@openlup/platform/commerce/server";
import { deriveAsyncCheckoutStatus } from "../../../src/domains/commerce/paymentStatus.js";
import type { PaymentStatusContinuationRequest } from "../../../src/domains/commerce/paymentContinuationContracts.js";
import type { CheckoutPaymentRecoveryGuidance } from "../../../src/domains/commerce/paymentRecoveryGuidanceContracts.js";
import type { PaymentFailureDisplayReason } from "../../../src/domains/commerce/paymentFailureDisplayContracts.js";
import type { CheckoutPaymentContinuationClaims } from "./checkoutPaymentContinuationCredential.js";
import type { CheckoutRecoveryTokenPort } from "./checkoutRecoveryToken.js";

/**
 * Maps a recorded failure reason to the bucket a surface may render, or null
 * when this deployment cannot say. The mapping reads provider reason codes, so
 * the composition root supplies it from the adapter layer.
 */
export type PaymentFailureDisplayResolver = (failureReason: string | null | undefined) => PaymentFailureDisplayReason | null;

export interface PaymentRecoveryReadDeps {
  port: PaymentRecoverySnapshotPort;
  tokenPort?: Pick<CheckoutRecoveryTokenPort, "validate">;
  resolveFailureDisplay: PaymentFailureDisplayResolver;
}

/** Missing optional infrastructure fails back to the old reader, never mixed reads. */
export async function readAuthorizedPaymentRecovery(input: {
  request: PaymentStatusContinuationRequest;
  claims: CheckoutPaymentContinuationClaims | null;
  authorization: unknown;
  deps: PaymentRecoveryReadDeps;
  now?: number;
}): Promise<{ snapshot: PaymentRecoverySnapshot; guidance: CheckoutPaymentRecoveryGuidance | null } | null> {
  return readPackagedRecovery({...input,deps:{port:input.deps.port,tokenPort:input.deps.tokenPort,
    projectGuidance(snapshot,status,projected){
      const exactDisplay = exactFailureDisplayGuidance(snapshot, status === "pending" ? "processing" : status, input.deps.resolveFailureDisplay);
      if (exactDisplay?.cause === "recurring_setup_failed") return exactDisplay;
      if (!projected) return exactDisplay;
      const mandateRefused = input.deps.resolveFailureDisplay(snapshot.failureReason) === "blik_recurring_unsupported_bank"
        && projected.method?.kind === "blik";
      const restriction = mandateRefused ? "method"
        : projected.advice?.code === "do_not_try_again" && projected.advice.scope !== "unknown"
          ? projected.advice.scope : null;
      return { version: 1, paymentAttemptId: projected.paymentAttemptId,
        purchaseContext: snapshot.purchaseContext!,
        cause: !mandateRefused ? projected.cause
          : projected.operation === "recurring_setup" ? "recurring_setup_failed" : "generic_decline",
        methodKind: projected.method?.kind ?? null, methodKey: projected.method?.recoveryMethodKey ?? null,
        operation: projected.operation, restriction,
        actions: mandateRefused ? ["change_method"] : [...projected.actions],
        consecutiveRefusals: projected.consecutiveRefusals, emphasis: projected.emphasis };
    }}});
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
  resolveFailureDisplay: PaymentFailureDisplayResolver,
): PackagedGuidance | null {
  if (status !== "failed" || snapshot.intentStatus !== "failed" || snapshot.attemptStatus !== "failed"
    || !snapshot.paymentAttemptId || !snapshot.purchaseContext || !snapshot.historyComplete
    || snapshot.observedSuccess || snapshot.attempts[0]?.id !== snapshot.paymentAttemptId
    || snapshot.attempts.some(({ status: attemptStatus }) => attemptStatus === "succeeded")) return null;
  const active = snapshot.attempts.find(({ id }) => id === snapshot.paymentAttemptId);
  const display = resolveFailureDisplay(snapshot.failureReason);
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
