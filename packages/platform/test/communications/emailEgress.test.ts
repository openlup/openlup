import { afterEach, expect, it, vi } from "vitest";
import {
  createGuardedEmailTransport, guardEmailTransport, createAuthEmailTransport, guardAuthEmailTransport,
  type EmailEgressContext, type EmailEgressDecision,
} from "../../src/communications/emailEgress.js";
import { classifyEmailSendOutcome, createInMemoryEmailTransport, type EmailMessage } from "../../src/communications/emailTransport.js";

const message: EmailMessage = { from: "sender@example.invalid", to: "reader@example.invalid", subject: "Notice", html: "<p>Notice</p>" };
const success = { outcome: { ok: true, resendId: "mail-1", httpStatus: 202, providerError: null, aborted: false }, providerResponse: { id: "mail-1" } };
const decision: EmailEgressContext = { mode: "sandbox_sink", reason: "test_sink", intendedRecipient: message.to,
  recipient: "sink@example.invalid", credential: "synthetic-credential", environmentTag: "non_production" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each([
  null, {}, { ...decision, mode: "unknown" }, { ...decision, recipient: "" },
  { ...decision, intendedRecipient: "wrong@example.invalid" }, { ...decision, credential: " " },
  { ...decision, environmentTag: "production" }, { ...decision, mode: "production" },
  { ...decision, mode: "sandbox_direct" }, { ...decision, recipient: "one@example.invalid,two@example.invalid" },
  { ...decision, reason: "sensitive@example.invalid" }, { ...decision, unsupportedEffect: true },
  { mode: "drop", reason: "test_drop", credential: "unexpected" },
])("refuses malformed/unknown policy before any sender effect: %j", async (value) => {
  const send = vi.fn(async (_message: EmailMessage, _context?: Readonly<EmailEgressContext>) => success);
  const transport = createGuardedEmailTransport({ providerKind: "synthetic", policy: () => value as EmailEgressDecision, send });
  expect(await guardEmailTransport(transport).send(message)).toEqual({
    outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "email_egress_policy_invalid", aborted: false },
    providerResponse: { egress_reason: "email_egress_policy_invalid" },
  });
  expect(send).not.toHaveBeenCalled();
});

it("missing/throwing policy and capture-name claims never admit effects or leak exceptions", async () => {
  const send = vi.fn(async (_message: EmailMessage, _context?: Readonly<EmailEgressContext>) => success);
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  for (const policy of [undefined, () => { throw new Error("secret recipient@example.invalid"); }]) {
    const transport = createGuardedEmailTransport({ providerKind: "in-memory", policy: policy as never, send });
    expect((await transport.send(message)).outcome.providerError).toBe("email_egress_policy_unavailable");
  }
  const raw = { providerKind: "in-memory", send };
  expect((await guardEmailTransport(raw).send(message)).outcome.providerError).toBe("email_egress_unadmitted");
  const claimed = { ...createInMemoryEmailTransport(), send };
  expect((await guardEmailTransport(claimed).send(message)).outcome.providerError).toBe("email_egress_unadmitted");
  expect(send).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});

it("block is failure, intentional drop is terminal skipped suppression, both with zero sends", async () => {
  const send = vi.fn(async (_message: EmailMessage, _context?: Readonly<EmailEgressContext>) => success);
  for (const mode of ["drop", "blocked"] as const) {
    const transport = createGuardedEmailTransport({ providerKind: "synthetic", policy: () => ({ mode, reason: "test_policy" }), send });
    const result = await transport.send(message);
    expect(result).toEqual(mode === "drop" ? {
      outcome: { ok: true, resendId: null, httpStatus: 0, providerError: null, aborted: false, suppressed: "drop", egressMode: "drop", egressReason: "test_policy" },
      providerResponse: { suppressed: "drop", egress_reason: "test_policy" },
    } : {
      outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "email_egress_blocked", aborted: false, egressReason: "test_policy" },
      providerResponse: { egress_reason: "email_egress_blocked" },
    });
    expect(classifyEmailSendOutcome(result.outcome)).toMatchObject({ timelineStatus: mode === "drop" ? "skipped" : "failed", sentAtEligible: false });
  }
  expect(send).not.toHaveBeenCalled();
});

it("preserves full envelope, optional absence, key bytes and signal; policy is fresh on each send", async () => {
  const policy = vi.fn(() => decision);
  const send = vi.fn(async (_message: EmailMessage, _context?: Readonly<EmailEgressContext>) => success);
  const transport = createGuardedEmailTransport({ providerKind: "synthetic", policy, send });
  const complete = { ...message, text: "Notice", replyTo: "reply@example.invalid", idempotencyKey: " key:42 ",
    attachments: [{ filename: "note.txt", content: "bm90ZQ==" }], signal: new AbortController().signal };
  for (const envelope of [message, complete]) {
    expect(await transport.send(envelope)).toEqual({ ...success, outcome: { ...success.outcome, egressMode: "sandbox_sink", egressReason: "test_sink" } });
  }
  expect(policy.mock.calls).toEqual([[message.to], [message.to]]);
  expect(send.mock.calls).toEqual([[{ ...message, to: decision.recipient }, decision], [{ ...complete, to: decision.recipient }, decision]]);
  expect(send.mock.calls[1]?.[0].signal).toBe(complete.signal);
  expect(send.mock.calls[0]?.[0]).not.toHaveProperty("text");
  expect(Object.isFrozen(send.mock.calls[0]?.[1])).toBe(true);
});

it.each(["production", "sandbox_direct"] as const)("explicit %s admission preserves the single intended recipient", async (mode) => {
  const send = vi.fn(async (_message: EmailMessage, _context?: Readonly<EmailEgressContext>) => success);
  const admitted = { ...decision, mode, recipient: message.to, environmentTag: mode === "production" ? "production" as const : "non_production" as const };
  await createGuardedEmailTransport({ providerKind: "synthetic", policy: () => admitted, send }).send(message);
  expect(send.mock.calls).toEqual([[message, admitted]]);
});

it("package capture remains local, ordered and synthetic through mandatory and Auth bridges", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  const capture = createInMemoryEmailTransport({ idPrefix: "capture" });
  const result = await guardEmailTransport(capture).send(message);
  expect(result).toEqual({ outcome: { ok: true, resendId: "capture-1", httpStatus: 200, providerError: null, aborted: false }, providerResponse: { id: "capture-1" } });
  const auth = createAuthEmailTransport(capture);
  const second = { sender: message.from, recipient: message.to, subject: "Auth notice", html: message.html, text: "Notice" };
  expect((await guardAuthEmailTransport(auth).send(second)).outcome.messageId).toBe("capture-2");
  expect(capture.sent).toEqual([message, { from: second.sender, to: second.recipient, subject: second.subject, html: second.html, text: second.text }]);
  const raw = { ...auth, send: vi.fn(auth.send) };
  expect((await guardAuthEmailTransport(raw).send(second)).outcome).toMatchObject({ ok: false, messageId: null, providerError: "email_egress_unadmitted" });
  expect(raw.send).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
