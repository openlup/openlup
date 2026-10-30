import { randomUUID } from "node:crypto";
import type { ChannelOrderSourcePort, ChannelPullPage, ChannelPurchaseCapture } from "@openlup/platform/channels";
import {
  acknowledgeChannelPurchasedOutcome, ChannelIngestUnavailableError, consumeChannelPurchasedCapture,
  createChannelExposureReservationRail, createChannelWebhookHandler, createChannelWebhookPort,
  createManagedChannelIngestChannelRead, createManagedChannelIngestOrderItemRead,
  createManagedChannelIngestPayments, createManagedChannelIngestReservations, createManagedChannelIngestStore,
  createManagedChannelPurchasedContextRead, createManagedChannelPurchasedSourceStore,
  createPostgresChannelPurchasedSourceStore, ingestRetainedChannelPurchase, mapChannelIngestLedger,
  recoverChannelPurchasedOrders,
  type ChannelHistoricalBundleReadPort, type ChannelIngestOutcome, type ChannelIngestPortOptions, type ChannelSourceExecutor,
  type ChannelWebhookHandlerDeps, type ManagedChannelIngestClient, type ManagedChannelRailsClient, type PurchasedReadClient,
} from "@openlup/platform/channels/server";
import { createManagedPaymentControlRuntimePort } from "../../adapters/managed/commerce/paymentControlRuntimePort.js";
import { createManagedBundleCatalogStore, type BundleCatalogQueryClient } from "../../adapters/supabase/bundleCatalogStore.js";
import { createChannelBundleRead } from "../../adapters/supabase/channelBundleRead.js";

type ManagedInput = {
  rail: "managed"; actorId: string; currentJobRunId: string;
  client: ManagedChannelIngestClient & ManagedChannelRailsClient & PurchasedReadClient;
  bundleClient: BundleCatalogQueryClient; historicalBundles: ChannelHistoricalBundleReadPort;
  acceptedCurrencies: readonly string[];
  connector: Pick<ChannelOrderSourcePort, "normalizeWebhook" | "acknowledgeOrder">;
  webhook: Pick<ChannelWebhookHandlerDeps, "connectorKind" | "enabled" | "verifyToken" | "readRawBody">;
};
type PortableInput = { rail: "portable"; actorId: string; executor: ChannelSourceExecutor };

/** An unmounted recipe. The independent enable argument is checked before reading any binding. */
export function createM17ChannelReferenceBinding(enabled: boolean, input: ManagedInput | PortableInput) {
  if (enabled !== true) return null;
  if (input.rail === "portable") {
    const source = createPostgresChannelPurchasedSourceStore(input);
    return { rail: input.rail, source, readiness: { ...source.readiness, jobs: "unavailable", simulator: false } as const,
      async consume(): Promise<never> { throw new ChannelIngestUnavailableError("channel_purchase_physical_unavailable"); },
    };
  }
  const managed = input;
  const source = createManagedChannelPurchasedSourceStore({ serviceClient: managed.client, actorId: managed.actorId });
  const store = createManagedChannelIngestStore(managed.client);
  const read = createManagedChannelPurchasedContextRead({ client: managed.client, actorId: managed.actorId, bundles: managed.historicalBundles });
  const options: ChannelIngestPortOptions = {
    store, channels: createManagedChannelIngestChannelRead(managed.client), acceptedCurrencies: managed.acceptedCurrencies,
    noopSettlementForbidden: true,
    rails: { bundles: createChannelBundleRead(createManagedBundleCatalogStore(managed.bundleClient)),
      reservations: createManagedChannelIngestReservations(managed.client),
      orderItems: createManagedChannelIngestOrderItemRead(managed.client),
      payments: createManagedChannelIngestPayments(managed.client, createManagedPaymentControlRuntimePort(managed.client)) },
  };
  const port = createChannelWebhookPort(options);
  const webhook = createChannelWebhookHandler({ ...managed.webhook, connector: managed.connector, port });
  function retain(capture: ChannelPurchaseCapture) {
    return consumeChannelPurchasedCapture({ capture,
      accepted: async () => (await source.readCapture({ channelId: capture.scope.channelId,
        providerEventId: capture.providerEventId, actorId: managed.actorId }))?.ledgerId ?? null,
      contexts: () => read.contexts(capture), record: async value => mapChannelIngestLedger(await source.recordCapture(value)).id,
      original: read.original,
      ingest: async (original, ledgerId) => ({ capture: original, ledgerId }),
      unresolved: async (original, ledgerId) => ({ capture: original, ledgerId }),
    });
  }
  async function consume(capture: ChannelPurchaseCapture, signal: AbortSignal) {
    const retained = await retain(capture);
    if (!retained.capture.retainedRows) throw new ChannelIngestUnavailableError("channel_purchase_retained_rows_unavailable");
    const reservations = createChannelExposureReservationRail({ jobRunId: managed.currentJobRunId,
      ledgerId: retained.ledgerId, capture: retained.capture, source, read, newId: randomUUID });
    const outcome = await ingestRetainedChannelPurchase({ capture: retained.capture, options, reservations });
    await acknowledgeChannelPurchasedOutcome({ capture: retained.capture, outcome,
      acknowledge: ids => managed.connector.acknowledgeOrder({ ...ids, connectionRef: retained.capture.scope.connectionId,
        channelExternalRef: retained.capture.namespace.channelExternalRef, signal }),
      complete: async ledgerId => { await store.advanceLedger({ ledgerId, toStatus: "done" }); },
    });
    return outcome;
  }
  async function purchasedPage(page: ChannelPullPage, captures: readonly ChannelPurchaseCapture[], signal: AbortSignal) {
    await source.recordPage(page);
    for (const capture of captures) await retain(capture);
    const receipt = await source.commitPage(page);
    const outcomes: ChannelIngestOutcome[] = [];
    for (const capture of captures) {
      if (signal.aborted) break;
      outcomes.push(await consume(capture, signal));
    }
    return { receipt, outcomes };
  }
  return { rail: managed.rail, source, read, webhook, consume, purchasedPage,
    recover: (channelId: string, signal: AbortSignal) => recoverChannelPurchasedOrders({ signal,
      list: () => read.pending(channelId), recover: capture => consume(capture, signal) }),
    readiness: { ...source.readiness, jobs: "unavailable", simulator: false } as const,
  };
}
