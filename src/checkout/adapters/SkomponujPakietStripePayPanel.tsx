import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { getCommercePaymentStatus } from "@/domains/commerce/commerceClient";
import {
  PaymentStatusPoller,
  type PollerStatusSnapshot,
  type PollerTerminalStatus,
} from "@/domains/payment/components/PaymentStatusPoller";
import type { PaymentFormSettlement } from "@/domains/payment/components/PaymentForm";
import { StripePaymentStep } from "@/domains/payment/components/StripePaymentStep";
import { FinishInBrowserHatch } from "./FinishInBrowserHatch";
import { useLocalizedPath } from "@/lib/i18nRoutes";
import {
  paymentStatusUrlFor,
  setCheckoutContinuationPhase,
} from "@/checkout/machine/checkoutNavigation";

export interface StripePayState {
  orderId: string;
  orderRef: string;
  paymentIntentId: string;
  clientSecret: string;
  clientId: string;
  journeyId?: string;
  awaitingWebhook: boolean;
  hasAlternativePaymentMethod?: boolean;
}

interface SkomponujPakietStripePayPanelProps {
  state: StripePayState;
  onConfirmSettled: (status: PaymentFormSettlement) => void;
  onPollerTerminal: (status: PollerTerminalStatus) => void;
  /** Cream-theme the embedded PSP Payment Element in account mode. */
  accountCream?: boolean;
  hasAlternativePaymentMethod?: boolean;
  /** Account host keeps off-site 3DS returns inside the account terminal. */
  returnPath?: string;
}

export function SkomponujPakietStripePayPanel({
  state,
  onConfirmSettled,
  onPollerTerminal,
  accountCream,
  hasAlternativePaymentMethod = state.hasAlternativePaymentMethod ?? false,
  returnPath,
}: SkomponujPakietStripePayPanelProps) {
  const { t, i18n } = useTranslation("checkout");
  const coveredCheckout = typeof i18n.getResource(i18n.resolvedLanguage ?? i18n.language, "checkout", "recoveryGuidance.messages.c09") === "string";
  const localizedPath = useLocalizedPath();
  const returnUrl = `${window.location.origin}${paymentStatusUrlFor(
    returnPath ?? localizedPath("configuratorPayment"),
    state,
  )}`;

  // L1 refresh-resume guard. The buyer's own card commit is the moment a payment
  // can start existing, so it is the moment the continuation marker stops being
  // "the server issued an action" and becomes "the provider was called". This
  // RAISES an existing marker rather than writing one: a rendered-but-unsubmitted
  // card is NOT a payment in flight — its payment intent has no payment method —
  // and a marker minted here used to strand that buyer on the status poller until
  // a provider readback terminalized an attempt that never happened. With no
  // marker present the transition is a no-op and the card form simply stays open.
  const onConfirmStart = useCallback(() => {
    setCheckoutContinuationPhase("confirm_dispatched");
  }, []);

  return (
    <div data-testid="stripe-pay-panel" className="w-full max-w-md space-y-6 rounded-2xl bg-card p-6 shadow-lg">
      <header className="space-y-1 text-center">
        <h2 className="font-display text-2xl text-foreground">{t("checkout:stripePay.title")}</h2>
        <p className="text-sm text-muted-foreground">
          {t("checkout:stripePay.body")}
        </p>
      </header>
      {!state.awaitingWebhook ? (
        <StripePaymentStep
          // The PSP forbids swapping `clientSecret` on a mounted `<Elements>`, and
          // a retry after a decline always arrives with a NEW intent. Keying on
          // the secret makes that remount structural rather than a convention a
          // later edit could quietly break.
          key={state.clientSecret}
          coveredCheckout={coveredCheckout}
          clientSecret={state.clientSecret}
          returnUrl={returnUrl}
          onSettled={onConfirmSettled}
          onConfirmStart={onConfirmStart}
          accountCream={accountCream}
          // `src/domains/payment` is a candidate neutral kernel and must not
          // reach into this app's translation namespaces, so the host supplies
          // every word. Before this, the step's failure copy was a hardcoded
          // literal inside the domain and the pay button fell back to the same
          // literal whatever locale the visitor was reading in.
          copy={{
            recoveryMessage: coveredCheckout ? (key) => t(key) : undefined,
            payButton: t("checkout:stripePay.payButton"),
            payingButton: t("checkout:stripePay.payingButton"),
            errorPrefix: t("checkout:stripePay.errorPrefix"),
            unavailable: t("checkout:stripePay.unavailable"),
            loading: t("checkout:stripePay.loading"),
            loadFailed: t(coveredCheckout ? hasAlternativePaymentMethod ? "checkout:recoveryGuidance.messages.c13" : "checkout:recoveryGuidance.messages.c13NoAlternative" : "checkout:stripePay.loadFailed"),
            loadRetry: t("checkout:stripePay.loadRetry"),
            loadAlternative: coveredCheckout ? hasAlternativePaymentMethod ? t("checkout:recoveryGuidance.messages.c14") : undefined : t("checkout:stripePay.loadAlternative"),
          }}
        />
      ) : null}
      {/* Under the pay button, where a buyer who cannot get the card through is
          actually looking. It renders for embedded webviews only. */}
      <FinishInBrowserHatch />
      {state.awaitingWebhook ? (
        <PaymentStatusPoller
          orderId={state.orderId}
          paymentIntentId={state.paymentIntentId}
          clientId={state.clientId}
          fetchStatus={fetchCommercePaymentStatusSnapshot}
          onTerminal={onPollerTerminal}
        />
      ) : null}
    </div>
  );
}

async function fetchCommercePaymentStatusSnapshot(input: {
  orderId: string;
  paymentIntentId: string;
  clientId: string;
}): Promise<PollerStatusSnapshot> {
  const response = await getCommercePaymentStatus(input);
  return {
    status: response.status,
    intentStatus: response.payment.intentStatus,
  };
}
