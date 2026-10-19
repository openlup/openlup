import type { Locale } from "../../../lib/i18n/resolveLocale.js";


type Localized<T> = Readonly<Record<Locale, T>>;

type Greeting = (firstName: string | null) => string;

export function localized<T>(
  greetings: Localized<Greeting>,
  pl: (greeting: Greeting) => T,
  en: (greeting: Greeting) => T,
): Localized<T> {
  return { pl: pl(greetings.pl), en: en(greetings.en) };
}
export type { SubscriptionBaseCopy, SubscriptionActionCopy, SubscriptionActivationCopy, SubscriptionScheduleCopy, SubscriptionPackageChangedCopy, SubscriptionPauseReminderCopy, SubscriptionPausedCopy, SubscriptionRenewalUpcomingCopy, SubscriptionResumedCopy, SubscriptionWelcomeCopy, SubscriptionWinbackCopy, SubscriptionPaymentExpiredCopy, SubscriptionPaymentFailedCopy, SubscriptionPaymentRecoveredCopy, SubscriptionRenewalAtRiskCopy, SubscriptionLifecycleEmailContent, SubscriptionDunningEmailContent, SubscriptionEmailContent } from "@openlup/platform/communications/contracts";
