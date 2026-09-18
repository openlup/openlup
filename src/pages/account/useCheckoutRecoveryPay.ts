import { presentCheckoutRecoveryGuidance, type CheckoutRecoveryAction } from "@/checkout/machine/checkoutRecoveryGuidance";
import { useCheckoutRecoveryGuidance } from "@/checkout/machine/useCheckoutRecoveryGuidance";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useLocalizedPath, useLocalizedRoute } from "@/lib/i18nRoutes";
import { CHECKOUT_TERMINAL_ROUTE } from "#checkout-terminal-route";
import type { CheckoutRecoveryFallback, CheckoutRecoveryOrderSummary } from "@/domains/commerce/checkoutRecoveryContracts";
import { emptyPaymentCheckoutDraft, validatePaymentCheckoutDraft, type PaymentCheckoutDraft, type PaymentMethod } from "@/checkout/adapters/paymentMethodOptions";
import { thankYouUrlFor } from "@/checkout/machine/checkoutNavigation";
import { reportCheckoutClientEvent } from "@/lib/telemetry/checkoutClientEvent";
import { readCheckoutRecoveryPaymentStatus, resolveCheckoutRecoveryEntry } from "./checkoutRecoveryEntry";
import { localizeRecoveryError } from "./recoveryErrorCopy";
import type { RecoveryPayStatus } from "./checkoutRecoveryPayStatus";
import { useCheckoutRecoveryPolling } from "./useCheckoutRecoveryPolling";
import { reportRecoveryHatchPaid, useCheckoutRecoveryPaymentSubmission } from "./useCheckoutRecoveryPaymentSubmission";
import {
  useCheckoutRecoveryMethods,
  useCheckoutRecoverySimulator,
} from "./useCheckoutRecoveryProviderUi";
import {
  checkoutRecoveryStripeConfirmationStarted,
  clearAllCheckoutRecoveryStripeSessions,
  clearCheckoutRecoveryStripeSession,
  persistCheckoutRecoveryStripeSession,
} from "./checkoutRecoveryStripeSession";
import { redirectRecoveryPayment } from "./checkoutRecoveryUiState";
export type { RecoveryPayStatus } from "./checkoutRecoveryPayStatus";

export function useCheckoutRecoveryPay(token: string, resumeStripe = false, fromHatch = false) {
  const navigate = useNavigate();
  const localizedPath = useLocalizedPath();
  const localizedRoute = useLocalizedRoute();
  const { t } = useTranslation("account");
  const [status, setStatus] = useState<RecoveryPayStatus>("redeeming");
  const [order, setOrder] = useState<CheckoutRecoveryOrderSummary | null>(null);
  const activeOrderRef = useRef<CheckoutRecoveryOrderSummary | null>(null);
  const [fallback, setFallback] = useState<CheckoutRecoveryFallback>("fresh_checkout");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [coveredOrderId, setCoveredOrderId] = useState<string | null>(null);
  const [declined, setDeclined] = useState(false);
  const [declineMessage, setDeclineMessage] = useState<string | null>(null);
  const [blikUnavailable, setBlikUnavailable] = useState(false);
  const [paymentMethod, setMethod] = useState<PaymentMethod | null>(null);
  const [draft, setDraft] = useState<PaymentCheckoutDraft>(emptyPaymentCheckoutDraft);
  const [stripeClientSecret, setStripeClientSecret] = useState<string | null>(null);
  const [resumeRedirectUrl, setResumeRedirectUrl] = useState<string | null>(null);
  const [redeemGeneration, setRedeemGeneration] = useState(0);
  const redeemedRef = useRef(-1);
  const providerReturnPollingRequestedRef = useRef(false);
  const providerReturnPollingStartedRef = useRef(false);
  const paySubmittedRef = useRef(false);
  const { checkoutMode, methods, channels, bankPickerEnabled } = useCheckoutRecoveryMethods(
    order,
    blikUnavailable,
  );
  const {
    applying,
    applySimulator,
    setProviderPaymentId,
    showSimulatorControls,
  } = useCheckoutRecoverySimulator(status);

  const setActiveOrder = useCallback((summary: CheckoutRecoveryOrderSummary) => {
    activeOrderRef.current = summary;
    setOrder(summary);
  }, []);

  const goToThankYou = useCallback(
    (summary: Pick<CheckoutRecoveryOrderSummary, "orderRef" | "orderId" | "clientId">) => {
      clearCheckoutRecoveryStripeSession(summary.orderId);
      // The single paid-in-browser producer also covers paid readback on entry.
      if (fromHatch) {
        reportCheckoutClientEvent("escape_hatch", "paid_in_browser");
        reportRecoveryHatchPaid();
      }
      // In neither funnel, so it asks the deployment rather than its own location.
      navigate(thankYouUrlFor(localizedRoute(CHECKOUT_TERMINAL_ROUTE), summary));
    },
    [navigate, localizedRoute, fromHatch],
  );

  useEffect(() => {
    if (!token || redeemedRef.current === redeemGeneration) return;
    redeemedRef.current = redeemGeneration;
    resolveCheckoutRecoveryEntry(token, resumeStripe)
      .then((entry) => {
        if (entry.kind === "paid") return goToThankYou(entry.order);
        if (entry.kind === "already_paid") return setStatus("already_paid");
        if (entry.kind === "terminal") {
          clearAllCheckoutRecoveryStripeSessions();
          setStatus(entry.status);
          return;
        }
        if (entry.kind === "fallback") {
          clearAllCheckoutRecoveryStripeSessions();
          setFallback(entry.fallback);
          setStatus("fallback");
          return;
        }
        setActiveOrder(entry.order);
        if (entry.kind === "awaiting_provider") {
          setStatus("awaiting_provider");
          return;
        }
        if (entry.kind === "manual_review") {
          setStatus("manual_review");
          return;
        }
        if (entry.kind === "resume_existing") {
          if (entry.clientAction.kind === "redirect") {
            setResumeRedirectUrl(entry.clientAction.url);
            setStatus("resume_redirect");
            return;
          }
          if (
            entry.clientAction.kind === "provider_embedded"
            && entry.clientAction.provider === "stripe"
            && entry.clientAction.clientSecret
          ) {
            const confirmationStarted = checkoutRecoveryStripeConfirmationStarted(entry.order);
            setMethod("card");
            if (entry.shouldPoll || confirmationStarted) {
              providerReturnPollingRequestedRef.current = true;
              setStatus("ready");
            } else {
              setStripeClientSecret(entry.clientAction.clientSecret);
              persistCheckoutRecoveryStripeSession(entry.order);
              setStatus("confirming_card");
            }
            return;
          }
          // A provider-specific action not renderable by the existing page is
          // deliberately treated as uncertain, never as permission to retry.
          setStatus("awaiting_provider");
          return;
        }
        if (entry.kind === "unsupported") {
          clearCheckoutRecoveryStripeSession(entry.order.orderId);
          setBlikUnavailable(true);
          setErrorMessage(t("account:completePayment.blikBankUnsupportedUnavailableBody"));
          setStatus("failed");
          return;
        }
        if (entry.unsupportedBlik) {
          setBlikUnavailable(true);
          setDeclined(true);
          setDeclineMessage(t("account:completePayment.blikBankUnsupportedExitBody"));
        }
        setMethod(entry.paymentMethod);
        if (resumeStripe) clearCheckoutRecoveryStripeSession(entry.order.orderId);
        if (entry.shouldPoll) providerReturnPollingRequestedRef.current = true;
        setStatus("ready");
      })
      .catch((reason) => {
        setErrorMessage(localizeRecoveryError(reason, t));
        setStatus("failed");
      });
  }, [goToThankYou, redeemGeneration, resumeStripe, setActiveOrder, token, t]);

  const markDeclined = useCallback((
    snapshot?: { failureReason?: string | null },
    summary: CheckoutRecoveryOrderSummary | null = activeOrderRef.current,
  ) => {
    if (summary) clearCheckoutRecoveryStripeSession(summary.orderId);
    setDraft((current) => ({ ...current, blikToken: "" }));
    setDeclineMessage(null);
    setDeclined(true);
    setStatus("ready");
    paySubmittedRef.current = false;
  }, []);

  const fieldErrors = useMemo(
    () => validatePaymentCheckoutDraft({
      enabled: Boolean(order),
      paymentMethod,
      draft,
      checkoutMode,
      bankPickerEnabled,
    }),
    [order, paymentMethod, draft, checkoutMode, bankPickerEnabled],
  );

  const markTerminalFailure = useCallback(() => {
    const activeOrder = activeOrderRef.current;
    if (activeOrder) clearCheckoutRecoveryStripeSession(activeOrder.orderId);
    setErrorMessage(null);
    setStatus("failed");
    paySubmittedRef.current = false;
  }, []);
  const markVerificationDelayed = useCallback(() => setStatus("verification_delayed"), []);
  const startPolling = useCheckoutRecoveryPolling({
    readStatus: (target) => readCheckoutRecoveryPaymentStatus(target, token),
    onPaid: () => {
      const activeOrder = activeOrderRef.current;
      if (!activeOrder) return;
      setStatus("paid");
      goToThankYou(activeOrder);
    },
    onProviderPaymentId: setProviderPaymentId,
    onRecoverableDecline: markDeclined,
    onTerminalFailure: markTerminalFailure,
    onVerificationDelayed: markVerificationDelayed,
    onRestorableAttempt: () => false,
  });

  const pollOrder = useCallback((summary: CheckoutRecoveryOrderSummary) => {
    if (!summary.paymentIntentId) {
      markTerminalFailure();
      return;
    }
    startPolling({
      orderId: summary.orderId,
      paymentIntentId: summary.paymentIntentId,
      clientId: summary.clientId,
    });
  }, [markTerminalFailure, startPolling]);

  useEffect(() => {
    if (
      !providerReturnPollingRequestedRef.current ||
      !order ||
      !order.paymentIntentId ||
      status !== "ready" ||
      providerReturnPollingStartedRef.current
    ) return;
    providerReturnPollingStartedRef.current = true;
    setStatus("polling");
    pollOrder(order);
  }, [order, pollOrder, status]);

  const { handlePay, handleStripeSettled, handleStripeConfirmStart } =
    useCheckoutRecoveryPaymentSubmission({
      token, order, activeOrderRef, paymentMethod, draft, checkoutMode, paySubmittedRef,
      translate: t, setStatus, setErrorMessage, setDeclined, setDeclineMessage,
      setStripeClientSecret, setFallback, setProviderPaymentId, setActiveOrder,
      markDeclined, pollOrder, goToThankYou, coveredCheckout: coveredOrderId === order?.orderId,
    });

  const recovery = useCheckoutRecoveryGuidance({
    statusRequest: order?.paymentIntentId ? { orderId: order.orderId, paymentIntentId: order.paymentIntentId, clientId: order.clientId } : null,
    recoveryToken: token, enabled: status === "ready", currentPaid: status === "paid" || status === "already_paid",
  });
  useEffect(() => {
    if (!order || !recovery.response) return;
    if (recovery.guidance) setCoveredOrderId(order.orderId);
    if (recovery.response.status === "paid") { setStatus("paid"); goToThankYou(order); }
    else if (recovery.response.status === "expired") { setFallback("fresh_checkout"); setStatus("fallback"); }
    else if (recovery.response.status !== "failed") setStatus("awaiting_provider");
  }, [recovery.response, recovery.guidance, order, goToThankYou]);
  const recoveryPresentation = presentCheckoutRecoveryGuidance({ guidance: recovery.guidance,
    methods: methods.filter(({ value }) => value !== "transfer" || channels.length > 0) });
  const handleRecoveryAction = (action: CheckoutRecoveryAction) => {
    if (status !== "ready" || recovery.loading) return;
    if (action.kind === "contact_support") { navigate(localizedPath("contact")); return; }
    const method = action.method ?? methods.find(({ value }) => value !== recovery.guidance?.methodKey && (value !== "transfer" || channels.length > 0))?.value;
    if (!method || !methods.some(({ value }) => value === method)) return;
    setMethod(method);
    window.requestAnimationFrame(() => document.getElementById(`recovery-payment-method-${method}`)?.focus());
  };

  return {
    status, order, checkoutMode, errorMessage, declined, declineMessage,
    recoveryPresentation, handleRecoveryAction, coveredCheckout: coveredOrderId === order?.orderId,
    stripeClientSecret, resumeRedirectUrl, methods, paymentMethod, setMethod,
    draft, setDraft, channels, fieldErrors, applying, showSimulatorControls,
    fallback, handlePay, handleStripeSettled, handleStripeConfirmStart,
    // ⛔ `src` rides along or the metric loses its numerator: 3DS is a full document
    // navigation, so a return URL without it re-initialises `fromHatch` to false.
    stripeReturnUrl: `${window.location.origin}${localizedPath("checkoutRecovery")}?${new URLSearchParams({ token, resume: "stripe", ...(fromHatch ? { src: "hatch" } : {}) })}`,
    canPay: !recovery.loading && (!recovery.response || (recovery.response.status === "failed" && recovery.response.orderStatus === "pending_payment"))
      && Object.keys(fieldErrors).length === 0 && paymentMethod !== null,
    retryVerification: () => {
      if (status === "awaiting_provider") {
        setStatus("redeeming");
        setRedeemGeneration((current) => current + 1);
        return;
      }
      const activeOrder = activeOrderRef.current;
      if (!activeOrder) return;
      setStatus("polling");
      pollOrder(activeOrder);
    },
    continueRedirect: () => {
      const activeOrder = activeOrderRef.current;
      if (!activeOrder || !resumeRedirectUrl) return;
      redirectRecoveryPayment(activeOrder, resumeRedirectUrl);
    },
    onContactSupport: () => navigate(localizedPath("contact")),
    applySimulator,
    onStartFresh: () => navigate(localizedPath("configurator")),
    onFallback: () => {
      const activeOrder = activeOrderRef.current;
      if (activeOrder) clearCheckoutRecoveryStripeSession(activeOrder.orderId);
      navigate(fallback === "customer_account"
        ? localizedPath("customerDashboard")
        : localizedPath("configurator"));
    },
  };
}
