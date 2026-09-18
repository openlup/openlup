// Subscription delivery-rescheduled confirmation – content, owned by the
// subscription domain. Sent when the customer moves the next delivery date via
// the self-service "Przełóż dostawę" (slide_next_cycle) action.
//
// ⚠️ The date the customer picked in the reschedule calendar is the CHARGE date
// (`subscriptions.next_cycle_at`), not the delivery date — dispatch and delivery
// follow it. This email states both explicitly so the picked date is never read
// as a delivery promise. Pure renderer: dates arrive pre-formatted from the
// handler. Chrome/transport live in communications + the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import {
  accentBox,
  button,
  dataTable,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface SubscriptionDeliveryRescheduledEmailVars {
  firstName: string | null;
  /** Localized new CHARGE date (the date the customer picked), or null. */
  chargeDateLabel?: string | null;
  /** Localized estimated delivery window derived from the new charge date, or null. */
  deliveryWindowLabel?: string | null;
  /** Localized holiday caveat; present ONLY when a holiday moved the window. */
  holidayNote?: string | null;
  /** Absolute CTA URL (manage subscription); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface SubscriptionDeliveryRescheduledEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionDeliveryRescheduledEmailContent(
  locale: Locale,
  vars: SubscriptionDeliveryRescheduledEmailVars,
  signoff: string,
): SubscriptionDeliveryRescheduledEmailContent {
  const copy = subscriptionEmailContent.deliveryRescheduled[locale];
  const hasSchedule = Boolean(vars.chargeDateLabel && vars.deliveryWindowLabel);
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(hasSchedule ? copy.intro : copy.introWithoutDates),
  ];

  if (locale === "pl" && hasSchedule) {
    blocks.push(dataTable([
      { label: copy.deliveryLabel, value: vars.deliveryWindowLabel! },
      { label: copy.chargeLabel, value: vars.chargeDateLabel! },
    ]));
  }

  const reassurance = [
    ...(locale !== "pl" && hasSchedule
      ? [copy.dateLine(vars.deliveryWindowLabel!, vars.chargeDateLabel!)]
      : []),
    ...(vars.holidayNote ? [vars.holidayNote] : []),
    ...copy.reassurance,
  ];
  blocks.push(accentBox(reassurance));

  if (vars.ctaUrl) {
    blocks.push(button(copy.cta, vars.ctaUrl));
  }

  blocks.push(paragraph(copy.outro));
  blocks.push(paragraph(signoff));

  return {
    subject: hasSchedule ? copy.subject : copy.subjectWithoutDates,
    preheader: copy.preheader,
    blocks,
  };
}
