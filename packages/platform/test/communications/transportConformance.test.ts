import { afterEach, expect, it, vi } from "vitest";
import {
  classifyEmailSendOutcome, createInMemoryEmailTransport, createResendTransport,
  type EmailMessage, type EmailSendResult,
} from "../../src/communications/emailTransport.js";
import { postResendEmail, type EmailEgressResolver } from "../../src/communications/resendEmailClient.js";

const envelope: EmailMessage = {
  from: "notices@example.invalid", to: "reader@example.invalid", subject: "Synthetic notice",
  html: "<p>A neutral notice</p>", text: "A neutral notice", replyTo: "replies@example.invalid",
  idempotencyKey: "synthetic-notice:42", attachments: [{ filename: "note.txt", content: "bm90ZQ==" }],
};
const sink: EmailEgressResolver = (_, intendedRecipient) => ({
  intendedRecipient, mode: "sandbox_sink", recipient: "mailbox@example.invalid", reason: "synthetic_sink",
});
const route = { egressMode: "sandbox_sink", egressReason: "synthetic_sink" } as const;

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  {
    label: "accepted without identifier", response: {}, status: 202,
    expected: { outcome: { ok: true, resendId: null, httpStatus: 202, providerError: null, aborted: false, ...route }, providerResponse: { id: null } },
    projection: { skipReason: null, timelineStatus: "sent", ledgerStatus: "sent", sentAtEligible: true, lastErrorCode: null },
  },
  {
    label: "sanitized coded rejection", response: { error: { code: "quota / exceeded", message: "  Refused\nreader@example.invalid  " }, private_detail: "discard" }, status: 409,
    expected: { outcome: { ok: false, resendId: null, httpStatus: 409, providerError: "Refused [email]", providerErrorCode: "quota___exceeded", aborted: false, ...route },
      providerResponse: { http_status: 409, provider_error_message: "Refused [email]", provider_error_code: "quota___exceeded" } },
    projection: { skipReason: null, timelineStatus: "failed", ledgerStatus: "failed", sentAtEligible: false, lastErrorCode: "refused_email" },
  },
  {
    label: "fetch throws", error: new Error(" Network\nunavailable "),
    expected: { outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "Network unavailable", aborted: false, ...route }, providerResponse: { exception: true, aborted: false } },
    projection: { skipReason: null, timelineStatus: "failed", ledgerStatus: "failed", sentAtEligible: false, lastErrorCode: "network_unavailable" },
  },
  {
    label: "fetch aborts", error: new DOMException("Send cancelled", "AbortError"),
    expected: { outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "Send cancelled", aborted: true, ...route }, providerResponse: { exception: true, aborted: true } },
    projection: { skipReason: null, timelineStatus: "delivery_delayed", ledgerStatus: "failed", sentAtEligible: false, lastErrorCode: "provider_request_aborted" },
  },
])("concrete send: $label", async (entry) => {
  const fetcher = vi.fn<typeof fetch>();
  if (entry.error) fetcher.mockRejectedValue(entry.error);
  else fetcher.mockResolvedValue(new Response(JSON.stringify(entry.response), { status: entry.status }));
  vi.stubGlobal("fetch", fetcher);
  const transport = createResendTransport({ apiKey: "synthetic-credential" }, (input) => postResendEmail(input, sink));
  const signal = new AbortController().signal;
  const result = await transport.send({ ...envelope, signal });
  expect(transport.providerKind).toBe("resend");
  expect(result).toEqual(entry.expected satisfies EmailSendResult);
  expect(classifyEmailSendOutcome(result.outcome)).toEqual(entry.projection);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://api.resend.com/emails");
  expect(options?.signal).toBe(signal);
  expect(options?.headers).toEqual({
    Authorization: "Bearer synthetic-credential", "Content-Type": "application/json",
    "Idempotency-Key": envelope.idempotencyKey, "X-Original-Recipient": envelope.to,
  });
  expect(JSON.parse(String(options?.body))).toEqual({
    from: envelope.from, to: ["mailbox@example.invalid"], subject: envelope.subject, html: envelope.html,
    text: envelope.text, reply_to: envelope.replyTo, attachments: envelope.attachments,
    tags: [{ name: "openlup_env", value: "non_production" }],
  });
});

it("suppression records a skip and performs no fetch", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const drop: EmailEgressResolver = (_, intendedRecipient) => ({ intendedRecipient, mode: "drop", recipient: null, reason: "synthetic_closed" });
  const result = await createResendTransport({ apiKey: "unused-synthetic" }, (input) => postResendEmail(input, drop)).send(envelope);
  expect(result).toEqual({
    outcome: { ok: true, resendId: null, httpStatus: 0, providerError: null, aborted: false, suppressed: "drop", egressMode: "drop", egressReason: "synthetic_closed" },
    providerResponse: { suppressed: "drop", egress_reason: "synthetic_closed" },
  });
  expect(classifyEmailSendOutcome(result.outcome)).toEqual({
    skipReason: "egress_suppressed", timelineStatus: "skipped", ledgerStatus: "skipped", sentAtEligible: false, lastErrorCode: "egress_suppressed",
  });
  expect(fetcher).not.toHaveBeenCalled();
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
