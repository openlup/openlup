// Subscription cycle-skipped confirmation – content, owned by the subscription
// domain. Sent when the customer skips the upcoming cycle via the self-service
// "Pomiń cykl" (skip_next_cycle) action. Confirms the skip, the new charge date
// and the ESTIMATED delivery window that follows it.
// Chrome/transport live in communications + the Resend port.
//
// ⚠️ `chargeDateLabel` is the renewal CHARGE date (`subscriptions.next_cycle_at`)
// after the skip, never a delivery promise. Pure renderer: dates arrive
// pre-formatted from the handler.

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

export interface SubscriptionCycleSkippedEmailVars {
  firstName: string | null;
  /** Localized next CHARGE date after the skip, or null when unavailable. */
  chargeDateLabel?: string | null;
  /** Localized estimated delivery window after the skip, or null when unavailable. */
  deliveryWindowLabel?: string | null;
  /** Localized holiday caveat; present ONLY when a holiday moved the window. */
  holidayNote?: string | null;
  /** Absolute CTA URL (manage subscription); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface SubscriptionCycleSkippedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionCycleSkippedEmailContent(
  locale: Locale,
  vars: SubscriptionCycleSkippedEmailVars,
  signoff: string,
): SubscriptionCycleSkippedEmailContent {
  const copy = subscriptionEmailContent.cycleSkipped[locale];
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
  blocks.push(paragraph(copy.manageLine));

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
