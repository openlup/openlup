/**
 * One uniform, greppable signal for a swallowed `email_sends` ledger-insert
 * failure, shared by every email port. The send itself already happened (or
 * failed) before this; the ledger write is best-effort, so we never throw here —
 * but emitting a single stable event code (`email_ledger_insert_failed`) lets a
 * log drain / Axiom alert cover all ports at once, instead of per-port ad-hoc
 * strings. Pairs with the email-health watchdog, which catches the aggregate
 * symptom in the persisted timeline.
 */

function safeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    try {
      return JSON.stringify(error);
    } catch {
      return "[unserializable error]";
    }
  }
  return String(error);
}

export function logEmailLedgerInsertFailure(input: {
  source: string;
  templateSlug: string;
  error: unknown;
}): void {
  console.error(
    "email_ledger_insert_failed",
    JSON.stringify({
      source: input.source,
      templateSlug: input.templateSlug,
      error: safeError(input.error).slice(0, 300),
    }),
  );
}
