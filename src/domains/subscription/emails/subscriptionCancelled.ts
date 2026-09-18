// Subscription cancellation confirmation – content (the "what to say"), owned by
// the subscription domain. Sent when a subscription transitions to
// status='cancelled'. Confirms the cancellation, reassures no further charges,
// and leaves the door open to come back. Chrome/transport live in communications
// + the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface SubscriptionCancelledEmailVars {
  firstName: string | null;
  /** Absolute CTA URL (back to shop / re-subscribe); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface SubscriptionCancelledEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionCancelledEmailContent(
  locale: Locale,
  vars: SubscriptionCancelledEmailVars,
  signoff: string,
): SubscriptionCancelledEmailContent {
  const copy = subscriptionEmailContent.cancelled[locale];
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro),
    accentBox(copy.reassurance),
  ];

  blocks.push(paragraph(copy.outro));

  if (vars.ctaUrl) {
    blocks.push(button(copy.cta, vars.ctaUrl));
  }

  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks,
  };
}
