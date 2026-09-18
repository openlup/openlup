// Subscription delivery-address-changed confirmation – content, owned by the
// subscription domain. Sent when the customer updates the subscription shipping
// address via the self-service "Zmień adres" (change_shipping_address) action.
// Confirms future deliveries use the new address. Chrome/transport live in
// communications + the Resend port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface SubscriptionAddressChangedEmailVars {
  firstName: string | null;
  /** Absolute CTA URL (manage subscription); null/absent → no button. */
  ctaUrl?: string | null;
}

export interface SubscriptionAddressChangedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionAddressChangedEmailContent(
  locale: Locale,
  vars: SubscriptionAddressChangedEmailVars,
  signoff: string,
): SubscriptionAddressChangedEmailContent {
  const copy = subscriptionEmailContent.addressChanged[locale];
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro),
    accentBox(copy.reassurance),
  ];

  if (vars.ctaUrl) {
    blocks.push(button(copy.cta, vars.ctaUrl));
  }

  blocks.push(paragraph(copy.outro));
  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks,
  };
}
