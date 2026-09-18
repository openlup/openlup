// Subscription pause confirmation – content (the "what to say"), owned by the
// subscription domain. Sent when a subscription transitions to status='paused' via
// customer self-service. Confirms the pause, reassures no charges while paused, and
// points to the account to resume anytime. Chrome/transport live in communications +
// the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface SubscriptionPausedEmailVars {
  firstName: string | null;
  /** Consumer-facing brand label injected by the app/composition root. */
  brandName: string;
  /** Absolute CTA URL (manage subscription); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface SubscriptionPausedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionPausedEmailContent(
  locale: Locale,
  vars: SubscriptionPausedEmailVars,
  signoff: string,
): SubscriptionPausedEmailContent {
  const copy = subscriptionEmailContent.paused[locale];
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro),
    accentBox(copy.reassurance(vars.brandName)),
  ];

  if (vars.ctaUrl) {
    blocks.push(button(copy.cta, vars.ctaUrl));
  }

  blocks.push(paragraph(copy.outro));
  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks,
  };
}
