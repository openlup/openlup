// Subscription dunning – payment-recovered notice (the "what to say"), owned by
// the subscription domain. Sent once per dunning case after the case reaches
// `recovered`, whichever writer got it there (customer redeem, cron retry,
// reconciliation). Closes the loop the recovery page already promises:
// "Sprawdź skrzynkę pocztową. Wkrótce wyślemy potwierdzenie…".
//
// Deliberately CTA-free. The customer has just finished the only action this
// rail ever asked of them; a button here would invent a second one. Purely
// transactional under PKE discipline — it states what was charged and that
// deliveries continue, and sells nothing.
//
// Chrome/transport live in communications + the transport port.

import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import {
  accentBox,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";

export interface SubscriptionPaymentRecoveredEmailVars {
  firstName: string | null;
  /** Formatted gross amount of the recovered cycle, e.g. "129,99 zł", or null. */
  amountLabel: string | null;
}

export interface SubscriptionPaymentRecoveredEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionPaymentRecoveredEmailContent(
  locale: Locale,
  vars: SubscriptionPaymentRecoveredEmailVars,
  signoff: string,
): SubscriptionPaymentRecoveredEmailContent {
  const copy = subscriptionEmailContent.paymentRecovered[locale];
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro),
    accentBox(copy.detail(vars.amountLabel)),
    paragraph(copy.outro),
    paragraph(signoff),
  ];

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks,
  };
}
