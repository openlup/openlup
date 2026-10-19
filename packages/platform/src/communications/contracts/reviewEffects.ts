import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import {
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

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

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createReviewEffectsContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "reviewEffects">;
  marketingUnsubscribeFooter: (locale: Locale, unsubscribeUrl: string) => EmailBlock[];
}) {
  const { commerceEmailContent, marketingUnsubscribeFooter } = input;

  function reviewEffectsEmailContent(
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
  return { reviewEffectsEmailContent };
}
