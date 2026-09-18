// Order-cancellation notice — content (the "what to say"), owned by commerce.
// Dormant until a real paid-order cancel + refund producer exists. The selected
// copy must not promise refund behavior the system has not guaranteed.

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

export interface OrderCanceledEmailVars {
  firstName: string | null;
  orderId: string;
  /** Formatted gross total, e.g. "129,99 zł", or null when unknown. */
  amountLabel: string | null;
  /** Absolute CTA URL (back to shop); null/absent → no button. */
  ctaUrl?: string | null;
  /** Optional context name for the selected return note. */
  petName?: string | null;
}

export interface OrderCanceledEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function orderCanceledEmailContent(
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
    paragraph(copy.returnNote(vars.petName ?? null)),
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
