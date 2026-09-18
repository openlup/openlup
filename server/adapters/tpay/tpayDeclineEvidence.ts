import type { PaymentFailureHint } from "@openlup/core/payment";

import type { DeclineCodeReading } from "./declineFailureHints.js";
import type { TpayHttpClient } from "../../infra/tpay/tpayHttpClient.js";

/**
 * What this rail is allowed to conclude from a refusal, and from which evidence.
 *
 * Two rails ask the same question — "which refusal code does this transaction
 * stand on" — the reconciliation poll and the execution path the moment the
 * provider says no, so the scan lives here once rather than twice against the
 * same payload shape. The message-shape heuristic lives here too, as the weakest
 * grade of evidence and the last one consulted.
 */

/**
 * Short on purpose. This read only EXPLAINS a refusal the provider has already
 * decided; the attempt is finalized either way, so every millisecond spent here
 * is pure added latency inside the money path. Well below the transport client's
 * own request timeout, so the deadline that fires is this one.
 */
export const DECLINE_CODE_READBACK_TIMEOUT_MS = 3_000;

export interface RefusalRow {
  row: Record<string, unknown>;
  code: string;
}

/**
 * The last row carrying a refusal code. Last rather than first: a payer may retry
 * inside their banking app, so the most recent row describes the charge's current
 * standing. Asserted only from an explicit code — never from silence or elapsed
 * time — so a charge genuinely still running is never turned terminal. The row
 * travels back with the code because a caller may need its date; a caller that
 * does not can ignore it.
 */
export function lastRefusalRow(rows: unknown, codeKey: string): RefusalRow | null {
  const entries = Array.isArray(rows) ? rows : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const row = asRecord(entries[index]);
    const raw = row[codeKey];
    if (typeof raw === "string" && raw.trim()) return { row, code: raw.trim() };
  }
  return null;
}

/**
 * The refusal code the provider's own attempt log stands on, or `null`.
 *
 * FAIL-OPEN BY CONSTRUCTION. A rejected request, a malformed body, a client that
 * never settles, an attempt log without codes — every one of them resolves to
 * `null`, which is the caller's "read nothing" branch. This function cannot
 * throw and cannot block past its deadline, because the only thing it can add is
 * a better explanation of a refusal that is already final. Anything stronger
 * would put a provider read on the critical path of terminalizing an attempt,
 * and a stalled terminalization is a stalled subscription cycle.
 */
export interface AttemptDeclineObservation {
  /** Diagnostic-only quarantine; code remains the unchanged legacy classifier input. */
  identityMismatch?: true;
  code: string | null;
  disposition: "present" | "absent" | "unreadable" | "read_failed" | "read_timeout";
}

/** Compatibility accessor: the existing classifier still sees exactly code or null. */
export async function readAttemptDeclineCode(
  client: Pick<TpayHttpClient, "getTransaction">,
  transactionId: string,
  timeoutMs: number = DECLINE_CODE_READBACK_TIMEOUT_MS,
): Promise<string | null> {
  return (await readAttemptDeclineObservation(client, transactionId, timeoutMs)).code;
}

export function attemptDeclineObservation(transaction: unknown): AttemptDeclineObservation {
  const record = asRecord(transaction);
  const payments = asRecord(record.payments);
  const attempts = payments.attempts;
  const code = lastRefusalRow(attempts, "paymentErrorCode")?.code ?? null;
  const malformed = transaction === null || typeof transaction !== "object" || Array.isArray(transaction)
    || (record.payments !== undefined && (record.payments === null || typeof record.payments !== "object" || Array.isArray(record.payments)))
    || (attempts !== undefined && !Array.isArray(attempts))
    || (Array.isArray(attempts) && attempts.some((row) => {
      const item = asRecord(row);
      return row === null || typeof row !== "object" || Array.isArray(row)
        || (item.paymentErrorCode !== undefined && item.paymentErrorCode !== null && typeof item.paymentErrorCode !== "string");
    }));
  return { code, disposition: malformed ? "unreadable" : code ? "present" : "absent" };
}

/** One bounded read; diagnostic failure never changes terminalization or legacy code. */
export async function readAttemptDeclineObservation(
  client: Pick<TpayHttpClient, "getTransaction">,
  transactionId: string,
  timeoutMs: number = DECLINE_CODE_READBACK_TIMEOUT_MS,
): Promise<AttemptDeclineObservation> {
  if (!transactionId) return { code: null, disposition: "absent" };
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(() => client.getTransaction(transactionId)).then(
        (transaction): AttemptDeclineObservation => {
          const observation = attemptDeclineObservation(transaction);
          const actualId = asRecord(transaction).transactionId ?? asRecord(transaction).id;
          return typeof actualId === "string" && actualId.trim() !== transactionId
            ? { ...observation, disposition: "unreadable", identityMismatch: true } : observation;
        },
        (): AttemptDeclineObservation => ({ code: null, disposition: "read_failed" }),
      ),
      new Promise<AttemptDeclineObservation>((resolve) => {
        deadline = setTimeout(() => resolve({ code: null, disposition: "read_timeout" }), timeoutMs);
      }),
    ]);
  } catch {
    return { code: null, disposition: "read_failed" };
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

/** Legacy attribution remains a separate field with unchanged precedence. */
export function declineEvidenceSource(input: {
  attemptCode: string | null; decidingAttemptReading: DeclineCodeReading | null;
  mandateUnsupported: boolean; reading: DeclineCodeReading; errorCode: string;
}): string {
  return input.decidingAttemptReading !== null ? `attempt_code:${input.attemptCode}`
    : input.mandateUnsupported ? "prose_regex"
    : states(input.reading) ? `error_code:${input.errorCode}`
    : input.attemptCode !== null ? `attempt_code:${input.attemptCode}` : "none";
}

/** Whether a reading says anything at all, as opposed to `indeterminate`. */
export function states(reading: DeclineCodeReading): boolean {
  return reading.hints !== undefined || reading.adviceCode !== undefined;
}

/** The one flow in which this provider is asked to REGISTER a reusable mandate. */
const MANDATE_REGISTRATION_FLOW = "blik_recurring_activation";

/**
 * Whether an observation of this flow may conclude anything about the payer's
 * BANK being able to hold a mandate.
 *
 * Only a mandate REGISTRATION can answer that question. A refused charge on an
 * already-registered mandate proves the bank held one, so a capability code
 * arriving there says something else — which one, nobody here knows.
 *
 * `observedFlow` is `null` for an observer that cannot establish the flow at
 * all, and that is a real answer rather than a missing argument: the
 * reconciliation poll sees a transaction readback, and the flow is not a column
 * of the claim it works from. Unknown is fail-closed for a capability claim, so
 * such an observer abstains. Parameterized rather than hardcoded per rail, so a
 * rail that later LEARNS its flow starts stating the claim by passing it, with
 * no second copy of this rule to keep in step.
 */
export function mandateCapabilityReadable(observedFlow: string | null): boolean {
  return observedFlow === MANDATE_REGISTRATION_FLOW;
}

/**
 * The hints one observation is allowed to assert from a reading.
 *
 * The reading table is a reading of a CODE and knows nothing about the charge
 * the code arrived on; this is where the observation's own context is applied
 * to it. Both rails funnel through here, because a refusal that classifies one
 * way when the execution path sees it and another way when the poll sees it is
 * a race rather than a verdict — and the retry ladder cannot be allowed to
 * terminate on a race.
 *
 * Narrow on purpose: only the mandate-capability hint depends on context. Every
 * other hint states something about the charge itself and crosses untouched.
 *
 * The reconciliation rail passes `null` here and therefore always abstains from
 * that one hint: it reads a transaction back, and a readback cannot tell a
 * refused mandate REGISTRATION from a refused charge on a mandate the bank
 * already holds. Abstaining is what it costs to have one verdict per refusal;
 * the claim stays reachable from evidence that is not a guess, which on a
 * renewal is the preflight reason this deployment writes itself.
 */
export function assertableHints(
  hints: readonly PaymentFailureHint[] | undefined,
  observedFlow: string | null,
): readonly PaymentFailureHint[] | undefined {
  if (mandateCapabilityReadable(observedFlow)) return hints;
  return hints?.filter((hint) => hint !== "mandateUnsupported");
}

/**
 * FALLBACK ONLY, since the 2026-08-26 incident. Whether a decline means "this
 * bank cannot hold a mandate" — the one cause a retry can never fix, and the
 * only one worth telling a buyer to use a card.
 *
 * The deciding signal is now the refusal code in the transaction's attempt log,
 * read back by `readAttemptDeclineCode`. This heuristic runs only when that read
 * yields no code, or a code the reading table cannot read. It exists because the
 * create response's own `errorCode` is generic (`payment_failed` covers a
 * mistyped code, an expired code and an incapable bank alike), and
 * `payIdEligible` is absent on EVERY rejection, not just this one — so absence
 * alone would brand a fat-fingered code as "your bank does not support
 * recurring". Reading the message is the last resort it always should have been:
 * only its shape is consulted, and the text itself is never returned or stored,
 * because it is free-form and can carry payer-identifying detail.
 *
 * Restricted to mandate REGISTRATION: a failed charge on an already-registered
 * mandate proves the bank can hold one, so bank capability is never the answer
 * there.
 *
 * Anything uncertain falls through to a generic decline, whose copy is never
 * wrong — only less specific.
 */
export function isMandateRefusal(
  flow: string,
  payIdEligible: boolean | null,
  errorMessage: string,
): boolean {
  if (!mandateCapabilityReadable(flow)) return false;
  if (payIdEligible === true) return false;
  const normalized = errorMessage
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase();
  const namesMandate = /alias|payid|powtarzaln|recurring/.test(normalized);
  const deniesCapability =
    /nie\s+(?:umozliwia|obsluguje|wspiera|pozwala)|brak\s+(?:mozliwosci|obslugi|wsparcia)|unsupported|not\s+supported|does\s+not\s+support|cannot|can't|unable/.test(
      normalized,
    );
  return namesMandate && deniesCapability;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
