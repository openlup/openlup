import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface SubscriptionPaymentRecoveredEmailVars {
  firstName: string | null;
  /** Formatted gross amount of the recovered cycle, e.g. "129,99 zł", or null. */
  amountLabel: string | null;
}

export interface SubscriptionPaymentRecoveredEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionPaymentRecoveredContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "paymentRecovered">;
}) {
  const { subscriptionEmailContent } = input;

  function subscriptionPaymentRecoveredEmailContent(
    locale: Locale,
    vars: SubscriptionPaymentRecoveredEmailVars,
    signoff: string,
  ): SubscriptionPaymentRecoveredEmailContent {
    const copy = subscriptionEmailContent.paymentRecovered[locale];
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro),
      accentBox(copy.detail(vars.amountLabel)),
      paragraph(copy.outro),
      paragraph(signoff),
    ];

    return {
      subject: copy.subject,
      preheader: copy.preheader,
      blocks,
    };
  }
  return { subscriptionPaymentRecoveredEmailContent };
}
