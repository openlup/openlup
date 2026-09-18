// Subscription win-back nudge – content (the "what to say"), owned by the
// subscription domain. Sent by the subscription-winback cron to customers who
// cancelled within the last 120 days. Invites them back and points the CTA at
// their authenticated account (/konto), where the "Wznów" (reactivate) button
// resumes the subscription. It is an EMAIL-ONLY nudge: reactivation is always
// customer-initiated in their account (that is the consent) – the email never
// authorizes a charge or reactivates anything. Chrome/transport live in
// communications + the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import type { SubscriptionWinbackCopy } from "./subscriptionEmailContent.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface SubscriptionWinbackEmailVars {
  firstName: string | null;
  /** Consumer-facing brand label injected by the app/composition root. */
  brandName: string;
  /** Absolute CTA URL (the customer account / "Wznów" button); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface SubscriptionWinbackEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionWinbackEmailContent(
  locale: Locale,
  vars: SubscriptionWinbackEmailVars,
  signoff: string,
): SubscriptionWinbackEmailContent {
  const copy: SubscriptionWinbackCopy = subscriptionEmailContent.winback[locale];
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro),
  ];
  if (copy.reasonsLabel) {
    blocks.push(paragraph(copy.reasonsLabel(vars.brandName)));
  }
  blocks.push(accentBox(copy.reasons));

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
