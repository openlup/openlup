import type { ChannelPurchaseCapture } from "../channelPurchaseSourceContracts.js";
import type { ChannelIngestOutcome } from "./channelOrderIngestSaga.js";
/** Recovery selection is independent of discovery enablement and provider cursors. */
export async function recoverChannelPurchasedOrders(input: {
  signal: AbortSignal; list(): Promise<readonly ChannelPurchaseCapture[]>;
  recover(capture: ChannelPurchaseCapture): Promise<ChannelIngestOutcome>;
}): Promise<({ outcome: ChannelIngestOutcome } | { unavailable: true })[]> {
  const results: ({ outcome: ChannelIngestOutcome } | { unavailable: true })[] = [];
  for (const capture of await input.list()) {
    if (input.signal.aborted) break;
    try { results.push({ outcome: await input.recover(capture) }); }
    catch { results.push({ unavailable: true }); }
  }
  return results;
}
/** Completion follows seller ACK readback; settled debt stays owed until that point. */
export async function acknowledgeChannelPurchasedOutcome(input: {
  capture: ChannelPurchaseCapture; outcome: ChannelIngestOutcome;
  acknowledge(input: { externalOrderRef: string; localOrderRef: string }): Promise<{ acknowledged: boolean }>;
  complete(ledgerId: string): Promise<void>;
}): Promise<boolean> {
  if (input.outcome.kind !== "settled" && input.outcome.kind !== "replayed") return true;
  const ack = await input.acknowledge({ externalOrderRef: input.capture.externalOrderRef, localOrderRef: input.outcome.orderId });
  if (!ack.acknowledged) return false;
  await input.complete(input.outcome.ledgerId);
  return true;
}
