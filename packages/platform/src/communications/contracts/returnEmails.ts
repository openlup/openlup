import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface ReturnEmailVars {
  firstName: string | null;
  orderId: string;
  /** Formatted gross refund total, e.g. "129,99 zł", or null when unknown. */
  amountLabel?: string | null;
  /** Absolute CTA URL appropriate for the state (returns guide / account / shop). */
  ctaUrl?: string | null;
}

export interface ReturnEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createReturnEmailsContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "returns" | "orderRefPrefix">;
  formatCustomerOrderReference: (orderId: string, prefix: string) => string;
}) {
  const { commerceEmailContent, formatCustomerOrderReference } = input;

  function returnApprovedEmailContent(
    locale: Locale,
    vars: ReturnEmailVars,
    signoff: string,
  ): ReturnEmailContent {
    const copy = commerceEmailContent.returns.approved[locale];
    const orderRef = formatCustomerOrderReference(
      vars.orderId,
      commerceEmailContent.orderRefPrefix,
    );
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro(orderRef)),
      accentBox([copy.returnAddressNotice]),
    ];
    if (vars.ctaUrl) {
      blocks.push(button(copy.cta, vars.ctaUrl));
    }
    blocks.push(paragraph(signoff));
    return {
      subject: copy.subject(orderRef),
      preheader: copy.preheader,
      blocks,
    };
  }

  function returnRejectedEmailContent(
    locale: Locale,
    vars: ReturnEmailVars,
    signoff: string,
  ): ReturnEmailContent {
    const copy = commerceEmailContent.returns.rejected[locale];
    const orderRef = formatCustomerOrderReference(
      vars.orderId,
      commerceEmailContent.orderRefPrefix,
    );
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro(orderRef)),
    ];
    if (vars.ctaUrl) blocks.push(button(copy.cta, vars.ctaUrl));
    blocks.push(paragraph(signoff));
    return {
      subject: copy.subject(orderRef),
      preheader: copy.preheader,
      blocks,
    };
  }

  function returnRefundedEmailContent(
    locale: Locale,
    vars: ReturnEmailVars,
    signoff: string,
  ): ReturnEmailContent {
    const copy = commerceEmailContent.returns.refunded[locale];
    const orderRef = formatCustomerOrderReference(
      vars.orderId,
      commerceEmailContent.orderRefPrefix,
    );
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(
        vars.amountLabel
          ? copy.amountKnown(vars.amountLabel, orderRef)
          : copy.amountUnknown(orderRef),
      ),
      paragraph(copy.returnNote),
    ];
    if (vars.ctaUrl) blocks.push(button(copy.cta, vars.ctaUrl));
    blocks.push(paragraph(signoff));
    return {
      subject: copy.subject(orderRef),
      preheader: copy.preheader,
      blocks,
    };
  }
  return { returnApprovedEmailContent, returnRejectedEmailContent, returnRefundedEmailContent };
}
