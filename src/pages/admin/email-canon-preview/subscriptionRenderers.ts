import { emailRouteUrl } from "@/domains/communications/email/links";
import { subscriptionActivationActionRequiredEmailContent } from "@/domains/subscription/emails/subscriptionActivationActionRequired";
import { subscriptionAddressChangedEmailContent } from "@/domains/subscription/emails/subscriptionAddressChanged";
import { subscriptionCancelledEmailContent } from "@/domains/subscription/emails/subscriptionCancelled";
import { subscriptionCycleSkippedEmailContent } from "@/domains/subscription/emails/subscriptionCycleSkipped";
import { subscriptionDeliveryRescheduledEmailContent } from "@/domains/subscription/emails/subscriptionDeliveryRescheduled";
import { subscriptionPackageChangedEmailContent } from "@/domains/subscription/emails/subscriptionPackageChanged";
import { subscriptionPauseReminderEmailContent } from "@/domains/subscription/emails/subscriptionPauseReminder";
import { subscriptionPausedEmailContent } from "@/domains/subscription/emails/subscriptionPaused";
import { subscriptionPaymentExpiredEmailContent } from "@/domains/subscription/emails/subscriptionPaymentExpired";
import { subscriptionPaymentFailedEmailContent } from "@/domains/subscription/emails/subscriptionPaymentFailed";
import { subscriptionPaymentRecoveredEmailContent } from "@/domains/subscription/emails/subscriptionPaymentRecovered";
import { subscriptionRenewalAtRiskEmailContent } from "@/domains/subscription/emails/subscriptionRenewalAtRisk";
import { subscriptionRenewalUpcomingEmailContent } from "@/domains/subscription/emails/subscriptionRenewalUpcoming";
import { subscriptionResumedEmailContent } from "@/domains/subscription/emails/subscriptionResumed";
import { subscriptionWelcomeEmailContent } from "@/domains/subscription/emails/subscriptionWelcome";
import { subscriptionWinbackEmailContent } from "@/domains/subscription/emails/subscriptionWinback";

import {
  ACCOUNT_URL,
  APP_EMAIL_BRAND,
  APP_EMAIL_TEAM_SIGNOFF,
  APP_SITE_ORIGIN,
  BODY_BRAND,
  CONFIG_URL,
  LOCALE,
  preview,
  type CanonPreviewRenderer,
} from "./shared";

const CUSTOMER_PAYMENT_RECOVERY_URL = emailRouteUrl(
  APP_SITE_ORIGIN,
  "customerPaymentRecovery",
  LOCALE,
  { token: "sample" },
);
const accountPaymentsUrl = new URL(ACCOUNT_URL);
accountPaymentsUrl.searchParams.set("sekcja", "payments");
accountPaymentsUrl.searchParams.set("sub", "sample");
const ACCOUNT_PAYMENTS_URL = accountPaymentsUrl.toString();

export const SUBSCRIPTION_CANON_PREVIEW_RENDERERS: Record<
  string,
  CanonPreviewRenderer
> = {
  "subscription-welcome": () =>
    preview(
      subscriptionWelcomeEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          cadenceDays: 30,
          chargeDateLabel: "20.07.2026",
          deliveryWindowLabel: "21.07.2026 – 22.07.2026",
          editCutoffLabel: "17.07.2026",
          ctaUrl: ACCOUNT_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-activation-action-required": () =>
    preview(
      subscriptionActivationActionRequiredEmailContent(
        LOCALE,
        { firstName: "Anna", ctaUrl: ACCOUNT_PAYMENTS_URL },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-cancelled": () =>
    preview(
      subscriptionCancelledEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          ctaUrl: CONFIG_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-paused": () =>
    preview(
      subscriptionPausedEmailContent(
        LOCALE,
        { firstName: "Anna", brandName: BODY_BRAND, ctaUrl: ACCOUNT_URL },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-resumed": () =>
    preview(
      subscriptionResumedEmailContent(
        LOCALE,
        { firstName: "Anna", brandName: BODY_BRAND, ctaUrl: ACCOUNT_URL },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-pause-reminder": () =>
    preview(
      subscriptionPauseReminderEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          brandName: APP_EMAIL_BRAND.copyBrandName,
          resumeDateLabel: "20.07.2026",
          ctaUrl: ACCOUNT_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-renewal-upcoming": () =>
    preview(
      subscriptionRenewalUpcomingEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          renewalDateLabel: "20.07.2026",
          deliveryWindowLabel: "21.07.2026 – 22.07.2026",
          editCutoffLabel: "17.07.2026",
          amountLabel: "129,99 zł",
          ctaUrl: ACCOUNT_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-winback": () =>
    preview(
      subscriptionWinbackEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          brandName: BODY_BRAND,
          ctaUrl: ACCOUNT_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-delivery-rescheduled": () =>
    preview(
      subscriptionDeliveryRescheduledEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          chargeDateLabel: "20.07.2026",
          deliveryWindowLabel: "21.07.2026 – 22.07.2026",
          ctaUrl: ACCOUNT_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-cycle-skipped": () =>
    preview(
      subscriptionCycleSkippedEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          chargeDateLabel: "20.07.2026",
          deliveryWindowLabel: "21.07.2026 – 22.07.2026",
          ctaUrl: ACCOUNT_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-address-changed": () =>
    preview(
      subscriptionAddressChangedEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          ctaUrl: ACCOUNT_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-package-changed": () =>
    preview(
      subscriptionPackageChangedEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          action: "update_recipe_mix",
          ctaUrl: ACCOUNT_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-payment-expired": () =>
    preview(
      subscriptionPaymentExpiredEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          amountLabel: "129,99 zł",
          recoveryUrl: CUSTOMER_PAYMENT_RECOVERY_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-payment-recovered": () =>
    preview(
      subscriptionPaymentRecoveredEmailContent(
        LOCALE,
        { firstName: "Anna", amountLabel: "129,99 zł" },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  "subscription-renewal-at-risk": () =>
    preview(
      subscriptionRenewalAtRiskEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          renewalDateLabel: "20.07.2026",
          cause: "mandate",
          ctaUrl: ACCOUNT_PAYMENTS_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
  // The dunning pattern row is displayed with this synthetic slug.
  "subscription-payment-failed-N": () =>
    preview(
      subscriptionPaymentFailedEmailContent(
        LOCALE,
        {
          firstName: "Anna",
          amountLabel: "129,99 zł",
          retryAttempt: 1,
          recoveryUrl: CUSTOMER_PAYMENT_RECOVERY_URL,
        },
        APP_EMAIL_TEAM_SIGNOFF[LOCALE],
      ),
    ),
};
