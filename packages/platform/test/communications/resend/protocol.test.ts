import { createHmac } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createResendWebhookHandler, runResendDeliveryReconciliation } from "../../../src/communications/resend/index.js";
import type { EmailObservationPort } from "../../../src/communications/emailObservation.js";
import type { DeliveryReconciliationPort } from "../../../src/communications/deliveryReconciliation.js";

const instant = 1_920_034_567;
const at = new Date(instant * 1000).toISOString();
const material = Buffer.from("synthetic-hook-material");
const secret = `whsec_${material.toString("base64")}`;
const data = { email_id: "message-1", click: { link: "https://example.invalid/雪" } };
const payload = { type: "email.delivered", created_at: at, data };
function signed(rawBody: string | Uint8Array = JSON.stringify(payload), timestamp = String(instant), key: string | Buffer = material) {
  const digest = createHmac("sha256", key).update(`hook-1.${timestamp}.`).update(rawBody).digest("base64");
  return { rawBody, headers: { webhookId: "hook-1", timestamp, signature: `v1,${digest}` } };
}
function hook(options: Partial<Parameters<typeof createResendWebhookHandler>[0]> = {}) {
  const port = { findSend: vi.fn(async () => ({ id: "send-1" }) as { id: string } | null), applyObservation: vi.fn(async () => {}), recordAttempt: vi.fn(async () => {}) } satisfies EmailObservationPort;
  const receivedAt = vi.fn(() => new Date(at));
  return { port, receivedAt, handle: createResendWebhookHandler({ port, webhookSecret: secret, environmentTagName: "host_env", now: () => instant, receivedAt, ...options }) };
}

it("R01 W2 Resend dialect preserves bare/v1 members and literal/base64 keys without Auth normalization", async () => {
  for (const webhookSecret of [material.toString(), secret, secret.replace(/=+$/, "")]) {
    for (const version of ["", "v1,", "v7,"]) {
      const h = hook({ webhookSecret }); const request = signed();
      request.headers.signature = `v1,wrong ${version}${request.headers.signature.slice(3)} v1,wrong`;
      expect((await h.handle(request)).status).toBe(version === "v7," ? 401 : 200);
    }
  }
  expect((await hook({ webhookSecret: `v1,${secret}` }).handle(signed())).status).toBe(401);
});
it("R02 W2 malformed/empty signing material cannot authenticate permissively decoded keys", async () => {
  for (const webhookSecret of ["", "whsec_", "whsec_%", "whsec_Q", "whsec_Zh=="]) {
    const key = webhookSecret.startsWith("whsec_") ? Buffer.from(webhookSecret.slice(6), "base64") : webhookSecret;
    const h = hook({ webhookSecret });
    expect((await h.handle(signed(undefined, undefined, key))).status).toBe(401);
    expect(h.port.findSend).not.toHaveBeenCalled();
  }
});
it("R03 W2 UTC-seconds replay boundaries ±300 accepted and ±301 refused", async () => {
  for (const offset of [-300, 300, -301, 301]) {
    const h = hook();
    expect((await h.handle(signed(undefined, String(instant + offset)))).status).toBe(Math.abs(offset) <= 300 ? 200 : 401);
  }
});
it("R04 W2 missing authentication fields and non-finite timestamps never reach lookup", async () => {
  for (const headers of [
    { ...signed().headers, webhookId: undefined }, { ...signed().headers, signature: undefined },
    { ...signed().headers, timestamp: undefined }, { ...signed().headers, timestamp: "NaN" },
    { ...signed().headers, timestamp: "Infinity" },
  ]) {
    const h = hook();
    expect((await h.handle({ rawBody: JSON.stringify(payload), headers })).status).toBe(401);
    expect(h.port.findSend).not.toHaveBeenCalled(); expect(h.receivedAt).not.toHaveBeenCalled();
  }
});
it("R05 W2 authenticates original whitespace and UTF-8 bytes before decoding", async () => {
  const h = hook(); const bytes = Buffer.from(` \n${JSON.stringify(payload)}\n`);
  const request = signed(bytes);
  expect((await h.handle(request)).status).toBe(200);
  expect((await h.handle({ ...request, rawBody: Buffer.from(JSON.stringify(payload)) })).status).toBe(401);
  expect(h.port.findSend).toHaveBeenCalledTimes(1);
  expect(h.port.applyObservation).toHaveBeenCalledWith({ sendId: "send-1", messageId: "message-1", eventType: "delivered", eventAt: at,
    metadata: { providerEventId: "hook-1", eventMetadata: data, link: data.click.link, source: "resend-webhook", eventTimeSource: "provider_created_at" } });
});
it("R06 W2 invalid JSON is rejected by authentication first; authenticated parse failures retry", async () => {
  const h = hook();
  expect(await h.handle({ rawBody: "{", headers: {} }), "R06 authenticate before JSON parse").toEqual({ status: 401, body: { error: "Invalid signature" } });
  expect((await h.handle(signed("{"))).status).toBe(500);
  expect(h.port.findSend).not.toHaveBeenCalled();
  expect(await h.handle({ method: "OPTIONS", rawBody: "{", headers: {} })).toEqual({ status: 200, body: "ok" });
});
it("R07 W2 explicit foreign tags never reach convergence, default receiver is non-production", async () => {
  for (const tags of [[{ name: "host_env", value: "production" }], { host_env: "production" }]) {
    const h = hook(); const request = signed(JSON.stringify({ ...payload, data: { ...data, tags } }));
    expect(await h.handle(request)).toEqual({ status: 200, body: { ignored: true, reason: "foreign_send_not_found" } });
    expect(h.port.findSend).not.toHaveBeenCalled(); expect(h.port.applyObservation).not.toHaveBeenCalled(); expect(h.receivedAt).not.toHaveBeenCalled();
    const production = hook({ resolveReceiverEnvironmentTag: () => "production" });
    expect((await production.handle(request)).status).toBe(200); expect(production.port.applyObservation).toHaveBeenCalledTimes(1);
  }
  for (const tags of [undefined, { host_env: "non_production" }, [{ name: "host_env", value: "non_production" }], { host_env: "unknown" }]) {
    const h = hook(); await h.handle(signed(JSON.stringify({ ...payload, data: { ...data, tags } })));
    expect(h.port.applyObservation).toHaveBeenCalledTimes(1);
  }
});
it("R08 W2 event mapping and replay feed the accepted observation port", async () => {
  const h = hook();
  for (const [type, eventType] of Object.entries({ sent: "sent", delivered: "delivered", delivery_delayed: "delivery_delayed", opened: "open", clicked: "click", bounced: "bounce", complained: "complaint", failed: "failed", suppressed: "suppressed", scheduled: "scheduled" })) {
    const request = signed(JSON.stringify({ ...payload, type: `email.${type}` }));
    await h.handle(request); await h.handle(request);
    expect(h.port.applyObservation).toHaveBeenLastCalledWith(expect.objectContaining({ eventType }));
  }
  expect(h.port.applyObservation).toHaveBeenCalledTimes(20);
});
it("R09 W2 unsupported and missing-ID events have no lookup, evidence clock or writer", async () => {
  const h = hook();
  for (const event of [{ type: "email.unknown", data }, { type: "constructor", data }, { type: "email.delivered", data: {} }]) {
    expect((await h.handle(signed(JSON.stringify(event)))).body).toMatchObject({ ignored: true });
  }
  expect(h.port.findSend).not.toHaveBeenCalled(); expect(h.port.applyObservation).not.toHaveBeenCalled(); expect(h.receivedAt).not.toHaveBeenCalled();
});
it("R10 W2 observation conformance: lookup/apply failures retry", async () => {
  for (const fault of ["lookup", "apply"]) {
    const label = `R10 observation ${fault}`;
    const h = hook();
    if (fault === "lookup") h.port.findSend.mockRejectedValue(Error(fault));
    if (fault === "apply") h.port.applyObservation.mockRejectedValue(Error(fault));
    if (fault === "telemetry") h.port.recordAttempt.mockRejectedValue(Error(fault));
    if (fault === "missing") h.port.findSend.mockResolvedValue(null);
    const response = await h.handle(signed());
    expect(response.status, `${label}: retryable lookup/apply; best-effort telemetry`).toBe(["lookup", "apply"].includes(fault) ? 500 : 200);
    expect(h.port.applyObservation, `${label}: convergence writer count`).toHaveBeenCalledTimes(["lookup", "missing"].includes(fault) ? 0 : 1);
    expect(h.port.recordAttempt, `${label}: telemetry count`).toHaveBeenCalledTimes(["lookup", "apply"].includes(fault) ? 0 : 1);
    expect(h.receivedAt, `${label}: evidence clock count`).toHaveBeenCalledTimes(["lookup", "missing"].includes(fault) ? 0 : 1);
    if (fault === "missing") expect(response.body, `${label}: ignored missing send`).toEqual({ ignored: true, reason: "send_not_found" });
  }
});
it("R11 W2 observation conformance: telemetry is best effort; missing send is ignored", async () => {
  for (const fault of ["telemetry", "missing"]) {
    const label = `R11 observation ${fault}`;
    const h = hook();
    if (fault === "lookup") h.port.findSend.mockRejectedValue(Error(fault));
    if (fault === "apply") h.port.applyObservation.mockRejectedValue(Error(fault));
    if (fault === "telemetry") h.port.recordAttempt.mockRejectedValue(Error(fault));
    if (fault === "missing") h.port.findSend.mockResolvedValue(null);
    const response = await h.handle(signed());
    expect(response.status, `${label}: retryable lookup/apply; best-effort telemetry`).toBe(["lookup", "apply"].includes(fault) ? 500 : 200);
    expect(h.port.applyObservation, `${label}: convergence writer count`).toHaveBeenCalledTimes(["lookup", "missing"].includes(fault) ? 0 : 1);
    expect(h.port.recordAttempt, `${label}: telemetry count`).toHaveBeenCalledTimes(["lookup", "apply"].includes(fault) ? 0 : 1);
    expect(h.receivedAt, `${label}: evidence clock count`).toHaveBeenCalledTimes(["lookup", "missing"].includes(fault) ? 0 : 1);
    if (fault === "missing") expect(response.body, `${label}: ignored missing send`).toEqual({ ignored: true, reason: "send_not_found" });
  }
});

function polling() {
  const port = { findFrozenSends: vi.fn(async () => [{ id: "send-1", messageId: "message/1" }]), applyPolledEvent: vi.fn(async () => {}),
    recordPollAttempt: vi.fn(async () => {}), recordSendNotFound: vi.fn(async () => ({ abandoned: true })) } satisfies DeliveryReconciliationPort;
  const fetcher = vi.fn<typeof fetch>(async () => Response.json({ last_event: "delivered", to: ["reader@example.invalid"] }));
  const signal = new AbortController().signal;
  return { port, fetcher, signal, run: () => runResendDeliveryReconciliation({ port, now: at, graceMinutes: 45, limit: 3, apiKey: "synthetic-read-only", fetch: fetcher, signal }) };
}
it("R12 W2 polling mapping preserves pending and terminal states and bounded GET-only IO", async () => {
  const h = polling();
  for (const last_event of ["sent", "unknown", "opened", null, "delivered", "delivery_delayed", "bounced", "complained", "failed"]) {
    h.port.applyPolledEvent.mockClear();
    h.fetcher.mockImplementation(async () => Response.json({ last_event, to: [1, "reader@example.invalid"] }));
    const pending = ["sent", "unknown", "opened", null].includes(last_event);
    const terminal = ["bounced", "complained", "failed"].includes(last_event!);
    expect(await h.run()).toMatchObject({ checked: 1, stillPending: pending ? 1 : 0, reconciled: pending ? 0 : 1, terminalPolled: terminal ? 1 : 0 });
    expect(h.port.applyPolledEvent.mock.calls).toEqual(pending ? [] : [[{ sendId: "send-1", messageId: "message/1", eventType: `email.${last_event}`, eventAt: at, recipientEmail: "reader@example.invalid" }]]);
  }
  expect(h.port.findFrozenSends).toHaveBeenLastCalledWith({ now: at, graceMinutes: 45, limit: 3 });
  expect(h.fetcher).toHaveBeenCalledTimes(9);
  for (const [url, options] of h.fetcher.mock.calls) {
    expect(url).toBe("https://api.resend.com/emails/message%2F1");
    expect(options).toEqual({ method: "GET", headers: { Authorization: "Bearer synthetic-read-only" }, signal: h.signal });
  }
});
it("R13 W2 only 404 abandons; auth/network/outage and malformed success never recover-send", async () => {
  for (const status of [404, 401, 403, 0, 500, 429, 200]) {
    const h = polling();
    h.fetcher.mockImplementation(async () => { if (!status) throw Error("network"); return new Response("not json", { status }); });
    const result = await h.run();
    expect(result.abandoned, `R13 status ${status}: 404-only abandonment`).toBe(status === 404 ? 1 : 0);
    expect(result.failures).toBe(status === 200 ? 0 : 1);
    expect(h.port.recordSendNotFound.mock.calls, `R13 status ${status}: threshold-3 404-only writer`).toEqual(status === 404 ? [[{ sendId: "send-1", threshold: 3 }]] : []);
    expect(h.port.recordPollAttempt).toHaveBeenCalledTimes(status === 404 ? 0 : 1);
    if ([401, 403].includes(status)) expect(result.failureBreakdown.authFailed).toBe(1);
    expect(h.fetcher).toHaveBeenCalledTimes(1); expect(h.fetcher.mock.calls[0][1]!.method).toBe("GET");
  }
});
it("R14 W2 webhook and poll share one host convergence writer without send authority", async () => {
  const writer = vi.fn(async (_event: unknown) => {});
  const h = hook(); h.port.applyObservation.mockImplementation(writer);
  const p = polling(); p.port.applyPolledEvent.mockImplementation(writer);
  await h.handle(signed()); await p.run();
  expect(writer.mock.calls.map(([event]) => event)).toEqual([
    expect.objectContaining({ sendId: "send-1", messageId: "message-1", eventType: "delivered" }),
    expect.objectContaining({ sendId: "send-1", messageId: "message/1", eventType: "email.delivered" }),
  ]);
  expect(p.fetcher.mock.calls.every(([, options]) => options!.method === "GET")).toBe(true);
});
it("R15 W2 event time fallback retains provider, signed timestamp, then receipt clock", async () => {
  for (const [created_at, timestamp, expected, source] of [[at, "0", at, "provider_created_at"], ["bad", String(instant), at, "svix_timestamp"], [null, "0", at, "received_at"]] as const) {
    const h = hook({ now: () => Number(timestamp) });
    await h.handle(signed(JSON.stringify({ ...payload, created_at }), timestamp));
    expect(h.port.applyObservation).toHaveBeenCalledWith(expect.objectContaining({ eventAt: expected, metadata: expect.objectContaining({ eventTimeSource: source }) }));
  }
});
