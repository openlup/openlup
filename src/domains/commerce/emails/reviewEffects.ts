// Review effects – content (the "what to say"), owned by commerce. The SECOND
// review touchpoint: sent at least 14 days after delivery, once enough time has
// passed for longer-term feedback. Same anon review form + token mechanism (baseUrl +
// '/recenzja/'+token PL, '/review/'+token EN), a DIFFERENT token (kind='effects'
// row) so it's a separate, second submission. MARKETING (consent-gated, one-click
// opt-out); chrome/transport live in communications + the marketing Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import {
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";
import { marketingUnsubscribeFooter } from "../../communications/email/marketingFooter.js";

export interface ReviewEffectsEmailVars {
  firstName: string | null;
  /** Consumer-facing brand label injected by the app/composition root. */
  brandName: string;
  /** Absolute CTA URL to the review form (baseUrl + locale review path + token). */
  reviewUrl: string;
  /** Absolute signed unsubscribe URL (purpose = 'marketing_newsletter'). */
  unsubscribeUrl: string;
  /** Optional product, service, or other review context label. */
  contextName?: string | null;
}

export interface ReviewEffectsEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function reviewEffectsEmailContent(
  locale: Locale,
  vars: ReviewEffectsEmailVars,
  signoff: string,
): ReviewEffectsEmailContent {
  const copy = commerceEmailContent.reviewEffects[locale];
  const withBrand = (text: string) => text.split("{{brand}}").join(vars.brandName);
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(vars.contextName ?? null, vars.brandName)),
    paragraph(copy.body),
    button(copy.cta, vars.reviewUrl),
    paragraph(copy.outro),
    paragraph(signoff),
    ...marketingUnsubscribeFooter(locale, vars.unsubscribeUrl),
  ];

  return {
    subject: withBrand(copy.subject),
    preheader: copy.preheader,
    blocks,
  };
}
