import type { OutboxHandlerOutcome } from "../domains/commerce/outboxDispatchContracts.js";

export const MAX_REASON_DETAIL_LENGTH = 300;

export function truncateReason(value: string): string {
  if (value.length <= MAX_REASON_DETAIL_LENGTH) return value;
  return `${value.slice(0, MAX_REASON_DETAIL_LENGTH)}…`;
}

// Structural shape shared by TransactionalEmailSendOutcome (commerce) and
// SubscriptionLifecycleEmailSendOutcome (subscription); both are field-identical.
export interface ResendDispatchOutcome {
  ok: boolean;
  resendId: string | null;
  // 0 = network-level failure (no HTTP response).
  httpStatus: number;
  providerError: string | null;
  /** Sanitized Resend machine code when the response included one. */
  providerErrorCode?: string | null;
  // True when the POST was cancelled by the handler-timeout AbortSignal. Mapped
  // to retry (attempt consumed), NOT snooze (attempt-refunded outage path), so a
  // reliably-slow send cannot re-execute ~maxSnoozes times and duplicate email.
  aborted: boolean;
  skipReason?: "admin_disabled" | "egress_suppressed" | null;
}

// The send-outcome → outbox-outcome tail shared verbatim by the transactional
// outbox email handlers (commerce + subscription). Extracted so the retry/snooze/
// discard classification lives in one place; per-handler parse/recipient/dedupe/
// send logic stays in each handler.
export function mapResendOutcome(outcome: ResendDispatchOutcome): OutboxHandlerOutcome {
  if (outcome.skipReason) {
    return { kind: "processed", detail: { skipped: outcome.skipReason } };
  }
  if (outcome.ok) {
    return { kind: "processed", detail: { resendId: outcome.resendId } };
  }
  if (outcome.aborted) {
    return { kind: "retry", reason: "outbox_handler_timeout" };
  }
  // Resend uses 409 for two materially different idempotency outcomes. A
  // concurrent request has not reached a stable response yet and must be
  // snoozed. A reused key with a different payload is permanently invalid.
  if (outcome.httpStatus === 409 && outcome.providerErrorCode === "concurrent_idempotent_requests") {
    return { kind: "snooze", reason: "concurrent_idempotent_requests" };
  }
  if (outcome.httpStatus === 409 && outcome.providerErrorCode === "invalid_idempotent_request") {
    return { kind: "discard", reason: "invalid_idempotent_request" };
  }
  if (outcome.httpStatus === 429 || outcome.httpStatus >= 500 || outcome.httpStatus === 0) {
    return {
      kind: "snooze",
      reason: truncateReason(outcome.providerError ?? "resend_unavailable"),
    };
  }
  // 401/403 are ACCOUNT-level failures (revoked/wrong API key, unverified
  // sending domain): they reject every email until an operator repairs the
  // Resend account, and they say nothing about this event's payload. Treat
  // them like an outage (snooze, attempt-refunded, bounded by maxSnoozes →
  // snooze_budget_exhausted keeps liveness) instead of discarding a customer
  // notification on the first attempt. Incident 2026-07-24: a transient DNS
  // window flipped openlup.com to "failed" in Resend; the 403
  // "domain is not verified" response discarded a payment-recovery email.
  if (outcome.httpStatus === 401 || outcome.httpStatus === 403) {
    return {
      kind: "snooze",
      reason: truncateReason(outcome.providerError ?? "resend_account_config"),
    };
  }
  if (outcome.httpStatus >= 400) {
    return {
      kind: "discard",
      reason: truncateReason(outcome.providerError ?? "resend_rejected"),
    };
  }
  return { kind: "retry", reason: "resend_post_failed" };
}
