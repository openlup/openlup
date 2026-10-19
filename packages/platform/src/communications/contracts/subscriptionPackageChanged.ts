import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { Locale } from "./email.js";
import type { SubscriptionPackageChangedCopy } from "./subscriptionEmailContent.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface SubscriptionPackageChangedEmailVars {
  firstName: string | null;
  action?: string | null;
  /** Absolute CTA URL (manage subscription); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface SubscriptionPackageChangedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionPackageChangedContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "packageChanged">;
}) {
  const { subscriptionEmailContent } = input;

  function subscriptionPackageChangedEmailContent(
    locale: Locale,
    vars: SubscriptionPackageChangedEmailVars,
    signoff: string,
  ): SubscriptionPackageChangedEmailContent {
    const copy: SubscriptionPackageChangedCopy = subscriptionEmailContent.packageChanged[locale];
    const actionLabel = vars.action ? copy.actionLabels[vars.action] ?? null : null;
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro(actionLabel)),
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
  return { subscriptionPackageChangedEmailContent };
}
