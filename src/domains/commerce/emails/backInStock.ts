// Back-in-stock alert – content (the "what to say"), owned by commerce. Fired
// when a sku a customer subscribed to is restocked. Marketing-class email: the
// caller MUST append the marketing
// unsubscribe footer (the handler does, building the signed token). Chrome /
// transport live in communications + the marketing Resend port; this module
// only assembles the localized subject + blocks (no footer – the handler spreads
// marketingUnsubscribeFooter onto the end).

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import {
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

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

export function backInStockEmailContent(
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
