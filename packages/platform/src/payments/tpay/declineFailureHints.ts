import type { PaymentFailureHint, PaymentRetryAdviceCode } from "@openlup/core/payment";

/**
 * ⚠️ UNOFFICIAL INFERENCE — the whole table below.
 *
 * The provider publishes no retryable-versus-terminal classification for these
 * numeric refusal codes. Every row is this adapter's reading of the code's
 * documented MEANING, not a documented retry verdict, and one of them
 * (`"100"`) appears in no published table at all. Treat the table as a
 * hypothesis under test. The class it produces is already DISPLAY-load-bearing:
 * it becomes the sentence the payer reads about their own refusal, so a wrong
 * row here misinforms a customer today. It is still not a cadence input: the
 * dunning programme validates this table against the historical refusal corpus
 * before anything in the retry ladder is allowed to branch on it.
 *
 * The contract that would end the inference is OUTSTANDING, not absent: the
 * dunning programme's letter to the provider asks for the official meaning of
 * these codes, and is tracked there as an open item. Until it is answered, a row
 * may be read more narrowly than it is written — see `assertableHints` in
 * `tpayDeclineEvidence.ts`, where each observation decides how much of its own
 * reading it is entitled to state — but no row may be read more widely.
 *
 * Two rails read this table, and both reach it through the attempt log's
 * `paymentErrorCode`: the reconciliation poll, and — since the 2026-08-26
 * incident — the synchronous execution path, which until then decided a
 * mandate refusal by pattern-matching the refusal MESSAGE.
 *
 * Codes arrive as strings because that is how they leave the transport layer.
 *
 * Two rows carry a decision worth stating rather than a lookup:
 *
 *   - `"101"` (refused by the payer) and `"107"` (refused on security grounds)
 *     are NOT credential death — the instrument may be in perfect health and
 *     the payer may approve the very next charge on it. There is no hint for
 *     "terminal for this attempt, instrument fine", so this adapter instead
 *     states the retry verdict directly, as advice: an unattended repeat of a
 *     refusal the payer or their bank made deliberately is the retry that
 *     cannot succeed and still costs a scheme fee. Naming it as advice is also
 *     the more honest shape — it records what this adapter concludes about
 *     RETRYING, without asserting anything about the instrument.
 *   - `"100"` and `"102"` get NO reading. Nothing published says what they mean
 *     precisely enough to classify, and `indeterminate` is the correct answer to
 *     a code we cannot read. They are named in
 *     `KNOWN_UNREADABLE_DECLINE_CODES` below, so their absence stays a recorded
 *     decision rather than an oversight.
 */
export interface DeclineCodeReading {
  hints?: readonly PaymentFailureHint[];
  adviceCode?: PaymentRetryAdviceCode;
}

export const DECLINE_CODE_READING_TABLE: Readonly<Record<string, DeclineCodeReading>> = Object.freeze({
  "101": Object.freeze({ adviceCode: "do_not_try_again" } as const),
  "103": Object.freeze({ hints: Object.freeze(["transient"] as const) } as const),
  "104": Object.freeze({ hints: Object.freeze(["transient"] as const) } as const),
  "105": Object.freeze({ hints: Object.freeze(["mandateUnsupported"] as const) } as const),
  "106": Object.freeze({ hints: Object.freeze(["limitExceeded"] as const) } as const),
  "107": Object.freeze({ adviceCode: "do_not_try_again" } as const),
});

/**
 * Codes this adapter has SEEN and still cannot read. They are deliberately absent
 * from the table above rather than mapped to a guess: a row there must state
 * vocabulary the kernel declares, and `indeterminate` is the honest answer to a
 * code whose meaning is unconfirmed. Listing them here separates "we have met
 * this code and refuse to invent its semantics" from "we have never seen it",
 * which read identically at the lookup.
 *
 *   - `"100"` — observed in production on 2026-08-26, as the first attempt of a
 *     refused mandate registration whose second attempt was `"105"`. Nothing
 *     published says what it means, so it maps to no hint and no advice.
 *   - `"102"` — same standing, from the same unpublished range.
 *
 * A code moving out of this list into the table is a semantics decision backed by
 * evidence, not a lookup edit.
 */
export const KNOWN_UNREADABLE_DECLINE_CODES: readonly string[] = Object.freeze(["100", "102"]);

const NO_READING: DeclineCodeReading = Object.freeze({});

/**
 * This adapter's reading of one refusal code. Own-property lookup, so an
 * inherited key (`constructor`, `toString`) is not a mapping.
 */
export function declineCodeReading(code: string | undefined): DeclineCodeReading {
  if (code === undefined) return NO_READING;
  return Object.prototype.hasOwnProperty.call(DECLINE_CODE_READING_TABLE, code)
    ? DECLINE_CODE_READING_TABLE[code]
    : NO_READING;
}
