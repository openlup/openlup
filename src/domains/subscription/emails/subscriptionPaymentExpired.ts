// Subscription dunning – payment-expired notice (the "what to say"), owned by the
// subscription domain. Sent when the dunning case expires (all retries exhausted)
// and the subscription is paused. Chrome/transport live in communications + the
// Resend port.
//
// This template used to be support-led on purpose: there was no way out of an
// expired case that did not strand the subscription, so offering a link would
// have collected a card and then reported a false success. There is one now
// (`subscription_resume_after_expired_dunning`), reachable from the recovery
// link and from the account page, so the CTA is real and rendered whenever the
// producer supplies a URL. With no URL the copy falls back to the support path
// unchanged — a missing link must never become a dead button.

import type { PaymentFailureCustomerCause } from "@openlup/core/payment";
import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { subscriptionEmailContent } from "#subscription-email-content";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "../../communications/email/blocks.js";
import { subscriptionPaymentCauseSentence } from "../subscriptionPaymentCauseCopy.js";

export interface SubscriptionPaymentExpiredEmailVars {
  firstName: string | null;
  /** Formatted gross amount of the unpaid cycle, e.g. "129,99 zł", or null. */
  amountLabel: string | null;
  /**
   * Why the charges were refused, in the payer-facing vocabulary. This template
   * needs it most: "after several attempts" without a reason is the one place
   * the rail asks for trust and offers nothing to trust. Absent or `unknown`
   * renders no cause sentence.
   */
  cause?: PaymentFailureCustomerCause | null;
  /**
   * Recovery-link URL for the case's `resume_subscription` token. When present
   * the template renders the resume CTA; when absent it keeps the support-led
   * wording, because a button with no destination is worse than no button.
   */
  recoveryUrl?: string | null;
}

export interface SubscriptionPaymentExpiredEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

export function subscriptionPaymentExpiredEmailContent(
  locale: Locale,
  vars: SubscriptionPaymentExpiredEmailVars,
  signoff: string,
): SubscriptionPaymentExpiredEmailContent {
  const copy = subscriptionEmailContent.paymentExpired[locale];
  const recoveryUrl = vars.recoveryUrl?.trim() ? vars.recoveryUrl.trim() : null;
  const causeSentence = subscriptionPaymentCauseSentence(locale, vars.cause ?? "unknown");
  const detail = [
    // Leads the box for the same reason as in the failed notice: it answers the
    // question the paused subscription raises, before the figures.
    ...(causeSentence ? [causeSentence] : []),
    ...(recoveryUrl
      ? [
          vars.amountLabel ? copy.detail(vars.amountLabel)[0] : copy.detail(null)[0],
          copy.ctaDetail,
        ]
      : copy.detail(vars.amountLabel)),
  ];

  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro),
    accentBox(detail),
  ];

  if (recoveryUrl) blocks.push(button(copy.cta, recoveryUrl));

  blocks.push(paragraph(copy.outro));
  blocks.push(paragraph(signoff));

  return {
    subject: copy.subject,
    preheader: recoveryUrl ? copy.preheaderWithCta : copy.preheader,
    blocks,
  };
}
