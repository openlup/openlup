// Subscription dunning – at-risk renewal notice (the "what to say"), owned by
// the subscription domain. Sent a few days BEFORE a renewal that is already
// known to be unchargeable, so the customer can repair the method while there is
// still time. The failure emails this rail sends today all arrive after the
// money path has already refused the charge.
//
// Two causes, one message. The copy states which of them applies in neutral
// language, because the customer's action is identical either way and the
// difference matters only for whether "the stored method" exists at all:
//
//   * `mandate`  – there IS a stored method, but the consent recorded with it
//                  declares an autopayment model the rail cannot use without the
//                  customer present. Saying "your card was declined" would be
//                  false; nothing has been attempted.
//   * `missing`  – there is no usable stored method for this subscription.
//
// Capped at two sends per (subscription, cause) by the producer, which is why
// this module carries no "we've told you before" wording: the second message is
// identical to the first on purpose, and there is never a third.
//
// Purely transactional under PKE discipline — it states a date, a cause and one
// repair link, and sells nothing. Chrome/transport live in communications + the
// transport port.

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

/**
 * Which of the two unchargeable states produced this notice.
 *
 * ⛔ THESE TWO TOKENS ARE LEDGER IDENTITY, NOT COPY KEYS. The producer's dedupe
 * key AND its two-send cap are one string, `<subscriptionId>:<cause>:<day>`, and
 * the cap is read back by matching this token as a LIKE prefix. Renaming either
 * value — including "aligning" it with the shared cause vocabulary below —
 * silently resets every cap ever recorded, because the new prefix matches
 * nothing. The mapping to the shared vocabulary therefore happens at RENDER
 * time, here, and never in the producer.
 */
export type SubscriptionRenewalAtRiskCause = "mandate" | "missing";

/** Render-time only. See the ⛔ above before touching either side of this map. */
const SHARED_CAUSE: Record<SubscriptionRenewalAtRiskCause, PaymentFailureCustomerCause> = {
  mandate: "method_cannot_recur",
  missing: "method_missing",
};

export interface SubscriptionRenewalAtRiskEmailVars {
  firstName: string | null;
  /** Calendar day of the scheduled renewal in the merchant zone, or null. */
  renewalDateLabel: string | null;
  cause: SubscriptionRenewalAtRiskCause;
  /** Account payments deep link; the same one the activation-gap email uses. */
  ctaUrl: string;
}

export interface SubscriptionRenewalAtRiskEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}


/**
 * Both of this rail's causes state something about the stored method, so both
 * have a shared sentence and neither can be `unknown`. The non-null assertion is
 * carried by the `SHARED_CAUSE` map's exhaustive typing, not by an assumption.
 */
function causeSentence(locale: Locale, cause: SubscriptionRenewalAtRiskCause): string {
  return subscriptionPaymentCauseSentence(locale, SHARED_CAUSE[cause]) ?? "";
}

export function subscriptionRenewalAtRiskEmailContent(
  locale: Locale,
  vars: SubscriptionRenewalAtRiskEmailVars,
  signoff: string,
): SubscriptionRenewalAtRiskEmailContent {
  const copy = subscriptionEmailContent.renewalAtRisk[locale];
  const blocks: EmailBlock[] = [
    heading(copy.heading),
    paragraph(copy.greeting(vars.firstName)),
    paragraph(copy.intro(vars.renewalDateLabel)),
    accentBox([causeSentence(locale, vars.cause), copy.consequence]),
    button(copy.cta, vars.ctaUrl),
    paragraph(copy.outro),
    paragraph(signoff),
  ];

  return {
    subject: copy.subject,
    preheader: copy.preheader,
    blocks,
  };
}
