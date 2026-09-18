// Checkout-recovery email handler (W3, transactional). Consumes the
// commerce.checkout_recovery outbox events produced by the W2 enqueue cron and
// sends a "finish your payment" email with a signed deep-link to complete payment
// for the SAME unpaid order. Transactional: NO marketing-consent gate. Promotes
// the W2 producer from dormant to runtime-gated.
//
// Three producers feed this one handler: the W2 cron, the operator payment-link
// command (`operatorIssued: true`), and the buyer's own escape hatch off a payment
// step that will not finish (`buyerRequested: true`). They differ in one place
// only — which eligibility question is asked below — and share the template, the
// dedupe ledger and the deep-link build.
//
// handle() flow: parse the minimal payload -> resolve recipient by order ->
// dedupe on the email_sends ledger -> build the localized deep-link from the raw
// recovery token -> send -> map the provider outcome to a worker outcome.

import { z } from "zod";
import { mapResendOutcome, truncateReason } from "../../shared/mapResendOutcome.js";
import { resolveLocale } from "../../../src/lib/i18n/resolveLocale.js";
import { COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import {
  OUTBOX_CHECKOUT_RECOVERY_TEMPLATE_SLUG,
  type OrderPaymentLifecyclePort,
  type TransactionalEmailPort,
  type OrderRecipientPort,
} from "./outboxOrderDraftEmailPorts.js";
import {
  PAYMENT_SESSION_ACTIVE,
  shouldSkipCheckoutRecovery,
  shouldSkipOperatorCheckoutRecovery,
} from "./orderEmailEligibility.js";
import type {
  OutboxEventRow,
  OutboxHandler,
  OutboxHandlerOutcome,
} from "./outboxDispatchContracts.js";

const HANDLER_TIMEOUT_MS = 10_000;

// Deferrals allowed before a nudge blocked by a live payment session retires.
// The dispatcher's default backoff is 60 s doubling to a 3600 s cap, so five
// attempts span ~31 min — past the 15 min activity window that produced the
// skip, and well inside the 120 min subscription sweep that would cancel the
// order anyway. It also sits under the default `maxAttempts` of 8: exhausting
// retries routes a row to the terminal DLQ as `discarded`, which records a
// dispatch failure for a reminder that was merely untimely. Retiring as
// `processed` keeps it an honest deliberate skip. A deployment that configures
// `maxAttempts` below this ceiling has chosen fewer retries globally, and gets
// that choice here too.
const PAYMENT_SESSION_RETRY_CEILING = 5;

// Frozen minimal parse: orderId (recipient + linkage) and recoveryToken (the
// deep-link) are load-bearing; mode/reminderHours degrade to safe defaults so a
// producer tweak never retro-DLQs an in-flight reminder.
//
// `operatorIssued` says a human minted this link on the operator surface rather
// than the cron finding an abandoned order. `buyerRequested` says the BUYER asked
// for it, from inside the payment step they are stuck on. Both optional, and
// absent means the cron: every row already in flight when either shipped keeps
// its exact behaviour.
const payloadSubsetSchema = z
  .object({
    orderId: z.guid(),
    recoveryToken: z.string().min(1),
    mode: z.string().optional(),
    reminderHours: z.number().int().positive().optional(),
    operatorIssued: z.boolean().optional(),
    buyerRequested: z.boolean().optional(),
  })
  .passthrough();

export function createOutboxCheckoutRecoveryEmailHandler(deps: {
  emailPort: TransactionalEmailPort;
  recipientPort: OrderRecipientPort;
  lifecyclePort: OrderPaymentLifecyclePort;
}): OutboxHandler {
  return {
    eventType: COMMERCE_CHECKOUT_RECOVERY_EVENT_TYPE,
    timeoutMs: HANDLER_TIMEOUT_MS,
    async handle(row: OutboxEventRow, signal: AbortSignal): Promise<OutboxHandlerOutcome> {
      const parsed = payloadSubsetSchema.safeParse(row.payload);
      if (!parsed.success) {
        const detail = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "payload"}: ${issue.message}`)
          .join("; ");
        return { kind: "discard", reason: `contract_parse_failed: ${truncateReason(detail)}` };
      }

      const lifecycle = await deps.lifecyclePort.read(parsed.data.orderId, signal);
      // Three producers, three questions. The cron asks "is this order still
      // sitting unpaid", and going quiet once it is not is right. An
      // operator-issued link is a decision a human already made about an order
      // that has usually left `pending_payment` — expired is the ordinary case —
      // and the redeem rail recreates it when the customer opens the link.
      // Judging that by the cron's rule would skip it as
      // `order_not_pending_payment` and no-send in silence.
      const skipReason = parsed.data.buyerRequested
        ? skipReasonForBuyerRequestedRecovery(lifecycle)
        : parsed.data.operatorIssued
          ? shouldSkipOperatorCheckoutRecovery(lifecycle)
          : shouldSkipCheckoutRecovery(lifecycle);
      if (skipReason === PAYMENT_SESSION_ACTIVE) {
        // Transient, not terminal. The emit key is `checkout_recovery:1h:<order>`
        // (or `checkout_recovery:operator:<token row>`), once per event forever,
        // so returning `processed` here would destroy the only send this buyer
        // will ever get from this row — the failure mode that silenced the decline
        // notice on 2026-08-20. Defer instead and let the session settle.
        //
        // Read `attempts` defensively: `undefined < n` is false, which would
        // retire the nudge on its FIRST deferral — the precise opposite of the
        // intent here, and silent.
        const attempts = Number.isFinite(row.attempts) ? row.attempts : 0;
        if (attempts < PAYMENT_SESSION_RETRY_CEILING) {
          return { kind: "retry", reason: PAYMENT_SESSION_ACTIVE };
        }
        // Past the ceiling, retire deliberately. Letting retries run out routes
        // the row to the terminal DLQ as `discarded`, which reads as a dispatch
        // failure for a reminder that was only untimely.
        return { kind: "processed", detail: { skipped: "payment_session_exhausted" } };
      }
      if (skipReason) {
        return { kind: "processed", detail: { skipped: skipReason } };
      }

      const recipient = await deps.recipientPort.resolve(parsed.data.orderId, signal);
      if (recipient === null) {
        // No client on the order (or unreadable) — nothing to send, never retry.
        return { kind: "processed", detail: { skipped: "recipient_unresolved" } };
      }

      const alreadySent = await deps.emailPort.findExistingSend(
        OUTBOX_CHECKOUT_RECOVERY_TEMPLATE_SLUG,
        row.id,
      );
      if (alreadySent) {
        return { kind: "processed", detail: { dedupe: "email_already_sent" } };
      }

      const locale = resolveLocale(recipient.country ?? null);

      const outcome = await deps.emailPort.sendCheckoutRecovery({
        to: recipient.email,
        firstName: recipient.firstName,
        petName: recipient.petName ?? null,
        orderId: parsed.data.orderId,
        recoveryToken: parsed.data.recoveryToken,
        mode: parsed.data.mode ?? "one_time",
        reminderHours: parsed.data.reminderHours ?? 1,
        outboxEventId: row.id,
        // Marks the deep-link as the one the buyer mailed themselves off a stuck
        // payment step, so the landing page can tell that arrival apart from a
        // cron nudge. Absent for every other producer, which keeps their URLs
        // byte-identical to what they were.
        linkSource: parsed.data.buyerRequested ? "buyer_hatch" : undefined,
        locale,
        signal,
      });

      return mapResendOutcome(outcome);
    },
  };
}

/**
 * Eligibility for a link the BUYER asked for, from inside the payment step.
 *
 * Everything the operator rule suppresses is suppressed here too — the order is
 * gone, or the money is already in — because those make the email actively wrong
 * rather than merely late. Exactly ONE rule is lifted:
 * `payment_session_active`.
 *
 * That rule is a politeness rule: do not remind someone to pay while they are
 * paying. For this producer it is not merely unhelpful, it is inverted. A buyer
 * who taps this control is BY CONSTRUCTION inside a live payment session — that
 * session is the thing that will not finish, and asking for a way out of it is
 * the whole request. Deferring on it would defer every buyer row through the
 * retry ceiling and then retire it as `payment_session_exhausted`, so the hatch
 * would send nothing, ever, and nothing would report a failure.
 *
 * Written here rather than as a fourth predicate in `orderEmailEligibility`: it
 * is not a different question from the operator's, it is the operator's question
 * with its one transient answer already decided by who is asking.
 */
function skipReasonForBuyerRequestedRecovery(
  lifecycle: Parameters<typeof shouldSkipOperatorCheckoutRecovery>[0],
): string | null {
  const reason = shouldSkipOperatorCheckoutRecovery(lifecycle);
  return reason === PAYMENT_SESSION_ACTIVE ? null : reason;
}
