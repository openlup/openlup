// Reorder reminder – content (the "what to say"), owned by commerce. Sent ~30
// days after a ONE-TIME order is delivered, to a customer who hasn't reordered
// or converted to a subscription. Goal (B2): replenishment nudge + a soft,
// honest subscription upsell. The payload carries NO snapshot, so the copy
// stays generic – no line items.
//
// This is a MARKETING email: it MUST append the RODO/CAN-SPAM unsubscribe footer
// (marketingUnsubscribeFooter) built from a signed unsubscribe URL. Chrome and
// transport live in communications + the marketing Resend port; this module only
// assembles the localized subject + blocks. The subscription upsell is allowed
// here precisely because this is consent-gated marketing, not a transactional
// mail (see the education-vs-promo rule).

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";
import { marketingUnsubscribeFooter } from "../../communications/email/marketingFooter.js";

export interface ReorderReminderEmailVars {
  firstName: string | null;
  /** Brand label used in body copy; callers must inject the app/tenant label. */
  brandName: string;
  /** Absolute CTA URL back to the configurator (compose/reorder the next box). */
  ctaUrl: string;
  /** Absolute signed unsubscribe URL (purpose 'marketing_newsletter'). */
  unsubscribeUrl: string;
}

export interface ReorderReminderEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function reorderReminderEmailContent(
  locale: Locale,
  vars: ReorderReminderEmailVars,
  signoff: string,
): ReorderReminderEmailContent {
  const copy = commerceEmailContent.reorderReminder[locale];

  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(vars.brandName)),
    paragraph(copy.consistencyNote),
    accentBox(copy.upsellLines, { label: copy.upsellLabel }),
    button(copy.cta, vars.ctaUrl),
    paragraph(signoff),
    ...marketingUnsubscribeFooter(locale, vars.unsubscribeUrl),
  ];

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks,
  };
}
