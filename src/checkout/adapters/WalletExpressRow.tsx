import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Elements, useElements, useStripe } from "@stripe/react-stripe-js";

import { paymentFormErrorPresentation } from "@/domains/payment/components/paymentFormErrorPresentation";
import { useStripeLoader } from "@/domains/payment/components/useStripePromise";
import { reportCheckoutClientEvent } from "@/lib/telemetry/checkoutClientEvent";
import type { ConfiguratorFormData } from "@/checkout/composer/configuratorFormStore";
import type { TpayCheckoutMode } from "./tpayCheckoutDraft";
import { useLiveQuote } from "@/checkout/machine/useLiveQuote";
import { isCheckoutDisabled } from "@/checkout/machine/checkoutDisabled";
import { useEffectiveConfiguratorPackage } from "@/checkout/composer/useEffectiveConfiguratorPackage";
import { useWalletOrderMint } from "./useWalletOrderMint";
import { persistCheckoutContinuation } from "@/checkout/machine/checkoutNavigation";
import { WalletRowPlaceholder } from "./WalletExpressSkeleton";
import { WalletExpressElement } from "./WalletExpressElement";
import { WalletExpressFeedback, WalletStripeLoadFailure } from "./WalletExpressFeedback";
import {
  type WalletCheckoutSettlement,
  type WalletPaymentContext,
  walletDeclineStaysInPlace,
  walletSettlementFromConfirmError,
  walletSettlementFromConfirmPaymentIntentStatus,
  walletPaymentReturnUrl,
} from "./walletExpressSettlement";

export type { WalletCheckoutSettlement, WalletFailureReason } from "./walletExpressSettlement";

/** Deferred wallet confirmation: mint only after local validation, reconcile every dispatched outcome. */

export interface WalletExpressRowProps {
  coveredCheckout?: boolean;
  data: ConfiguratorFormData;
  checkoutMode: TpayCheckoutMode;
  onSettled: (settlement: WalletCheckoutSettlement) => void;
  /** Explicit host-owned terminal route; browser location is never inferred. */
  returnPath: string;
  /** Line γ seam: composition vocabulary for `buildCheckoutIntent`. */ knownCompositionSlugs: readonly string[];
}

export function WalletExpressRow({ data, checkoutMode, onSettled, returnPath, knownCompositionSlugs, coveredCheckout }: WalletExpressRowProps) {
  const { stripePromise, status: stripeLoadStatus, retry: retryStripeLoad } = useStripeLoader();
  const { snapshot: effectiveSnapshot } = useEffectiveConfiguratorPackage(
    data,
    checkoutMode === "subscription",
  );
  const quote = useLiveQuote({
    snapshot: effectiveSnapshot,
    subscription: checkoutMode === "subscription",
    lengthDays: data.lengthDays,
    promoCodes: data.promoCodes,
    customerEmail: data.email,
    pricingPolicyToken: data.pricingPolicyAssignment?.pricingPolicyToken,
    promotionAcceptanceToken: data.checkoutQuoteExpectation?.promotionAcceptanceToken,
  });

  const total = quote.quote?.totalGross;
  if (stripeLoadStatus === "unconfigured" || !stripePromise) {
    return null; // Without a publishable key there is no wallet surface at all.
  }
  // The deferred Elements needs a concrete amount/currency to render wallet
  // buttons, so while the live quote resolves the row keeps its space with a
  // skeleton (CLS on the money step); only a resolved-but-unusable quote
  // (error/zero) collapses it for good.
  if (!total || total.amountMinor <= 0) {
    return quote.loading ? <WalletRowPlaceholder /> : null;
  }
  if (stripeLoadStatus === "failed") {
    return <WalletStripeLoadFailure coveredCheckout={coveredCheckout} onRetry={retryStripeLoad} />;
  }
  const dataWithQuoteExpectation = {
    ...data,
    checkoutQuoteExpectation: {
      totalGross: total,
      ...(quote.quote?.context?.pricingPolicy
        ? { pricingPolicy: quote.quote.context.pricingPolicy }
        : {}),
      ...(quote.quote?.promotionAcceptanceToken
        ? { promotionAcceptanceToken: quote.quote.promotionAcceptanceToken }
        : {}),
    },
  };

  return (
    <Elements
      key={`${total.amountMinor}:${total.currency}`}
      stripe={stripePromise}
      options={{
        mode: "payment",
        amount: total.amountMinor,
        currency: total.currency.toLowerCase(),
        // Must match the PaymentIntent minted in stripeApiClient
        // (`payment_method_types: ["card"]`). Apple/Google Pay are card wallets;
        // left implicit, Elements picks automatic methods and the PSP rejects
        // confirmation before any charge attempt.
        paymentMethodTypes: ["card"],
        setupFutureUsage: checkoutMode === "subscription" ? "off_session" : undefined,
        appearance: { theme: "stripe" },
      }}
    >
      <WalletExpressInner
        coveredCheckout={coveredCheckout}
        data={dataWithQuoteExpectation}
        checkoutMode={checkoutMode}
        onSettled={onSettled}
        returnPath={returnPath} knownCompositionSlugs={knownCompositionSlugs}
      />
    </Elements>
  );
}

function WalletExpressInner({ data, checkoutMode, onSettled, returnPath, knownCompositionSlugs, coveredCheckout }: WalletExpressRowProps) {
  const { t, i18n } = useTranslation("checkout");
  const approvedGuidance = coveredCheckout === true && typeof i18n.getResource(i18n.resolvedLanguage ?? i18n.language, "checkout", "recoveryGuidance.messages.c09") === "string";
  const stripe = useStripe();
  const elements = useElements();
  // null = PSP still resolving device wallet support (skeleton keeps the space), true = wallet button live, false = confirmed none (collapse).
  const [available, setAvailable] = useState<boolean | null>(null);
  const confirmInFlightRef = useRef(false);
  const [priceUpdated, setPriceUpdated] = useState(false);
  const [subscriptionUnavailable, setSubscriptionUnavailable] = useState(false);
  const [detailsIncomplete, setDetailsIncomplete] = useState(false);
  const [preDispatchFailed, setPreDispatchFailed] = useState(false);
  const [preDispatchMessage, setPreDispatchMessage] = useState<string>();
  const [declined, setDeclined] = useState(false);
  const [checkoutQuoteExpectation, setCheckoutQuoteExpectation] = useState(data.checkoutQuoteExpectation);
  // Stable mint within one confirmed wallet action, invoked only after Elements submission succeeds, never from wallet onClick.
  const startWalletOrder = useWalletOrderMint(
    data,
    checkoutQuoteExpectation,
    i18n.language === "en" ? "en" : "pl",
    knownCompositionSlugs,
  );
  useEffect(() => {
    setCheckoutQuoteExpectation(data.checkoutQuoteExpectation);
    setDeclined(false);
    setPriceUpdated(false);
    setSubscriptionUnavailable(false);
    setDetailsIncomplete(false);
    setPreDispatchFailed(false);
    setPreDispatchMessage(undefined);
  }, [data.checkoutQuoteExpectation]);

  async function handleConfirm() {
    if (!stripe || !elements || confirmInFlightRef.current) return;
    confirmInFlightRef.current = true;
    setDeclined(false);
    setPriceUpdated(false);
    setSubscriptionUnavailable(false);
    setDetailsIncomplete(false);
    setPreDispatchFailed(false);
    setPreDispatchMessage(undefined);
    let settled = false;
    let awaitingStatus = false;
    let settlementContext: WalletPaymentContext | undefined;
    const settle = (settlement: WalletCheckoutSettlement) => {
      if (settled) return;
      settled = true;
      if (approvedGuidance && settlement.kind === "failed" && settlementContext) {
        awaitingStatus = true;
        onSettled({ kind: "processing", ...settlementContext });
        return;
      }
      awaitingStatus = approvedGuidance && (settlement.kind === "processing" || settlement.kind === "status" || settlement.kind === "paid");
      if (settlement.kind === "failed" && walletDeclineStaysInPlace(settlement.reason)) setDeclined(true);
      onSettled(settlement);
    };
    // Null intent: error in place + emit settlement (caller must not route to success).
    const settleDisabled = () => { setDetailsIncomplete(true); settle({ kind: "disabled" }); };
    try {
      const { error: submitError } = await elements.submit();
      if (submitError) {
        console.error("[wallet-express] wallet elements submit failed", {
          code: submitError.code,
          type: submitError.type,
        });
        setPreDispatchFailed(true);
        setPreDispatchMessage(t(paymentFormErrorPresentation(submitError, { dispatch: "not_dispatched", retryAllowed: true })));
        settle({ kind: "retryable" });
        return;
      }
      let start;
      try {
        // The deferred Intent is created only after Elements accepted the details.
        start = await startWalletOrder();
      } catch (err) {
        if (isCheckoutDisabled(err)) return settleDisabled();
        // Surface the real BFF/mint failure: dataLayer/GTM are dead on /konto, so console.error is the only reliable signal here.
        console.error("[wallet-express] checkout start failed", err);
        settle({ kind: "failed", reason: "technical" });
        return;
      }
      if (start.kind === "quote_unavailable") {
        setPriceUpdated(true);
        return;
      }
      if (start.kind === "subscription_unavailable") {
        setSubscriptionUnavailable(true);
        settle({ kind: "subscription_unavailable" });
        return;
      }
      if (start.kind === "disabled") return settleDisabled();
      if (start.kind === "invoice_required") return settle({ kind: "failed" });
      if (start.kind === "retryable") {
        setPreDispatchFailed(true);
        return settle({ kind: "retryable" });
      }
      if (start.kind === "price_changed") {
        setPriceUpdated(true);
        setCheckoutQuoteExpectation(null);
        return settle({ kind: "price_changed" });
      }
      if (start.kind === "in_flight") return settle({ kind: "in_flight" });
      if (start.kind === "paid") return settle({ kind: "paid", orderRef: start.orderRef });
      if (start.kind === "status") return settle(start);

      settlementContext = {
        orderId: start.orderId, orderRef: start.orderRef,
        paymentIntentId: start.paymentIntentId, clientId: start.clientId,
      };
      const returnUrl = walletPaymentReturnUrl(returnPath, settlementContext);
      // `none` + `confirm_dispatched` are what the retired legacy marker resolved to
      // implicitly; stating them earns this marker an expiry (see `actionKind`).
      persistCheckoutContinuation({ ...settlementContext, journeyId: start.journeyId, actionKind: "none", phase: "confirm_dispatched" });
      const confirmResult = await stripe.confirmPayment({
        elements,
        clientSecret: start.clientSecret,
        confirmParams: { return_url: returnUrl },
        redirect: "if_required",
      });
      if (confirmResult.error) {
        // Capture the actual PSP decline so a swallowed wallet failure stays diagnosable (no dataLayer on /konto). One log per failed path.
        console.error("[wallet-express] wallet confirmPayment failed", {
          code: confirmResult.error.code,
          decline_code: confirmResult.error.decline_code,
          type: confirmResult.error.type,
          paymentIntentId: start.paymentIntentId,
        });
        const errorSettlement = walletSettlementFromConfirmError(confirmResult.error, settlementContext);
        if (errorSettlement.kind === "retryable") {
          setPreDispatchFailed(true);
          setPreDispatchMessage(t(paymentFormErrorPresentation(confirmResult.error, { dispatch: "not_dispatched", retryAllowed: true })));
        }
        settle(errorSettlement);
        return;
      }
      const confirmSettlement = walletSettlementFromConfirmPaymentIntentStatus(
        confirmResult.paymentIntent?.status,
        settlementContext,
      );
      if (confirmSettlement.kind === "failed") {
        console.warn("[wallet-express] wallet confirmPayment returned non-charge status", {
          status: confirmResult.paymentIntent?.status,
          paymentIntentId: start.paymentIntentId,
        });
      }
      settle(confirmSettlement);
    } catch (error) {
      // With a minted context, a rejected confirmation requires authoritative readback.
      console.error("[wallet-express] wallet checkout Promise rejected", error);
      if (!settlementContext) {
        setPreDispatchMessage(t(paymentFormErrorPresentation({}, { dispatch: "not_dispatched", retryAllowed: true })));
        setPreDispatchFailed(true);
        settle({ kind: "retryable" });
      } else {
        settle({ kind: "failed", reason: "technical", ...settlementContext });
      }
    } finally {
      confirmInFlightRef.current = awaitingStatus;
    }
  }

  return <>
      <WalletExpressElement
        available={available}
        dividerLabel={t("checkout:step6.walletOrDivider")}
        onClick={(event) => {
          // Preserve the Apple Pay user-gesture window; Order/Intent minting is deferred to onConfirm, after elements.submit() succeeds.
          event.resolve();
        }}
        onReady={(event) => {
          // Actual device support determines whether this wallet choice is available.
          const walletAvailable = Boolean(event.availablePaymentMethods);
          setAvailable(walletAvailable);
          reportCheckoutClientEvent(
            "payment_form",
            walletAvailable ? "wallet_row_shown" : "wallet_row_hidden",
          );
        }}
        onConfirm={handleConfirm}
      />
      <WalletExpressFeedback coveredCheckout={approvedGuidance} declined={declined} priceUpdated={priceUpdated}
        subscriptionUnavailable={subscriptionUnavailable}
        detailsIncomplete={detailsIncomplete} preDispatchFailed={preDispatchFailed} preDispatchMessage={preDispatchMessage} />
    </>;
}
