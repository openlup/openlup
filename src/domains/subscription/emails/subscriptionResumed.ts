// Subscription resume confirmation – content (the "what to say"), owned by the
// subscription domain. Sent when a subscription transitions back to status='active'
// from a pause (customer self-service resume OR timed auto-resume). Confirms it's
// active again and points to the account. Chrome/transport live in communications +
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

export interface SubscriptionResumedEmailVars {
  firstName: string | null;
  /** Consumer-facing brand label injected by the app/composition root. */
  brandName: string;
  /** Absolute CTA URL (manage subscription); null/absent → no button. */
  ctaUrl?: string | null;
  /** Optional consumer context label; absent/null uses the selected pack's fallback. */
  contextName?: string | null;
}

export interface SubscriptionResumedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionResumedEmailContent(
  locale: Locale,
  vars: SubscriptionResumedEmailVars,
  signoff: string,
): SubscriptionResumedEmailContent {
  const copy = subscriptionEmailContent.resumed[locale];
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(vars.contextName ?? null)),
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
