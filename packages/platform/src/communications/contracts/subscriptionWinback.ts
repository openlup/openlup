import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { Locale } from "./email.js";
import type { SubscriptionWinbackCopy } from "./subscriptionEmailContent.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

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

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionWinbackContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "winback">;
}) {
  const { subscriptionEmailContent } = input;

  function subscriptionWinbackEmailContent(
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
  return { subscriptionWinbackEmailContent };
}
