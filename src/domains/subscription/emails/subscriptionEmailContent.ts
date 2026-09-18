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

export interface SubscriptionBaseCopy {
  subject: string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
}

export interface SubscriptionActionCopy extends SubscriptionBaseCopy {
  intro: string;
  reassurance: string[];
  cta: string;
  outro: string;
}

export interface SubscriptionActivationCopy extends SubscriptionBaseCopy {
  intro: string;
  facts: string[];
  cta: string;
  outro: string;
}

export interface SubscriptionScheduleCopy extends SubscriptionBaseCopy {
  subjectWithoutDates: string;
  intro: string;
  introWithoutDates: string;
  deliveryLabel: string;
  chargeLabel: string;
  dateLine: (window: string, chargeDate: string) => string;
  reassurance: string[];
  cta: string;
  outro: string;
}

export interface SubscriptionPackageChangedCopy extends SubscriptionBaseCopy {
  intro: (actionLabel: string | null) => string;
  reassurance: string[];
  actionLabels: Readonly<Record<string, string>>;
  cta: string;
  outro: string;
}

export interface SubscriptionPauseReminderCopy extends SubscriptionBaseCopy {
  intro: (brandName: string) => string;
  resume: (resumeDate: string) => string;
  reassurance: string[];
  cta: string;
  outro: string;
}

export interface SubscriptionPausedCopy extends SubscriptionBaseCopy {
  intro: string;
  reassurance: (brandName: string) => string[];
  cta: string;
  outro: string;
}

export interface SubscriptionRenewalUpcomingCopy extends SubscriptionBaseCopy {
  intro: (contextName: string | null) => string;
  dateLine: (label: string) => string;
  deliveryLine: (window: string) => string;
  editCutoffLine: (label: string) => string;
  noDateLine: string;
  amountLine: (label: string) => string;
  starterGraduationLine: (units: number, cadenceDays: number) => string;
  detailsLabel: string;
  manageLine: string;
  cta: string;
}

export interface SubscriptionResumedCopy extends SubscriptionBaseCopy {
  intro: (contextName: string | null) => string;
  reassurance: (brandName: string) => string[];
  cta: string;
  outro: string;
}

export interface SubscriptionWelcomeCopy extends SubscriptionBaseCopy {
  intro: string;
  cadenceLine: (days: number) => string;
  deliveryLine: (window: string, chargeDate: string) => string;
  editCutoffLine: (label: string) => string;
  fallbackLine: string;
  starterDelivery2Line: (amount: string) => string;
  starterSteadyLine: (units: number, cadenceDays: number) => string;
  detailsLabel: string;
  manageLine: string;
  cta: string;
  outro: string;
}

export interface SubscriptionWinbackCopy extends SubscriptionBaseCopy {
  intro: string;
  reasonsLabel?: (brandName: string) => string;
  reasons: string[];
  cta: string;
  outro: string;
}

export interface SubscriptionPaymentExpiredCopy extends SubscriptionBaseCopy {
  preheaderWithCta: string;
  intro: string;
  detail: (amountLabel: string | null) => string[];
  ctaDetail: string;
  cta: string;
  outro: string;
}

export interface SubscriptionPaymentFailedCopy extends SubscriptionBaseCopy {
  intro: string;
  amountLine: (amountLabel: string) => string;
  noAmountLine: string;
  noAmountLineNoRetry: string;
  methodLine: (scheme: string, lastDigits: string) => string;
  reassurance: (attempt: number, dateLabel: string | null) => string;
  noRetryAction: string;
  cta: string;
  outro: string;
}

export interface SubscriptionPaymentRecoveredCopy extends SubscriptionBaseCopy {
  intro: string;
  detail: (amountLabel: string | null) => string[];
  outro: string;
}

export interface SubscriptionRenewalAtRiskCopy extends SubscriptionBaseCopy {
  intro: (renewalDateLabel: string | null) => string;
  consequence: string;
  cta: string;
  outro: string;
}

export interface SubscriptionLifecycleEmailContent {
  activationActionRequired: Localized<SubscriptionActivationCopy>;
  addressChanged: Localized<SubscriptionActionCopy>;
  cancelled: Localized<SubscriptionActionCopy>;
  cycleSkipped: Localized<SubscriptionScheduleCopy & { manageLine: string }>;
  deliveryRescheduled: Localized<SubscriptionScheduleCopy>;
  packageChanged: Localized<SubscriptionPackageChangedCopy>;
  pauseReminder: Localized<SubscriptionPauseReminderCopy>;
  paused: Localized<SubscriptionPausedCopy>;
  renewalUpcoming: Localized<SubscriptionRenewalUpcomingCopy>;
  resumed: Localized<SubscriptionResumedCopy>;
  welcome: Localized<SubscriptionWelcomeCopy>;
  winback: Localized<SubscriptionWinbackCopy>;
}

export interface SubscriptionDunningEmailContent {
  paymentExpired: Localized<SubscriptionPaymentExpiredCopy>;
  paymentFailed: Localized<SubscriptionPaymentFailedCopy>;
  paymentRecovered: Localized<SubscriptionPaymentRecoveredCopy>;
  renewalAtRisk: Localized<SubscriptionRenewalAtRiskCopy>;
}

export interface SubscriptionEmailContent
  extends SubscriptionLifecycleEmailContent,
    SubscriptionDunningEmailContent {
  id: "example" | "deployment-overlay";
}
