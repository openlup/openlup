import { describe, expect, it } from "vitest";
import {
  createSupabaseOmnipackProductSyncPort,
  type OmnipackProductSyncSupabaseClient,
} from "./omnipackProductSyncPort.js";

interface RpcCall { fn: string; args: Record<string, unknown>; }

// Minimal structural Supabase fake: chainable from()/select()/update()/eq() resolving to a
// preset result, plus rpc() returning a preset result per function name.
function fakeClient(opts: {
  fromData?: unknown;
  fromError?: { code?: string; message?: string } | null;
  rpcResults?: Record<string, { data: unknown; error: { code?: string; message?: string } | null }>;
}) {
  const rpcCalls: RpcCall[] = [];
  let lastUpdate: Record<string, unknown> | null = null;
  const eqs: Array<[string, unknown]> = [];
  interface FakeBuilder {
    select: () => FakeBuilder;
    update: (values: Record<string, unknown>) => FakeBuilder;
    eq: (col: string, val: unknown) => FakeBuilder;
    then: (resolve: (r: { data: unknown; error: unknown }) => unknown) => unknown;
  }
  const builder: FakeBuilder = {
    select: () => builder,
    update: (values: Record<string, unknown>) => { lastUpdate = values; return builder; },
    eq: (col: string, val: unknown) => { eqs.push([col, val]); return builder; },
    then: (resolve: (r: { data: unknown; error: unknown }) => unknown) =>
      resolve({ data: opts.fromData ?? [], error: opts.fromError ?? null }),
  };
  const client = {
    from: () => builder,
    rpc: (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      const r = opts.rpcResults?.[fn] ?? { data: {}, error: null };
      return Promise.resolve(r);
    },
  };
  // The fake satisfies the port's structural client shape (the builder is intentionally a minimal
  // chainable stub, not a full PromiseLike); cast through unknown rather than widen with `any`.
  return {
    client: client as unknown as OmnipackProductSyncSupabaseClient,
    rpcCalls,
    getUpdate: () => lastUpdate,
    getEqs: () => eqs,
  };
}

describe("createSupabaseOmnipackProductSyncPort", () => {
  it("lists local packs grouped by SKU", async () => {
    const { client } = fakeClient({
      fromData: [
        { sku: "OPENLUP-DOG-LAMB-CAN-400G", ean: "5908121193005", quantity: 1, kind: "unit" },
        { sku: "OPENLUP-DOG-LAMB-CAN-400G", ean: "5908121193999", quantity: 12, kind: "collective" },
        { sku: "OPENLUP-DOG-BEEF-CAN-400G", ean: "5908121193012", quantity: 1, kind: "unit" },
        { sku: "", ean: "x", quantity: 1, kind: "unit" }, // dropped (no sku)
      ],
    });
    const port = createSupabaseOmnipackProductSyncPort(client);
    const out = await port.listLocalProductPacks();
    expect(out).toEqual([
      { sku: "OPENLUP-DOG-LAMB-CAN-400G", packs: [
        { ean: "5908121193005", quantity: 1, kind: "unit" },
        { ean: "5908121193999", quantity: 12, kind: "collective" },
      ] },
      { sku: "OPENLUP-DOG-BEEF-CAN-400G", packs: [{ ean: "5908121193012", quantity: 1, kind: "unit" }] },
    ]);
  });

  it("marks a pack synced via an omnipack_synced_at update keyed on sku+ean", async () => {
    const { client, getUpdate, getEqs } = fakeClient({});
    const port = createSupabaseOmnipackProductSyncPort(client, () => new Date("2026-06-25T10:00:00.000Z"));
    await port.markPackSynced({ sku: "OPENLUP-DOG-LAMB-CAN-400G", ean: "5908121193005" });
    expect(getUpdate()).toEqual({ omnipack_synced_at: "2026-06-25T10:00:00.000Z" });
    expect(getEqs()).toEqual([["sku", "OPENLUP-DOG-LAMB-CAN-400G"], ["ean", "5908121193005"]]);
  });

  it("upserts a pulled pack as source=omnipack and returns the conflict + replayed", async () => {
    const { client, rpcCalls } = fakeClient({
      rpcResults: { catalog_sku_eans_upsert_pack: { data: { conflict: "local_locked_mismatch", replayed: true }, error: null } },
    });
    const port = createSupabaseOmnipackProductSyncPort(client);
    const out = await port.upsertPulledPack({ sku: "S", ean: "E", quantity: 6, kind: "collective" });
    expect(out).toEqual({ conflict: "local_locked_mismatch", replayed: true });
    expect(rpcCalls[0]).toMatchObject({ fn: "catalog_sku_eans_upsert_pack", args: { p_source: "omnipack", p_sku: "S", p_ean: "E", p_quantity: 6, p_kind: "collective" } });
  });

  it("translates the unknown-SKU RPC error into a sku_not_found conflict (no throw)", async () => {
    const { client } = fakeClient({
      rpcResults: { catalog_sku_eans_upsert_pack: { data: null, error: { code: "P0001", message: "catalog_sku_eans_sku_not_found" } } },
    });
    const port = createSupabaseOmnipackProductSyncPort(client);
    await expect(port.upsertPulledPack({ sku: "NOPE", ean: "E", quantity: 1, kind: "unit" }))
      .resolves.toEqual({ conflict: "sku_not_found", replayed: false });
  });

  it("throws on an unexpected upsert RPC error", async () => {
    const { client } = fakeClient({
      rpcResults: { catalog_sku_eans_upsert_pack: { data: null, error: { code: "XX000", message: "boom" } } },
    });
    const port = createSupabaseOmnipackProductSyncPort(client);
    await expect(port.upsertPulledPack({ sku: "S", ean: "E", quantity: 1, kind: "unit" })).rejects.toThrow(/upsert_pack_failed:XX000/);
  });

  it("records + resolves reconciliation evidence through the RPCs", async () => {
    const { client, rpcCalls } = fakeClient({
      rpcResults: {
        omnipack_record_product_reconciliation_evidence: { data: { replayed: false }, error: null },
        omnipack_resolve_product_reconciliation_evidence: { data: { resolved: 2 }, error: null },
      },
    });
    const port = createSupabaseOmnipackProductSyncPort(client);
    await expect(port.recordReconciliationEvidence({
      idempotencyKey: "k", sku: "S", ean: "E", conflictKind: "ean_conflict", providerQuantity: 1, evidence: {},
    })).resolves.toEqual({ replayed: false });
    await expect(port.resolveReconciliationEvidence({
      sku: "S", activeConflictKinds: ["ean_conflict"], syncRunId: "r", evidence: {},
    })).resolves.toEqual({ resolved: 2 });
    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "omnipack_record_product_reconciliation_evidence",
      "omnipack_resolve_product_reconciliation_evidence",
    ]);
  });
});
