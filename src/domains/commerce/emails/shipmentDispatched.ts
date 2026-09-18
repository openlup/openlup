// Shipment-dispatched notice – content (the "what to say"), owned by commerce.
// Sent when an order is handed to the carrier. Confirms the parcel is on its way,
// surfaces the tracking number and makes carrier tracking the primary action,
// with the account summary as a secondary link. Chrome/transport live in communications +
// the Resend port. The carrier and the tracking-URL shape stay out of here –
// the handler passes a ready absolute trackingUrl.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";
import { guideCardBlock } from "./guideCard.js";
import {
  accentBox,
  dataTable,
  heading,
  linkParagraph,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface ShipmentDispatchedEmailVars {
  firstName: string | null;
  orderId: string;
  /** Opaque carrier tracking number, or null when none is available. */
  trackingNumber: string | null;
  /** Absolute tracking URL (carrier page); rendered as a "track parcel" link. */
  trackingUrl?: string | null;
  /** Site origin (absolute, no trailing slash) the guide links are built on. */
  siteOrigin: string;
  /** Optional deployment-specific context consumed by the selected copy pack. */
  petName?: string | null;
}

export interface ShipmentDispatchedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function shipmentDispatchedEmailContent(
  locale: Locale,
  vars: ShipmentDispatchedEmailVars,
  signoff: string,
): ShipmentDispatchedEmailContent {
  const copy = commerceEmailContent.shipmentDispatched[locale];
  const orderRef = formatCustomerOrderReference(
    vars.orderId,
    commerceEmailContent.orderRefPrefix,
  );
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(orderRef)),
  ];

  // Tracking is the job-to-be-done of this message: the number and the
  // carrier page share one box, and the guide card is the only button.
  const trackLink = vars.trackingUrl ? { label: copy.trackParcel, href: vars.trackingUrl } : undefined;
  if (vars.trackingNumber) {
    blocks.push(dataTable([{ label: copy.trackingLabel, value: vars.trackingNumber }], { link: trackLink }));
  } else {
    blocks.push(accentBox(copy.noTracking, { label: copy.noTrackingLabel }));
    if (trackLink) blocks.push(linkParagraph(trackLink.label, trackLink.href));
  }

  blocks.push(guideCardBlock(copy.accountGuide, vars.siteOrigin, vars.petName ?? null));

  blocks.push(paragraph(copy.outro(vars.petName ?? null)));
  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject(orderRef),
    preheader: copy.preheader,
    blocks,
  };
}
