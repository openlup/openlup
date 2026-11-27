/**
 * One uniform, greppable signal for a swallowed `email_sends` ledger-insert
 * failure, shared by every email port. The send itself already happened (or
 * failed) before this; the ledger write is best-effort, so we never throw here —
 * but emitting a single stable event code (`email_ledger_insert_failed`) lets a
 * log drain / Axiom alert cover all ports at once, instead of per-port ad-hoc
 * strings. Pairs with the email-health watchdog, which catches the aggregate
 * symptom in the persisted timeline.
 */

const EMAIL_ADDRESS_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const PROVIDER_KEY_PATTERN = /\bre_[A-Za-z0-9_]{6,}\b/g;
const WEBHOOK_SECRET_PATTERN = /\bwhsec_[A-Za-z0-9+/=_-]+/g;

function redactSensitiveText(value: string): string {
  return value
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(PROVIDER_KEY_PATTERN, "[redacted]")
    .replace(WEBHOOK_SECRET_PATTERN, "[redacted]")
    .replace(EMAIL_ADDRESS_PATTERN, "[email]");
}

function safeError(error: unknown): string {
  if (error instanceof Error) return redactSensitiveText(error.message);
  if (error && typeof error === "object") {
    try {
      return redactSensitiveText(JSON.stringify(error));
    } catch {
      return "[unserializable error]";
    }
  }
  return redactSensitiveText(String(error));
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
