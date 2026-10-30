import { describe, expect, it, vi } from "vitest";
import { runChannelOrderPullScan, emptyResult, ChannelIngestUnavailableError } from "../../src/channels/server/index.js";
import type { ChannelOrderPullDeps, ChannelIngestOutcome } from "../../src/channels/server/index.js";
import type { ChannelConnectionPullRow, ChannelOrderSourcePort } from "../../src/channels/index.js";
import { orderFixture } from "./fixtures.js";
function harness() {
  const trace: string[] = [];
  const connection: ChannelConnectionPullRow = { connectionId: "connection:503", slug: "synthetic-connection", connectorProviderKind: "synthetic_source",
    connectorShape: "direct", pullCursor: "cursor:509", pullWatermarkAt: "2026-02-11T06:00:00Z", pullCaptureGeneration: 13 };
  const source: ChannelOrderSourcePort = { listChannelBindings: vi.fn(async () => []), acknowledgeOrder: vi.fn(async () => ({ acknowledged: true })),
    normalizeWebhook: vi.fn(async () => ({ kind: "ignored", providerEventId: "ignored:521", reason: "test" })),
    pullOrders: vi.fn(async () => ({ orders: [orderFixture()], unmapped: [], nextCursor: "cursor:523", watermarkAt: "2026-02-12T07:12:00Z" })) };
  const deps: ChannelOrderPullDeps = { connections: { listPullableConnections: vi.fn(async () => { trace.push("connections"); return [connection]; }), recordPullProgress: vi.fn(async () => { trace.push("progress"); }) },
    ingest: { ingestOrder: vi.fn(async (): Promise<ChannelIngestOutcome> => { trace.push("ingest"); return { kind: "settled", ledgerId: "ledger:541", orderId: "order:547", paymentIntentId: "intent:557" }; }),
      quarantineSignal: vi.fn(async () => { trace.push("quarantine"); return { quarantineId: "quarantine:563" }; }) },
    resolveOrderSource: vi.fn(() => { trace.push("resolve"); return source; }), selectsPurchasedSource: vi.fn(() => false) };
  return { connection, source, deps, trace, run: () => runChannelOrderPullScan(deps, new AbortController().signal) };
}
describe("R1 pull scan preservation witness", () => {
  it("uses the existing cursor/watermark ABI and advances after a fully handled direct page", async () => {
    const h = harness(); expect(await h.run()).toEqual({ ...emptyResult(), connections: 1, pulled: 1, settled: 1 });
    expect(h.trace).toEqual(["connections", "resolve", "ingest", "progress"]);
    expect(h.source.pullOrders).toHaveBeenCalledWith({ connectionRef: "connection:503", channelExternalRef: null, since: "2026-02-11T06:00:00Z", cursor: "cursor:509", limit: 50, signal: expect.any(AbortSignal) });
    expect(h.deps.connections.recordPullProgress).toHaveBeenCalledWith({ connectionId: "connection:503", pullCursor: "cursor:523", pullWatermarkAt: "2026-02-12T07:12:00Z" });
  });
  it("fans aggregator surfaces out without inventing per-surface legacy cursor state", async () => {
    const h = harness(); h.connection.connectorShape = "aggregator";
    vi.mocked(h.source.listChannelBindings).mockResolvedValue(["surface:a", "surface:b"].map(channelExternalRef => ({ channelExternalRef, displayName: channelExternalRef, marketplaceHint: null, currency: null, regionCode: null })));
    expect(await h.run()).toMatchObject({ connections: 1, pulled: 2, settled: 2 });
    expect(vi.mocked(h.source.pullOrders).mock.calls.map(([input]) => [input.channelExternalRef, input.cursor])).toEqual([["surface:a", "cursor:509"], ["surface:b", "cursor:509"]]);
  });
  it.each(["replayed", "blocked_stock", "quarantined", "refused"])("counts %s as handled and preserves legacy progress", async kind => {
    const h = harness(); const outcomes: Record<string, ChannelIngestOutcome> = {
      replayed: { kind: "replayed", ledgerId: "ledger:569", orderId: "order:571" }, blocked_stock: { kind: "blocked_stock", ledgerId: "ledger:577", orderId: "order:587", detail: "stock" },
      quarantined: { kind: "quarantined", ledgerId: null, reason: "money_mismatch", detail: "money" }, refused: { kind: "refused", refusal: "channel_not_active", detail: "disabled" } };
    vi.mocked(h.deps.ingest.ingestOrder).mockResolvedValue(outcomes[kind]); const result = await h.run();
    expect(result).toMatchObject({ ok: true, [kind === "blocked_stock" ? "blocked" : kind]: 1 });
    expect(h.deps.connections.recordPullProgress).toHaveBeenCalledTimes(1);
  });
  it("holds progress on unavailable ingest while still surfacing unmapped wire signals", async () => {
    const h = harness(); vi.mocked(h.deps.ingest.ingestOrder).mockRejectedValue(new ChannelIngestUnavailableError("channel_ingest_rails_unbound"));
    vi.mocked(h.source.pullOrders).mockResolvedValue({ orders: [orderFixture()], unmapped: [{ vocabulary: "UNKNOWN_WIRE", externalOrderRef: null, detail: null, payload: {} }], nextCursor: "cursor:new", watermarkAt: null });
    expect(await h.run()).toEqual({ ...emptyResult(), ok: false, connections: 1, pulled: 1, unavailable: 1, quarantined: 1, reason: "channel_ingest_rails_unbound" });
    expect(h.deps.ingest.quarantineSignal).toHaveBeenCalledWith({ providerEventId: "synthetic-connection:UNKNOWN_WIRE", signal: { vocabulary: "UNKNOWN_WIRE", externalOrderRef: null, detail: null, payload: {} } });
    expect(h.deps.connections.recordPullProgress).not.toHaveBeenCalled();
  });
  it("retains source-resolution unavailable skip without turning the entire scan into a fault", async () => {
    const h = harness(); vi.mocked(h.deps.resolveOrderSource).mockImplementation(() => { throw new Error("source_unbound"); });
    expect(await h.run()).toMatchObject({ ok: true, unavailable: 1, reason: "source_unbound" });
    expect(h.deps.connections.recordPullProgress).not.toHaveBeenCalled();
  });
  it("recovers paid debt before discovery and selects purchased pull through the host mapping", async () => {
    const h = harness(); h.deps.recoverPurchased = vi.fn(async () => { h.trace.push("recovery"); return { ...emptyResult(), replayed: 2 }; });
    h.deps.nativePull = vi.fn(async () => { h.trace.push("purchased"); return { ...emptyResult(), pulled: 3, settled: 1, blocked: 2 }; });
    vi.mocked(h.deps.selectsPurchasedSource).mockReturnValue(true);
    expect(await h.run()).toEqual({ ...emptyResult(), connections: 1, pulled: 3, settled: 1, blocked: 2, replayed: 2 });
    expect(h.trace).toEqual(["recovery", "connections", "purchased"]); expect(h.deps.resolveOrderSource).not.toHaveBeenCalled();
    expect(h.deps.selectsPurchasedSource).toHaveBeenCalledWith(h.connection);
  });
  it("keeps selected-source fallback when the purchased callback is absent", async () => {
    const h = harness(); vi.mocked(h.deps.selectsPurchasedSource).mockReturnValue(true);
    expect(await h.run()).toMatchObject({ settled: 1 }); expect(h.deps.resolveOrderSource).toHaveBeenCalledTimes(1);
  });
  it("preserves recovery, listing and purchased failures without advancing legacy progress", async () => {
    const h = harness(); h.deps.recoverPurchased = async () => { throw new Error("recovery_busy"); };
    vi.mocked(h.deps.connections.listPullableConnections).mockRejectedValue(new Error("list_busy"));
    expect(await h.run()).toMatchObject({ ok: false, reason: "list_busy", connections: 0 });
    vi.mocked(h.deps.connections.listPullableConnections).mockResolvedValue([h.connection]);
    vi.mocked(h.deps.selectsPurchasedSource).mockReturnValue(true); h.deps.nativePull = async () => { throw new Error("purchase_busy"); };
    expect(await h.run()).toMatchObject({ ok: false, unavailable: 1, reason: "purchase_busy" });
    expect(h.deps.connections.recordPullProgress).not.toHaveBeenCalled();
  });
  it("observes abort before processing connections", async () => {
    const h = harness(), abort = new AbortController(); abort.abort();
    expect(await runChannelOrderPullScan(h.deps, abort.signal)).toMatchObject({ ok: false, reason: "aborted", connections: 1 });
    expect(h.deps.resolveOrderSource).not.toHaveBeenCalled();
  });
});
