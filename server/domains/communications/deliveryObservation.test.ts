import { describe, expect, it, vi } from "vitest";
import { createResendWebhookHandler, RESEND_EVENT_MAP, type ResendWebhookPort } from "./resendWebhookHandler.js";
import { runResendDeliveryReconciliation, type ResendDeliveryReconciliationPort } from "./resendDeliveryReconciliationWorker.js";
import { createSupabaseResendWebhookPort } from "../../adapters/supabase/communications/resendWebhookPort.js";
import { createSupabaseResendDeliveryReconciliationPort } from "../../adapters/supabase/communications/resendDeliveryReconciliation.js";

const now = "2026-01-02T03:04:05.000Z";

function callback(overrides: Partial<ResendWebhookPort> = {}) {
  const calls: unknown[] = [];
  const port: ResendWebhookPort = {
    findEmailSendByResendId: async id => { calls.push(["lookup", id]); return { id: "send-1" }; },
    applyProviderEvent: async event => { calls.push(["apply", event]); },
    recordAttempt: async attempt => { calls.push(["attempt", attempt]); },
    ...overrides,
  };
  const clock = vi.fn(() => new Date(now));
  const createPort = vi.fn(() => port);
  const verify = vi.fn(() => true);
  const handler = createResendWebhookHandler({ webhookSecret: "synthetic", createPort, verifySignature: verify,
    environmentTagName: "environment", receivedAt: clock });
  const invoke = (payload: unknown, timestamp?: string) => handler({ rawBody: JSON.stringify(payload), headers: { webhookId: "event-1", timestamp } });
  return { calls, clock, createPort, verify, handler, invoke };
}

describe("reference callback characterization", () => {
  it.each(Object.keys(RESEND_EVENT_MAP))("routes %s without changing evidence", async type => {
    const h = callback();
    const data = { email_id: "message-1", click: { link: "https://example.invalid/link" }, extra: [1, 2] };
    expect(await h.invoke({ type, data, created_at: now })).toEqual({ status: 200, body: { success: true } });
    expect(h.calls).toEqual([
      ["lookup", "message-1"],
      ["apply", expect.objectContaining({ emailSendId: "send-1", resendId: "message-1", resendEventType: type, eventAt: now,
        metadata: expect.objectContaining({ providerEventId: "event-1", eventMetadata: data,
          link: data.click.link, eventTimeSource: "provider_created_at" }) })],
      ["attempt", expect.objectContaining({ outcome: "processed", httpStatus: 200, metadata: { send_id: "send-1" } })],
    ]);
    expect(h.clock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ type: "unknown", data: {} }, "unsupported_event", { ignored: true }],
    [{ type: "email.delivered", data: { email_id: "" } }, "missing_email_id", { ignored: true, reason: "missing_email_id" }],
    [{ type: "email.delivered", data: { email_id: 42 } }, "missing_email_id", { ignored: true, reason: "missing_email_id" }],
    [{ type: "email.delivered", data: { email_id: "message-1", tags: { environment: "production" } } }, "foreign_send_not_found", { ignored: true, reason: "foreign_send_not_found" }],
  ])("acknowledges admitted ignored input %#", async (payload, outcome, body) => {
    const h = callback();
    expect(await h.invoke(payload)).toEqual({ status: 200, body });
    expect(h.calls).toEqual([["attempt", expect.objectContaining({ outcome })]]);
    expect(h.clock).not.toHaveBeenCalled();
  });

  it("retains signature/OPTIONS/JSON admission before persistence", async () => {
    const h = callback();
    expect(await h.handler({ method: "OPTIONS", rawBody: "{", headers: {} })).toEqual({ status: 200, body: "ok" });
    expect(h.verify).not.toHaveBeenCalled();
    h.verify.mockReturnValue(false);
    expect(await h.invoke({})).toEqual({ status: 401, body: { error: "Invalid signature" } });
    h.verify.mockReturnValue(true);
    expect(await h.handler({ rawBody: "{", headers: {} })).toEqual({ status: 500, body: { error: expect.any(String) } });
    expect(h.createPort).not.toHaveBeenCalled();
  });

  it.each(["lookup", "apply", "attempt", "missing"])("retains %s exception/disposition ordering", async fault => {
    const h = callback({
      ...(fault === "lookup" ? { findEmailSendByResendId: async () => { throw Error("lookup"); } } : {}),
      ...(fault === "apply" ? { applyProviderEvent: async () => { throw Error("apply"); } } : {}),
      ...(fault === "attempt" ? { recordAttempt: async () => { throw Error("attempt"); } } : {}),
      ...(fault === "missing" ? { findEmailSendByResendId: async () => null } : {}),
    });
    const response = await h.invoke({ type: "email.delivered", data: { email_id: "message-1" } });
    expect(response).toEqual(fault === "lookup" || fault === "apply"
      ? { status: 500, body: { error: `Error: ${fault}` } }
      : { status: 200, body: fault === "missing" ? { ignored: true, reason: "send_not_found" } : { success: true } });
    if (fault === "lookup" || fault === "apply") expect(h.calls.some(c => (c as unknown[])[0] === "attempt")).toBe(false);
    if (fault === "missing") expect(h.clock).not.toHaveBeenCalled();
  });

  it.each(["unsupported", "foreign", "local"])("retains lazy factory failure for %s", async branch => {
    const h = callback();
    h.createPort.mockImplementation(() => { throw Error("factory"); });
    const response = await h.invoke({ type: branch === "unsupported" ? "unknown" : "email.delivered",
      data: { email_id: "message-1", ...(branch === "foreign" ? { tags: [{ name: "environment", value: "production" }] } : {}) } });
    expect(response).toEqual(branch === "unsupported" ? { status: 200, body: { ignored: true } }
      : { status: 500, body: { error: "Error: factory" } });
  });

  it.each([[now, "1", now, "provider_created_at"], ["bad", "1", "1970-01-01T00:00:01.000Z", "svix_timestamp"],
    [null, "bad", now, "received_at"]])("preserves timestamp precedence %#", async (created_at, timestamp, eventAt, source) => {
    const h = callback();
    await h.invoke({ type: "email.clicked", created_at, data: { email_id: "message-1" } }, timestamp ?? undefined);
    expect(h.calls[1]).toEqual(["apply", expect.objectContaining({ eventAt, metadata: expect.objectContaining({ eventTimeSource: source, link: null }) })]);
  });

  it("retains inherited table lookup and default environment semantics", async () => {
    const h = callback();
    expect(await h.invoke({ type: "toString", data: { email_id: "message-1", tags: { environment: "invalid" } } })).toEqual({ status: 200, body: { success: true } });
    expect(h.calls[1]).toEqual(["apply", expect.objectContaining({ resendEventType: "toString" })]);
  });
});

describe("reference polling characterization", () => {
  it.each([null, "unknown", "sent", "delivered", "delivery_delayed", "bounced", "complained", "failed"])("retains read mapping %s", async lastEvent => {
    const calls: unknown[] = [];
    const port: ResendDeliveryReconciliationPort = {
      findFrozenSends: async query => { calls.push(["query", query]); return [{ id: "send-1", resendId: "message-1", status: "sent" }]; },
      recordPollAttempt: async row => { calls.push(["rotate", row]); },
      applyPolledEvent: async event => { calls.push(["apply", event]); },
      recordSendNotFound: async () => { throw Error("unexpected"); },
    };
    const result = await runResendDeliveryReconciliation({ port, now, graceMinutes: 45, limit: 50,
      readEmail: async id => { calls.push(["read", id]); return { ok: true, httpStatus: 200, providerError: null, lastEvent, recipientEmail: "reader@example.invalid" }; } });
    const pending = !lastEvent || ["unknown", "sent"].includes(lastEvent);
    expect(result).toEqual({ checked: 1, reconciled: pending ? 0 : 1, stillPending: pending ? 1 : 0,
      terminalPolled: ["bounced", "complained", "failed"].includes(lastEvent ?? "") ? 1 : 0,
      failures: 0, abandoned: 0, failureBreakdown: { notFound: 0, authFailed: 0, network: 0, providerError: 0, other: 0 } });
    expect(calls.slice(0, 3)).toEqual([["query", { now, graceMinutes: 45, limit: 50 }], ["read", "message-1"], ["rotate", { sendId: "send-1", attemptedAt: now }]]);
    expect(calls.slice(3)).toEqual(pending ? [] : [["apply", { sendId: "send-1", resendId: "message-1", webhookType: `email.${lastEvent}`, eventAt: now, recipientEmail: "reader@example.invalid" }]]);
  });
});

it.each(["success", "lookup", "apply", "telemetry", "abort", "replay"])("W3: actual callback store records every effect on %s", async fault => {
  const effects: Array<[string, string, unknown?]> = [];
  const client = {
    from(table: string) {
      effects.push(["from", table]);
      return {
        select: (columns: string) => ({ eq: (column: string, value: string) => ({ maybeSingle: async () => {
          effects.push(["lookup", table, { columns, column, value }]);
          if (fault === "abort") throw new DOMException("aborted", "AbortError");
          return { data: { id: "send-1" }, error: fault === "lookup" ? "unavailable" : null };
        } }) }),
        insert: async (row: unknown) => { effects.push(["insert", table, row]); if (fault === "telemetry") throw Error(fault); },
      };
    },
    async rpc(name: string, args: Record<string, unknown>) {
      effects.push(["rpc", name, args]);
      return { data: null, error: fault === "apply" ? "unavailable" : null };
    },
  };
  const handler = createResendWebhookHandler({ webhookSecret: "synthetic", environmentTagName: "environment",
    verifySignature: () => true, createPort: () => createSupabaseResendWebhookPort(client), receivedAt: () => new Date(now) });
  const request = { rawBody: JSON.stringify({ type: "email.complained", created_at: now,
    data: { email_id: "message-1", email: "reader@example.invalid" } }), headers: { webhookId: "event-1" } };
  const result = await handler(request);
  expect(result.status).toBe(["lookup", "apply", "abort"].includes(fault) ? 500 : 200);
  if (fault === "replay") expect(await handler(request)).toEqual(result);
  // Inspect every recorded access, including telemetry failures swallowed by the store.
  // There is one convergence writer and no subscription/cycle/payment/dunning writer.
  expect(effects.length).toBeGreaterThan(0);
  for (const [operation, target] of effects) {
    expect(operation === "rpc" ? ["communication_update_email_delivery_from_provider"] : ["email_sends", "email_webhook_attempts"]).toContain(target);
    if (operation === "insert") expect(target).toBe("email_webhook_attempts");
  }
  expect(effects.filter(([operation]) => operation === "rpc")).toHaveLength(["lookup", "abort"].includes(fault) ? 0 : fault === "replay" ? 2 : 1);
});

it.each([200, 404, 401, 0, 503])("W3: actual polling store records every write on HTTP %s", async httpStatus => {
  const effects: Array<[string, string, unknown]> = [];
  const client = {
    from: (table: string) => ({ update: (patch: unknown) => ({ eq: async () => {
      effects.push(["update", table, patch]); return { data: null, error: null };
    } }) }),
    rpc: async (name: string, args: unknown) => { effects.push(["rpc", name, args]); return { data: false, error: null }; },
  };
  const store = createSupabaseResendDeliveryReconciliationPort(client as unknown as Parameters<typeof createSupabaseResendDeliveryReconciliationPort>[0]);
  const port = { ...store, findFrozenSends: async () => [{ id: "send-1", resendId: "message-1", status: "sent" }] };
  await runResendDeliveryReconciliation({ port, now, graceMinutes: 45, limit: 50,
    readEmail: async () => ({ ok: httpStatus === 200, httpStatus, lastEvent: "complained", recipientEmail: "reader@example.invalid", providerError: null }) });
  expect(effects.map(([operation, target]) => [operation, target])).toEqual(httpStatus === 404
    ? [["rpc", "communication_record_email_poll_not_found"]]
    : [["update", "email_sends"], ...(httpStatus === 200 ? [["rpc", "communication_update_email_delivery_from_provider"]] : [])]);
});
