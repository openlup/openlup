import { expect, it, vi } from "vitest";
import * as resend from "../../../src/communications/resend/index.js";
import { guardEmailTransport, type EmailEgressPolicy } from "../../../src/communications/emailEgress.js";
import { classifyEmailSendOutcome, type EmailMessage, type EmailTransport } from "../../../src/communications/emailTransport.js";

const message: EmailMessage = { from: "sender@example.invalid", to: "reader@example.invalid", subject: "Notice", html: "<p>Notice</p>" };
const decision = { mode: "sandbox_direct", reason: "synthetic_policy", intendedRecipient: message.to, recipient: message.to,
  credential: "synthetic-selected", environmentTag: "non_production" } as const;
function harness(policy: EmailEgressPolicy = () => decision) {
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ id: "message-1" }));
  const transport: EmailTransport = resend.createResendTransport({ policy, environmentTagName: "host_env", fetch: fetcher });
  return { fetcher, transport, send: (input = message) => guardEmailTransport(transport).send(input) };
}

it("E01 W1 every send reaches the guard: all refusal/drop variants give zero POST", async () => {
  for (const [kind, value] of [
    ["missing", undefined], ["null", null], ["throwing", "throw"],
    ["blocked", { mode: "blocked", reason: "host_blocked" }], ["drop", { mode: "drop", reason: "host_drop" }],
    ["bad reason", { ...decision, reason: "unsafe diagnostic" }], ["no credential", { ...decision, credential: " " }],
    ["wrong tag", { ...decision, environmentTag: "production" }], ["wrong recipient", { ...decision, recipient: "other@example.invalid" }],
    ["wrong mode", { ...decision, mode: "unknown" }], ["extra input", { ...decision, apiKey: "synthetic-original" }],
  ] as const) {
    const label = `E01 guard ${kind}`;
    const policy = vi.fn(() => { if (value === "throw") throw Error("synthetic"); return value; });
    const h = harness(kind === "missing" ? undefined : policy as EmailEgressPolicy);
    // Exercise a genuinely missing runtime policy despite the required TypeScript input.
    if (kind === "missing") h.transport = resend.createResendTransport({ policy: undefined as unknown as EmailEgressPolicy, environmentTagName: "host_env", fetch: h.fetcher });
    const result = await h.transport.send(message);
    expect(h.fetcher, `${label}: zero POST`).not.toHaveBeenCalled();
    if (kind !== "missing") expect(policy, `${label}: fresh policy with intended recipient`).toHaveBeenCalledExactlyOnceWith(message.to);
    if (kind === "drop") {
      expect(result, `${label}: exact terminal drop`).toEqual({ outcome: { ok: true, resendId: null, httpStatus: 0, providerError: null, aborted: false,
        suppressed: "drop", egressMode: "drop", egressReason: "host_drop" }, providerResponse: { suppressed: "drop", egress_reason: "host_drop" } });
      expect(classifyEmailSendOutcome(result.outcome).skipReason, `${label}: suppression classification`).toBe("egress_suppressed");
    } else expect(result.outcome, `${label}: refusal outcome`).toMatchObject({ ok: false, httpStatus: 0, resendId: null, aborted: false });
  }
});

it.each([["E02", "production"], ["E03", "sandbox_direct"], ["E04", "sandbox_sink"]] as const)("%s W1 selected %s credential, recipient and tag only", async (id, mode) => {
  const policy = vi.fn(() => ({ ...decision, mode, environmentTag: mode === "production" ? "production" as const : "non_production" as const,
    recipient: mode === "sandbox_sink" ? "sink@example.invalid" : message.to }));
  const h = harness(policy);
  expect(h.transport.providerKind, `${id}: provider kind`).toBe("resend");
  for (let count = 1; count <= 2; count++) {
    expect((await h.send()).outcome, `${id}: selected-mode send outcome`).toMatchObject({ ok: true, resendId: "message-1", egressMode: mode });
    expect(policy, `${id}: fresh guard on repeated send`).toHaveBeenCalledTimes(count);
    expect(h.fetcher, `${id}: one POST per guarded send`).toHaveBeenCalledTimes(count);
  }
  const [url, options] = h.fetcher.mock.calls[0];
  expect(url, `${id}: endpoint`).toBe("https://api.resend.com/emails");
  expect(options, `${id}: selected credential and POST`).toMatchObject({ method: "POST", headers: { Authorization: "Bearer synthetic-selected", "Content-Type": "application/json" } });
  expect(options!.headers, `${id}: selected credential and sink original-recipient header`).toEqual({ Authorization: "Bearer synthetic-selected", "Content-Type": "application/json",
    ...(mode === "sandbox_sink" ? { "X-Original-Recipient": message.to } : {}) });
  expect(JSON.parse(options!.body as string), `${id}: selected recipient and tag only`).toEqual({ from: message.from, to: [policy().recipient], subject: message.subject, html: message.html,
    tags: [{ name: "host_env", value: policy().environmentTag }] });
});

it("E05 W1 optional payload and exact idempotency bytes", async () => {
  const absent = harness();
  await absent.send();
  const absentOptions = absent.fetcher.mock.calls[0][1]!;
  expect(Object.keys(JSON.parse(absentOptions.body as string)), "E05 absent optional keys and base wire order")
    .toEqual(["from", "to", "subject", "html", "tags"]);
  expect(Object.hasOwn(absentOptions.headers!, "Idempotency-Key"), "E05 absent idempotency key").toBe(false);
  for (const idempotencyKey of [undefined, "", " \t ", "  exact:key\t "]) {
    const h = harness();
    const signal = new AbortController().signal;
    await h.send({ ...message, text: "", replyTo: "reply@example.invalid", attachments: [], signal, idempotencyKey });
    const options = h.fetcher.mock.calls[0][1]!;
    expect(options.signal, "E05 signal identity").toBe(signal);
    expect(Object.keys(JSON.parse(options.body as string)), "E05 present optional keys and wire order").toEqual(["from", "to", "subject", "html", "text", "reply_to", "attachments", "tags"]);
    expect(JSON.parse(options.body as string), "E05 empty text, reply-to and empty attachments").toMatchObject({ text: "", reply_to: "reply@example.invalid", attachments: [] });
    expect(Object.hasOwn(options.headers!, "Idempotency-Key"), `E05 idempotency presence ${JSON.stringify(idempotencyKey)}`).toBe(idempotencyKey !== undefined);
    if (idempotencyKey !== undefined) expect((options.headers as Record<string, string>)["Idempotency-Key"], `E05 exact idempotency bytes ${JSON.stringify(idempotencyKey)}`).toBe(idempotencyKey);
    await h.send({ ...message, attachments: [{ filename: "note.txt", content: "bm90ZQ==" }] });
    expect(JSON.parse(h.fetcher.mock.calls[1][1]!.body as string).attachments, "E05 populated attachments").toEqual([{ filename: "note.txt", content: "bm90ZQ==" }]);
  }
});

it.each([["E06", "no-id"], ["E07", "invalid-json"], ["E08", "error-string"], ["E09", "error-object"]] as const)("%s W1 legacy outcome %s", async (id, kind) => {
  const h = harness();
  const failed = kind.startsWith("error");
  h.fetcher.mockImplementation(async () => kind === "invalid-json" ? new Response("not json", { status: 202 })
    : Response.json(kind === "error-string" ? { error: "  failed reader@example.invalid \n", code: "quota / exceeded" }
      : kind === "error-object" ? { error: { message: "failed", name: "quota / exceeded" } } : {}, { status: failed ? 429 : 202 }));
  const result = await h.send();
  expect(result.outcome).toEqual({ ok: !failed, resendId: null, httpStatus: failed ? 429 : 202,
    providerError: failed ? kind === "error-string" ? "failed [email]" : "failed" : null,
    ...(failed ? { providerErrorCode: "quota___exceeded" } : {}), aborted: false, egressMode: decision.mode, egressReason: decision.reason });
  expect(result.providerResponse).toEqual(failed ? { http_status: 429, provider_error_message: result.outcome.providerError, provider_error_code: "quota___exceeded" } : { id: null });
  expect(classifyEmailSendOutcome(result.outcome).sentAtEligible, `${id}: sentAt eligibility`).toBe(!failed);
  expect(h.fetcher, `${id}: one POST, no recovery send after acceptance without ID`).toHaveBeenCalledTimes(1);
});

it.each([["E10", "abort"], ["E11", "network"]] as const)("%s W1 %s has no retry or second POST", async (_id, kind) => {
  const h = harness(); const controller = new AbortController();
  if (kind === "abort") controller.abort();
  h.fetcher.mockRejectedValue(kind === "abort" ? new DOMException("cancelled", "AbortError") : Error("failed reader@example.invalid"));
  const result = await h.send({ ...message, signal: controller.signal });
  expect(h.fetcher).toHaveBeenCalledTimes(1);
  expect(result).toMatchObject({ outcome: { ok: false, resendId: null, httpStatus: 0, providerError: kind === "abort" ? "cancelled" : "failed [email]", aborted: kind === "abort" }, providerResponse: { exception: true, aborted: kind === "abort" } });
});

it("E12 exports exactly the three approved functions", () => {
  expect(Object.keys(resend).sort()).toEqual(["createResendTransport", "createResendWebhookHandler", "runResendDeliveryReconciliation"]);
  for (const value of Object.values(resend)) expect(typeof value).toBe("function");
});
