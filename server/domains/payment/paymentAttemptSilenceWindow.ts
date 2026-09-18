import type {
  ClaimedPaymentAttempt,
  SilenceWindowLookup,
} from "./paymentProviderReconciliationContracts.js";

/**
 * Whether this rail has answered non-terminally for longer than it declares
 * normal. The window comes from the rail's published capability - never a
 * provider identity, never a global constant, because a pushed-event rail and a
 * polled rail have genuinely different normal silences and a self-hoster
 * declares their own. Absent or unusable means never overdue: stay quiet rather
 * than accuse a healthy rail.
 */
export function silenceIsOverdue(
  capabilities: SilenceWindowLookup | undefined,
  attempt: ClaimedPaymentAttempt,
  now: string,
): boolean {
  const minutes = capabilities?.get(attempt.provider)?.terminalOutcomeReporting
    ?.silenceBecomesSuspectAfterMinutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes <= 0) return false;
  const since = Date.parse(attempt.localUpdatedAt);
  const at = Date.parse(now);
  if (!Number.isFinite(since) || !Number.isFinite(at)) return false;
  return at - since >= minutes * 60_000;
}
