import { useState, type FormEvent } from "react";
import { PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";

export interface RecoveryPaymentSetupFormCopy {
  submitButton: string;
  submittingButton: string;
  errorPrefix: string;
}

const DEFAULT_COPY: RecoveryPaymentSetupFormCopy = {
  submitButton: "Zaktualizuj metodę płatności",
  submittingButton: "Zapisujemy…",
  errorPrefix: "Nie udało się zapisać karty",
};

export interface RecoveryPaymentSetupFormProps {
  /**
   * Stripe-hosted redirect target for off-site auth flows (3DS). Should be the
   * canonical recovery landing path so the FE can resume the redeem step after
   * the bounce.
   */
  returnUrl: string;
  /**
   * Fires with the new Stripe payment method identifier after a successful
   * `confirmSetup`. The parent calls `savePaymentRecoveryMethodEvidence` and
   * the redeem BFF with this ref.
   */
  onMethodReady: (result: { paymentMethodRef: string; paymentMethodKind: string }) => void;
  onError?: (message: string) => void;
  copy?: RecoveryPaymentSetupFormCopy;
}

/**
 * Wave D-4b — inner Stripe recovery form rendered inside an `<Elements>`
 * boundary supplied by `RecoveryPaymentSetupStep`. The form collects a new
 * payment method via `stripe.confirmSetup` (SetupIntent flow, no charge),
 * extracts the resulting Stripe `payment_method` id + type, and hands them
 * back to the parent so the redeem BFF can persist the recovery. The server
 * schedules the existing failed cycle only after the method-ref webhook is
 * durable for the same recovery case.
 *
 * `redirect: "if_required"` keeps non-3DS happy paths entirely in-modal.
 */
export function RecoveryPaymentSetupForm({
  returnUrl,
  onMethodReady,
  onError,
  copy = DEFAULT_COPY,
}: RecoveryPaymentSetupFormProps) {
  const stripe = useStripe();
  const elements = useElements();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!stripe || !elements || isSubmitting) return;
    setErrorMessage(null);
    setIsSubmitting(true);

    const result = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: returnUrl },
      redirect: "if_required",
    });

    if (result.error) {
      const message = result.error.message ?? "Wystąpił błąd zapisu karty.";
      setErrorMessage(message);
      onError?.(message);
      setIsSubmitting(false);
      return;
    }

    const paymentMethod = result.setupIntent?.payment_method;
    const paymentMethodRef = typeof paymentMethod === "string" ? paymentMethod : paymentMethod?.id;
    const paymentMethodKind = typeof paymentMethod === "string" ? "card" : paymentMethod?.type ?? "card";

    if (!paymentMethodRef) {
      const message = `${copy.errorPrefix}: brak identyfikatora metody płatności.`;
      setErrorMessage(message);
      onError?.(message);
      setIsSubmitting(false);
      return;
    }

    onMethodReady({ paymentMethodRef, paymentMethodKind });
    // Parent is responsible for unmounting / navigating; keep the disabled
    // state so the customer cannot resubmit before the redeem completes.
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {/* Disable Stripe Link — removes the floating "Link"/stripe launcher badge that
          Stripe otherwise injects at the viewport corner; we only accept a directly-entered
          card here, so Link autofill adds nothing. */}
      <PaymentElement options={{ layout: "tabs", wallets: { link: "never" } }} />
      {errorMessage ? (
        <p role="alert" className="text-sm text-destructive">
          {errorMessage}
        </p>
      ) : null}
      <button
        type="submit"
        disabled={!stripe || !elements || isSubmitting}
        className="inline-flex h-11 w-full items-center justify-center rounded-full bg-primary px-6 text-sm font-semibold text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {isSubmitting ? copy.submittingButton : copy.submitButton}
      </button>
    </form>
  );
}
