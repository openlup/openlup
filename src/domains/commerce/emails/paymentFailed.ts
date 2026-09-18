// Recoverable payment-failed notice — content (the "what to say"), owned by
// commerce. Terminal expiry uses checkoutExpired so we never send "still active"
// copy after the reservation window closes.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { commerceEmailContent } from "#commerce-email-content";
import { formatCustomerOrderReference } from "./orderRef.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface PaymentFailedEmailVars {
  firstName: string | null;
  orderId: string;
  /** Formatted gross total, e.g. "129,99 zł", or null when unknown. */
  amountLabel: string | null;
  mode: "subscription_cycle" | "one_time";
  /** Absolute tokenized /konto/... recovery URL for the same order context. */
  recoveryUrl: string;
}

export interface PaymentFailedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function paymentFailedEmailContent(
  locale: Locale,
  vars: PaymentFailedEmailVars,
  signoff: string,
): PaymentFailedEmailContent {
  const copy = commerceEmailContent.paymentFailed[locale];
  const orderRef = formatCustomerOrderReference(vars.orderId, commerceEmailContent.orderRefPrefix);
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(orderRef)),
    accentBox(copy.details(vars.amountLabel, vars.mode), { label: copy.detailsLabel }),
    button(copy.cta, vars.recoveryUrl),
  ];

  blocks.push(paragraph(copy.outro));
  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject(orderRef),
    preheader: copy.preheader,
    blocks,
  };
}
