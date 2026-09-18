import { useTranslation } from "react-i18next";
import { TriangleAlert, Wrench } from "lucide-react";

import type { SubscriptionPaymentMethodStatus } from "@/domains/subscription/selfServiceContracts";
import { money } from "../../DashboardPanelUtils";
import type { AccountLang } from "../lib/format";
import { formatDayMonth } from "../lib/format";
import { subscriptionPaymentCauseSentence } from "@/domains/subscription/subscriptionPaymentCauseCopy";
import type { SubscriptionArrears } from "../lib/dunningFacts";
import {
  EXPIRED_RESUME_NEEDS_METHOD_KEY,
  expiredResumeChargeable,
} from "../lib/subscriptionActionAvailability";
import { CoralButton } from "../ui/atoms";

/**
 * The one red surface for a subscription whose payment recovery is still open.
 * Rendered by both the Start screen and the Subscription screen, so the two
 * cannot describe the same state differently.
 *
 * Everything it prints comes from `selectSubscriptionArrears` and the
 * subscription's own method status. A figure the payload does not carry is
 * omitted, never guessed: the customer is deciding whether to act on money, and
 * an invented amount or date is worse than a missing one.
 */
/**
 * `open` describes a case still on the retry ladder. `expired` describes one
 * that ran out: nothing is retrying, the unpaid cycle will never be collected,
 * and the way back is to update the method and resume. Same figures, different
 * promise -- which is why the copy is switched rather than shared.
 *
 * The promise is not the only thing that differs. An open case has a repair
 * flow; an expired one has none, because the recovery-token issuer only ever
 * looks at cases whose status is still open. So the two variants also route
 * their control differently, and the expired variant offers no control at all
 * while the stored method cannot be charged -- an honest sentence beats a button
 * the server would refuse.
 */
export type ActionRequiredVariant = "open" | "expired";

export function ActionRequiredBanner({
  petName,
  arrears,
  methodStatus,
  lang,
  onRepair,
  onResumeAfterExpired,
  variant = "open",
}: {
  petName: string;
  arrears: SubscriptionArrears;
  methodStatus?: SubscriptionPaymentMethodStatus;
  lang: AccountLang;
  onRepair: () => void;
  /**
   * The expired-case route: the charge-timing confirmation that precedes
   * `resume`. Absent means the surface cannot offer it, which reads the same as
   * an unchargeable method -- no button.
   */
  onResumeAfterExpired?: () => void;
  variant?: ActionRequiredVariant;
}) {
  const { t } = useTranslation("account");
  // Written out rather than built from a prefix: the unused-i18n-keys guard has
  // to be able to see every key this component can reach.
  const copy = variant === "expired"
    ? {
        title: t("account:dashboard.start.actionRequired.expired.title"),
        body: t("account:dashboard.start.actionRequired.expired.body", { pet: petName }),
        cta: t("account:dashboard.start.actionRequired.expired.cta"),
      }
    : {
        title: t("account:dashboard.start.actionRequired.title"),
        body: t("account:dashboard.start.actionRequired.body", { pet: petName }),
        cta: t("account:dashboard.start.actionRequired.cta"),
      };
  // Asked of the shared helper, not of a private copy of the rule: the lifecycle
  // card on the same page asks the identical question about the identical
  // subscription, and the two must never answer differently.
  const expiredWithoutRoute =
    variant === "expired" && !(onResumeAfterExpired && expiredResumeChargeable(methodStatus));
  const deadline = arrears.nextRetryAt ?? arrears.dueAt;
  const facts: string[] = [];
  // The cause leads, because it is the one fact that tells the payer what to DO;
  // an amount and a date only tell them how much and when. Quoted from the table
  // the emails render rather than restated here — a customer who read the mail
  // and then opened this page must not be told two different things.
  const cause = subscriptionPaymentCauseSentence(lang, arrears.failureCause);
  if (cause) facts.push(cause);
  // Both halves or neither: an overdue figure whose currency the selector could not
  // establish is not shown at all, rather than shown under an assumed one.
  if (arrears.amountMinor !== null && arrears.currency !== null) {
    facts.push(
      t("account:dashboard.start.actionRequired.amount", {
        amount: money({ amountMinor: arrears.amountMinor, currency: arrears.currency }, lang),
      }),
    );
  }
  if (deadline) {
    facts.push(
      t(
        arrears.nextRetryAt
          ? "account:dashboard.start.actionRequired.nextRetry"
          : "account:dashboard.start.actionRequired.due",
        { date: formatDayMonth(deadline, lang) },
      ),
    );
  }
  if (methodStatus && methodStatus !== "usable") {
    facts.push(t(`account:dashboard.start.actionRequired.methodStatus.${methodStatus}`));
  }

  return (
    <div
      role="group"
      aria-labelledby="account-action-required-title"
      className="flex flex-col gap-4 rounded-card border border-warm-coral/40 bg-warm-coral/[0.08] p-5 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-3">
        <TriangleAlert size={22} className="mt-0.5 shrink-0 text-warm-coral" aria-hidden />
        <div>
          <p
            id="account-action-required-title"
            className="font-display text-base font-bold text-foreground"
          >
            {copy.title}
          </p>
          <p className="mt-0.5 text-sm text-foreground/65">{copy.body}</p>
          {facts.length > 0 ? (
            <ul className="mt-2 space-y-0.5 text-sm font-semibold text-warm-coral">
              {facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          ) : null}
          {arrears.recoveryEligible || variant === "expired" ? null : (
            <p className="mt-2 text-sm text-foreground/65">{t("account:dashboard.start.actionRequired.supportNote")}</p>
          )}
          {expiredWithoutRoute ? (
            <p className="mt-2 text-sm text-foreground/65">{t(EXPIRED_RESUME_NEEDS_METHOD_KEY)}</p>
          ) : null}
        </div>
      </div>
      {expiredWithoutRoute ? null : (
        <CoralButton
          icon={<Wrench size={16} aria-hidden />}
          onClick={variant === "expired" ? onResumeAfterExpired : onRepair}
          className="shrink-0"
        >
          {copy.cta}
        </CoralButton>
      )}
    </div>
  );
}
