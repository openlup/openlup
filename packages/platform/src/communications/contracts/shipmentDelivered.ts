import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import { guideCardBlock } from "./guideCard.js";
import {
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface ShipmentDeliveredEmailVars {
  firstName: string | null;
  orderId: string;
  /** Site origin (absolute, no trailing slash) the guide links are built on. */
  siteOrigin: string;
  /** Optional deployment-specific context consumed by the selected copy pack. */
  contextName?: string | null;
}

export interface ShipmentDeliveredEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createShipmentDeliveredContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "shipmentDelivered" | "orderRefPrefix">;
  formatCustomerOrderReference: (orderId: string, prefix: string) => string;
}) {
  const { commerceEmailContent, formatCustomerOrderReference } = input;

  function shipmentDeliveredEmailContent(
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
      paragraph(copy.intro(orderRef, vars.contextName ?? null)),
      guideCardBlock(copy.startGuide, vars.siteOrigin, vars.contextName ?? null),
    ];

    blocks.push(paragraph(copy.outro));
    blocks.push(paragraph(signoff));

    return {
      subject: copy.subject(orderRef),
      preheader: copy.preheader,
      blocks,
    };
  }
  return { shipmentDeliveredEmailContent };
}
