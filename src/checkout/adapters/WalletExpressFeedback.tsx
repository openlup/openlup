import { useTranslation } from "react-i18next";

import { WalletInlineError } from "./WalletInlineError";

/** Retry surface for a Stripe.js load that failed before wallet Elements mounted. */
export function WalletStripeLoadFailure({ onRetry, coveredCheckout }: { onRetry: () => void; coveredCheckout?: boolean }) {
  const { t, i18n } = useTranslation("checkout");
  const approved = coveredCheckout === true && typeof i18n.getResource(i18n.resolvedLanguage ?? i18n.language, "checkout", "recoveryGuidance.messages.c13NoAlternative") === "string";

  return (
    <div
      role="alert"
      data-testid="wallet-stripe-load-failed"
      className="space-y-3 text-sm text-destructive"
    >
      <p>{t(approved ? "recoveryGuidance.messages.c13NoAlternative" : "stripePay.loadFailed")}</p>
      {!approved && <p>{t("stripePay.loadAlternative")}</p>}
      <button
        type="button"
        data-testid="wallet-stripe-load-retry"
        onClick={onRetry}
        className="inline-flex h-10 items-center justify-center rounded-full border border-current px-5 text-sm font-semibold transition hover:opacity-80"
      >
        {t("stripePay.loadRetry")}
      </button>
    </div>
  );
}

interface WalletExpressFeedbackProps {
  /** An issuer refused the wallet charge; the buyer may retry or switch tile. */
  coveredCheckout?: boolean;
  declined: boolean;
  detailsIncomplete: boolean;
  preDispatchFailed: boolean;
  preDispatchMessage?: string;
  priceUpdated: boolean;
  subscriptionUnavailable: boolean;
}

/** In-place wallet outcomes that deliberately keep the buyer on step 6. */
export function WalletExpressFeedback({
  coveredCheckout,
  declined,
  detailsIncomplete,
  preDispatchFailed,
  preDispatchMessage,
  priceUpdated,
  subscriptionUnavailable,
}: WalletExpressFeedbackProps) {
  const { t } = useTranslation("checkout");

  return (
    <div className="mb-4">
      {priceUpdated && <WalletInlineError message={t("checkout:errors.priceChanged")} />}
      {subscriptionUnavailable && (
        <WalletInlineError alert message={t("checkout:errors.subscriptionCheckoutUnavailable")} />
      )}
      {detailsIncomplete && (
        <WalletInlineError alert message={t("checkout:errors.walletDetailsIncomplete")} />
      )}
      {preDispatchFailed && (
        <WalletInlineError alert message={coveredCheckout ? preDispatchMessage ?? t("checkout:recoveryGuidance.messages.c09") : t("checkout:errors.detailsIncomplete")} />
      )}
      {declined && (
        <WalletInlineError alert message={t("checkout:errors.paymentDeclinedCard")} />
      )}
    </div>
  );
}
