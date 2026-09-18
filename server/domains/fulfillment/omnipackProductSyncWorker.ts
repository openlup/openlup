// Pure two-way OmniPack product-sync worker (one SKU ↔ many EAN "packs"). Mirrors the
// omnipackStockSyncWorker shape: the worker is PURE and orchestrates injected `provider`
// (OmniPack side) + `port` (local DB side) interfaces; the cron composition root binds them to
// the OmniPack HTTP client + the merchant dictionary + Supabase (server/domains may not import
// server/infra). No catalog SKU is ever auto-created; a local-owned pack is never overwritten.

import { safeReason } from "./omnipackReconciliationPayload.js";

export type OmnipackPackKind = "unit" | "collective";

export interface OmnipackLocalPack {
  ean: string;
  quantity: number;
  kind: OmnipackPackKind;
}

export interface OmnipackLocalProductPacks {
  sku: string;
  packs: OmnipackLocalPack[];
}

export interface OmnipackProviderPack {
  ean: string;
  quantity: number;
}

// Raw conflict signal from the upsert path (see catalog_sku_eans_upsert_pack); 'none' = ingested.
export type OmnipackPackUpsertConflict =
  | "none"
  | "local_locked_mismatch"
  | "ean_owned_by_other_sku"
  | "sku_not_found";

// Operator-resolvable reconciliation conflict kinds (omnipack_product_reconciliation_evidence).
export type OmnipackReconciliationConflict = "unknown_sku" | "ean_conflict" | "kind_quantity_conflict";

export interface OmnipackProductSyncProvider {
  // Ensure the product exists on OmniPack (createProduct; 409/exists ⇒ replayed). Returns null
  // when the SKU has no push metadata (no dictionary entry) ⇒ skipped, not a failure.
  ensureProduct(sku: string): Promise<{ replayed: boolean } | null>;
  getProductPacks(sku: string): Promise<OmnipackProviderPack[]>;
  addProductPack(sku: string, pack: OmnipackProviderPack): Promise<void>;
  // Pull enumerates SKUs from getStock (OmniPack has no product LIST endpoint).
  listStockedSkus(): Promise<string[]>;
}

export interface OmnipackProductSyncPort {
  listLocalProductPacks(): Promise<OmnipackLocalProductPacks[]>;
  markPackSynced(input: { sku: string; ean: string }): Promise<void>;
  // Upserts an OmniPack-seen pack as source='omnipack'; returns the conflict signal + replayed.
  upsertPulledPack(input: {
    sku: string;
    ean: string;
    quantity: number;
    kind: OmnipackPackKind;
  }): Promise<{ conflict: OmnipackPackUpsertConflict; replayed: boolean }>;
  recordReconciliationEvidence(input: {
    idempotencyKey: string;
    sku: string;
    ean: string | null;
    conflictKind: OmnipackReconciliationConflict;
    providerQuantity: number;
    evidence: Record<string, unknown>;
  }): Promise<{ replayed: boolean }>;
  resolveReconciliationEvidence(input: {
    sku: string;
    activeConflictKinds: OmnipackReconciliationConflict[];
    syncRunId: string;
    evidence: Record<string, unknown>;
  }): Promise<{ resolved: number }>;
}

export interface OmnipackProductSyncResult {
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

function packKindForQuantity(quantity: number): OmnipackPackKind {
  return quantity > 1 ? "collective" : "unit";
}

// Maps an upsert conflict signal to a reconciliation conflict kind (null ⇒ no evidence needed).
function reconciliationKindFor(conflict: OmnipackPackUpsertConflict): OmnipackReconciliationConflict | null {
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

export async function runOmnipackProductSyncWorker(input: {
  port: OmnipackProductSyncPort;
  provider: OmnipackProductSyncProvider;
  mode?: "push" | "pull" | "both";
  now?: () => Date;
}): Promise<OmnipackProductSyncResult> {
  const now = input.now?.() ?? new Date();
  const mode = input.mode ?? "both";
  const syncRunId = `omnipack-product-sync:${now.toISOString()}`;
  const result: OmnipackProductSyncResult = {
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
  if (mode === "pull" || mode === "both") await runPull(input, result, syncRunId);

  return result;
}

// Push (local→OmniPack): ensure each product exists, then add only the EANs it is missing
// (additive; never delete provider packs). Idempotent: the missing-EAN diff + the DB sync marker.
async function runPush(
  input: { port: OmnipackProductSyncPort; provider: OmnipackProductSyncProvider },
  result: OmnipackProductSyncResult,
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
      result.reason = result.reason ?? safeReason(error);
    }
  }
}

// Pull (OmniPack→local): enumerate SKUs from getStock, read each product's packs, upsert them as
// source='omnipack'. A pack we cannot safely ingest opens reconciliation evidence; a clean SKU
// resolves any stale evidence for it. Never auto-creates a SKU; never overwrites a local pack.
async function runPull(
  input: { port: OmnipackProductSyncPort; provider: OmnipackProductSyncProvider },
  result: OmnipackProductSyncResult,
  syncRunId: string,
): Promise<void> {
  const skus = await input.provider.listStockedSkus();
  result.providerCalls += 1;
  for (const sku of skus.filter((value) => value.trim())) {
    try {
      const providerPacks = await input.provider.getProductPacks(sku);
      result.providerCalls += 1;
      result.pulledSkus += 1;
      const activeConflicts = new Set<OmnipackReconciliationConflict>();

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
          idempotencyKey: `omnipack-product-reconciliation:${sku}:${pack.ean}:${conflictKind}`,
          sku,
          ean: pack.ean,
          conflictKind,
          providerQuantity: pack.quantity,
          evidence: { provider: "omnipack", source: "product_sync", syncRunId, upsertConflict: upsert.conflict },
        });
        if (evidence.replayed) result.replayed += 1;
        else result.reconciliations += 1;
      }

      await input.port.resolveReconciliationEvidence({
        sku,
        activeConflictKinds: [...activeConflicts],
        syncRunId,
        evidence: { provider: "omnipack", source: "product_sync", providerPackCount: providerPacks.length },
      });
    } catch (error) {
      result.ok = false;
      result.failures += 1;
      result.reason = result.reason ?? safeReason(error);
    }
  }
}
