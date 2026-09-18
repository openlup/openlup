// Post-delivery review request – content (the "what to say"), owned by commerce.
// The FIRST of two review touchpoints: a warm first-impression request sent a
// few days after delivery. Longer-term feedback gets its own 14-60 day email
// (reviewEffects). CTA to the anon review form
// (baseUrl + '/recenzja/'+token PL, '/review/'+token EN) + the mandatory
// marketing unsubscribe footer. MARKETING (consent-gated, one-click opt-out),
// not transactional – chrome/transport live in communications + marketing port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import {
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";
import { marketingUnsubscribeFooter } from "../../communications/email/marketingFooter.js";

export interface ReviewRequestEmailVars {
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

export interface ReviewRequestEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function reviewRequestEmailContent(
  locale: Locale,
  vars: ReviewRequestEmailVars,
  signoff: string,
): ReviewRequestEmailContent {
  const copy = commerceEmailContent.reviewRequest[locale];
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(vars.contextName ?? null)),
    paragraph(copy.body),
    button(copy.cta, vars.reviewUrl),
    paragraph(copy.outro),
    paragraph(signoff),
    ...marketingUnsubscribeFooter(locale, vars.unsubscribeUrl),
  ];

  return {
    subject: copy.subject,
    preheader: copy.preheader.split("{{brand}}").join(vars.brandName),
    blocks,
  };
}

/** Build the absolute review-form URL for the locale. */
export function reviewFormUrl(baseUrl: string, locale: Locale, token: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = locale === "en" ? "/review/" : "/recenzja/";
  return `${base}${path}${encodeURIComponent(token)}`;
}
