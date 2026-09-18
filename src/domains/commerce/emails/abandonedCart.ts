// Abandoned-cart reminder – content (the "what to say"), owned by commerce.
// Sent for a draft order that never reached payment. TWO tones keyed off
// reminderHours: 24h is a gentle saved-cart nudge, while 72h is the final
// reminder. The payload carries NO snapshot, so the copy stays generic – no
// line items or totals.
//
// Unlike the transactional order-draft nudge, this is a MARKETING email: it MUST
// append the RODO/CAN-SPAM unsubscribe footer (marketingUnsubscribeFooter) built
// from a signed unsubscribe URL. Chrome/transport live in communications + the
// marketing Resend port; this module only assembles localized subject + blocks.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import {
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";
import { marketingUnsubscribeFooter } from "../../communications/email/marketingFooter.js";

/** 1 = light same-session nudge, 24 = gentle nudge, 72 = final last-nudge. */
export type AbandonedCartReminderHours = 1 | 24 | 72;

export interface AbandonedCartEmailVars {
  firstName: string | null;
  /** Consumer-facing brand label injected by the app/composition root. */
  brandName: string;
  reminderHours: AbandonedCartReminderHours;
  /** Absolute CTA URL back to the configurator. */
  ctaUrl: string;
  /** Absolute signed unsubscribe URL (purpose 'marketing_newsletter'). */
  unsubscribeUrl: string;
}

export interface AbandonedCartEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function abandonedCartEmailContent(
  locale: Locale,
  vars: AbandonedCartEmailVars,
  signoff: string,
): AbandonedCartEmailContent {
  const copy = commerceEmailContent.abandonedCart[locale];
  const tone =
    vars.reminderHours === 72 ? copy.last : vars.reminderHours === 1 ? copy.first : copy.gentle;
  const withBrand = (text: string) => text.split("{{brand}}").join(vars.brandName);

  const blocks: EmailBlock[] = [
    heading(withBrand(tone.heading)),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(withBrand(tone.intro)),
    paragraph(withBrand(tone.body)),
    button(tone.cta, vars.ctaUrl),
    paragraph(signoff),
    ...marketingUnsubscribeFooter(locale, vars.unsubscribeUrl),
  ];

  return {
    subject: withBrand(tone.subject),
    preheader: withBrand(tone.preheader),
    blocks,
  };
}
