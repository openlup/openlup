import { describe, expect, it, vi } from "vitest";
import {
  createSupabaseOmnipackStockSyncPort,
  type OmnipackStockSyncSupabaseClient,
} from "./omnipackStockSyncPort.js";

describe("Supabase OmniPack stock sync port", () => {
  it("reads ATP-shaped local inventory stock without mutating inventory", async () => {
    const client = fakeClient({
      inventoryRows: [
        row("OPENLUP-BEEF-2KG", 10, 2, 1, 2),
        row("OPENLUP-DUCK-2KG", 4, 0, 0, 1, { fulfillable: false }),
      ],
    });
    const port = createSupabaseOmnipackStockSyncPort(client as unknown as OmnipackStockSyncSupabaseClient);

    await expect(port.readLocalInventoryStock()).resolves.toEqual([
      expect.objectContaining({
        sku: "OPENLUP-BEEF-2KG",
        onHand: 10,
        reserved: 2,
        unavailable: 1,
        safetyStock: 2,
        locationStatus: "active",
        fulfillable: true,
        lotStatus: "available",
      }),
      expect.objectContaining({
        sku: "OPENLUP-DUCK-2KG",
        fulfillable: false,
      }),
    ]);

    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "inventory_balances",
      op: "select",
    }));
    expect(client.calls).not.toContainEqual(expect.objectContaining({
      table: "inventory_balances",
      op: "insert",
    }));
    expect(client.calls).not.toContainEqual(expect.objectContaining({
      table: "inventory_balances",
      op: "update",
    }));
  });

  it("records stock snapshots through RPC and reads them back by idempotency key", async () => {
    const client = fakeClient({
      snapshotReadBack: {
        idempotency_key: "key-1",
        sku: "OPENLUP-BEEF-2KG",
        mismatch_kind: "none",
      },
      rpcResult: { replayed: false },
    });
    const port = createSupabaseOmnipackStockSyncPort(client as unknown as OmnipackStockSyncSupabaseClient);

    await expect(port.recordStockSnapshot({
      idempotencyKey: "key-1",
      sku: "OPENLUP-BEEF-2KG",
      providerTotalQuantity: 4,
      providerForSaleQuantity: 3,
      providerReservedUnavailableQuantity: 1,
      localOnHand: 10,
      localReserved: 2,
      localUnavailable: 1,
      localSafetyStock: 2,
      mismatchKind: "none",
      inventoryClass: "sellable",
      syncRunId: "run-1",
      evidence: { provider: "omnipack" },
    })).resolves.toEqual({ replayed: false, readBack: true });

    expect(client.rpc).toHaveBeenCalledWith("omnipack_record_stock_snapshot", expect.objectContaining({
      p_idempotency_key: "key-1",
      p_sku: "OPENLUP-BEEF-2KG",
      p_mismatch_kind: "none",
      p_inventory_class: "sellable",
    }));
    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "omnipack_stock_snapshots",
      op: "select",
    }));
  });

  it("records provider-current stock through the generic fulfillment projection", async () => {
    const client = fakeClient({
      currentStockReadBack: {
        provider_kind: "omnipack",
        sku: "OPENLUP-BEEF-2KG",
        provider_for_sale_quantity: 12,
        stale_after: "2026-06-10T18:00:00.000Z",
      },
      rpcResult: { replayed: false },
    });
    const port = createSupabaseOmnipackStockSyncPort(client as unknown as OmnipackStockSyncSupabaseClient);

    await expect(port.recordProviderStockCurrent({
      idempotencyKey: "current-1",
      sku: "OPENLUP-BEEF-2KG",
      providerTotalQuantity: 14,
      providerForSaleQuantity: 12,
      providerReservedUnavailableQuantity: 2,
      inventoryClass: "sellable",
      lastSyncedAt: "2026-06-10T12:00:00.000Z",
      staleAfter: "2026-06-10T18:00:00.000Z",
      syncRunId: "run-1",
      evidence: { stockAuthority: "external_stock_master_with_local_reservations" },
    })).resolves.toEqual({ replayed: false, readBack: true });

    expect(client.rpc).toHaveBeenCalledWith("fulfillment_provider_upsert_stock_current", expect.objectContaining({
      p_provider_kind: "omnipack",
      p_sku: "OPENLUP-BEEF-2KG",
      p_provider_for_sale_quantity: 12,
      p_inventory_class: "sellable",
      p_stale_after: "2026-06-10T18:00:00.000Z",
    }));
    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "fulfillment_provider_stock_current",
      op: "select",
    }));
  });

  it("reads cursor and records/resolves low-stock evidence via additive OmniPack RPCs", async () => {
    const client = fakeClient({
      cursorReadBack: {
        status: "succeeded",
        cursor: { coverageGapSkus: ["OPENLUP-BEEF-2KG"] },
        last_stock_synced_at: "2026-06-10T12:00:00.000Z",
        last_movement_occurred_at: "2026-06-10T11:00:00.000Z",
      },
      rpcResult: { replayed: true, resolved: 2 },
    });
    const port = createSupabaseOmnipackStockSyncPort(client as unknown as OmnipackStockSyncSupabaseClient);

    await expect(port.readCursor()).resolves.toEqual({
      status: "succeeded",
      cursor: { coverageGapSkus: ["OPENLUP-BEEF-2KG"] },
      lastStockSyncedAt: "2026-06-10T12:00:00.000Z",
      lastMovementOccurredAt: "2026-06-10T11:00:00.000Z",
    });
    await port.recordCursor({
      status: "succeeded",
      lastStockSyncedAt: "2026-06-10T12:00:00.000Z",
      lastMovementOccurredAt: "2026-06-10T11:00:00.000Z",
      cursor: { syncRunId: "run-1" },
      error: {},
    });
    await expect(port.recordLowStockEvidence({
      idempotencyKey: "low-1",
      sku: "OPENLUP-BEEF-2KG",
      thresholdKind: "reservation_coverage",
      severity: "critical",
      providerForSaleQuantity: 0,
      localAvailableQuantity: 5,
      evidence: { source: "stock_sync" },
    })).resolves.toEqual({ replayed: true });
    await expect(port.resolveLowStockEvidence({
      sku: "OPENLUP-BEEF-2KG",
      activeThresholdKinds: ["reservation_coverage"],
      syncRunId: "run-1",
      evidence: { source: "stock_sync" },
    })).resolves.toEqual({ resolved: 2 });

    expect(client.calls).toContainEqual(expect.objectContaining({
      table: "omnipack_stock_sync_cursors",
      op: "select",
    }));
    expect(client.rpc).toHaveBeenCalledWith("omnipack_upsert_stock_sync_cursor", expect.objectContaining({
      p_status: "succeeded",
    }));
    expect(client.rpc).toHaveBeenCalledWith("omnipack_record_low_stock_evidence", expect.objectContaining({
      p_idempotency_key: "low-1",
      p_threshold_kind: "reservation_coverage",
      p_severity: "critical",
    }));
    expect(client.rpc).toHaveBeenCalledWith("omnipack_resolve_low_stock_evidence", expect.objectContaining({
      p_sku: "OPENLUP-BEEF-2KG",
      p_active_threshold_kinds: ["reservation_coverage"],
    }));
  });

  it("classifies catalog and packaging SKUs and sums only active reservations", async () => {
    const client = fakeClient({
      catalogRows: [{ sku: "OPENLUP-BEEF-2KG" }],
      reservationRows: [
        reservationRow("OPENLUP-BEEF-2KG", 2, "reserved", null, "paid", "omnipack"),
        reservationRow("OPENLUP-BEEF-2KG", 9, "reserved", null, "paid", "dhl"),
        reservationRow("OPENLUP-BEEF-2KG", 4, "reserved", null, "cancelled", "omnipack"),
        reservationRow("OPENLUP-BEEF-2KG", 5, "released", null, "paid", "omnipack"),
        reservationRow("OPENLUP-BEEF-2KG", 7, "reserved", "2026-06-10T11:00:00.000Z", "paid", "omnipack"),
      ],
    });
    const port = createSupabaseOmnipackStockSyncPort(
      client as unknown as OmnipackStockSyncSupabaseClient,
      { inventoryClasses: new Map([["INSERTopenlup", "packaging"]]) },
    );

    await expect(port.readSkuInventoryClasses(["OPENLUP-BEEF-2KG", "INSERTopenlup", "UNKNOWN"])).resolves.toEqual(new Map([
      ["OPENLUP-BEEF-2KG", "sellable"],
      ["INSERTopenlup", "packaging"],
      ["UNKNOWN", null],
    ]));
    await expect(port.readActiveReservations(["OPENLUP-BEEF-2KG"], "2026-06-10T12:00:00.000Z")).resolves.toEqual(new Map([
      ["OPENLUP-BEEF-2KG", 2],
    ]));
  });

  it("uses the merchant dictionary classification for provider-only packaging", async () => {
    const client = fakeClient({ catalogRows: [] });
    const port = createSupabaseOmnipackStockSyncPort(
      client as unknown as OmnipackStockSyncSupabaseClient,
      { inventoryClasses: new Map([["CUSTOM-BOX", "packaging"]]) },
    );

    await expect(port.readSkuInventoryClasses(["CUSTOM-BOX"])).resolves.toEqual(new Map([
      ["CUSTOM-BOX", "packaging"],
    ]));
  });
});

function fakeClient(options: {
  inventoryRows?: unknown[];
  cursorReadBack?: Record<string, unknown> | null;
  snapshotReadBack?: Record<string, unknown> | null;
  currentStockReadBack?: Record<string, unknown> | null;
  catalogRows?: unknown[];
  reservationRows?: unknown[];
  rpcResult?: Record<string, unknown>;
} = {}) {
  const calls: Array<{ table: string; op: string; values?: Record<string, unknown> }> = [];
  const client = {
    calls,
    from(table: string) {
      const state = { table, op: "select", values: undefined as Record<string, unknown> | undefined };
      const builder = {
        select: vi.fn(() => {
          calls.push({ table, op: state.op, values: state.values });
          if (table === "inventory_balances") return Promise.resolve(result(options.inventoryRows ?? []));
          return builder;
        }),
        eq: vi.fn(() => builder),
        in: vi.fn(() => {
          calls.push({ table, op: state.op, values: state.values });
          if (table === "catalog_skus") return Promise.resolve(result(options.catalogRows ?? []));
          if (table === "inventory_reservations") return Promise.resolve(result(options.reservationRows ?? []));
          return Promise.resolve(result([]));
        }),
        maybeSingle: vi.fn(() => {
          calls.push({ table, op: state.op, values: state.values });
          if (table === "omnipack_stock_sync_cursors") return Promise.resolve(result(options.cursorReadBack ?? null));
          if (table === "omnipack_stock_snapshots") return Promise.resolve(result(options.snapshotReadBack ?? null));
          if (table === "fulfillment_provider_stock_current") return Promise.resolve(result(options.currentStockReadBack ?? null));
          return Promise.resolve(result(null));
        }),
        then: undefined,
      };
      return builder;
    },
    rpc: vi.fn(async () => ({ data: options.rpcResult ?? { replayed: false }, error: null })),
  };
  return client;
}

function reservationRow(
  sku: string,
  quantity: number,
  status: string,
  expiresAt: string | null,
  orderStatus: string,
  providerKind: string,
) {
  return {
    quantity,
    status,
    expires_at: expiresAt,
    metadata: { providerKind },
    catalog_skus: { sku },
    commerce_orders: { status: orderStatus },
  };
}

function result(data: unknown) {
  return { data, error: null };
}

function row(
  sku: string,
  onHand: number,
  reserved: number,
  unavailable: number,
  safetyStock: number,
  overrides: { fulfillable?: boolean; locationStatus?: "active" | "inactive"; lotStatus?: "available" | "quarantined" | "expired" | "recalled" | null } = {},
) {
  return {
    sku_id: "11111111-1111-4111-8111-111111111111",
    location_id: "22222222-2222-4222-8222-222222222222",
    lot_id: null,
    on_hand: onHand,
    reserved,
    unavailable,
    incoming: 0,
    safety_stock: safetyStock,
    catalog_skus: { sku },
    inventory_locations: {
      code: "pl-main",
      kind: "third_party_logistics",
      status: overrides.locationStatus ?? "active",
      fulfillable: overrides.fulfillable ?? true,
    },
    inventory_lots: {
      lot_code: "lot-1",
      status: overrides.lotStatus ?? "available",
      expires_at: null,
    },
  };
}
