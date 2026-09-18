import { describe, expect, it, vi } from "vitest";
import {
  OMNIPACK_STALE_SYNC_EVIDENCE_SKU,
  runOmnipackStockSyncWorker,
  type OmnipackStockSyncPort,
  type OmnipackStockSyncProvider,
} from "./omnipackStockSyncWorker.js";
import type { InventoryStockLine } from "../../../src/domains/inventory/contracts.js";

describe("OmniPack stock sync worker", () => {
  it("records classified raw snapshots without provider/local mismatch evidence", async () => {
    const port = fakePort({
      localBalances: [
        stockLine({ sku: "OPENLUP-BEEF-2KG", onHand: 10, reserved: 2, unavailable: 1, safetyStock: 2 }),
        stockLine({ sku: "OPENLUP-DUCK-2KG", onHand: 4, reserved: 1, unavailable: 0, safetyStock: 0 }),
      ],
    });
    const provider = fakeProvider({
      stock: [
        { provider: "omnipack", sku: "OPENLUP-BEEF-2KG", totalQuantity: 4, forSaleQuantity: 4, reservedOrUnavailableQuantity: 0 },
        { provider: "omnipack", sku: "OPENLUP-DUCK-2KG", totalQuantity: 8, forSaleQuantity: 8, reservedOrUnavailableQuantity: 0 },
      ],
      movements: [
        movement("OPENLUP-BEEF-2KG", "2026-06-10T09:00:00+00:00"),
        movement("OPENLUP-DUCK-2KG", "2026-06-10T11:00:00+00:00"),
      ],
    });

    await expect(runOmnipackStockSyncWorker({
      port,
      provider,
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T12:00:00.000Z"),
    })).resolves.toMatchObject({
      ok: true,
      checked: 2,
      updated: 4,
      mismatches: 0,
      lowStock: 0,
      movements: 2,
      providerCalls: 2,
      readBacks: 4,
      lastMovementOccurredAt: "2026-06-10T11:00:00+00:00",
    });

    expect(port.recordStockSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      sku: "OPENLUP-BEEF-2KG",
      localOnHand: 10,
      localReserved: 2,
      localUnavailable: 1,
      localSafetyStock: 2,
      mismatchKind: "none",
      inventoryClass: "sellable",
    }));
    expect(port.recordProviderStockCurrent).toHaveBeenCalledWith(expect.objectContaining({
      sku: "OPENLUP-BEEF-2KG",
      providerForSaleQuantity: 4,
      inventoryClass: "sellable",
      lastSyncedAt: "2026-06-10T12:00:00.000Z",
      staleAfter: "2026-06-10T18:00:00.000Z",
      evidence: expect.objectContaining({
        stockAuthority: "external_stock_master_with_local_reservations",
      }),
    }));
    expect(port.recordStockSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      sku: "OPENLUP-DUCK-2KG",
      mismatchKind: "none",
    }));
    expect(port.recordLowStockEvidence).not.toHaveBeenCalledWith(expect.objectContaining({ thresholdKind: "provider_mismatch" }));
    expect(port.resolveLowStockEvidence).toHaveBeenCalledWith(expect.objectContaining({
      sku: "OPENLUP-BEEF-2KG",
      activeThresholdKinds: [],
    }));
    expect(JSON.stringify(port)).not.toContain("inventory_stock_movements");
    expect(JSON.stringify(port)).not.toContain("commerce_fulfillment");
    expect(JSON.stringify(port)).not.toContain("email");
  });

  it("records safety-stock evidence without hard sales blocking", async () => {
    const port = fakePort({
      localBalances: [stockLine({ sku: "OPENLUP-LAMB-2KG", onHand: 3, reserved: 0, unavailable: 0, safetyStock: 2 })],
    });

    await runOmnipackStockSyncWorker({
      port,
      provider: fakeProvider({
        stock: [{ provider: "omnipack", sku: "OPENLUP-LAMB-2KG", totalQuantity: 2, forSaleQuantity: 2, reservedOrUnavailableQuantity: 0 }],
        movements: [],
      }),
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(port.recordLowStockEvidence).toHaveBeenCalledWith(expect.objectContaining({
      thresholdKind: "safety_stock",
      severity: "warning",
    }));
    expect(port.recordLowStockEvidence).not.toHaveBeenCalledWith(expect.objectContaining({
      thresholdKind: "forecast",
    }));
  });

  it("uses provider stock minus active reservations as canonical sellable stock before and after pick", async () => {
    const beforePick = fakePort({ reservations: new Map([["OPENLUP-BEEF-2KG", 3]]) });
    await runOmnipackStockSyncWorker({
      port: beforePick,
      provider: fakeProvider({
        stock: [{ provider: "omnipack", sku: "OPENLUP-BEEF-2KG", totalQuantity: 100, forSaleQuantity: 100, reservedOrUnavailableQuantity: 0 }],
        movements: [],
      }),
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T12:00:00.000Z"),
    });
    expect(beforePick.recordStockSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      mismatchKind: "none",
      evidence: expect.objectContaining({ activeReservedQuantity: 3, sellableNow: 97 }),
    }));
    expect(beforePick.recordLowStockEvidence).not.toHaveBeenCalled();

    const afterPick = fakePort({ reservations: new Map() });
    await runOmnipackStockSyncWorker({
      port: afterPick,
      provider: fakeProvider({
        stock: [{ provider: "omnipack", sku: "OPENLUP-BEEF-2KG", totalQuantity: 97, forSaleQuantity: 97, reservedOrUnavailableQuantity: 0 }],
        movements: [],
      }),
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T13:00:00.000Z"),
    });
    expect(afterPick.recordStockSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      mismatchKind: "none",
      evidence: expect.objectContaining({ activeReservedQuantity: 0, sellableNow: 97 }),
    }));
    expect(afterPick.recordLowStockEvidence).not.toHaveBeenCalled();
  });

  it("counts replayed writes without double-counting updates", async () => {
    const port = fakePort({
      localBalances: [stockLine({ sku: "OPENLUP-BEEF-2KG", onHand: 1, reserved: 0, unavailable: 0, safetyStock: 1 })],
      snapshotResult: { replayed: true, readBack: true },
      lowStockResult: { replayed: true },
    });

    await expect(runOmnipackStockSyncWorker({
      port,
      provider: fakeProvider({
        stock: [{ provider: "omnipack", sku: "OPENLUP-BEEF-2KG", totalQuantity: 0, forSaleQuantity: 0, reservedOrUnavailableQuantity: 0 }],
        movements: [],
      }),
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T12:00:00.000Z"),
    })).resolves.toMatchObject({
      updated: 0,
      lowStock: 0,
      replayed: 3,
      readBacks: 2,
    });
  });

  it("uses the previous cursor for required OmniPack stock-movement date params", async () => {
    const port = fakePort({
      cursor: {
        lastStockSyncedAt: "2026-06-09T08:00:00.000Z",
        lastMovementOccurredAt: "2026-06-08T22:15:00.000Z",
      },
    });
    const provider = fakeProvider({ stock: [], movements: [] });

    await runOmnipackStockSyncWorker({
      port,
      provider,
      movementBatchSize: 25,
      now: () => new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(provider.getStockMovements).toHaveBeenCalledWith({
      startLocalDate: "2026-06-09",
      endLocalDate: "2026-06-10",
      size: 25,
    });
  });

  it("retains raw ATP-compatible local stock without deriving a legacy mismatch", async () => {
    const port = fakePort({
      localBalances: [
        stockLine({ sku: "OPENLUP-BEEF-2KG", onHand: 7, reserved: 1, unavailable: 1, safetyStock: 1 }),
        stockLine({ sku: "OPENLUP-BEEF-2KG", onHand: 99, fulfillable: false }),
        stockLine({ sku: "OPENLUP-BEEF-2KG", onHand: 99, locationStatus: "inactive" }),
        stockLine({ sku: "OPENLUP-BEEF-2KG", onHand: 99, lotStatus: "quarantined" }),
        stockLine({ sku: "OPENLUP-BEEF-2KG", onHand: 99, expiresAt: "2026-06-09T12:00:00.000Z" }),
      ],
    });

    await runOmnipackStockSyncWorker({
      port,
      provider: fakeProvider({
        stock: [{ provider: "omnipack", sku: "OPENLUP-BEEF-2KG", totalQuantity: 4, forSaleQuantity: 4, reservedOrUnavailableQuantity: 0 }],
        movements: [],
      }),
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(port.recordStockSnapshot).toHaveBeenCalledWith(expect.objectContaining({
      localOnHand: 7,
      localReserved: 1,
      localUnavailable: 1,
      localSafetyStock: 1,
      mismatchKind: "none",
    }));
  });

  it("resolves open low-stock evidence when provider/local stock recovers", async () => {
    const port = fakePort({
      localBalances: [stockLine({ sku: "OPENLUP-BEEF-2KG", onHand: 8, reserved: 0, unavailable: 0, safetyStock: 2 })],
    });

    await runOmnipackStockSyncWorker({
      port,
      provider: fakeProvider({
        stock: [{ provider: "omnipack", sku: "OPENLUP-BEEF-2KG", totalQuantity: 6, forSaleQuantity: 6, reservedOrUnavailableQuantity: 0 }],
        movements: [],
      }),
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T12:00:00.000Z"),
    });

    expect(port.recordLowStockEvidence).not.toHaveBeenCalled();
    expect(port.resolveLowStockEvidence).toHaveBeenCalledWith(expect.objectContaining({
      sku: "OPENLUP-BEEF-2KG",
      activeThresholdKinds: [],
    }));
  });

  it("opens reservation coverage only on the second consecutive successful observation", async () => {
    const provider = fakeProvider({
      stock: [{ provider: "omnipack", sku: "OPENLUP-BEEF-2KG", totalQuantity: 2, forSaleQuantity: 2, reservedOrUnavailableQuantity: 0 }],
      movements: [],
    });
    const firstPort = fakePort({ reservations: new Map([["OPENLUP-BEEF-2KG", 3]]) });
    await expect(runOmnipackStockSyncWorker({
      port: firstPort,
      provider,
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T12:00:00.000Z"),
    })).resolves.toMatchObject({ reservationCoverage: 0 });
    expect(firstPort.recordLowStockEvidence).not.toHaveBeenCalledWith(expect.objectContaining({ thresholdKind: "reservation_coverage" }));

    const secondPort = fakePort({
      cursor: { status: "succeeded", cursor: { coverageGapSkus: ["OPENLUP-BEEF-2KG"] } },
      reservations: new Map([["OPENLUP-BEEF-2KG", 3]]),
    });
    await expect(runOmnipackStockSyncWorker({
      port: secondPort,
      provider,
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T13:00:00.000Z"),
    })).resolves.toMatchObject({ reservationCoverage: 1 });
    expect(secondPort.recordLowStockEvidence).toHaveBeenCalledWith(expect.objectContaining({
      sku: "OPENLUP-BEEF-2KG",
      thresholdKind: "reservation_coverage",
      severity: "critical",
    }));
  });

  it("breaks coverage consecutiveness after a failed run", async () => {
    const port = fakePort({
      cursor: { status: "failed", cursor: { coverageGapSkus: ["OPENLUP-BEEF-2KG"] } },
      reservations: new Map([["OPENLUP-BEEF-2KG", 3]]),
    });
    await runOmnipackStockSyncWorker({
      port,
      provider: fakeProvider({
        stock: [{ provider: "omnipack", sku: "OPENLUP-BEEF-2KG", totalQuantity: 2, forSaleQuantity: 2, reservedOrUnavailableQuantity: 0 }],
        movements: [],
      }),
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T13:00:00.000Z"),
    });
    expect(port.recordLowStockEvidence).not.toHaveBeenCalledWith(expect.objectContaining({ thresholdKind: "reservation_coverage" }));
    expect(port.resolveLowStockEvidence).toHaveBeenCalledWith(expect.objectContaining({
      sku: "OPENLUP-BEEF-2KG",
      activeThresholdKinds: ["reservation_coverage"],
    }));
  });

  it("retains packaging and unknown SKUs as raw evidence but excludes them from ATP signals", async () => {
    const port = fakePort({
      inventoryClasses: new Map([
        ["INSERTopenlup", "packaging"],
        ["UNKNOWN-OMNI", null],
      ]),
      reservations: new Map([["INSERTopenlup", 20], ["UNKNOWN-OMNI", 20]]),
    });
    await expect(runOmnipackStockSyncWorker({
      port,
      provider: fakeProvider({
        stock: [
          { provider: "omnipack", sku: "INSERTopenlup", totalQuantity: 1, forSaleQuantity: 1, reservedOrUnavailableQuantity: 0 },
          { provider: "omnipack", sku: "UNKNOWN-OMNI", totalQuantity: 1, forSaleQuantity: 1, reservedOrUnavailableQuantity: 0 },
        ],
        movements: [],
      }),
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T12:00:00.000Z"),
    })).resolves.toMatchObject({ checked: 2, reservationCoverage: 0, unclassified: 1 });
    expect(port.recordStockSnapshot).toHaveBeenCalledWith(expect.objectContaining({ sku: "INSERTopenlup", inventoryClass: "packaging" }));
    expect(port.recordStockSnapshot).toHaveBeenCalledWith(expect.objectContaining({ sku: "UNKNOWN-OMNI", inventoryClass: null }));
    expect(port.recordLowStockEvidence).not.toHaveBeenCalledWith(expect.objectContaining({ thresholdKind: "reservation_coverage" }));
    expect(port.resolveLowStockEvidence).toHaveBeenCalledWith(expect.objectContaining({
      sku: "INSERTopenlup",
      activeThresholdKinds: [],
    }));
  });

  it("opens a stale_sync evidence row when the last successful sync is older than the threshold", async () => {
    const port = fakePort({
      cursor: { lastStockSyncedAt: "2026-06-10T00:00:00.000Z", lastMovementOccurredAt: null },
    });

    await runOmnipackStockSyncWorker({
      port,
      provider: fakeProvider({ stock: [], movements: [] }),
      movementBatchSize: 100,
      staleSyncThresholdHours: 6,
      now: () => new Date("2026-06-10T12:00:00.000Z"), // 12h gap > 6h
    });

    expect(port.recordLowStockEvidence).toHaveBeenCalledWith(expect.objectContaining({
      sku: OMNIPACK_STALE_SYNC_EVIDENCE_SKU,
      thresholdKind: "stale_sync",
      severity: "warning",
    }));
    // While stale, this run does NOT also resolve the sentinel stale_sync row.
    expect(port.resolveLowStockEvidence).not.toHaveBeenCalledWith(expect.objectContaining({
      sku: OMNIPACK_STALE_SYNC_EVIDENCE_SKU,
    }));
  });

  it("does not open stale_sync within the threshold, and resolves the sentinel on a healthy run", async () => {
    const port = fakePort({
      cursor: { lastStockSyncedAt: "2026-06-10T10:00:00.000Z", lastMovementOccurredAt: null },
    });

    await runOmnipackStockSyncWorker({
      port,
      provider: fakeProvider({ stock: [], movements: [] }),
      movementBatchSize: 100,
      staleSyncThresholdHours: 6,
      now: () => new Date("2026-06-10T12:00:00.000Z"), // 2h gap < 6h
    });

    expect(port.recordLowStockEvidence).not.toHaveBeenCalledWith(expect.objectContaining({
      thresholdKind: "stale_sync",
    }));
    expect(port.resolveLowStockEvidence).toHaveBeenCalledWith(expect.objectContaining({
      sku: OMNIPACK_STALE_SYNC_EVIDENCE_SKU,
      activeThresholdKinds: [],
    }));
  });

  it("never reports stale_sync when there is no prior sync cursor", async () => {
    const port = fakePort({});
    await runOmnipackStockSyncWorker({
      port,
      provider: fakeProvider({ stock: [], movements: [] }),
      movementBatchSize: 100,
      now: () => new Date("2026-06-10T12:00:00.000Z"),
    });
    expect(port.recordLowStockEvidence).not.toHaveBeenCalledWith(expect.objectContaining({
      thresholdKind: "stale_sync",
    }));
  });
});

function fakeProvider(input: {
  stock: Awaited<ReturnType<OmnipackStockSyncProvider["getStock"]>>;
  movements: Awaited<ReturnType<OmnipackStockSyncProvider["getStockMovements"]>>;
}): OmnipackStockSyncProvider {
  return {
    getStock: vi.fn(async () => input.stock),
    getStockMovements: vi.fn(async () => input.movements),
  };
}

function fakePort(options: {
  cursor?: Partial<NonNullable<Awaited<ReturnType<OmnipackStockSyncPort["readCursor"]>>>>;
  localBalances?: Awaited<ReturnType<OmnipackStockSyncPort["readLocalInventoryStock"]>>;
  inventoryClasses?: Map<string, "sellable" | "packaging" | null>;
  reservations?: Map<string, number>;
  snapshotResult?: { replayed: boolean; readBack: boolean };
  lowStockResult?: { replayed: boolean };
} = {}): OmnipackStockSyncPort {
  return {
    readCursor: vi.fn(async () => options.cursor ? ({
      status: options.cursor.status ?? "succeeded",
      cursor: options.cursor.cursor ?? {},
      lastStockSyncedAt: options.cursor.lastStockSyncedAt ?? null,
      lastMovementOccurredAt: options.cursor.lastMovementOccurredAt ?? null,
    }) : null),
    readLocalInventoryStock: vi.fn(async () => options.localBalances ?? []),
    readSkuInventoryClasses: vi.fn(async (skus: string[]) => options.inventoryClasses ?? new Map<string, "sellable">(skus.map((sku) => [sku, "sellable"]))),
    readActiveReservations: vi.fn(async () => options.reservations ?? new Map()),
    recordCursor: vi.fn(async () => undefined),
    recordStockSnapshot: vi.fn(async () => options.snapshotResult ?? { replayed: false, readBack: true }),
    recordProviderStockCurrent: vi.fn(async () => options.snapshotResult ?? { replayed: false, readBack: true }),
    recordLowStockEvidence: vi.fn(async () => options.lowStockResult ?? { replayed: false }),
    resolveLowStockEvidence: vi.fn(async () => ({ resolved: 0 })),
  };
}

function movement(sku: string, occurredAt: string) {
  return {
    provider: "omnipack" as const,
    sku,
    occurredAt,
    quantity: 1,
    operationType: "receipt",
    warehouseDocumentNumber: "WD-1",
    lotNumber: null,
    expirationDate: null,
  };
}

function stockLine(overrides: Partial<InventoryStockLine> = {}): InventoryStockLine {
  return {
    skuId: "11111111-1111-4111-8111-111111111111",
    sku: "OPENLUP-BEEF-2KG",
    locationId: "22222222-2222-4222-8222-222222222222",
    locationCode: "pl-main",
    locationKind: "third_party_logistics",
    locationStatus: "active",
    fulfillable: true,
    lotId: null,
    lotCode: null,
    lotStatus: "available",
    expiresAt: null,
    onHand: 10,
    reserved: 0,
    unavailable: 0,
    incoming: 0,
    safetyStock: 0,
    ...overrides,
  };
}
