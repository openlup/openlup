// Returns/RMA customer notices — content (the "what to say"), owned by commerce.
// Three transactional emails in the return lifecycle:
//   - approved: we accepted the return request and link to the public guide.
//   - rejected: we could not accept the return; why, and what to do.
//   - refunded: the refund has been issued.
// Chrome/transport live in communications + the Resend port (Node renderer only;
// no mirror needed: every sender has been Node since 2026-09-04).

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

export function returnApprovedEmailContent(
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

export function returnRejectedEmailContent(
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

export function returnRefundedEmailContent(
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
