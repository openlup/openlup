import type {
  ChannelIngestStorePort,
  ChannelQuarantineReason,
} from "../../../src/domains/channels/channelIngestStorePort.js";
import type { NormalizedChannelOrder } from "../../../src/domains/channels/orderContracts.js";
import type { ChannelBundleStepRefusal } from "./channelBundleIngestStep.js";
import { classifyQuarantineReason, quarantineVocabulary } from "./quarantineClassifier.js";

// How a refusal becomes a drawer row and a halted ledger — in ONE place, for both kinds of refusal
// the ingest saga can produce.
//
// The two kinds arrive differently and that is the only difference between them. A STORE refusal is
// a name raised inside SQL, so it has to be classified before it can be filed; a BUNDLE refusal was
// decided in this process and already knows its own drawer. Everything after that point is
// identical — the same quarantine row, the same ledger halt, the same outcome shape — so it is
// written once. A second copy of this is how one refusal path quietly stops advancing the ledger
// while the other keeps doing it.

export interface ChannelRefusalOutcome {
  kind: "quarantined";
  ledgerId: string;
  reason: string;
  detail: string;
}

export interface ChannelRefusalChannel {
  id: string;
  connectionId: string | null;
}

/**
 * File a refusal this process decided (today: a bundle line that cannot be expanded). The caller
 * has already named the drawer and the wire token, so nothing is classified here.
 */
export async function fileBundleRefusal(
  store: ChannelIngestStorePort,
  context: {
    order: NormalizedChannelOrder;
    channel: ChannelRefusalChannel;
    ledgerId: string;
    refusal: ChannelBundleStepRefusal;
  },
): Promise<ChannelRefusalOutcome> {
  return file(store, {
    order: context.order,
    channel: context.channel,
    ledgerId: context.ledgerId,
    reason: context.refusal.kind,
    vocabulary: context.refusal.vocabulary,
    detail: context.refusal.detail,
  });
}

/**
 * File a refusal the STORE raised, or rethrow.
 *
 * The rethrow is load-bearing. `classifyQuarantineReason` returns null for anything that is not a
 * named refusal, and a dropped connection or a serialization failure is a TRANSIENT fault: filing
 * operator work for it would both create noise and take the order out of the retry path that would
 * have carried it.
 */
export async function quarantineOrderRefusal(
  store: ChannelIngestStorePort,
  context: {
    order: NormalizedChannelOrder;
    channel: ChannelRefusalChannel;
    ledgerId: string;
    error: unknown;
  },
): Promise<ChannelRefusalOutcome> {
  const reason = classifyQuarantineReason(context.error);
  if (!reason) throw context.error;

  return file(store, {
    order: context.order,
    channel: context.channel,
    ledgerId: context.ledgerId,
    reason,
    vocabulary: quarantineVocabulary(context.error, wireTokenFor(reason, context.order)),
    detail: readMessage(context.error),
  });
}

async function file(
  store: ChannelIngestStorePort,
  context: {
    order: NormalizedChannelOrder;
    channel: ChannelRefusalChannel;
    ledgerId: string;
    reason: ChannelQuarantineReason;
    vocabulary: string;
    detail: string;
  },
): Promise<ChannelRefusalOutcome> {
  await store.quarantine({
    channelId: context.channel.id,
    connectionId: context.channel.connectionId,
    providerEventId: context.order.providerEventId,
    externalOrderRef: context.order.externalOrderRef,
    vocabulary: context.vocabulary,
    reason: context.reason,
    payload: { detail: context.detail, totals: context.order.totals },
  });
  await store.advanceLedger({
    ledgerId: context.ledgerId,
    toStatus: "quarantined",
    lastError: context.detail,
  });
  return { kind: "quarantined", ledgerId: context.ledgerId, reason: context.reason, detail: context.detail };
}

/** The far side's own string to file the refusal under, when the refusal names one. */
function wireTokenFor(reason: string, order: NormalizedChannelOrder): string | null {
  if (reason !== "unmapped_sellable") return null;
  const line = order.lines[0];
  if (!line) return null;
  return line.sellable.kind === "sku"
    ? line.sellable.skuCode ?? line.sellable.externalOfferRef
    : line.sellable.bundleCode ?? line.sellable.externalOfferRef;
}

export function readMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown error";
}
