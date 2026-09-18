/**
 * When a checkout wait may escalate from polling our own database to reading the
 * payment provider live.
 *
 * The wait page polls payment-control state, which only a webhook or the
 * adopter-configured reconciliation worker can move. That is sufficient for a rail that
 * reports a refusal — but BLIK reports declines through NO webhook at all
 * (`tr_status` only ever carries `true` or `chargeback`), so a refused BLIK
 * leaves the database saying `processing` until the next cron run. Measured on
 * order 83A12D4A: the bank refused inside the transaction's creation minute and
 * our database learned of it 15 minutes later, by which time the buyer had long
 * since left an untimed spinner.
 *
 * The card path already solves this by asking the server to read the provider
 * NOW, but it can only trigger on a client-side confirm failure, which a BLIK
 * decline never produces. This policy is the missing trigger: it escalates a
 * wait that our own database cannot explain.
 *
 * Three bounds, because a readback costs one provider API call per waiting
 * browser and an unbounded cadence would turn a display defect into a payment
 * outage:
 *
 *   - a delay before the first readback, since a buyer must physically confirm
 *     in their banking app and an immediate read would only ever say `pending`;
 *   - a minimum interval between readbacks;
 *   - a hard cap on how many a single wait may ever make. The cap, not elapsed
 *     time, is what bounds cost when a buyer abandons the tab open. Past it the
 *     page falls back to database-only polling and the reconciliation cron
 *     remains the safety net it has always been.
 */

/** Long enough that the buyer has had a chance to confirm; far below the cron. */
export const FIRST_PROVIDER_READBACK_DELAY_MS = 8_000;

export const PROVIDER_READBACK_INTERVAL_MS = 10_000;

/**
 * Together with the delay and interval this covers roughly the first two
 * minutes of a wait — the window a BLIK confirmation actually lives in.
 */
export const MAX_PROVIDER_READBACKS = 12;

export interface ProviderReadbackDecisionInput {
  /** Milliseconds since this wait began. */
  elapsedMs: number;
  /** How many readbacks this wait has already made. */
  readbackCount: number;
  /** `elapsedMs` recorded at the previous readback, or null when none was made. */
  lastReadbackAtMs: number | null;
}

/**
 * Whether this poll tick should also read the provider. Callers pass elapsed
 * time rather than wall-clock instants so the decision stays independent of the
 * clock and directly testable.
 */
/**
 * How long this page may go on saying "to zwykle kilka sekund" before that
 * sentence stops being true.
 *
 * Sized off the longest wait any rail can legitimately still be in. That is the
 * Model O mandate grace of {@link SUBSCRIPTION_ACTIVATION_GRACE_MS} (2 min),
 * after which the server itself resolves the wait into `action_required` — a
 * state this page already renders with its own repair CTA. The provider
 * readbacks above are exhausted at ~2 min too, so past this cap nothing new can
 * be learned here at all: the reconciliation worker owns the attempt; adopters must configure
 * a maximum reconciliation lag of 30 minutes or less once it becomes eligible at 15 minutes.
 *
 * ⛔ Reaching the cap is NOT a failure and must never be rendered as one. The
 * two populations that reach it are a BLIK code nobody confirmed and a bank
 * transfer the payer cancelled — but a payment we simply have no answer for
 * looks identical from here, so the honest statement is "no confirmation yet",
 * never "it failed" and never "try again".
 *
 * ⚠️ The cap changes what the wait SAYS, not whether it listens. Polling
 * continues past it at a slower cadence, so the first screen's promise — that it
 * changes by itself — still holds. What stops at the cap is the provider
 * readback, which is where the cost actually is.
 *
 * Set to the grace itself rather than the grace plus a buffer: the one-time code
 * the buyer is being asked to confirm does not outlive it either, so a longer
 * wait would keep asking for an approval that can no longer land.
 */
export const PAYMENT_WAIT_CAP_MS = 120_000;

/** Has the wait run out of things it can honestly still promise? */
export function hasExhaustedPaymentWait(elapsedMs: number): boolean {
  return elapsedMs >= PAYMENT_WAIT_CAP_MS;
}

export function shouldReadBackProvider({
  elapsedMs,
  readbackCount,
  lastReadbackAtMs,
}: ProviderReadbackDecisionInput): boolean {
  if (readbackCount >= MAX_PROVIDER_READBACKS) return false;
  if (lastReadbackAtMs === null) return elapsedMs >= FIRST_PROVIDER_READBACK_DELAY_MS;
  return elapsedMs - lastReadbackAtMs >= PROVIDER_READBACK_INTERVAL_MS;
}
