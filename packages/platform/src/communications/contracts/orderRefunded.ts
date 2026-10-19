import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface OrderRefundedEmailVars {
  firstName: string | null;
  brandName: string;
  orderId: string;
  /** Formatted gross refund total, e.g. "129,99 zł", or null when unknown. */
  amountLabel: string | null;
  /** Absolute CTA URL (back to shop); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface OrderRefundedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createOrderRefundedContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "orderRefunded" | "orderRefPrefix">;
  formatCustomerOrderReference: (orderId: string, prefix: string) => string;
}) {
  const { commerceEmailContent, formatCustomerOrderReference } = input;

  function orderRefundedEmailContent(
    locale: Locale,
    vars: OrderRefundedEmailVars,
    signoff: string,
  ): OrderRefundedEmailContent {
    const copy = commerceEmailContent.orderRefunded[locale];
    const orderRef = formatCustomerOrderReference(vars.orderId, commerceEmailContent.orderRefPrefix);
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro(orderRef)),
      accentBox(copy.details(vars.amountLabel), { label: copy.detailsLabel }),
      paragraph(copy.returnNote(vars.brandName)),
    ];

    if (vars.ctaUrl) {
      blocks.push(button(copy.cta, vars.ctaUrl));
    }

    blocks.push(paragraph(copy.outro));
    blocks.push(paragraph(signoff));

    return {
      subject: copy.subject(orderRef),
      preheader: copy.preheader,
      blocks,
    };
  }
  return { orderRefundedEmailContent };
}
