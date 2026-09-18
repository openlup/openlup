import { describe, expect, it } from "vitest";
import {
  runOmnipackProductSyncWorker,
  type OmnipackProductSyncPort,
  type OmnipackProductSyncProvider,
  type OmnipackProviderPack,
  type OmnipackLocalProductPacks,
} from "./omnipackProductSyncWorker.js";

const NOW = () => new Date("2026-06-25T10:00:00.000Z");

function fakeProvider(overrides: Partial<OmnipackProductSyncProvider> = {}): OmnipackProductSyncProvider {
  return {
    ensureProduct: async () => ({ replayed: false }),
    getProductPacks: async () => [],
    addProductPack: async () => {},
    listStockedSkus: async () => [],
    ...overrides,
  };
}

function fakePort(overrides: Partial<OmnipackProductSyncPort> = {}): OmnipackProductSyncPort {
  return {
    listLocalProductPacks: async () => [],
    markPackSynced: async () => {},
    upsertPulledPack: async () => ({ conflict: "none", replayed: false }),
    recordReconciliationEvidence: async () => ({ replayed: false }),
    resolveReconciliationEvidence: async () => ({ resolved: 0 }),
    ...overrides,
  };
}

describe("runOmnipackProductSyncWorker — push", () => {
  it("ensures the product, then adds only the EANs OmniPack is missing, and marks them synced", async () => {
    const local: OmnipackLocalProductPacks[] = [
      { sku: "OPENLUP-DOG-LAMB-CAN-400G", packs: [
        { ean: "5908121193005", quantity: 1, kind: "unit" },
        { ean: "5908121193999", quantity: 12, kind: "collective" },
      ] },
    ];
    const added: OmnipackProviderPack[] = [];
    const synced: string[] = [];
    const result = await runOmnipackProductSyncWorker({
      mode: "push",
      now: NOW,
      provider: fakeProvider({
        // OmniPack already has the unit EAN; only the carton is missing.
        getProductPacks: async () => [{ ean: "5908121193005", quantity: 1 }],
        addProductPack: async (_sku, pack) => { added.push(pack); },
      }),
      port: fakePort({
        listLocalProductPacks: async () => local,
        markPackSynced: async ({ ean }) => { synced.push(ean); },
      }),
    });

    expect(added).toEqual([{ ean: "5908121193999", quantity: 12 }]);
    expect(synced).toEqual(["5908121193999"]);
    expect(result).toMatchObject({ ok: true, pushedProducts: 1, pushedPacks: 1, skippedProducts: 0, failures: 0 });
  });

  it("skips a SKU with no push metadata (ensureProduct returns null) and counts a replayed product", async () => {
    const result = await runOmnipackProductSyncWorker({
      mode: "push",
      now: NOW,
      provider: fakeProvider({
        ensureProduct: async (sku) => (sku === "NO-META" ? null : { replayed: true }),
        getProductPacks: async () => [],
        addProductPack: async () => { throw new Error("should not add for replayed-only"); },
      }),
      port: fakePort({
        listLocalProductPacks: async () => [
          { sku: "NO-META", packs: [{ ean: "1", quantity: 1, kind: "unit" }] },
          { sku: "OPENLUP-DOG-BEEF-CAN-400G", packs: [] },
        ],
      }),
    });
    expect(result).toMatchObject({ skippedProducts: 1, pushedProducts: 0, replayed: 1, pushedPacks: 0, ok: true });
  });
});

describe("runOmnipackProductSyncWorker — pull", () => {
  it("ingests a new OmniPack pack as source=omnipack and resolves a clean SKU", async () => {
    const resolves: string[] = [];
    const result = await runOmnipackProductSyncWorker({
      mode: "pull",
      now: NOW,
      provider: fakeProvider({
        listStockedSkus: async () => ["OPENLUP-DOG-LAMB-CAN-400G"],
        getProductPacks: async () => [{ ean: "5908121193005", quantity: 1 }],
      }),
      port: fakePort({
        upsertPulledPack: async () => ({ conflict: "none", replayed: false }),
        resolveReconciliationEvidence: async ({ sku, activeConflictKinds }) => {
          resolves.push(`${sku}:${activeConflictKinds.join(",")}`);
          return { resolved: 0 };
        },
      }),
    });
    expect(result).toMatchObject({ pulledSkus: 1, ingestedPacks: 1, reconciliations: 0, ok: true });
    expect(resolves).toEqual(["OPENLUP-DOG-LAMB-CAN-400G:"]); // no active conflicts ⇒ clean SKU resolved
  });

  it("opens reconciliation evidence for each conflict kind (unknown SKU, EAN conflict, kind/qty)", async () => {
    const evidences: string[] = [];
    const result = await runOmnipackProductSyncWorker({
      mode: "pull",
      now: NOW,
      provider: fakeProvider({
        listStockedSkus: async () => ["UNKNOWN", "OPENLUP-DOG-LAMB-CAN-400G"],
        getProductPacks: async (sku) =>
          sku === "UNKNOWN"
            ? [{ ean: "5900000000001", quantity: 1 }]
            : [
                { ean: "5900000000002", quantity: 1 }, // EAN owned by another SKU
                { ean: "5908121193005", quantity: 6 }, // local-locked kind/qty mismatch
              ],
      }),
      port: fakePort({
        upsertPulledPack: async ({ ean }) => {
          if (ean === "5900000000001") return { conflict: "sku_not_found", replayed: false };
          if (ean === "5900000000002") return { conflict: "ean_owned_by_other_sku", replayed: false };
          return { conflict: "local_locked_mismatch", replayed: false };
        },
        recordReconciliationEvidence: async ({ conflictKind, sku }) => {
          evidences.push(`${sku}:${conflictKind}`);
          return { replayed: false };
        },
      }),
    });
    expect(result).toMatchObject({ pulledSkus: 2, ingestedPacks: 0, reconciliations: 3, ok: true });
    expect(evidences).toEqual([
      "UNKNOWN:unknown_sku",
      "OPENLUP-DOG-LAMB-CAN-400G:ean_conflict",
      "OPENLUP-DOG-LAMB-CAN-400G:kind_quantity_conflict",
    ]);
  });

  it("records a per-SKU failure without aborting the whole run", async () => {
    const result = await runOmnipackProductSyncWorker({
      mode: "pull",
      now: NOW,
      provider: fakeProvider({
        listStockedSkus: async () => ["A", "B"],
        getProductPacks: async (sku) => {
          if (sku === "A") throw new Error("provider boom for A");
          return [{ ean: "5900000000009", quantity: 1 }];
        },
      }),
      port: fakePort(),
    });
    expect(result.ok).toBe(false);
    expect(result.failures).toBe(1);
    expect(result.pulledSkus).toBe(1); // B still processed
    expect(result.reason).toContain("provider boom for A");
  });
});
