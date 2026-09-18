// Checkout-expired notice — content (the "what to say"), owned by commerce.
// This template is only for terminal expired one-time checkouts.

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

export interface CheckoutExpiredEmailVars {
  firstName: string | null;
  orderId: string;
  amountLabel: string | null;
  ctaUrl?: string | null;
  ctaKind?: "recovery" | "compose";
}

export interface CheckoutExpiredEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function checkoutExpiredEmailContent(
  locale: Locale,
  vars: CheckoutExpiredEmailVars,
  signoff: string,
): CheckoutExpiredEmailContent {
  const copy = commerceEmailContent.checkoutExpired[
    vars.ctaKind === "recovery" ? "recovery" : "expired"
  ][locale];
  const orderRef = formatCustomerOrderReference(
    vars.orderId,
    commerceEmailContent.orderRefPrefix,
  );
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(orderRef)),
    accentBox(copy.details(vars.amountLabel), { label: copy.detailsLabel }),
  ];

  if (vars.ctaUrl) blocks.push(button(copy.cta, vars.ctaUrl));
  blocks.push(paragraph(copy.outro));
  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject(orderRef),
    preheader: copy.preheader,
    blocks,
  };
}
