import { describe, expect, it, vi } from "vitest";
import type { HttpRequest, HttpResponse } from "../../src/http/index.js";
import { createChannelWebhookHandler, emptyChannelWebhookPort, ChannelIngestUnavailableError } from "../../src/channels/server/index.js";
import type { ChannelWebhookHandlerDeps, ChannelIngestOutcome } from "../../src/channels/server/index.js";
import type { NormalizedWebhookResult } from "../../src/channels/index.js";
import { orderFixture } from "./fixtures.js";

function harness() {
  const trace: string[] = [], order = orderFixture();
  const normalized: NormalizedWebhookResult = { kind: "order", providerEventId: "wire-event:307", order };
  const deps: ChannelWebhookHandlerDeps = {
    connectorKind: "synthetic_source", enabled: vi.fn(() => { trace.push("flag"); return true; }),
    verifyToken: vi.fn(() => { trace.push("token"); return true; }),
    readRawBody: vi.fn(async () => { trace.push("body"); return "synthetic bytes"; }),
    connector: { normalizeWebhook: vi.fn(async () => { trace.push("signature"); return normalized; }) },
    port: { ingestOrder: vi.fn(async (): Promise<ChannelIngestOutcome> => { trace.push("ingest"); return { kind: "settled", ledgerId: "ledger:311", orderId: "order:313", paymentIntentId: "intent:317" }; }),
      quarantineSignal: vi.fn(async () => { trace.push("quarantine"); return { quarantineId: "quarantine:331" }; }) },
  };
  const req = { method: "POST", headers: { "X-Wire": ["first", "second"], ignored: undefined }, query: {} } as unknown as HttpRequest;
  const res = { setHeader: vi.fn(), status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() } as unknown as HttpResponse;
  const run = () => createChannelWebhookHandler(deps)(req, res);
  const envelope = () => vi.mocked(res.json).mock.calls.at(-1)?.[0];
  const error = (code: string, message: string, details?: Record<string, unknown>) => ({ ok: false, error: { code, message, ...(details ? { details } : {}) } });
  return { trace, deps, req, res, run, envelope, error };
}

// C1: fourteen original handler behaviors plus the three exact operator-evidence outcomes.
// This is a handler-port witness; it makes no live connector or signature implementation claim.
describe("R1 webhook C1 — 17 preserved cases", () => {
  it("01 method guard precedes flag, token and body", async () => {
    const h = harness(); h.req.method = "GET"; await h.run();
    expect(h.trace).toEqual([]); expect(h.res.status).toHaveBeenCalledWith(405);
    expect(h.res.setHeader).toHaveBeenCalledWith("Allow", "POST");
    expect(h.envelope()).toEqual(h.error("METHOD_NOT_ALLOWED", "Method not allowed"));
  });
  it("02 disabled flag refuses before token or body", async () => {
    const h = harness(); vi.mocked(h.deps.enabled).mockReturnValue(false); await h.run();
    expect(h.trace).toEqual([]); expect(h.res.status).toHaveBeenCalledWith(503);
    expect(h.envelope()).toEqual(h.error("UPSTREAM_UNAVAILABLE", "Channel webhook is disabled", { feature: "channel-ingest-webhook", connectorKind: "synthetic_source", reason: "feature_flag_disabled" }));
  });
  it("03 token rejection never normalizes or writes", async () => {
    const h = harness(); vi.mocked(h.deps.verifyToken).mockReturnValue(false); h.deps.port = emptyChannelWebhookPort(); await h.run();
    expect(h.trace).toEqual(["flag"]); expect(h.res.status).toHaveBeenCalledWith(403);
    expect(h.envelope()).toEqual(h.error("FORBIDDEN", "Channel webhook token rejected", { connectorKind: "synthetic_source", reason: "token_rejected" }));
  });
  it("04 empty port refuses both durable operations", async () => {
    const port = emptyChannelWebhookPort();
    await expect(port.ingestOrder(orderFixture())).rejects.toThrow("channel_webhook_port_unavailable");
    await expect(port.quarantineSignal({ providerEventId: "event:337", signal: { vocabulary: "unknown", externalOrderRef: null, detail: null, payload: {} } })).rejects.toThrow("channel_webhook_port_unavailable");
  });
  it("05 signature rejection cannot touch the ingest port", async () => {
    const h = harness(); vi.mocked(h.deps.connector.normalizeWebhook).mockResolvedValue({ kind: "rejected", reason: "signature" }); await h.run();
    expect(h.deps.port.ingestOrder).not.toHaveBeenCalled(); expect(h.deps.port.quarantineSignal).not.toHaveBeenCalled();
    expect(h.envelope()).toEqual(h.error("FORBIDDEN", "Channel webhook signature rejected", { connectorKind: "synthetic_source", reason: "signature_rejected" }));
    expect(h.res.status).toHaveBeenCalledWith(403);
  });
  it("06 malformed normalization refuses without a durable write", async () => {
    const h = harness(); vi.mocked(h.deps.connector.normalizeWebhook).mockResolvedValue({ kind: "rejected", reason: "malformed" }); await h.run();
    expect(h.envelope()).toEqual(h.error("BAD_REQUEST", "Channel webhook payload is malformed", { connectorKind: "synthetic_source", reason: "payload_malformed" }));
    expect(h.deps.port.ingestOrder).not.toHaveBeenCalled(); expect(h.res.status).toHaveBeenCalledWith(400);
  });
  it("07 unknown vocabulary is filed once and acknowledged with exact evidence", async () => {
    const h = harness(), signal = { vocabulary: "WIRE_UNRECOGNIZED", externalOrderRef: "sale:347", detail: null, payload: { opaque: true } };
    vi.mocked(h.deps.connector.normalizeWebhook).mockResolvedValue({ kind: "unmapped", providerEventId: "unmapped:349", signal }); await h.run();
    expect(h.deps.port.quarantineSignal).toHaveBeenCalledWith({ providerEventId: "unmapped:349", signal });
    expect(h.deps.port.ingestOrder).not.toHaveBeenCalled(); expect(h.res.status).toHaveBeenCalledWith(200);
    expect(h.envelope()).toEqual({ ok: true, data: { connectorKind: "synthetic_source", status: "quarantined", providerEventId: "unmapped:349",
      reason: "unmapped_vocabulary", vocabulary: "WIRE_UNRECOGNIZED", quarantineId: "quarantine:331" } });
  });
  it("08 unmodeled signal is acknowledged without ingest", async () => {
    const h = harness(); vi.mocked(h.deps.connector.normalizeWebhook).mockResolvedValue({ kind: "ignored", providerEventId: "ignored:353", reason: "not_an_order" }); await h.run();
    expect(h.envelope()).toEqual({ ok: true, data: { connectorKind: "synthetic_source", status: "ignored", providerEventId: "ignored:353", reason: "not_an_order" } });
    expect(h.deps.port.ingestOrder).not.toHaveBeenCalled(); expect(h.res.status).toHaveBeenCalledWith(200);
  });
  it("09 settled response contains original event/order and only operator evidence", async () => {
    const h = harness(); await h.run();
    expect(h.trace).toEqual(["flag", "token", "body", "signature", "ingest"]);
    expect(h.deps.connector.normalizeWebhook).toHaveBeenCalledWith({ headers: { "x-wire": "first" }, rawBody: "synthetic bytes", signal: expect.any(AbortSignal) });
    expect(h.envelope()).toEqual({ ok: true, data: { connectorKind: "synthetic_source", status: "settled", providerEventId: "wire-event:307", externalOrderRef: "sale:47",
      ledgerId: "ledger:311", orderId: "order:313", paymentIntentId: "intent:317" } });
  });
  it("10 admission refusal answers conflict and never ACK success", async () => {
    const h = harness(); vi.mocked(h.deps.port.ingestOrder).mockResolvedValue({ kind: "refused", refusal: "channel_not_found", detail: "no registered surface" }); await h.run();
    expect(h.res.status).toHaveBeenCalledWith(409);
    expect(h.envelope()).toEqual(h.error("CONFLICT", "Channel webhook delivery refused", { connectorKind: "synthetic_source", reason: "channel_not_found", detail: "no registered surface" }));
  });
  it("11 currency refusal preserves its original detail in the same conflict envelope", async () => {
    const h = harness(); vi.mocked(h.deps.port.ingestOrder).mockResolvedValue({ kind: "refused", refusal: "currency_not_accepted", detail: "currency USD is not settled here (channel USD, order USD)" }); await h.run();
    expect(h.envelope()).toEqual(h.error("CONFLICT", "Channel webhook delivery refused", { connectorKind: "synthetic_source", reason: "currency_not_accepted", detail: "currency USD is not settled here (channel USD, order USD)" }));
    expect(h.res.status).toHaveBeenCalledWith(409);
  });
  it("12 missing rails answer unavailable with the named reason", async () => {
    const h = harness(); vi.mocked(h.deps.port.ingestOrder).mockRejectedValue(new ChannelIngestUnavailableError("channel_ingest_rails_unbound")); await h.run();
    expect(h.envelope()).toEqual(h.error("UPSTREAM_UNAVAILABLE", "Channel ingest is not configured", { connectorKind: "synthetic_source", reason: "channel_ingest_rails_unbound" }));
    expect(h.res.status).toHaveBeenCalledWith(503);
  });
  it("13 genuine faults remain thrown", async () => {
    const h = harness(), error = new Error("transient_write_busy"); vi.mocked(h.deps.port.ingestOrder).mockRejectedValue(error);
    await expect(h.run()).rejects.toBe(error); expect(h.res.json).not.toHaveBeenCalled();
  });
  it("14 unreadable raw body stops before normalization", async () => {
    const h = harness(); vi.mocked(h.deps.readRawBody).mockRejectedValue(new Error("too large")); await h.run();
    expect(h.deps.connector.normalizeWebhook).not.toHaveBeenCalled(); expect(h.res.status).toHaveBeenCalledWith(400);
    expect(h.envelope()).toEqual(h.error("BAD_REQUEST", "Channel webhook body could not be read", { connectorKind: "synthetic_source", reason: "body_unreadable" }));
  });
  it.each([
    { number: 15, outcome: { kind: "replayed", ledgerId: "ledger:359", orderId: "order:367" } },
    { number: 16, outcome: { kind: "blocked_stock", ledgerId: "ledger:373", orderId: "order:379", detail: "stock_busy" } },
    { number: 17, outcome: { kind: "quarantined", ledgerId: null, reason: "revision_conflict", detail: "original revision retained" } },
  ] satisfies { number: number; outcome: ChannelIngestOutcome }[])("$number $outcome.kind preserves exact evidence without buyer payload or duplicate quarantine", async ({ outcome }) => {
    const h = harness(); vi.mocked(h.deps.port.ingestOrder).mockResolvedValue(outcome); await h.run();
    const { kind, ...evidence } = outcome;
    expect(h.envelope()).toEqual({ ok: true, data: { connectorKind: "synthetic_source", status: kind,
      providerEventId: "wire-event:307", externalOrderRef: "sale:47", ...evidence } });
    expect(h.deps.port.ingestOrder).toHaveBeenCalledTimes(1); expect(h.deps.port.quarantineSignal).not.toHaveBeenCalled();
    expect(h.res.status).toHaveBeenCalledWith(200);
  });
});
