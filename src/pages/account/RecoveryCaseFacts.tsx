import { useTranslation } from 'react-i18next';

import type { PaymentRecoverySetupMethodResponse } from '@/domains/payment/contracts';
import { subscriptionPaymentCauseSentence } from '@/domains/subscription/subscriptionPaymentCauseCopy';
import { formatCurrencyMinor } from '@/lib/currency/formatMinor';
import type { Locale } from '@/lib/i18n/resolveLocale';

/**
 * What the mail said, restated by the page that mail linked to.
 *
 * The payer arrives from a message quoting an amount and a reason and lands on a
 * form. Without this block the page confirms nothing they were told, which is the
 * worst possible moment to make someone wonder whether they are in the right
 * place. Every fact is optional and an absent one drops its line rather than
 * printing a placeholder — the same discipline the emails follow.
 *
 * The cause sentence is READ from the shared table the emails render, never
 * restated in an i18n bundle: two copies of one sentence drift silently, and the
 * drift would show up as the mail and the page disagreeing about why a payment
 * failed.
 *
 * The amount wears the label its token's promise earned. A repair amount is one
 * the dunning ladder will retry, so calling it outstanding is true. A resume
 * token arrives from a mail that already promised the unpaid cycle will not be
 * collected retroactively, and a page that then bills it as outstanding calls
 * its own email a lie at the moment the payer is deciding to trust it.
 */
export function RecoveryCaseFacts({ setup, locale }: { setup: PaymentRecoverySetupMethodResponse["setup"] | null; locale: Locale }) {
  const { t } = useTranslation("account");
  if (!setup) return null;
  const cause = subscriptionPaymentCauseSentence(locale, setup.failureCause);
  const amount = setup.amountMinor !== null && setup.currency
    ? formatMinorAmount(setup.amountMinor, setup.currency, locale)
    : null;
  if (!cause && !amount) return null;
  return (
    <div className="mb-6 rounded-control bg-teal/5 p-4 text-sm text-foreground/80">
      {amount ? (
        <p className="font-semibold text-foreground">
          {t(setup.purpose === "resume_subscription"
            ? "account:recovery.unpaidCycle"
            : "account:recovery.outstanding", { amount })}
        </p>
      ) : null}
      {cause ? <p className={amount ? "mt-1" : undefined}>{cause}</p> : null}
      {setup.failureCause === "method_cannot_recur" ? (
        <p className="mt-1">{t("account:recovery.whyCard")}</p>
      ) : null}
    </div>
  );
}

/**
 * Minor units to a localized amount; the page never does money arithmetic.
 *
 * The locale tag is passed through as-is rather than widened to a region tag:
 * `Intl` resolves a bare language fine, and naming regions here would spend
 * country vocabulary on a formatting detail that does not need it.
 */
function formatMinorAmount(amountMinor: number, currency: string, locale: Locale): string {
  return formatCurrencyMinor(amountMinor, { currency, locale });
}
