// Subscription pause reminder — content (the "what to say"), owned by the
// subscription domain. Sent shortly before a timed pause ends, as a friendly
// heads-up that deliveries are about to resume. Chrome/transport live in
// communications + the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface SubscriptionPauseReminderEmailVars {
  firstName: string | null;
  /** Consumer-facing brand label injected by the app/composition root. */
  brandName: string;
  /** Pre-formatted resume date, or null when unknown. */
  resumeDateLabel: string | null;
  /** Absolute CTA URL to manage the subscription. */
  ctaUrl: string;
}

export interface SubscriptionPauseReminderEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionPauseReminderEmailContent(
  locale: Locale,
  vars: SubscriptionPauseReminderEmailVars,
  signoff: string,
): SubscriptionPauseReminderEmailContent {
  const copy = subscriptionEmailContent.pauseReminder[locale];
  const resumeDate = vars.resumeDateLabel
    ? locale === "en"
      ? ` on ${vars.resumeDateLabel}`
      : ` ${vars.resumeDateLabel}`
    : "";

  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(vars.brandName)),
    paragraph(copy.resume(resumeDate)),
    accentBox(copy.reassurance),
    button(copy.cta, vars.ctaUrl),
    paragraph(copy.outro),
    paragraph(signoff),
  ];

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks,
  };
}
