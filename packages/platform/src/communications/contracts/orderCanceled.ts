import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface OrderCanceledEmailVars {
  firstName: string | null;
  orderId: string;
  /** Formatted gross total, e.g. "129,99 zł", or null when unknown. */
  amountLabel: string | null;
  /** Absolute CTA URL (back to shop); null/absent → no button. */
  ctaUrl?: string | null;
  /** Optional context name for the selected return note. */
  contextName?: string | null;
}

export interface OrderCanceledEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createOrderCanceledContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "orderCanceled" | "orderRefPrefix">;
  formatCustomerOrderReference: (orderId: string, prefix: string) => string;
}) {
  const { commerceEmailContent, formatCustomerOrderReference } = input;

  function orderCanceledEmailContent(
    locale: Locale,
    vars: OrderCanceledEmailVars,
    signoff: string,
  ): OrderCanceledEmailContent {
    const copy = commerceEmailContent.orderCanceled[locale];
    const orderRef = formatCustomerOrderReference(vars.orderId, commerceEmailContent.orderRefPrefix);
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro(orderRef)),
      accentBox(copy.details(vars.amountLabel), { label: copy.detailsLabel }),
      paragraph(copy.returnNote(vars.contextName ?? null)),
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
  return { orderCanceledEmailContent };
}
