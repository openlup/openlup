import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

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

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionResumedContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "resumed">;
}) {
  const { subscriptionEmailContent } = input;

  function subscriptionResumedEmailContent(
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
  return { subscriptionResumedEmailContent };
}
