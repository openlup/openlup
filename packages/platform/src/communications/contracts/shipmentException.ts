import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

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

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createShipmentExceptionContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "shipmentException" | "orderRefPrefix">;
  formatCustomerOrderReference: (orderId: string, prefix: string) => string;
}) {
  const { commerceEmailContent, formatCustomerOrderReference } = input;

  function shipmentExceptionEmailContent(
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
  return { shipmentExceptionEmailContent };
}
