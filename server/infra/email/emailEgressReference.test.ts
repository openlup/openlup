import { afterEach, expect, it, vi } from "vitest";
import { createEmailTransport, resolveEmailApiKey } from "./emailTransport.js";
import { createAuthEmailTransport, guardEmailTransport, type EmailMessage } from "@openlup/platform/communications";

const routing = vi.hoisted(() => ({ decision: null as import("../../_lib/publicDeploymentPolicies.js").EgressDecision | null }));
vi.mock("#communications-egress-policy", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../_lib/publicDeploymentPolicies.js")>();
  return { ...original, resolveEgressMode: (env: Record<string, string | undefined>, intended: string) => routing.decision ?? original.resolveEgressMode(env, intended) };
});

const input: EmailMessage = { from: "sender@example.invalid", to: "reader@example.invalid", subject: "Notice", html: "<p>Notice</p>" };
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); routing.decision = null; });

it("maintained policy remains sink/drop even with production-looking markers", async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: "wire-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher); vi.spyOn(console, "error").mockImplementation(() => {});
  for (const env of [{}, { NODE_ENV: "production", VERCEL_ENV: "production", COMMS_PRODUCTION_PROJECT_REF: "synthetic" }]) {
    const transport = guardEmailTransport(createEmailTransport({ apiKey: "", env }));
    expect(await transport.send(input)).toEqual({
      outcome: { ok: true, resendId: null, httpStatus: 0, providerError: null, aborted: false,
        suppressed: "drop", egressMode: "drop", egressReason: "public_default_drop" },
      providerResponse: { suppressed: "drop", egress_reason: "public_default_drop" },
    });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it("maintained sink preserves exact key selection, original recipient, tags, optional payload and signal", async () => {
  const fetcher = vi.fn(async (_url: unknown, _options: RequestInit) => new Response(JSON.stringify({ id: "wire-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  for (const override of [undefined, "  sandbox-credential  "]) {
    const env = { COMMS_SANDBOX_SINK_ADDRESS: "  sink@example.invalid  ", RESEND_SANDBOX_API_KEY: override };
    const transport = guardEmailTransport(createEmailTransport({ apiKey: "primary-credential", env }));
    const complete = { ...input, text: "Notice", replyTo: "reply@example.invalid", idempotencyKey: " key:42 ",
      attachments: [{ filename: "note.txt", content: "bm90ZQ==" }], signal: new AbortController().signal };
    for (const message of [input, complete]) {
      expect(await transport.send(message)).toEqual({
        outcome: { ok: true, resendId: "wire-1", httpStatus: 200, providerError: null, aborted: false,
          egressMode: "sandbox_sink", egressReason: "public_default_sink" }, providerResponse: { id: "wire-1" },
      });
      const options = fetcher.mock.calls.at(-1)?.[1];
      expect(options).toEqual({ method: "POST", headers: {
        Authorization: `Bearer ${override?.trim() ?? "primary-credential"}`, "Content-Type": "application/json",
        "X-Original-Recipient": input.to,
        ...(message.idempotencyKey === undefined ? {} : { "Idempotency-Key": message.idempotencyKey }),
      }, body: JSON.stringify({ from: input.from, to: ["sink@example.invalid"], subject: input.subject, html: input.html,
        ...(message.text === undefined ? {} : { text: message.text }),
        ...(message.replyTo === undefined ? {} : { reply_to: message.replyTo }),
        ...(message.attachments === undefined ? {} : { attachments: message.attachments }),
        tags: [{ name: "openlup_env", value: "non_production" }],
      }), signal: message.signal });
      expect(options?.signal).toBe(message.signal);
    }
  }
  expect(resolveEmailApiKey({ RESEND_API_KEY: " primary ", RESEND_SANDBOX_API_KEY: " sandbox " })).toBe("primary");
  expect(resolveEmailApiKey({ RESEND_API_KEY: " ", RESEND_SANDBOX_API_KEY: " sandbox " })).toBe("sandbox");
});

it("maintained Auth bridge is identical to the existing envelope and result mapping on the wire", async () => {
  const fetcher = vi.fn(async (_url: unknown, _options: RequestInit) => new Response(JSON.stringify({ id: "auth-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const transport = createEmailTransport({ apiKey: "synthetic", env: { COMMS_SANDBOX_SINK_ADDRESS: "sink@example.invalid" } });
  const message = { sender: input.from, recipient: input.to, subject: input.subject, html: input.html, text: "Notice" };
  const old = await transport.send({ from: message.sender, to: message.recipient, subject: message.subject, html: message.html, text: message.text });
  expect(await createAuthEmailTransport(transport).send(message)).toEqual({
    outcome: { ...old.outcome, messageId: old.outcome.resendId }, providerResponse: old.providerResponse,
  });
  expect(fetcher.mock.calls[0]).toEqual(fetcher.mock.calls[1]);
});

it.each(["production", "sandbox_direct"] as const)("maintained client preserves isolated host %s routing, empty input key and tag", async (mode) => {
  routing.decision = { mode, reason: "synthetic_host", recipient: null, intendedRecipient: input.to };
  const fetcher = vi.fn(async (_url: unknown, _options: RequestInit) => new Response(JSON.stringify({ id: "wire-1" }), { status: 200 }));
  vi.stubGlobal("fetch", fetcher);
  const result = await guardEmailTransport(createEmailTransport({ apiKey: "", env: {} })).send(input);
  expect(result.outcome).toMatchObject({ ok: true, resendId: "wire-1", egressMode: mode, egressReason: "synthetic_host" });
  const options = fetcher.mock.calls[0]?.[1];
  expect(options?.headers).toEqual({ Authorization: "Bearer ", "Content-Type": "application/json" });
  expect(JSON.parse(String(options?.body))).toEqual({ from: input.from, to: [input.to], subject: input.subject, html: input.html,
    tags: [{ name: "openlup_env", value: mode === "production" ? "production" : "non_production" }] });
});

it("maintained explicit block precedes drop without HTTP or altered delivery classification", async () => {
  const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
  for (const reason of ["production_like_sandbox_test", "synthetic_block"]) {
    routing.decision = { mode: "drop", reason, recipient: null, intendedRecipient: input.to, blockedReason: "synthetic_profile_block" };
    expect(await guardEmailTransport(createEmailTransport({ apiKey: "", env: {} })).send(input)).toEqual({
      outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "synthetic_profile_block", aborted: false, egressMode: "drop", egressReason: reason },
      providerResponse: { egress_reason: "email_delivery_profile_blocked", deliveryMode: reason.startsWith("production_like_sandbox") ? "sandbox" : "production_like_real" },
    });
  }
  expect(fetcher).not.toHaveBeenCalled();
});

it.each(["failure", "abort"])("maintained client preserves sanitized %s diagnostics and uncertainty", async (scenario) => {
  routing.decision = { mode: "sandbox_direct", reason: "synthetic_host", recipient: input.to, intendedRecipient: input.to };
  const fetcher = vi.fn(async () => {
    if (scenario === "abort") throw Object.assign(new Error("stopped reader@example.invalid"), { name: "AbortError" });
    return new Response(JSON.stringify({ error: { message: "rejected reader@example.invalid", code: "validation_error" } }), { status: 403 });
  });
  vi.stubGlobal("fetch", fetcher);
  const result = await guardEmailTransport(createEmailTransport({ apiKey: "synthetic", env: {} })).send(input);
  expect(result).toEqual(scenario === "abort" ? {
    outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "stopped [email]", aborted: true, egressMode: "sandbox_direct", egressReason: "synthetic_host" },
    providerResponse: { exception: true, aborted: true },
  } : {
    outcome: { ok: false, resendId: null, httpStatus: 403, providerError: "rejected [email]", providerErrorCode: "validation_error", aborted: false, egressMode: "sandbox_direct", egressReason: "synthetic_host" },
    providerResponse: { http_status: 403, provider_error_message: "rejected [email]", provider_error_code: "validation_error" },
  });
});
