import { TimerOff } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * What this page says once it has run out of things it can honestly wait for.
 *
 * Deliberately NOT a failure and NOT a retry prompt. At this point we do not
 * know that the payment failed — only that no confirmation has reached us, and
 * a payment that WAS taken looks exactly the same from here. Telling this buyer
 * to "try again" is how you charge someone twice; the account rail already
 * learned that and says the same thing there
 * (`account:completePayment.verificationDelayed`).
 *
 * The only action offered is therefore a re-read, not a re-payment.
 */
export function PaymentWaitDelayed(
  { onCheckAgain, cream }: { onCheckAgain: () => void; cream?: boolean },
) {
  const { t } = useTranslation("checkout");
  // Same statement, both shells: the public rail is dark, the account rail cream.
  const muted = cream ? "text-foreground/60" : "text-offwhite/70";
  const control = cream
    ? "border-foreground/25 text-foreground hover:border-foreground/50"
    : "border-offwhite/25 text-offwhite hover:border-offwhite/50";

  return (
    <div data-testid="payment-wait-delayed" className="flex flex-col items-center">
      <TimerOff className={`h-8 w-8 ${muted}`} aria-hidden="true" />
      <p role="status" className={`mt-4 max-w-md text-center font-body text-sm ${muted}`}>
        {t("checkout:paymentStatus.verificationDelayed")}
      </p>
      <button
        type="button"
        data-testid="payment-wait-recheck"
        onClick={onCheckAgain}
        className={`focus-ring mt-6 inline-flex h-11 items-center justify-center rounded-control border px-5 text-sm font-semibold transition ${control}`}
      >
        {t("checkout:paymentStatus.checkStatus")}
      </button>
    </div>
  );
}
