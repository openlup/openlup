import { Elements } from "@stripe/react-stripe-js";
import type { StripeElementsOptions } from "@stripe/stripe-js";

import {
  PaymentForm,
  type PaymentFormCopy,
  type PaymentFormSettlement,
} from "./PaymentForm";
import { useStripeLoader } from "./useStripePromise";

const DEFAULT_UNAVAILABLE = "Płatność kartą jest teraz niedostępna.";
const DEFAULT_LOAD_FAILED = "Nie udało się wczytać formularza karty. Sprawdź połączenie i spróbuj ponownie.";
const DEFAULT_LOAD_RETRY = "Spróbuj ponownie";

/**
 * Cream account-flow appearance for the embedded Payment Element. Applied ONLY
 * when the configurator runs in account mode (`accountCream`); the public
 * marketing flow keeps the default `theme: "stripe"` appearance untouched.
 */
const ACCOUNT_CREAM_APPEARANCE: StripeElementsOptions["appearance"] = {
  theme: "stripe",
  variables: {
    colorPrimary: "#45babc",
    colorBackground: "#ffffff",
    colorText: "#042b2c",
    colorTextSecondary: "#5b6b6b",
    fontFamily: "Plus Jakarta Sans, sans-serif",
    borderRadius: "12px",
  },
};

export interface StripePaymentStepProps {
  /**
   * The Stripe PaymentIntent client secret returned by the BFF checkout
   * response (`runtime.payment.providerClientSecret` propagated through
   * `clientAction.clientSecret`). Callers keep it in memory. Checkout recovery
   * stores only a local confirmation marker in tab-scoped sessionStorage; it
   * never stores this secret or the recovery token.
   */
  coveredCheckout?: boolean;
  clientSecret: string;
  /**
   * Stripe-hosted redirect target for off-site auth flows (3DS, wallets).
   * Should be a static URL under `/skomponuj-pakiet/dziekujemy?…` so the
   * configurator can resume after the bounce.
   */
  returnUrl: string;
  onSettled: (status: PaymentFormSettlement) => void;
  copy?: PaymentFormCopy;
  /** Forwarded to {@link PaymentForm}: fired when the buyer commits a card. */
  onConfirmStart?: () => void;
  /**
   * When true, theme the embedded Payment Element to the cream account look.
   * Optional + defaults to the public (dark-ish default) appearance.
   */
  accountCream?: boolean;
}

/**
 * Hidden Stripe pay step (W11.7 Wave C).
 *
 * Renders only when `VITE_COMMERCE_STRIPE_CHECKOUT_UI_ENABLED === "true"`; the
 * configurator checks the flag before mounting. The publishable key is read
 * from the build-time `VITE_STRIPE_PUBLISHABLE_KEY` env. `loadStripe` is
 * memoized across renders so the Stripe.js bundle is fetched at most once per
 * session.
 *
 * SAFETY: this component must never see the server-side `STRIPE_SECRET_KEY`.
 * The publishable key (`pk_test_…` / `pk_live_…`) is the only client value
 * Stripe expects in the browser bundle.
 */
export function StripePaymentStep({
  clientSecret,
  returnUrl,
  onSettled,
  copy,
  onConfirmStart,
  accountCream,
  coveredCheckout,
}: StripePaymentStepProps) {
  const { stripePromise, status, retry } = useStripeLoader();
  // Two distinct dead ends, two distinct answers. "No key configured" is a
  // deployment fault the buyer can only route around; "the script did not load"
  // is a transient fault they can retry. Collapsing them into one message — as
  // this component did — told a buyer with a flaky connection that the shop does
  // not take cards at all, and offered them no button.
  if (status === "unconfigured" || !stripePromise) {
    return (
      <div role="alert" data-testid="stripe-unavailable" className="space-y-2 text-sm text-destructive">
        <p>{copy?.unavailable ?? DEFAULT_UNAVAILABLE}</p>
        {copy?.loadAlternative ? <p>{copy.loadAlternative}</p> : null}
      </div>
    );
  }
  if (status === "failed") {
    return (
      <div role="alert" data-testid="stripe-load-failed" className="space-y-3 text-sm text-destructive">
        <p>{copy?.loadFailed ?? DEFAULT_LOAD_FAILED}</p>
        {copy?.loadAlternative ? <p>{copy.loadAlternative}</p> : null}
        <button
          type="button"
          data-testid="stripe-load-retry"
          onClick={retry}
          className="inline-flex h-10 items-center justify-center rounded-full border border-current px-5 text-sm font-semibold transition hover:opacity-80"
        >
          {copy?.loadRetry ?? DEFAULT_LOAD_RETRY}
        </button>
      </div>
    );
  }
  // `loading` deliberately falls through: Elements accepts a pending promise and
  // renders the provider's own skeleton, so a slow-but-working network is not
  // punished with an error screen.
  return (
    <Elements
      stripe={stripePromise}
      options={{
        clientSecret,
        appearance: accountCream ? ACCOUNT_CREAM_APPEARANCE : { theme: "stripe" },
      }}
    >
      <PaymentForm coveredCheckout={coveredCheckout} returnUrl={returnUrl} onSettled={onSettled} copy={copy} onConfirmStart={onConfirmStart} />
    </Elements>
  );
}
