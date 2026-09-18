import { describe, expect, it } from "vitest";
import {
  mapResendOutcome,
  truncateReason,
  MAX_REASON_DETAIL_LENGTH,
  type ResendDispatchOutcome,
} from "./mapResendOutcome.js";

function outcome(over: Partial<ResendDispatchOutcome>): ResendDispatchOutcome {
  return { ok: false, resendId: null, httpStatus: 200, providerError: null, aborted: false, ...over };
}

describe("mapResendOutcome", () => {
  it.each(["admin_disabled", "egress_suppressed"] as const)(
    "explicit %s skip → processed with truthful detail",
    (skipReason) => {
      expect(mapResendOutcome(outcome({ ok: true, skipReason }))).toEqual({
        kind: "processed",
        detail: { skipped: skipReason },
      });
    },
  );

  it("ok → processed with the resendId", () => {
    expect(mapResendOutcome(outcome({ ok: true, resendId: "re_1" }))).toEqual({
      kind: "processed",
      detail: { resendId: "re_1" },
    });
    expect(mapResendOutcome(outcome({ ok: true, resendId: null }))).toEqual({
      kind: "processed",
      detail: { resendId: null },
    });
  });

  it("aborted → retry (attempt consumed), even on an otherwise-snoozeable status", () => {
    expect(mapResendOutcome(outcome({ aborted: true, httpStatus: 503 }))).toEqual({
      kind: "retry",
      reason: "outbox_handler_timeout",
    });
  });

  it("429 / >=500 / 0 → snooze, preferring providerError then a default", () => {
    expect(mapResendOutcome(outcome({ httpStatus: 429, providerError: "rate" }))).toEqual({
      kind: "snooze",
      reason: "rate",
    });
    expect(mapResendOutcome(outcome({ httpStatus: 500 }))).toEqual({
      kind: "snooze",
      reason: "resend_unavailable",
    });
    expect(mapResendOutcome(outcome({ httpStatus: 0 }))).toEqual({
      kind: "snooze",
      reason: "resend_unavailable",
    });
  });

  it(">=400 payload-level (non-429/401/403) → discard, preferring providerError then a default", () => {
    expect(mapResendOutcome(outcome({ httpStatus: 422, providerError: "bad" }))).toEqual({
      kind: "discard",
      reason: "bad",
    });
    expect(mapResendOutcome(outcome({ httpStatus: 400 }))).toEqual({
      kind: "discard",
      reason: "resend_rejected",
    });
  });

  it("401/403 account-config failures → snooze, not discard", () => {
    // Incident 2026-07-24: Resend 403 validation_error "domain is not
    // verified" discarded a customer payment-recovery email on attempt 1.
    expect(mapResendOutcome(outcome({
      httpStatus: 403,
      providerError: "The openlup.com domain is not verified.",
      providerErrorCode: "validation_error",
    }))).toEqual({ kind: "snooze", reason: "The openlup.com domain is not verified." });
    expect(mapResendOutcome(outcome({ httpStatus: 401 }))).toEqual({
      kind: "snooze",
      reason: "resend_account_config",
    });
  });

  it("snoozes only the retryable Resend idempotency conflict", () => {
    expect(mapResendOutcome(outcome({
      httpStatus: 409,
      providerErrorCode: "concurrent_idempotent_requests",
    }))).toEqual({ kind: "snooze", reason: "concurrent_idempotent_requests" });
    expect(mapResendOutcome(outcome({
      httpStatus: 409,
      providerErrorCode: "invalid_idempotent_request",
    }))).toEqual({ kind: "discard", reason: "invalid_idempotent_request" });
    expect(mapResendOutcome(outcome({ httpStatus: 409 }))).toEqual({
      kind: "discard",
      reason: "resend_rejected",
    });
  });

  it("other non-ok statuses (e.g. an unexpected 3xx) → retry", () => {
    expect(mapResendOutcome(outcome({ httpStatus: 302 }))).toEqual({
      kind: "retry",
      reason: "resend_post_failed",
    });
  });

  it("truncates the snooze/discard reason to the max detail length", () => {
    const long = "x".repeat(MAX_REASON_DETAIL_LENGTH + 50);
    const result = mapResendOutcome(outcome({ httpStatus: 503, providerError: long }));
    expect(result).toEqual({
      kind: "snooze",
      reason: `${"x".repeat(MAX_REASON_DETAIL_LENGTH)}…`,
    });
  });
});

describe("truncateReason", () => {
  it("returns short input unchanged and truncates long input with an ellipsis", () => {
    expect(truncateReason("short")).toBe("short");
    const long = "y".repeat(MAX_REASON_DETAIL_LENGTH + 1);
    expect(truncateReason(long)).toBe(`${"y".repeat(MAX_REASON_DETAIL_LENGTH)}…`);
  });
});
