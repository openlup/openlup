import {
  EmailDeliveryTimelineError,
  recordEmailDeliveryTimeline as record,
} from "../../src/communications/emailDeliveryTimeline.js";
import { logEmailLedgerInsertFailure } from "../../src/communications/emailLedgerLog.js";
import { logAdminDisabledEmailSend } from "../../src/communications/emailNotificationSkipLog.js";
import { resolveEmailApiKey } from "../../src/communications/emailTransport.js";
import { resolveResendApiKey } from "../../src/communications/resendApiKey.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyEmailSendOutcome, createInMemoryEmailTransport, createResendTransport,
  type EmailMessage, type EmailSendResult,
} from "../../src/communications/emailTransport.js";
import { postResendEmail, type EmailEgressResolver } from "../../src/communications/resendEmailClient.js";

const provider = { endpoint: "https://mail.example.invalid/emails", httpErrorPrefix: "Synthetic HTTP" };

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
  const transport = createResendTransport({ apiKey: "synthetic-credential", providerKind: "synthetic-mail" }, (input) => postResendEmail(input, sink, provider));
  const signal = new AbortController().signal;
  const result = await transport.send({ ...envelope, signal });
  expect(transport.providerKind).toBe("synthetic-mail");
  expect(result).toEqual(entry.expected satisfies EmailSendResult);
  expect(classifyEmailSendOutcome(result.outcome)).toEqual(entry.projection);
  expect(fetcher).toHaveBeenCalledTimes(1);
  const [url, options] = fetcher.mock.calls[0]!;
  expect(url).toBe("https://mail.example.invalid/emails");
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
  const result = await createResendTransport({ apiKey: "unused-synthetic", providerKind: "synthetic-mail" }, (input) => postResendEmail(input, drop, provider)).send(envelope);
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


const recordEmailDeliveryTimeline = (client: Parameters<typeof record>[0], input: Parameters<typeof record>[1], options: Parameters<typeof record>[2] = {}) =>
  record(client, input, options, "synthetic-mail");

const baseInput = {
  dedupeKey: "outbox:evt-1",
  templateSlug: "synthetic-notice",
  purpose: "transactional" as const,
  triggerSource: "outbox-dispatch",
  triggerEvent: "outbox_dispatch_send",
  status: "processing" as const,
  recipientEmail: "recipient@example.invalid",
  metadata: { adapter: "test" },
};

describe("recordEmailDeliveryTimeline", () => {
  it("returns the durable delivery id from the RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "delivery-1", error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, baseInput, { required: true }))
      .resolves.toBe("delivery-1");
    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_dedupe_key: "outbox:evt-1",
      p_provider_kind: "synthetic-mail",
      p_template_slug: "synthetic-notice",
      p_status: "processing",
      p_recipient_email: "recipient@example.invalid",
      p_metadata: { adapter: "test" },
    }));
  });

  it("fails closed for required customer sends when the RPC is unavailable", async () => {
    await expect(recordEmailDeliveryTimeline({}, baseInput, {
      required: true,
      context: "outbox-dispatch:synthetic-notice",
    })).rejects.toThrow(/email_delivery_timeline_rpc_missing:outbox-dispatch:synthetic-notice/);
  });

  it("keeps best-effort callers non-blocking on RPC errors", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "down", code: "PGRST204" } });

    await expect(recordEmailDeliveryTimeline({ rpc }, baseInput)).resolves.toBeNull();
    // Was a bare single-argument assertion. The lost send is now identifiable:
    // on production this fires from the live payment webhook several times a
    // day and named nothing at all.
    expect(consoleError).toHaveBeenCalledWith(
      "[email-delivery-timeline] record RPC returned error",
      {
        context: null,
        templateSlug: "synthetic-notice",
        purpose: "transactional",
        triggerSource: "outbox-dispatch",
        triggerEvent: "outbox_dispatch_send",
        status: "processing",
        aggregateType: null,
        aggregateId: null,
        outboxEventId: null,
        errorCode: "PGRST204",
      },
    );
  });

  it("names the caller and the row when a best-effort write throws", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const rpc = vi.fn().mockRejectedValue(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      aggregateType: "synthetic_record",
      aggregateId: "11111111-2222-3333-4444-555555555555",
      outboxEventId: "evt-1",
    }, { context: "outbox-dispatch:synthetic-notice" })).resolves.toBeNull();

    expect(consoleError).toHaveBeenCalledWith(
      "[email-delivery-timeline] record RPC threw",
      expect.objectContaining({
        context: "outbox-dispatch:synthetic-notice",
        aggregateType: "synthetic_record",
        aggregateId: "11111111-2222-3333-4444-555555555555",
        outboxEventId: "evt-1",
        errorCode: "ECONNRESET",
      }),
    );
  });

  // The guardrail for this whole wave. Both log sites are on a live payment
  // webhook path, so a spread of `input` or of the raw error would replicate a
  // customer address into the log drain several times a day. Poison every
  // excluded channel at once and assert none of it survives serialization.
  it("never logs personal data, whichever channel it arrives through", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const address = "recipient@example.invalid";
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: {
        code: "23505",
        message: `duplicate key value violates unique constraint, email=${address}`,
        details: `Key (recipient_email)=(${address}) already exists.`,
        hint: address,
      },
    });

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      recipientEmail: address,
      dedupeKey: `outbox:${address}`,
      metadata: { operator: address },
    })).resolves.toBeNull();

    const [, context] = consoleError.mock.calls[0] ?? [];
    expect(JSON.stringify(context)).not.toContain(address);
    expect(JSON.stringify(context)).not.toContain("recipient");
    // The code is the one thing lifted off the error, and it still gets through.
    expect(context).toMatchObject({ errorCode: "23505" });
  });

  it("throws a typed error when a required RPC does not return an id", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, baseInput, { required: true }))
      .rejects.toBeInstanceOf(EmailDeliveryTimelineError);
  });

  // `p_platform_job_run_id` is a uuid column with a foreign key to the job-run
  // ledger. A dispatch label reached it from the payment webhook and failed the
  // cast before the function body ran, so the whole row was lost twice per mail.
  it("keeps a run id that is not uuid-shaped out of the column and inside the metadata", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "delivery-1", error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      platformJobRunId: "synthetic-dispatch",
    }, { required: true })).resolves.toBe("delivery-1");

    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_platform_job_run_id: null,
      p_metadata: { adapter: "test", platformJobRunId: "synthetic-dispatch" },
    }));
  });

  it("passes a uuid-shaped run id through and leaves the metadata untouched", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "delivery-1", error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      platformJobRunId: "3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B",
    }, { required: true })).resolves.toBe("delivery-1");

    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_platform_job_run_id: "3F2A1B4C-5D6E-4F70-8A9B-0C1D2E3F4A5B",
      p_metadata: { adapter: "test" },
    }));
  });

  it("keeps the production shape as is: the same label in the input and in the port's origin metadata", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "delivery-1", error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      platformJobRunId: "synthetic-dispatch",
      metadata: { adapter: "test", platformJobRunId: "synthetic-dispatch" },
    }, { required: true })).resolves.toBe("delivery-1");

    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_platform_job_run_id: null,
      p_metadata: { adapter: "test", platformJobRunId: "synthetic-dispatch" },
    }));
  });

  it("never overwrites a run id the caller already carries in its own metadata", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "delivery-1", error: null });

    await expect(recordEmailDeliveryTimeline({ rpc }, {
      ...baseInput,
      platformJobRunId: "synthetic-dispatch",
      metadata: { adapter: "test", platformJobRunId: "caller-owned-label" },
    }, { required: true })).resolves.toBe("delivery-1");

    expect(rpc).toHaveBeenCalledWith("communication_record_email_delivery", expect.objectContaining({
      p_platform_job_run_id: null,
      p_metadata: { adapter: "test", platformJobRunId: "caller-owned-label" },
    }));
  });
});



describe("logEmailLedgerInsertFailure", () => {
  it("emits one uniform, greppable event code with serialized PostgREST error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logEmailLedgerInsertFailure({
      source: "outbox-dispatch",
      templateSlug: "synthetic-notice",
      error: { code: "23505", message: "duplicate key" },
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const [code, payload] = spy.mock.calls[0] as [string, string];
    expect(code).toBe("email_ledger_insert_failed");
    const parsed = JSON.parse(payload);
    expect(parsed).toMatchObject({ source: "outbox-dispatch", templateSlug: "synthetic-notice" });
    expect(parsed.error).toContain("duplicate key");
  });

  it("serializes a thrown Error to its message", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    logEmailLedgerInsertFailure({ source: "marketing-dispatch", templateSlug: "x", error: new Error("boom") });
    const parsed = JSON.parse((spy.mock.calls[0] as [string, string])[1]);
    expect(parsed.error).toBe("boom");
  });
});



describe("logAdminDisabledEmailSend", () => {
  it("writes a terminal skipped email_sends ledger row", async () => {
    const insert = vi.fn(() => Promise.resolve({ error: null }));
    const client = {
      from: vi.fn(() => ({ insert })),
    };

    await logAdminDisabledEmailSend({
      client,
      source: "synthetic",
      templateSlug: "synthetic-confirmation",
      originMetadata: { emailEnvironment: "test", emailBaseUrl: "https://example.test", emailOriginSource: "test" },
      providerContext: { orderId: "order-1" },
    }, "admin_disabled");

    expect(client.from).toHaveBeenCalledWith("email_sends");
    expect(insert).toHaveBeenCalledWith({
      tester_id: null,
      template_slug: "synthetic-confirmation",
      source: "synthetic",
      resend_id: null,
      status: "skipped",
      sent_at: null,
      provider_error: null,
      provider_response: expect.objectContaining({
        skipped: "admin_disabled",
        emailEnvironment: "test",
        orderId: "order-1",
      }),
    });
  });
});


describe("resolveResendApiKey", () => {
  it("resolves the live key when no provider mode is set", () => {
    expect(resolveResendApiKey({ RESEND_API_KEY: "re_live_123" })).toEqual({
      apiKey: "re_live_123",
      mode: "live",
    });
  });

  it("resolves the sandbox key when RESEND_PROVIDER_MODE=sandbox", () => {
    expect(
      resolveResendApiKey({
        RESEND_PROVIDER_MODE: "sandbox",
        RESEND_SANDBOX_API_KEY: "re_sb_123",
        // A live key may be absent on preview (the guard forbids it).
      }),
    ).toEqual({ apiKey: "re_sb_123", mode: "sandbox" });
  });

  it("ignores the live key in sandbox mode and reports missing when the sandbox key is absent", () => {
    expect(
      resolveResendApiKey({ RESEND_PROVIDER_MODE: "sandbox", RESEND_API_KEY: "re_live_123" }),
    ).toEqual({ apiKey: undefined, mode: "sandbox" });
  });

  it("returns undefined in live mode when no key is present", () => {
    expect(resolveResendApiKey({})).toEqual({ apiKey: undefined, mode: "live" });
  });

  it("treats blank/whitespace keys as missing and trims real keys", () => {
    expect(resolveResendApiKey({ RESEND_API_KEY: "   " }).apiKey).toBeUndefined();
    expect(resolveResendApiKey({ RESEND_API_KEY: "  re_x  " }).apiKey).toBe("re_x");
  });

  it("is case-insensitive and trims the provider mode", () => {
    expect(
      resolveResendApiKey({ RESEND_PROVIDER_MODE: "  SANDBOX ", RESEND_SANDBOX_API_KEY: "re_sb" }).mode,
    ).toBe("sandbox");
  });
});

it("resolves the primary composition key before its sandbox fallback", () => {
  expect(resolveEmailApiKey({ RESEND_API_KEY: " live ", RESEND_SANDBOX_API_KEY: " sandbox " })).toBe("live");
  expect(resolveEmailApiKey({ RESEND_API_KEY: "  ", RESEND_SANDBOX_API_KEY: " sandbox " })).toBe("sandbox");
  expect(resolveEmailApiKey({})).toBe("");
});
