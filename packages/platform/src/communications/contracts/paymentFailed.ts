import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface PaymentFailedEmailVars {
  firstName: string | null;
  orderId: string;
  /** Formatted gross total, e.g. "129,99 zł", or null when unknown. */
  amountLabel: string | null;
  mode: "subscription_cycle" | "one_time";
  /** Absolute tokenized /konto/... recovery URL for the same order context. */
  recoveryUrl: string;
}

export interface PaymentFailedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createPaymentFailedContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "paymentFailed" | "orderRefPrefix">;
  formatCustomerOrderReference: (orderId: string, prefix: string) => string;
}) {
  const { commerceEmailContent, formatCustomerOrderReference } = input;

  function paymentFailedEmailContent(
    locale: Locale,
    vars: PaymentFailedEmailVars,
    signoff: string,
  ): PaymentFailedEmailContent {
    const copy = commerceEmailContent.paymentFailed[locale];
    const orderRef = formatCustomerOrderReference(vars.orderId, commerceEmailContent.orderRefPrefix);
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro(orderRef)),
      accentBox(copy.details(vars.amountLabel, vars.mode), { label: copy.detailsLabel }),
      button(copy.cta, vars.recoveryUrl),
    ];

    blocks.push(paragraph(copy.outro));
    blocks.push(paragraph(signoff));

    return {
      subject: copy.subject(orderRef),
      preheader: copy.preheader,
      blocks,
    };
  }
  return { paymentFailedEmailContent };
}
