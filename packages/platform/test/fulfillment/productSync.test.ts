import { expect, it } from "vitest";
import { runFulfillmentProductSyncWorker as run } from "../../src/fulfillment/index.js";
import type { FulfillmentProductSyncPort } from "../../src/fulfillment/contracts/index.js";
import { at } from "./fixtures.js";

it("preserves additive push, dictionary skip, durable markers and pull ownership/conflict/failure rules", async () => {
  const added: string[] = [], marked: string[] = [], evidence: Parameters<FulfillmentProductSyncPort["recordReconciliationEvidence"]>[0][] = [], resolved: Parameters<FulfillmentProductSyncPort["resolveReconciliationEvidence"]>[0][] = [];
  const input: Parameters<typeof run>[0] = {
    now: () => new Date(at), compatibility: { identity: () => ({ providerRef: "warehouse-a", syncRunId: "legacy-product-run", collectedAt: at, sourceRevision: null, revisionSource: "collection" }), evidenceKey: (s, e, c) => `legacy:${s}:${e}:${c}` },
    provider: { async ensureProduct(sku) { return sku === "skip" ? null : { replayed: true }; },
      async getProductPacks(sku) { if (sku === "failure") throw new Error("synthetic-secret"); return sku === "push" ? [{ ean: "known", quantity: 1 }] : [{ ean: "unit", quantity: 1 }, { ean: "locked", quantity: 2 }, { ean: "owned", quantity: 3 }, { ean: "unknown", quantity: 1 }]; },
      async addProductPack(_sku, pack) { added.push(pack.ean); }, async listStockedSkus() { return ["pull", "failure", " "]; } },
    port: { async listLocalProductPacks() { return [{ sku: "push", packs: [{ ean: "known", quantity: 1, kind: "unit" }, { ean: "new", quantity: 2, kind: "collective" }] }, { sku: "skip", packs: [] }]; },
      async markPackSynced(value) { marked.push(value.ean); }, async upsertPulledPack(value) { return { conflict: value.ean === "locked" ? "local_locked_mismatch" : value.ean === "owned" ? "ean_owned_by_other_sku" : value.ean === "unknown" ? "sku_not_found" : "none", replayed: value.ean === "unit" }; },
      async recordReconciliationEvidence(value) { evidence.push(value); return { replayed: false }; }, async resolveReconciliationEvidence(value) { resolved.push(value); return { resolved: 0 }; } },
  };
  expect(await run(input)).toMatchObject({ ok: false, pushedProducts: 0, pushedPacks: 1, skippedProducts: 1, pulledSkus: 1, reconciliations: 3, failures: 1, reason: "product_sync_operation_failed" });
  expect(added).toEqual(["new"]); expect(marked).toEqual(["new"]);
  expect(evidence.map(e => e.conflictKind)).toEqual(["kind_quantity_conflict", "ean_conflict", "unknown_sku"]);
  expect(resolved).toEqual([{ sku: "pull", activeConflictKinds: ["kind_quantity_conflict", "ean_conflict", "unknown_sku"], syncRunId: "legacy-product-run" }]);
  expect(JSON.stringify(evidence)).not.toContain("synthetic-secret");
});
