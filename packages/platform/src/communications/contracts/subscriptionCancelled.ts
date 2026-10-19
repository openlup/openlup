import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

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

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionCancelledContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "cancelled">;
}) {
  const { subscriptionEmailContent } = input;

  function subscriptionCancelledEmailContent(
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
  return { subscriptionCancelledEmailContent };
}
