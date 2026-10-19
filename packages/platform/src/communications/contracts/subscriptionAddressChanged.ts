import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface SubscriptionAddressChangedEmailVars {
  firstName: string | null;
  /** Absolute CTA URL (manage subscription); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface SubscriptionAddressChangedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionAddressChangedContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "addressChanged">;
}) {
  const { subscriptionEmailContent } = input;

  function subscriptionAddressChangedEmailContent(
    locale: Locale,
    vars: SubscriptionAddressChangedEmailVars,
    signoff: string,
  ): SubscriptionAddressChangedEmailContent {
    const copy = subscriptionEmailContent.addressChanged[locale];
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro),
      accentBox(copy.reassurance),
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
  return { subscriptionAddressChangedEmailContent };
}
