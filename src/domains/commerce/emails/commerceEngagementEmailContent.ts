import type { Locale } from "../../../lib/i18n/resolveLocale.js";

export interface AbandonedCartToneEmailCopy {
  subject: string;
  preheader: string;
  heading: string;
  intro: string;
  body: string;
  cta: string;
}

export interface AbandonedCartEmailCopy {
  greeting: (firstName: string | null) => string;
  first: AbandonedCartToneEmailCopy;
  gentle: AbandonedCartToneEmailCopy;
  last: AbandonedCartToneEmailCopy;
}

export interface BackInStockEmailCopy {
  genericLabel: string;
  subject: (productLabel: string) => string;
  preheader: string;
  heading: (productLabel: string) => string;
  greeting: string;
  intro: (productLabel: string) => string;
  hook: string;
  cta: string;
}

export interface CheckoutExpiredEmailCopy {
  subject: (orderRef: string) => string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (orderRef: string) => string;
  detailsLabel: string;
  details: (amountLabel: string | null) => string[];
  cta: string;
  outro: string;
}

export interface CheckoutRecoveryEmailCopy {
  greeting: (firstName: string | null) => string;
  cta: string;
  subjectFirst: string;
  subjectFinal: string;
  preheader: string;
  headingFirst: string;
  headingFinal: string;
  introSubscription: string;
  introOneTime: string;
  contextCheer: (contextName: string | null) => string;
  subscriptionCheer: (contextName: string | null, appName: string) => string;
  finalNote: string;
}

export interface ReorderReminderEmailCopy {
  subject: string;
  preheader: string;
  greeting: (firstName: string | null) => string;
  heading: string;
  intro: (appName: string) => string;
  consistencyNote: string;
  upsellLabel: string;
  upsellLines: string[];
  cta: string;
}

export interface ReviewRequestEmailCopy {
  subject: string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (contextName: string | null) => string;
  body: string;
  cta: string;
  outro: string;
}

export interface ReviewEffectsEmailCopy {
  subject: string;
  preheader: string;
  heading: string;
  greeting: (firstName: string | null) => string;
  intro: (contextName: string | null, appName: string) => string;
  body: string;
  cta: string;
  outro: string;
}

export interface CommerceRecoveryEmailContent {
  readonly abandonedCart: Record<Locale, AbandonedCartEmailCopy>;
  readonly checkoutExpired: {
    readonly expired: Record<Locale, CheckoutExpiredEmailCopy>;
    readonly recovery: Record<Locale, CheckoutExpiredEmailCopy>;
  };
  readonly checkoutRecovery: Record<Locale, CheckoutRecoveryEmailCopy>;
}

export interface CommerceEngagementEmailContent {
  readonly backInStock: Record<Locale, BackInStockEmailCopy>;
  readonly reorderReminder: Record<Locale, ReorderReminderEmailCopy>;
  readonly reviewRequest: Record<Locale, ReviewRequestEmailCopy>;
  readonly reviewEffects: Record<Locale, ReviewEffectsEmailCopy>;
}
