// Shipment-delivered notice – content (the "what to say"), owned by commerce.
// Sent when the carrier marks the parcel delivered. Confirms delivery and points
// at the deployment's getting-started guide; the guide card is the only CTA.
// Chrome/transport live in communications + the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";
import { guideCardBlock } from "./guideCard.js";
import {
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface ShipmentDeliveredEmailVars {
  firstName: string | null;
  orderId: string;
  /** Site origin (absolute, no trailing slash) the guide links are built on. */
  siteOrigin: string;
  /** Optional deployment-specific context consumed by the selected copy pack. */
  petName?: string | null;
}

export interface ShipmentDeliveredEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function shipmentDeliveredEmailContent(
  locale: Locale,
  vars: ShipmentDeliveredEmailVars,
  signoff: string,
): ShipmentDeliveredEmailContent {
  const copy = commerceEmailContent.shipmentDelivered[locale];
  const orderRef = formatCustomerOrderReference(
    vars.orderId,
    commerceEmailContent.orderRefPrefix,
  );
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(orderRef, vars.petName ?? null)),
    guideCardBlock(copy.startGuide, vars.siteOrigin, vars.petName ?? null),
  ];

  blocks.push(paragraph(copy.outro));
  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject(orderRef),
    preheader: copy.preheader,
    blocks,
  };
}
