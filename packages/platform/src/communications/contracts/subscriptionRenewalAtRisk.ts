import type { SubscriptionEmailContent } from "./subscriptionEmailContent.js";
import type { PaymentFailureCustomerCause } from "@openlup/core/payment";
import type { Locale } from "./email.js";
import {
  accentBox,
  button,
  heading,
  paragraph,
  type EmailBlock,
} from "./blocks.js";

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

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionRenewalAtRiskContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "renewalAtRisk">;
  subscriptionPaymentCauseSentence: (locale: Locale, cause: PaymentFailureCustomerCause) => string | null;
}) {
  const { subscriptionEmailContent, subscriptionPaymentCauseSentence } = input;

  /** Render-time only. See the ⛔ above before touching either side of this map. */
  const SHARED_CAUSE: Record<SubscriptionRenewalAtRiskCause, PaymentFailureCustomerCause> = {
    mandate: "method_cannot_recur",
    missing: "method_missing",
  };

  /**
   * Both of this rail's causes state something about the stored method, so both
   * have a shared sentence and neither can be `unknown`. The non-null assertion is
   * carried by the `SHARED_CAUSE` map's exhaustive typing, not by an assumption.
   */
  function causeSentence(locale: Locale, cause: SubscriptionRenewalAtRiskCause): string {
    return subscriptionPaymentCauseSentence(locale, SHARED_CAUSE[cause]) ?? "";
  }

  function subscriptionRenewalAtRiskEmailContent(
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
  return { subscriptionRenewalAtRiskEmailContent };
}
