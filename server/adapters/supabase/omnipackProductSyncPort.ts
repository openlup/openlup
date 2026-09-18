import type {
  OmnipackPackKind,
  OmnipackPackUpsertConflict,
  OmnipackProductSyncPort,
  OmnipackLocalProductPacks,
} from "../../domains/fulfillment/omnipackProductSyncWorker.js";

// catalog_sku_eans is not in the generated Database types (like the omnipack evidence tables), so
// this port speaks to a minimal structural Supabase shape and parses defensively.
export interface OmnipackProductSyncSupabaseClient {
  from(table: string): SupabaseQueryBuilder;
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: RpcError | null }>;
}

interface SupabaseQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns?: string): SupabaseQueryBuilder;
  update(values: Record<string, unknown>): SupabaseQueryBuilder;
  eq(column: string, value: unknown): SupabaseQueryBuilder;
}

interface SupabaseQueryResult {
  data: unknown;
  error: RpcError | null;
}

interface RpcError {
  code?: string;
  message?: string;
}

export function createSupabaseOmnipackProductSyncPort(
  client: OmnipackProductSyncSupabaseClient,
  now: () => Date = () => new Date(),
): OmnipackProductSyncPort {
  return {
    async listLocalProductPacks(): Promise<OmnipackLocalProductPacks[]> {
      const result = await client
        .from("catalog_sku_eans")
        .select("sku, ean, quantity, kind")
        .eq("source", "local");
      if (result.error) throw new Error(`omnipack_product_sync_list_local_packs_failed:${result.error.code ?? "unknown"}`);
      const bySku = new Map<string, OmnipackLocalProductPacks>();
      for (const raw of Array.isArray(result.data) ? result.data : []) {
        const row = asRecord(raw);
        const sku = readText(row.sku);
        const ean = readText(row.ean);
        if (!sku || !ean) continue;
        const entry = bySku.get(sku) ?? { sku, packs: [] };
        entry.packs.push({ ean, quantity: readInteger(row.quantity, 1), kind: readKind(row.kind) });
        bySku.set(sku, entry);
      }
      return [...bySku.values()];
    },

    async markPackSynced(input): Promise<void> {
      const result = await client
        .from("catalog_sku_eans")
        .update({ omnipack_synced_at: now().toISOString() })
        .eq("sku", input.sku)
        .eq("ean", input.ean);
      if (result.error) throw new Error(`omnipack_product_sync_mark_synced_failed:${result.error.code ?? "unknown"}`);
    },

    async upsertPulledPack(input): Promise<{ conflict: OmnipackPackUpsertConflict; replayed: boolean }> {
      const { data, error } = await client.rpc("catalog_sku_eans_upsert_pack", {
        p_sku: input.sku,
        p_ean: input.ean,
        p_kind: input.kind,
        p_label_variant: null,
        p_quantity: input.quantity,
        p_is_primary: false,
        p_source: "omnipack",
      });
      if (error) {
        // Never auto-create a SKU: the RPC raises for an unknown SKU — surface it as a conflict
        // the pull turns into reconciliation evidence, not a hard failure.
        if ((error.message ?? "").includes("catalog_sku_eans_sku_not_found")) {
          return { conflict: "sku_not_found", replayed: false };
        }
        throw new Error(`omnipack_product_sync_upsert_pack_failed:${error.code ?? "unknown"}`);
      }
      const row = asRecord(data);
      return { conflict: readConflict(row.conflict), replayed: row.replayed === true };
    },

    async recordReconciliationEvidence(input): Promise<{ replayed: boolean }> {
      const { data, error } = await client.rpc("omnipack_record_product_reconciliation_evidence", {
        p_idempotency_key: input.idempotencyKey,
        p_sku: input.sku,
        p_conflict_kind: input.conflictKind,
        p_ean: input.ean,
        p_provider_quantity: input.providerQuantity,
        p_evidence: input.evidence,
      });
      if (error) throw new Error(`omnipack_product_reconciliation_record_failed:${error.code ?? "unknown"}`);
      return { replayed: asRecord(data).replayed === true };
    },

    async resolveReconciliationEvidence(input): Promise<{ resolved: number }> {
      const { data, error } = await client.rpc("omnipack_resolve_product_reconciliation_evidence", {
        p_sku: input.sku,
        p_active_conflict_kinds: input.activeConflictKinds,
        p_sync_run_id: input.syncRunId,
        p_evidence: input.evidence,
      });
      if (error) throw new Error(`omnipack_product_reconciliation_resolve_failed:${error.code ?? "unknown"}`);
      const resolved = asRecord(data).resolved;
      return { resolved: typeof resolved === "number" ? resolved : 0 };
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function readText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : fallback;
}

function readKind(value: unknown): OmnipackPackKind {
  return value === "collective" ? "collective" : "unit";
}

function readConflict(value: unknown): OmnipackPackUpsertConflict {
  return value === "local_locked_mismatch" || value === "ean_owned_by_other_sku" || value === "sku_not_found"
    ? value
    : "none";
}
