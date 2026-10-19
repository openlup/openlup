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

export interface SubscriptionPaymentFailedEmailVars {
  firstName: string | null;
  /** Formatted gross amount that failed, e.g. "129,99 zł", or null when unknown. */
  amountLabel: string | null;
  /** Dunning retry attempt: 1 (gentle), 2 (reminder), 3+ (final retry announced). */
  retryAttempt: number;
  /** Absolute recovery URL (localized); null/absent → no button. */
  recoveryUrl?: string | null;
  /**
   * Pre-formatted calendar day of the scheduled next charge, in the merchant's
   * zone (e.g. "11.08.2026"). The dunning row that selects THIS template always
   * carries a scheduled retry, so in production this is present; null keeps the
   * pre-date sentence rather than printing a placeholder date.
   */
  nextRetryDateLabel?: string | null;
  /** Card scheme as stored on the method's consent snapshot, e.g. "visa". */
  methodScheme?: string | null;
  /** Trailing digits of the stored method, e.g. "4242". */
  methodLastDigits?: string | null;
  /**
   * Why the charge was refused, in the payer-facing vocabulary. Absent or
   * `unknown` renders no cause sentence at all — see `subscriptionPaymentCauseCopy`.
   */
  cause?: PaymentFailureCustomerCause | null;
  /**
   * Whether the ladder scheduled a further charge for this cycle. Absent or
   * `true` is today's rail and today's copy. `false` states that no further
   * attempt is coming and leaves the CTA as the only remedy; any
   * `nextRetryDateLabel` supplied alongside it is ignored rather than printed,
   * because a date is only ever printed as part of a retry promise.
   */
  retryScheduled?: boolean;
}

export interface SubscriptionPaymentFailedEmailContent {
  subject: string;
  preheader: string;
  blocks: EmailBlock[];
}

/** Bind host-selected copy and pure helpers without provider or environment access. */
export function createSubscriptionPaymentFailedContentFactory(input: {
  subscriptionEmailContent: Pick<SubscriptionEmailContent, "paymentFailed">;
  subscriptionPaymentCauseSentence: (locale: Locale, cause: PaymentFailureCustomerCause) => string | null;
}) {
  const { subscriptionEmailContent, subscriptionPaymentCauseSentence } = input;

  function subscriptionPaymentFailedEmailContent(
    locale: Locale,
    vars: SubscriptionPaymentFailedEmailVars,
    signoff: string,
  ): SubscriptionPaymentFailedEmailContent {
    const copy = subscriptionEmailContent.paymentFailed[locale];
    // Method facts are additive and BOTH halves must be present: "karta Visa ••••"
    // with no digits identifies nothing, and bare digits with no scheme is worse.
    // Absent facts drop the sentence rather than render a placeholder.
    const scheme = vars.methodScheme?.trim() || null;
    const lastDigits = vars.methodLastDigits?.trim() || null;
    // The cause leads the box: it is the answer to the question the subject line
    // just raised, and the amount means little until the reader knows why. It is
    // also why it is PREPENDED and never appended — the retry sentence must stay
    // last (see below).
    const causeSentence = subscriptionPaymentCauseSentence(locale, vars.cause ?? "unknown");
    // Only an explicit `false` turns the promises off. Absent means "no producer
    // told us", and the only rail that exists always schedules a retry, so absent
    // must keep rendering today's copy rather than the safer-sounding new copy:
    // telling a customer no attempt is coming when one is would push them to
    // cancel a subscription that was about to recover on its own.
    const retryScheduled = vars.retryScheduled !== false;
    const detail = [
      ...(causeSentence ? [causeSentence] : []),
      vars.amountLabel
        ? copy.amountLine(vars.amountLabel)
        : retryScheduled
          ? copy.noAmountLine
          : copy.noAmountLineNoRetry,
      ...(scheme && lastDigits ? [copy.methodLine(scheme, lastDigits)] : []),
      // Kept LAST in the box on purpose: the retry sentence is the one the
      // characterization pins read off the end of `accentBox.lines`. Its
      // no-retry replacement takes the same position for the same reason.
      retryScheduled
        ? copy.reassurance(vars.retryAttempt, vars.nextRetryDateLabel?.trim() || null)
        : copy.noRetryAction,
    ];
    const blocks: EmailBlock[] = [
      heading(copy.heading),
      paragraph(copy.greeting(vars.firstName)),
      paragraph(copy.intro),
      accentBox(detail),
    ];

    if (vars.recoveryUrl) {
      blocks.push(button(copy.cta, vars.recoveryUrl));
    }

    blocks.push(paragraph(copy.outro));
    blocks.push(paragraph(signoff));

    return {
      subject: copy.subject,
      preheader: copy.preheader,
      blocks,
    };
  }
  return { subscriptionPaymentFailedEmailContent };
}
