// Order-draft confirmation – content (the "what to say"), owned by commerce.
// The order-draft outbox event fires when a customer has SAVED a composition but
// not yet finished checkout, so this is a resume nudge, not a paid-order receipt.
// Chrome/transport (the "how to render & send") lives in communications + the
// Resend port; this module only assembles localized subject + blocks.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import {
  button,
  dataTable,
  heading,
  list,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";
import { formatCustomerOrderReference } from "./orderRef.js";

export interface OrderDraftLineItem {
  /** Resolved, localized product name (or slug/sku fallback). */
  name: string;
  quantity: number;
  /** Formatted gross line total, e.g. "129,98 zł"; "" when price unknown. */
  lineTotalLabel: string;
}

export interface OrderDraftTotals {
  /** null → omit the subtotal row (value unknown); never alias the grand total. */
  subtotalLabel: string | null;
  /** Already sign-prefixed, e.g. "-20,00 zł"; null → no discount row. */
  discountLabel: string | null;
  totalLabel: string;
}

export interface OrderDraftEmailVars {
  firstName: string | null;
  /** Technical order id from outbox, e.g. "order_<uuid>". */
  orderId: string;
  /** Itemized order lines (name × qty + line total). */
  items: OrderDraftLineItem[];
  /** Money breakdown, or null when totals are unknown. */
  totals: OrderDraftTotals | null;
  /** Absolute CTA URL back to the configurator; null/absent → no button. */
  ctaUrl?: string | null;
  /**
   * Dog's name from the owner's survey, when known. Drives an optional warm
   * closing line. Absent/null (e.g. anonymous drafts) → the line is omitted.
   * Never inflect the copy by gender: the name doesn't reveal it.
   */
  petName?: string | null;
}

export interface OrderDraftEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

function itemLine(item: OrderDraftLineItem): string {
  const base = `${item.quantity}× ${item.name}`;
  return item.lineTotalLabel ? `${base} – ${item.lineTotalLabel}` : base;
}

export function orderDraftEmailContent(
  locale: Locale,
  vars: OrderDraftEmailVars,
  signoff: string,
): OrderDraftEmailContent {
  const copy = commerceEmailContent.orderDraft[locale];
  const orderRef = formatCustomerOrderReference(vars.orderId, commerceEmailContent.orderRefPrefix);
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(orderRef)),
  ];

  blocks.push(
    vars.items.length > 0
      ? list(vars.items.map(itemLine))
      : paragraph(copy.noItems),
  );

  if (vars.totals) {
    const rows: Array<{ label: string; value: string }> = [];
    if (vars.totals.subtotalLabel) {
      rows.push({ label: copy.subtotalLabel, value: vars.totals.subtotalLabel });
    }
    if (vars.totals.discountLabel) {
      rows.push({ label: copy.discountRowLabel, value: vars.totals.discountLabel });
    }
    rows.push({ label: copy.totalLabel, value: vars.totals.totalLabel });
    blocks.push(dataTable(rows));
  }

  if (vars.ctaUrl) {
    blocks.push(button(copy.cta, vars.ctaUrl));
  }

  blocks.push(paragraph(copy.outro));
  if (vars.petName) {
    blocks.push(paragraph(copy.personalizedClosing(vars.petName)));
  }
  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject(orderRef),
    preheader: copy.preheader,
    blocks,
  };
}
