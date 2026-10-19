import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { Locale } from "./email.js";
import { accentBox, button, heading, paragraph, type EmailBlock } from "./blocks.js";

export interface SubscriptionActivationActionRequiredVars {
  firstName: string | null;
  ctaUrl: string;
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionActivationActionRequiredContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "activationActionRequired">;
}) {
  const { subscriptionEmailContent } = input;

  function subscriptionActivationActionRequiredEmailContent(
    locale: Locale,
    vars: SubscriptionActivationActionRequiredVars,
    signoff: string,
  ): { subject: string; preheader: string; blocks: EmailBlock[] } {
    const copy = subscriptionEmailContent.activationActionRequired[locale];
    return {
      subject: copy.subject,
      preheader: copy.preheader,
      blocks: [
        heading(copy.heading),
        paragraph(copy.greeting(vars.firstName)),
        paragraph(copy.intro),
        accentBox(copy.facts),
        button(copy.cta, vars.ctaUrl),
        paragraph(copy.outro),
        paragraph(signoff),
      ],
    };
  }
  return { subscriptionActivationActionRequiredEmailContent };
}
