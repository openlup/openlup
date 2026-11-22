import type { TransientSecret } from "./contracts/adapter.js";

/**
 * Brand a validated, non-empty browser-handoff credential as a `TransientSecret`.
 * Keeps adapter code free of raw type assertions while failing closed on empty values.
 */
export function brandTransientSecret(value: string): TransientSecret {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError("transient_secret_nonempty_string_required");
  }
  return value as TransientSecret;
}
