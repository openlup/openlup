import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import { accentBox, button, heading, paragraph, type EmailBlock } from "../../communications/email/blocks.js";

export interface SubscriptionActivationActionRequiredVars {
  firstName: string | null;
  ctaUrl: string;
}

export function subscriptionActivationActionRequiredEmailContent(
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
