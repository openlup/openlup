import type { FulfillmentProductSyncPort, FulfillmentProductSyncProvider } from "./contracts/index.js";
type PackKind = "unit" | "collective";
type PackUpsertConflict = Awaited<ReturnType<FulfillmentProductSyncPort["upsertPulledPack"]>>["conflict"];
type ReconciliationConflict = Parameters<FulfillmentProductSyncPort["recordReconciliationEvidence"]>[0]["conflictKind"];
type SyncIdentity = Parameters<FulfillmentProductSyncPort["recordReconciliationEvidence"]>[0]["identity"];
interface ProductSyncResult {
  ok: boolean;
  pushedProducts: number;
  pushedPacks: number;
  skippedProducts: number;
  pulledSkus: number;
  ingestedPacks: number;
  reconciliations: number;
  replayed: number;
  failures: number;
  providerCalls: number;
  syncRunId: string;
  reason?: string;
}

function packKindForQuantity(quantity: number): PackKind {
  return quantity > 1 ? "collective" : "unit";
}

function reconciliationKindFor(conflict: PackUpsertConflict): ReconciliationConflict | null {
  switch (conflict) {
    case "sku_not_found":
      return "unknown_sku";
    case "ean_owned_by_other_sku":
      return "ean_conflict";
    case "local_locked_mismatch":
      return "kind_quantity_conflict";
    default:
      return null;
  }
}

export async function runFulfillmentProductSyncWorker(input: {
  port: FulfillmentProductSyncPort;
  provider: FulfillmentProductSyncProvider;
  mode?: "push" | "pull" | "both";
  now?: () => Date;
  compatibility: { identity(now: Date): SyncIdentity; evidenceKey(sku: string, ean: string, kind: ReconciliationConflict): string };
}): Promise<ProductSyncResult> {
  const now = input.now?.() ?? new Date();
  const mode = input.mode ?? "both";
  const identity = input.compatibility.identity(now);
  const syncRunId = identity.syncRunId;
  const result: ProductSyncResult = {
    ok: true,
    pushedProducts: 0,
    pushedPacks: 0,
    skippedProducts: 0,
    pulledSkus: 0,
    ingestedPacks: 0,
    reconciliations: 0,
    replayed: 0,
    failures: 0,
    providerCalls: 0,
    syncRunId,
  };

  if (mode === "push" || mode === "both") await runPush(input, result);
  if (mode === "pull" || mode === "both") await runPull(input, result, identity);

  return result;
}

async function runPush(
  input: { port: FulfillmentProductSyncPort; provider: FulfillmentProductSyncProvider },
  result: ProductSyncResult,
): Promise<void> {
  const localProducts = await input.port.listLocalProductPacks();
  for (const product of localProducts) {
    try {
      const ensured = await input.provider.ensureProduct(product.sku);
      result.providerCalls += 1;
      if (ensured === null) {
        result.skippedProducts += 1;
        continue;
      }
      result.pushedProducts += ensured.replayed ? 0 : 1;
      if (ensured.replayed) result.replayed += 1;

      const existingEans = new Set((await input.provider.getProductPacks(product.sku)).map((pack) => pack.ean));
      result.providerCalls += 1;
      for (const pack of product.packs) {
        if (existingEans.has(pack.ean)) continue;
        await input.provider.addProductPack(product.sku, { ean: pack.ean, quantity: pack.quantity });
        result.providerCalls += 1;
        await input.port.markPackSynced({ sku: product.sku, ean: pack.ean });
        result.pushedPacks += 1;
      }
    } catch (error) {
      result.ok = false;
      result.failures += 1;
      result.reason = result.reason ?? "product_sync_operation_failed";
    }
  }
}

async function runPull(
  input: Pick<Parameters<typeof runFulfillmentProductSyncWorker>[0], "port" | "provider" | "compatibility">,
  result: ProductSyncResult,
  identity: SyncIdentity,
): Promise<void> {
  const syncRunId = identity.syncRunId;
  const skus = await input.provider.listStockedSkus();
  result.providerCalls += 1;
  for (const sku of skus.filter((value) => value.trim())) {
    try {
      const providerPacks = await input.provider.getProductPacks(sku);
      result.providerCalls += 1;
      result.pulledSkus += 1;
      const activeConflicts = new Set<ReconciliationConflict>();

      for (const pack of providerPacks.filter((entry) => entry.ean.trim())) {
        const upsert = await input.port.upsertPulledPack({
          sku,
          ean: pack.ean,
          quantity: pack.quantity,
          kind: packKindForQuantity(pack.quantity),
        });
        const conflictKind = reconciliationKindFor(upsert.conflict);
        if (conflictKind === null) {
          if (!upsert.replayed) result.ingestedPacks += 1;
          else result.replayed += 1;
          continue;
        }
        activeConflicts.add(conflictKind);
        const evidence = await input.port.recordReconciliationEvidence({
          requestKey: input.compatibility.evidenceKey(sku, pack.ean, conflictKind),
          sku,
          ean: pack.ean,
          conflictKind,
          providerQuantity: pack.quantity,
          identity, refusal: null,
        });
        if (evidence.replayed) result.replayed += 1;
        else result.reconciliations += 1;
      }

      await input.port.resolveReconciliationEvidence({
        sku,
        activeConflictKinds: [...activeConflicts],
        syncRunId,
      });
    } catch (error) {
      result.ok = false;
      result.failures += 1;
      result.reason = result.reason ?? "product_sync_operation_failed";
    }
  }
}
