import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

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

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createCheckoutExpiredContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "checkoutExpired" | "orderRefPrefix">;
  formatCustomerOrderReference: (orderId: string, prefix: string) => string;
}) {
  const { commerceEmailContent, formatCustomerOrderReference } = input;

  function checkoutExpiredEmailContent(
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
  return { checkoutExpiredEmailContent };
}
