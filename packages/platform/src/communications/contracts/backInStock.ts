import type { CommerceEmailContent } from "./commerceEmailContent.js";
import type { Locale } from "./email.js";
import {
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

export interface BackInStockEmailVars {
  /** Consumer-facing brand label injected by the app/composition root. */
  brandName: string;
  /** The sku that came back. Used for context/keying – never shown in copy. */
  sku: string;
  /**
   * Resolved, localized product name. When unknown (catalog miss / failure) the
   * copy falls back to a generic localized label – a raw sku must never surface
   * in a customer-facing subject or body.
   */
  productName?: string | null;
  /** Absolute CTA URL (product page or configurator). null/absent → no button. */
  ctaUrl?: string | null;
}

export interface BackInStockEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createBackInStockContentFactory(input: {
  commerceEmailContent: Pick<CommerceEmailContent, "backInStock">;
}) {
  const { commerceEmailContent } = input;

  function backInStockEmailContent(
    locale: Locale,
    vars: BackInStockEmailVars,
    signoff: string,
  ): BackInStockEmailContent {
    const copy = commerceEmailContent.backInStock[locale];
    const productLabel =
      vars.productName && vars.productName.trim() !== ""
        ? vars.productName.trim()
        : copy.genericLabel;
    const withBrand = (text: string) => text.split("{{brand}}").join(vars.brandName);

    const blocks: EmailBlock[] = [
      heading(copy.heading(productLabel)),
      paragraph(copy.greeting),
      paragraph(copy.intro(productLabel)),
      paragraph(withBrand(copy.hook)),
    ];

    if (vars.ctaUrl) {
      blocks.push(button(copy.cta, vars.ctaUrl));
    }

    blocks.push(paragraph(signoff));

    return {
      subject: withBrand(copy.subject(productLabel)),
      preheader: copy.preheader,
      blocks,
    };
  }
  return { backInStockEmailContent };
}
