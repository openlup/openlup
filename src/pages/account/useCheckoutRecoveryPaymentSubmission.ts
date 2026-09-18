import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";

import { payCheckoutRecovery } from "@/domains/commerce/checkoutRecoveryClient";
import { BffClientError } from "@/lib/bff/client";
import { createCustomerDiagnosticActionKeyWhenEnabled, loadCustomerDiagnosticReporterWhenEnabled } from "@/lib/flags";
import {
  CHECKOUT_RECOVERY_RECREATE_CAPABILITY,
  type CheckoutRecoveryFallback,
  type CheckoutRecoveryOrderSummary,
  type CheckoutRecoveryPayRequest,
} from "@/domains/commerce/checkoutRecoveryContracts";
import { idempotencyKey } from "@/pages/account/DashboardPanelUtils";
import {
  buildPaymentCheckoutRequestPatch,
  RECOVERY_PAYMENT_PROVIDER,
  type PaymentCheckoutDraft,
  type PaymentCheckoutMode,
  type PaymentMethod,
} from "@/checkout/adapters/paymentMethodOptions";
import { isBffConflict, isRecoveryInFlightConflict } from "./recoveryBffError";
import { localizeRecoveryError, recoveryErrorReason } from "./recoveryErrorCopy";
import {
  paymentOrderAfterStart,
  recoveryConflictOutcome,
  redirectRecoveryPayment,
} from "./checkoutRecoveryUiState";
import type { RecoveryPayStatus } from "./checkoutRecoveryPayStatus";
import {
  clearCheckoutRecoveryStripeSession,
  hasCheckoutRecoveryStripeIdentity,
  persistCheckoutRecoveryStripeSession,
  setCheckoutRecoveryStripeConfirmationStarted,
} from "./checkoutRecoveryStripeSession";

type CardConfirmationSettlement = "succeeded" | "failed" | "unknown" | "retryable";

interface SubmissionControls {
  coveredCheckout?: boolean;
  token: string;
  order: CheckoutRecoveryOrderSummary | null;
  activeOrderRef: MutableRefObject<CheckoutRecoveryOrderSummary | null>;
  paymentMethod: PaymentMethod | null;
  draft: PaymentCheckoutDraft;
  checkoutMode: PaymentCheckoutMode;
  paySubmittedRef: MutableRefObject<boolean>;
  translate: (key: string) => string;
  setStatus: Dispatch<SetStateAction<RecoveryPayStatus>>;
  setErrorMessage: Dispatch<SetStateAction<string | null>>;
  setDeclined: Dispatch<SetStateAction<boolean>>;
  setDeclineMessage: Dispatch<SetStateAction<string | null>>;
  setStripeClientSecret: Dispatch<SetStateAction<string | null>>;
  setFallback: Dispatch<SetStateAction<CheckoutRecoveryFallback>>;
  setProviderPaymentId: (providerPaymentId: string) => void;
  setActiveOrder: (order: CheckoutRecoveryOrderSummary) => void;
  markDeclined: (
    snapshot?: { failureReason?: string | null },
    order?: CheckoutRecoveryOrderSummary | null,
  ) => void;
  pollOrder: (order: CheckoutRecoveryOrderSummary) => void;
  goToThankYou: (
    order: Pick<CheckoutRecoveryOrderSummary, "orderRef" | "orderId" | "clientId">,
  ) => void;
}

export function useCheckoutRecoveryPaymentSubmission(controls: SubmissionControls) {
  const {
    token, order, activeOrderRef, paymentMethod, draft, checkoutMode, paySubmittedRef,
    translate, setStatus, setErrorMessage, setDeclined, setDeclineMessage,
    setStripeClientSecret, setFallback, setProviderPaymentId, setActiveOrder,
    markDeclined, pollOrder, goToThankYou, coveredCheckout = false,
  } = controls;

  const handlePay = useCallback(async () => {
    if (!order || paySubmittedRef.current) return;
    const diagnostic = startAccountRecoverySubmitDiagnostic();
    let diagnosticSettled = false;
    const stripeSelected = paymentMethod === "card";
    const providerPatch = stripeSelected
      ? null
      : buildPaymentCheckoutRequestPatch({ enabled: true, paymentMethod, draft, checkoutMode });
    if (!stripeSelected && !providerPatch) {
      setStatus("ready");
      diagnostic?.settle("validation_blocked");
      return;
    }
    paySubmittedRef.current = true;
    setStatus("paying");
    setErrorMessage(null);
    setDeclined(false);
    setDeclineMessage(null);
    try {
      const result = await payCheckoutRecovery({
        token,
        idempotencyKey: idempotencyKey("checkout-recovery-pay"),
        paymentProvider: stripeSelected ? "stripe" : providerPatch!.paymentProvider ?? RECOVERY_PAYMENT_PROVIDER,
        capabilities: [CHECKOUT_RECOVERY_RECREATE_CAPABILITY],
        ...(providerPatch ? {
          paymentExecution: providerPatch.paymentExecution as CheckoutRecoveryPayRequest["paymentExecution"],
        } : {}),
      });
      const paymentOrder = paymentOrderAfterStart(order, result);
      diagnostic?.settle(result.status === "failed" ? "rejected" : "succeeded");
      diagnosticSettled = true;
      setActiveOrder(paymentOrder);
      if (result.providerPaymentId) setProviderPaymentId(result.providerPaymentId);
      if (result.status === "paid") {
        setStatus("paid");
        goToThankYou(paymentOrder);
        return;
      }
      if (result.status === "failed") {
        markDeclined({ failureReason: recoveryPayFailureReason(result) }, paymentOrder);
        return;
      }
      if (result.clientAction.kind === "redirect") {
        clearCheckoutRecoveryStripeSession(order.orderId);
        clearCheckoutRecoveryStripeSession(paymentOrder.orderId);
        redirectRecoveryPayment(paymentOrder, result.clientAction.url);
        return;
      }
      if (
        stripeSelected &&
        result.clientAction.kind === "provider_embedded" &&
        result.clientAction.provider === "stripe" &&
        result.clientAction.clientSecret
      ) {
        if (!hasCheckoutRecoveryStripeIdentity(paymentOrder, result)) {
          setStatus("polling");
          pollOrder(paymentOrder);
          return;
        }
        persistCheckoutRecoveryStripeSession(paymentOrder, result);
        setStripeClientSecret(result.clientAction.clientSecret);
        setStatus("confirming_card");
        return;
      }
      if (stripeSelected) throw new Error("stripe_recovery_missing_client_secret");
      setStatus("polling");
      pollOrder(paymentOrder);
    } catch (reason) {
      if (!diagnosticSettled) diagnostic?.settle(recoverySubmitDiagnosticCode(reason), reason);
      if (isRecoveryInFlightConflict(reason)) {
        setErrorMessage(localizeRecoveryError(reason, translate));
        setStatus("failed");
        paySubmittedRef.current = false;
        return;
      }
      if (isBffConflict(reason)) {
        clearCheckoutRecoveryStripeSession(order.orderId);
        const outcome = recoveryConflictOutcome(recoveryErrorReason(reason), order.mode);
        if (outcome.fallback) setFallback(outcome.fallback);
        setStatus(outcome.status);
        return;
      }
      setErrorMessage(localizeRecoveryError(reason, translate));
      setStatus("failed");
      paySubmittedRef.current = false;
    }
  }, [
    checkoutMode, draft, goToThankYou, markDeclined, order, paymentMethod, pollOrder,
    setActiveOrder, setDeclineMessage, setDeclined, setErrorMessage, setFallback,
    setProviderPaymentId, setStatus, setStripeClientSecret, paySubmittedRef, token, translate,
  ]);

  const handleStripeSettled = useCallback((stripeStatus: CardConfirmationSettlement) => {
    const activeOrder = activeOrderRef.current;
    if (!activeOrder) return;
    if (stripeStatus === "failed") {
      if (!coveredCheckout) {
        setCheckoutRecoveryStripeConfirmationStarted(activeOrder.orderId, false);
        setDeclined(true); setDeclineMessage(null); paySubmittedRef.current = false;
        return;
      }
      clearCheckoutRecoveryStripeSession(activeOrder.orderId);
      setStripeClientSecret(null);
      setStatus("polling");
      pollOrder(activeOrder);
      return;
    }
    if (stripeStatus === "retryable") {
      // Stripe rejected locally before dispatch. Keep the same Elements
      // session/form available, but remove its provisional refresh marker so a
      // reload restores the still-valid client secret instead of polling.
      setCheckoutRecoveryStripeConfirmationStarted(activeOrder.orderId, false);
      setDeclined(false);
      setDeclineMessage(null);
      paySubmittedRef.current = false;
      setStatus("confirming_card");
      return;
    }
    // A rejected browser Promise has an unknown PSP outcome. Poll it without
    // clearing the resumable session or reopening another payment attempt.
    if (stripeStatus === "unknown") {
      setStatus("polling");
      pollOrder(activeOrder);
      return;
    }
    clearCheckoutRecoveryStripeSession(activeOrder.orderId);
    setStatus("polling");
    pollOrder(activeOrder);
  }, [activeOrderRef, paySubmittedRef, pollOrder, setDeclineMessage, setDeclined, setStatus, setStripeClientSecret, coveredCheckout]);

  const handleStripeConfirmStart = useCallback(() => {
    const activeOrder = activeOrderRef.current;
    if (activeOrder) setCheckoutRecoveryStripeConfirmationStarted(activeOrder.orderId, true);
  }, [activeOrderRef]);

  return { handlePay, handleStripeSettled, handleStripeConfirmStart };
}

type RecoverySubmitDiagnosticCode = "succeeded" | "rejected" | "validation_blocked" | "unknown" | "timeout" | "transport_uncertain";

function startAccountRecoverySubmitDiagnostic(): { settle: (code: RecoverySubmitDiagnosticCode, error?: unknown) => void } | null {
  try {
    const clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
    const reporter = loadCustomerDiagnosticReporterWhenEnabled?.();
    if (!clientActionKey || !reporter) return null;
    const report = (phase: "attempted" | "settled", code: "observed" | RecoverySubmitDiagnosticCode, error?: unknown): void => {
      const relatedRequestId = error instanceof BffClientError ? error.requestId : undefined;
      void reporter.then((loadedReporter) => {
        try {
          loadedReporter?.reportCustomerJourneyDiagnostic({
            action: "checkout_recovery_submit", phase, code, clientActionKey,
            ...(relatedRequestId ? { relatedRequestId } : {}),
          });
        } catch {
          // Diagnostics never change recovery payment behavior.
        }
      }).catch(() => {});
    };
    report("attempted", "observed");
    return { settle: (code, error) => report("settled", code, error) };
  } catch {
    return null;
  }
}

export function reportRecoveryHatchPaid(): void {
  try {
    const clientActionKey = createCustomerDiagnosticActionKeyWhenEnabled?.();
    const reporter = loadCustomerDiagnosticReporterWhenEnabled?.();
    if (!clientActionKey || !reporter) return;
    void reporter.then((loadedReporter) => {
      try {
        loadedReporter?.reportCustomerJourneyDiagnostic({
          action: "checkout_recovery_hatch", phase: "attempted", code: "observed", clientActionKey,
        });
        loadedReporter?.reportCustomerJourneyDiagnostic({
          action: "checkout_recovery_hatch", phase: "settled", code: "succeeded", clientActionKey,
        });
      } catch { /* Diagnostics never change recovery navigation. */ }
    }).catch(() => {});
  } catch { /* The gated lazy reporter is best effort. */ }
}

function recoverySubmitDiagnosticCode(error: unknown): RecoverySubmitDiagnosticCode {
  if (isRecoverySubmitTimeout(error)) return "timeout";
  if (error instanceof BffClientError) {
    if (error.status === 0) return "transport_uncertain";
    if (error.status >= 400 && error.status < 500) return "rejected";
    return "unknown";
  }
  return error instanceof TypeError ? "transport_uncertain" : "unknown";
}

function isRecoverySubmitTimeout(error: unknown): boolean {
  return error instanceof BffClientError
    && error.code === "UPSTREAM_UNAVAILABLE"
    && typeof error.details === "object"
    && error.details !== null
    && "reason" in error.details
    && error.details.reason === "timeout";
}

function recoveryPayFailureReason(result: unknown): string | null {
  if (typeof result !== "object" || result === null || !("failureReason" in result)) return null;
  const failureReason = (result as { failureReason?: unknown }).failureReason;
  return typeof failureReason === "string" ? failureReason : null;
}
