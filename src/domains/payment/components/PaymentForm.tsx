import { useEffect, useRef, useState, type FormEvent } from "react";
import { PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";

import { reportCheckoutClientEvent } from "@/lib/telemetry/checkoutClientEvent";

import { paymentFormErrorPresentation } from "./paymentFormErrorPresentation";
import { usePaymentStepDeparture } from "./usePaymentStepDeparture";
import { STRIPE_LOAD_TIMEOUT_MS } from "./useStripePromise";

/**
 * Every word this domain renders comes from its host, because
 * `src/domains/payment` is a candidate neutral kernel and must not reach into
 * the application's translation namespaces. The `*` fields below are the
 * failure vocabulary added for the silent-dead-end fix; they are optional so
 * existing callers keep compiling, and every in-repo host fills them from
 * `checkout:stripePay.*` or `account:completePayment.*`.
 */
export interface PaymentFormCopy {
  /** Host-translated approved guidance; supplied only by covered checkout callers. */
  recoveryMessage?: (key: string) => string;
  payButton: string;
  payingButton: string;
  errorPrefix: string;
  /** Shown when no publishable key is configured at all. */
  unavailable?: string;
  /** Shown while the payment fields are still painting. */
  loading?: string;
  /** Shown when the provider script failed or never finished loading. */
  loadFailed?: string;
  /** Label of the button that starts a fresh load attempt. */
  loadRetry?: string;
  /** Points the buyer at the payment methods that do not need this script. */
  loadAlternative?: string;
}

/** Browser confirmation outcome; `unknown` requires payment-control readback. */
export type PaymentFormSettlement = "succeeded" | "failed" | "unknown" | "retryable";

const DEFAULT_COPY: PaymentFormCopy = {
  payButton: "Zapłać",
  payingButton: "Przetwarzanie…",
  errorPrefix: "Płatność odrzucona",
};

const DEFAULT_LOAD_FAILED = "Nie udało się wczytać formularza karty. Sprawdź połączenie i spróbuj ponownie.";
// The host fills this from its own namespace like every other string here; the
// fallback exists so a caller that has not been updated still says SOMETHING
// rather than showing the buyer a blank panel above a dead button.
const DEFAULT_LOADING = "Wczytujemy bezpieczny formularz płatności…";

// These failures are raised before Stripe dispatches a PaymentIntent
// confirmation. Routing them as terminal payment failures would send the
// account host to a status poll that can never observe a webhook.
const PRE_DISPATCH_STRIPE_ERROR_TYPES = new Set([
  "validation_error",
  "invalid_request_error",
  "authentication_error",
  "rate_limit_error",
]);

export interface PaymentFormProps {
  coveredCheckout?: boolean;
  returnUrl: string;
  onSettled: (status: PaymentFormSettlement) => void;
  copy?: PaymentFormCopy;
  /**
   * Fired ONCE, synchronously, right before `stripe.confirmPayment`. That — not
   * the Element mounting — is when a payment genuinely goes in flight, so it is
   * the only safe point to persist the refresh-resume marker: any earlier and a
   * buyer who refreshes before typing a card is stranded on the poller for an
   * intent with no payment method (see SkomponujPakietStripePayPanel).
   */
  onConfirmStart?: () => void;
}

/** Inline outcomes go to payment-control; covered checkout locks until a fresh form mounts. */
export function PaymentForm({ returnUrl, onSettled, copy = DEFAULT_COPY, onConfirmStart, coveredCheckout = false }: PaymentFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const confirmationLocked = useRef(false);
  const curated = (
    error: { type?: string; code?: string },
    dispatch: "not_dispatched" | "unknown",
    retryAllowed = false,
  ) => coveredCheckout ? copy.recoveryMessage?.(paymentFormErrorPresentation(error, { dispatch, retryAllowed })) : undefined;
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // `disabled={!stripe || !elements}` used to be the ONLY signal that the
  // Elements handshake had not completed. When it never completes — the exact
  // shape of the 2026-08-26 webview report — the buyer sees a greyed button and
  // nothing else, forever. The same budget the loader uses turns that state into
  // a sentence on screen. The button stays disabled: there is genuinely nothing
  // to confirm against yet.
  const elementsReady = Boolean(stripe && elements);
  // ⛔ NOT THE SAME QUESTION AS `elementsReady`, and conflating them is what made
  // the payment step lie to buyers. `elementsReady` only says the SDK handed us
  // an `elements` object, which on a warm script happens immediately — long
  // before the iframe paints a single field: the pay button went live above an
  // empty box, the 10-second not-ready message could never fire, and the panel
  // grew by ~224px under a click already in flight (measured: it swallowed the
  // first click in 4 of 5 subscription e2e runs). `elementReady` is the
  // provider's OWN readiness callback, and the only honest gate for the button,
  // the timeout and the placeholder. Full argument: docs/platform/RUNTIME_AND_SELF_HOSTING.md.
  const [elementReady, setElementReady] = useState(false);
  const [handshakeTimedOut, setHandshakeTimedOut] = useState(false);
  // The panel-departure reporter owns the `committed` flag and the three
  // listeners; it is hoisted out of this form because window/document plumbing
  // is not a form's job, and because this file is at its 300-line cap.
  const setDepartureCommitted = usePaymentStepDeparture();

  // Measured against `elementReady`, not `elementsReady`. Against the latter the
  // timer was cancelled on the first render of a warm script, so the state it
  // exists to report — fields that never appear — could not reach the buyer or
  // the drain.
  useEffect(() => {
    if (elementReady) {
      setHandshakeTimedOut(false);
      return;
    }
    const timer = setTimeout(() => {
      setHandshakeTimedOut(true);
      // Fires with the sentence, not before it: the buyer seeing the alert and
      // us recording the alert are the same event, so they cannot drift.
      reportCheckoutClientEvent("payment_form", "payment_element_not_ready");
    }, STRIPE_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [elementReady]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements || isSubmitting || confirmationLocked.current) return;
    confirmationLocked.current = true;
    setErrorMessage(null);
    setIsSubmitting(true);
    let settled = false;
    const settle = (status: PaymentFormSettlement) => {
      if (settled) return;
      settled = true;
      confirmationLocked.current = coveredCheckout && status !== "retryable";
      onSettled(status);
    };

    try {
      // Payment is now genuinely in flight (a 3DS bounce may follow). The
      // refresh-resume marker is persisted HERE, never on Element mount, so a
      // refresh before this point re-lands the buyer on the configurator; and
      // from here on a departure is a bounce or a purchase, not an abandonment.
      setDepartureCommitted(true);
      onConfirmStart?.();
      // The last thing recorded before control leaves for the provider. Nine card
      // checkouts died on 2026-09-02 with nothing on the provider's side at all.
      reportCheckoutClientEvent("payment_form", "confirm_started");

      const result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
        redirect: "if_required",
      });

      if (result.error) {
        reportCheckoutClientEvent("payment_form", "confirm_returned_error");
        const local = PRE_DISPATCH_STRIPE_ERROR_TYPES.has(result.error.type ?? "");
        setErrorMessage(curated(result.error, local ? "not_dispatched" : "unknown", local) ?? result.error.message ?? "Wystąpił błąd płatności.");
        if (PRE_DISPATCH_STRIPE_ERROR_TYPES.has(result.error.type ?? "")) {
          // Keep a known local/integration mistake in the live form. The parent
          // clears the provisional refresh marker set at confirm start;
          // `finally` releases the button without entering a poller.
          setDepartureCommitted(false);
          settle("retryable");
          return;
        }
        // An API or unfamiliar provider error may arrive after Stripe accepted
        // confirmation. Only an issuer/card error proves this attempt can be
        // safely retried; everything else must be reconciled by payment-control.
        settle(
          result.error.type === "card_error" ? "failed" : "unknown",
        );
        return;
      }
      // `paymentIntent.status` is Stripe's view, not payment-control's. An
      // authorization (`requires_capture`) can still settle into a charge, so
      // it is just as unsafe to offer a retry as processing or 3DS. Only Stripe
      // statuses that explicitly require a new payment method/confirmation are
      // a deterministic terminal failure; absent or future statuses need the
      // authoritative payment-control readback.
      const status = result.paymentIntent?.status;
      reportCheckoutClientEvent("payment_form", "confirm_returned_status");
      if (
        status === "succeeded"
        || status === "processing"
        || status === "requires_action"
        || status === "requires_capture"
      ) {
        settle("succeeded");
      } else if (
        status === "canceled"
        || status === "requires_payment_method"
        || status === "requires_confirmation"
      ) {
        setErrorMessage(curated({}, "unknown") ?? `${copy.errorPrefix}: ${status ?? "unknown"}`);
        settle("failed");
      } else {
        setErrorMessage(curated({}, "unknown") ?? `${copy.errorPrefix}: ${status ?? "unknown"}`);
        settle("unknown");
      }
    } catch {
      // The SDK can reject rather than return a StripeError (a browser sheet
      // disappearing, say). The browser cannot know whether the PSP received
      // confirmation, so reconcile before offering a new charge. This is the ONE
      // branch where the browser has no answer at all — no error object, no
      // intent, nothing for the attempt row — so it is counted separately from
      // the refusals it would otherwise be lumped in with.
      reportCheckoutClientEvent("payment_form", "psp_confirm_no_response");
      setErrorMessage(curated({}, "unknown") ?? "Wystąpił błąd płatności.");
      settle("unknown");
    } finally {
      if (!coveredCheckout || !confirmationLocked.current) setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* A LAYOUT FIX, not decoration: it reserves the height the payment fields
          will occupy, so the panel cannot grow under the buyer's cursor when the
          iframe paints — the measured cause of the swallowed first click. It
          collapses the instant the provider reports readiness. `aria-hidden`
          because the live region below already announces the wait. */}
      {!elementReady ? (
        <div
          aria-hidden="true"
          data-testid="payment-form-placeholder"
          className="h-[264px] w-full animate-pulse rounded-xl bg-muted"
        />
      ) : null}
      <PaymentElement
        options={{ layout: "tabs" }}
        // The provider's own answer to "can the buyer type into this yet", and
        // the first fact the seam hunt needs: did the fields ever paint?
        onReady={() => {
          setElementReady(true);
          reportCheckoutClientEvent("payment_form", "element_ready");
        }}
        // The failure the 10-second budget was written for, arriving early and
        // named. Reuses the EXISTING code rather than adding an enum value: from
        // the buyer's side "the fields never became usable" is one state however
        // it was reached, and the timeout path already reports it.
        onLoadError={() => {
          setHandshakeTimedOut(true);
          reportCheckoutClientEvent("payment_form", "payment_element_not_ready");
        }}
      />
      {/* Announced, not merely rendered: while this is the only thing between the
          buyer and a disabled button, silence is what the webview report was made
          of. A live region carries the wait and its failure to a screen reader
          without stealing focus. */}
      {!elementReady && !handshakeTimedOut ? (
        <p role="status" aria-live="polite" data-testid="payment-form-loading" className="text-sm text-muted-foreground">
          {copy.loading ?? DEFAULT_LOADING}
        </p>
      ) : null}
      {errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}
      {!elementReady && handshakeTimedOut ? (
        <p role="alert" data-testid="payment-form-not-ready" className="text-sm text-destructive">
          {copy.loadFailed ?? DEFAULT_LOAD_FAILED}
          {copy.loadAlternative ? ` ${copy.loadAlternative}` : ""}
        </p>
      ) : null}
      {/* Gated on `elementReady` AND `elementsReady`: the first says the buyer can
          have typed a card, the second that the SDK objects `confirmPayment`
          needs exist. A live button before the fields paint is an offer to submit
          nothing, and it is the button that used to move out from under a click.

          The wrapper exists ONLY to see the taps the button itself cannot report:
          a disabled control fires no event at all, so "I pressed pay and nothing
          happened" was a claim we could neither confirm nor refute. Capture phase
          catches the pointer before it dies; the button below is untouched. */}
      <div
        onPointerDownCapture={() => {
          if (!elementReady || !elementsReady || isSubmitting) {
            reportCheckoutClientEvent("payment_form", "submit_disabled_tap");
          }
        }}
      >
        <button
          type="submit"
          disabled={!elementReady || !elementsReady || isSubmitting}
          className="inline-flex h-11 w-full items-center justify-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting ? copy.payingButton : copy.payButton}
        </button>
      </div>
    </form>
  );
}
