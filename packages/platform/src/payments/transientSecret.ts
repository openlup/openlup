import type { TransientSecret } from "./contracts/adapter.js";

/**
 * Brand a validated, non-blank browser-handoff credential as a `TransientSecret`.
 * Keeps adapter code free of raw type assertions while failing closed on empty or whitespace-only values.
 */
export function brandTransientSecret(value: string): TransientSecret {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError("transient_secret_nonempty_string_required");
  }
  return value as TransientSecret;
}
