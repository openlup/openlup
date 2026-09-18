// Subscription dunning – payment-failed notice (the "what to say"), owned by the
// subscription domain. Sent when a subscription renewal charge fails and a retry
// is scheduled. Reassures, states the amount, and drives the customer to fix the
// payment method via a recovery link. Tone escalates gently by retry attempt.
// Chrome/transport live in communications + the Resend port.
//
// The escalated (attempt >= 3) line states the REAL remaining runway, not a
// scarier one. apply_result's ladder schedules the retry after attempt 3 at
// +168h and returns NULL from attempt 4 on. Only NULL AT OR PAST rung four is
// exhaustion, and only exhaustion routes the customer to
// `subscription-payment-expired` instead of this template
// (20260826170000_*.sql:210-224), so the >= 3 branch is only ever rendered at
// attempt 3 WITH a retry still to come: exactly one charge, seven days out.
// Changing the ladder means changing the "7 days" here.
//
// The concrete facts (W3): the scheduled retry DATE, and the stored method's
// scheme + trailing digits. Both arrive pre-resolved from the dispatch worker —
// this module formats copy, never reads a clock or a table. Every fact is
// optional and omitted when absent; the template never prints a placeholder,
// because a wrong date here is a promise the retry ladder cannot keep.
//
// `retryScheduled` (W7) is the one fact that changes what this notice PROMISES
// rather than what it states. Everything above assumes a further charge is
// coming. W9 made that conditional: a refusal classed `hard_do_not_retry` ends
// the ladder at the attempt it happened on while the case stays OPEN and the
// subscription ACTIVE, and that email must not say "we'll retry" next to "your
// card is dead". Passing `false` swaps both retry promises in this file — the
// reassurance line AND the amount fallback — for copy whose only remedy is the
// CTA.
//
// ⛔ It is a SEPARATE field, not the absence of `nextRetryDateLabel`, and the two
// must not be merged. A missing label already means "a retry exists, its date is
// unusable": `ClaimedDunningNotification.nextRetryAt` is null for a legacy or
// malformed payload too (subscriptionDunningDispatchPorts.ts:36-40), which is a
// defensive path and not a statement about the ladder. Keying the branch off
// absence would collapse the two.
//
// The producer is `subscriptionDunningDispatchWorker`, which asks the ladder's
// own `ladderTerminatedByClass` about the class it already read for the cause
// sentence. That predicate fails open in four ways, so every refusal this
// deployment does not explicitly list still renders exactly what it rendered
// before, which is what the W0/W3 characterization pins assert.

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

export function subscriptionPaymentFailedEmailContent(
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
