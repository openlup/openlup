import { afterEach, expect, it, vi } from "vitest";
import {
  classifyEmailSendOutcome, createInMemoryEmailTransport, failedEmailTransportResult,
  emailTransportMessageId, emailTransportLedgerIdentifier, withEmailSendSkipReason,
  type EmailMessage, type EmailSendResult,
} from "../../src/communications/emailTransport.js";

const envelope: EmailMessage = {
  from: "notices@example.invalid", to: "reader@example.invalid", subject: "Synthetic notice",
  html: "<p>A neutral notice</p>", text: "A neutral notice", replyTo: "replies@example.invalid",
  idempotencyKey: "synthetic-notice:42", attachments: [{ filename: "note.txt", content: "bm90ZQ==" }],
};

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  { outcome: { ok: true, resendId: null, httpStatus: 202, providerError: null, aborted: false }, status: "sent", code: null },
  { outcome: { ok: false, resendId: null, httpStatus: 409, providerError: "quota / exceeded", aborted: false }, status: "failed", code: "quota_exceeded" },
  { outcome: failedEmailTransportResult().outcome, status: "failed", code: "provider_transport_threw" },
  { outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "cancelled", aborted: true }, status: "delivery_delayed", code: "provider_request_aborted" },
])("transport result projection: $status / $code", ({ outcome, status, code }) => {
  const result: EmailSendResult = { outcome, providerResponse: {} };
  expect(classifyEmailSendOutcome(result.outcome)).toEqual({
    skipReason: null, timelineStatus: status, ledgerStatus: status === "delivery_delayed" ? "failed" : status,
    sentAtEligible: status === "sent", lastErrorCode: code,
  });
  expect(emailTransportLedgerIdentifier(emailTransportMessageId(outcome))).toEqual({ resend_id: null });
});

it("suppression and admin disablement retain explicit skip precedence", () => {
  const base = { ok: true, resendId: null, providerError: null };
  for (const [input, reason] of [
    [{ ...base, suppressed: "drop" as const }, "egress_suppressed"],
    [{ ...base, adminDisabled: true, suppressed: "drop" as const }, "admin_disabled"],
    [{ ...base, adminDisabled: true, skipReason: "egress_suppressed" as const }, "egress_suppressed"],
  ] as const) {
    expect(classifyEmailSendOutcome(input)).toEqual({ skipReason: reason, timelineStatus: "skipped", ledgerStatus: "skipped", sentAtEligible: false, lastErrorCode: reason });
    expect(withEmailSendSkipReason(input)).toEqual({ ...input, skipReason: reason });
  }
  expect(failedEmailTransportResult()).toEqual({ outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "provider_transport_threw", aborted: false }, providerResponse: { exception: true } });
});

it("in-memory capture retains complete ordered envelopes and outcomes", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const capture = createInMemoryEmailTransport({ idPrefix: "synthetic-capture" });
  const second = { ...envelope, subject: "Second neutral notice", signal: new AbortController().signal };
  for (const [index, message] of [envelope, second].entries()) {
    const id = `synthetic-capture-${index + 1}`;
    expect(await capture.send(message)).toEqual({
      outcome: { ok: true, resendId: id, httpStatus: 200, providerError: null, aborted: false }, providerResponse: { id },
    });
  }
  expect(capture.providerKind).toBe("in-memory");
  expect(capture.sent).toEqual([envelope, second]);
  expect(fetcher).not.toHaveBeenCalled();
});
