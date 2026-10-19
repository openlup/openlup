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

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionPaymentExpiredContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "paymentExpired">;
  subscriptionPaymentCauseSentence: (locale: Locale, cause: PaymentFailureCustomerCause) => string | null;
}) {
  const { subscriptionEmailContent, subscriptionPaymentCauseSentence } = input;

  function subscriptionPaymentExpiredEmailContent(
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
  return { subscriptionPaymentExpiredEmailContent };
}
