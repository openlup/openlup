// Refund confirmation – content (the "what to say"), owned by commerce. Sent when
// an order transitions to status='refunded'. Confirms the refund, shows the
// amount, sets the timing expectation, and offers a "back to shop" CTA. Chrome/
// transport live in communications + the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

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

export function orderRefundedEmailContent(
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
