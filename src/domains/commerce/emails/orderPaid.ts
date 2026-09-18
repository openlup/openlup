// Paid-order confirmation – content (the "what to say"), owned by commerce. Sent
// when an order transitions to paid (commerce.order.paid.email event). Unlike the
// pre-payment order-draft nudge, this is a receipt: it confirms the order, lists
// the purchased items with prices + totals, and varies the intro by mode
// (one-time bundle vs subscription cycle). Chrome/transport live in
// communications + the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";
import {
  button,
  dataTable,
  heading,
  linkParagraph,
  list,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface OrderPaidLineItem {
  name: string;
  quantity: number;
  lineTotalLabel: string;
}

export interface OrderPaidTotals {
  /** null → omit the subtotal row (value unknown); never alias the grand total. */
  subtotalLabel: string | null;
  discountLabel: string | null;
  totalLabel: string;
  firstSubscription?: {
    catalogLabel: string;
    productPayableLabel: string;
    shippingLabel: string | null;
    shippingFree: boolean;
  };
}

export interface OrderPaidEmailVars {
  firstName: string | null;
  orderId: string;
  /** "one_time" | "subscription_cycle" (free-form); drives the intro framing. */
  mode: string;
  items: OrderPaidLineItem[];
  totals: OrderPaidTotals | null;
  /** Absolute CTA URL to the customer's order/account; null/absent → no button. */
  ctaUrl?: string | null;
  /**
   * Absolute URL of the shop terms (which include the §10 withdrawal-right
   * section and the model withdrawal form). Renders the consumer-law footer
   * link; the fine-print paragraph itself is always included (durable-medium
   * confirmation duty, art. 21 ustawy o prawach konsumenta).
   */
  termsUrl?: string | null;
  /** Optional context name for the selected post-receipt note. */
  petName?: string | null;
}

export interface OrderPaidEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

function itemLine(item: OrderPaidLineItem): string {
  const base = `${item.quantity}× ${item.name}`;
  return item.lineTotalLabel ? `${base} – ${item.lineTotalLabel}` : base;
}

export function orderPaidEmailContent(
  locale: Locale,
  vars: OrderPaidEmailVars,
  signoff: string,
): OrderPaidEmailContent {
  const copy = commerceEmailContent.orderPaid[locale];
  const orderRef = formatCustomerOrderReference(vars.orderId, commerceEmailContent.orderRefPrefix);
  const intro =
    vars.mode === "subscription_cycle"
      ? copy.introSubscription(orderRef)
      : copy.introOneTime(orderRef);

  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(intro),
  ];

  blocks.push(
    vars.items.length > 0 ? list(vars.items.map(itemLine)) : paragraph(copy.noItems),
  );

  if (vars.totals) {
    const rows: Array<{ label: string; value: string }> = [];
    if (vars.totals.firstSubscription) {
      rows.push({ label: copy.catalogProductsLabel, value: vars.totals.firstSubscription.catalogLabel });
      if (vars.totals.discountLabel) {
        rows.push({ label: copy.firstSubscriptionDiscountRowLabel, value: vars.totals.discountLabel });
      }
      rows.push({ label: copy.productPayableLabel, value: vars.totals.firstSubscription.productPayableLabel });
      if (vars.totals.firstSubscription.shippingFree) {
        rows.push({ label: copy.shippingLabel, value: copy.shippingFree });
      } else if (vars.totals.firstSubscription.shippingLabel) {
        rows.push({ label: copy.shippingLabel, value: vars.totals.firstSubscription.shippingLabel });
      }
    } else if (vars.totals.subtotalLabel) {
      rows.push({ label: copy.subtotalLabel, value: vars.totals.subtotalLabel });
    }
    if (!vars.totals.firstSubscription && vars.totals.discountLabel) {
      rows.push({ label: copy.discountRowLabel, value: vars.totals.discountLabel });
    }
    rows.push({
      label: vars.totals.firstSubscription ? copy.finalPaidLabel : copy.totalLabel,
      value: vars.totals.totalLabel,
    });
    blocks.push(dataTable(rows));
  }

  // Selected post-receipt copy is shown for both one-time and subscription-cycle
  // receipts, without changing the payment or delivery facts around it.
  blocks.push(paragraph(copy.receiptNote(vars.petName ?? null)));

  if (vars.ctaUrl) {
    blocks.push(button(copy.cta, vars.ctaUrl));
  }

  blocks.push(paragraph(copy.outro));

  // Durable-medium confirmation (art. 21 uPK): the receipt must carry the
  // withdrawal-right information alongside a link to the full terms + form.
  blocks.push(paragraph(copy.withdrawalNotice, { muted: true }));
  if (vars.termsUrl) {
    blocks.push(linkParagraph(copy.withdrawalLinkLabel, vars.termsUrl, { muted: true }));
  }

  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject(orderRef),
    preheader: copy.preheader,
    blocks,
  };
}
