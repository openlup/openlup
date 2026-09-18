// Shipment-exception notice – content (the "what to say"), owned by commerce.
// Sent only for customer-visible provider/carrier shipment exceptions on a paid
// order. Internal/manual-review holds (for example split-shipment unsupported)
// stay in OMS without this customer email. The notice is deliberately
// reassurance-only: it does NOT expose the internal reason, asks the customer to
// do nothing, and promises a follow-up. Chrome/transport live in communications
// + the Resend port; the CTA URL is passed in by the renderer.

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

export interface ShipmentExceptionEmailVars {
  firstName: string | null;
  orderId: string;
  /** Absolute URL to the customer's order/account page; null/absent → no button. */
  ctaUrl?: string | null;
}

export interface ShipmentExceptionEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function shipmentExceptionEmailContent(
  locale: Locale,
  vars: ShipmentExceptionEmailVars,
  signoff: string,
): ShipmentExceptionEmailContent {
  const copy = commerceEmailContent.shipmentException[locale];
  const orderRef = formatCustomerOrderReference(
    vars.orderId,
    commerceEmailContent.orderRefPrefix,
  );
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(orderRef)),
    accentBox(copy.reassurance, { label: copy.reassuranceLabel }),
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
