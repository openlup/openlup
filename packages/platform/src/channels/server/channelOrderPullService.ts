import type { ChannelConnectionPullPort, ChannelConnectionPullRow } from "../channelIngestStorePort.js";
import { ChannelIngestUnavailableError, type ChannelWebhookPort } from "./channelWebhookHandler.js";
import type { ChannelOrderSourcePort } from "../connectorPort.js";
export interface ChannelOrderPullResult {
  ok: boolean; connections: number; pulled: number; settled: number; replayed: number;
  quarantined: number; blocked: number; refused: number; unavailable: number; reason?: string;
}
export interface ChannelOrderPullDeps {
  connections: ChannelConnectionPullPort; ingest: ChannelWebhookPort;
  resolveOrderSource(kind: string): ChannelOrderSourcePort;
  /** Host maps its purchased-source identity; selection precedes ordinary source resolution. */
  selectsPurchasedSource(connection: ChannelConnectionPullRow): boolean;
  nativePull?: (connection: ChannelConnectionPullRow, signal: AbortSignal) => Promise<ChannelOrderPullResult>;
  recoverPurchased?: (signal: AbortSignal) => Promise<ChannelOrderPullResult>;
}
export function emptyResult(): ChannelOrderPullResult {
  return { ok: true, connections: 0, pulled: 0, settled: 0, replayed: 0, quarantined: 0, blocked: 0, refused: 0, unavailable: 0 };
}
function safeMessage(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 180); }
function combine(target: ChannelOrderPullResult, value: ChannelOrderPullResult): void {
  for (const key of ["pulled", "settled", "replayed", "quarantined", "blocked", "refused", "unavailable"] as const) target[key] += value[key];
  if (!value.ok) target.ok = false;
  target.reason ??= value.reason;
}
export async function runChannelOrderPullScan(deps: ChannelOrderPullDeps, signal: AbortSignal): Promise<ChannelOrderPullResult> {
  const result = emptyResult();
  if (deps.recoverPurchased) {
    try { combine(result, await deps.recoverPurchased(signal)); }
    catch (error) { result.ok = false; result.reason = safeMessage(error); }
  }
  let connections: readonly ChannelConnectionPullRow[];
  try { connections = await deps.connections.listPullableConnections(); }
  catch (error) { return { ...result, ok: false, reason: safeMessage(error) }; }
  result.connections = connections.length;
  for (const connection of connections) {
    if (signal.aborted) { result.ok = false; result.reason = "aborted"; break; }
    if (deps.selectsPurchasedSource(connection) && deps.nativePull) {
      try { combine(result, await deps.nativePull(connection, signal)); }
      catch (error) { result.ok = false; result.unavailable++; result.reason = safeMessage(error); }
      continue;
    }
    let source: ChannelOrderSourcePort;
    try { source = deps.resolveOrderSource(connection.connectorProviderKind); }
    catch (error) { result.unavailable++; result.reason ??= safeMessage(error); continue; }
    try { await pullConnection(deps, connection, source, signal, result); }
    catch (error) { result.ok = false; result.reason = safeMessage(error); }
  }
  return result;
}
async function pullConnection(deps: ChannelOrderPullDeps, connection: ChannelConnectionPullRow,
  source: ChannelOrderSourcePort, signal: AbortSignal, result: ChannelOrderPullResult): Promise<void> {
  const surfaces = connection.connectorShape === "aggregator"
    ? (await source.listChannelBindings({ connectionRef: connection.connectionId, signal })).map(value => value.channelExternalRef) : [null];
  for (const channelExternalRef of surfaces) {
    const page = await source.pullOrders({ connectionRef: connection.connectionId, channelExternalRef,
      since: connection.pullWatermarkAt, cursor: connection.pullCursor, limit: 50, signal });
    result.pulled += page.orders.length;
    let handled = true;
    for (const order of page.orders) {
      try {
        const { kind } = await deps.ingest.ingestOrder(order);
        if (kind === "settled") result.settled++;
        else if (kind === "replayed") result.replayed++;
        else if (kind === "quarantined") result.quarantined++;
        else if (kind === "blocked_stock") result.blocked++;
        else result.refused++;
      } catch (error) {
        if (!(error instanceof ChannelIngestUnavailableError)) throw error;
        result.unavailable++; result.reason ??= error.reason; handled = false;
      }
    }
    for (const signal of page.unmapped) {
      await deps.ingest.quarantineSignal({ providerEventId: `${connection.slug}:${signal.vocabulary}`, signal });
      result.quarantined++;
    }
    if (!handled) { result.ok = false; continue; }
    await deps.connections.recordPullProgress({ connectionId: connection.connectionId,
      pullCursor: page.nextCursor, pullWatermarkAt: page.watermarkAt });
  }
}
