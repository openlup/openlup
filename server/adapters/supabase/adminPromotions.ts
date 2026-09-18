import type {
  AdminPromotion,
  AdminPromotionUpdatePayload,
  AdminSubscriptionBandEntry,
} from "../../../src/domains/commerce/adminPromotionsContracts.js";
import type {
  AdminPromotionsAuditEntry,
  AdminPromotionsDataPort,
} from "../../domains/commerce/adminPromotionsDataPort.js";
import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import { readSettlementProfile } from "../../../src/lib/currency/platformCurrency.js";
import {
  isTargetPercentageMirror,
  isTechnicalFirstSubscriptionLegacy,
  mapAdminPromotion,
} from "../../domains/commerce/adminPromotionSemantic.js";
import { listSubscriptionBandEntries } from "./adminPromotionSubscriptionBand.js";

/**
 * @agent-domain-anti-reference
 * NOT THE REFERENCE — Promotions back-compat harness adapter (see
 * `adminPromotionsHandler.ts`). Copy the catalog `@agent-domain-reference`
 * adapter for a new domain.
 *
 * Service-role Supabase adapter for the admin discounts editor. Promotions and
 * price_entries are admin-RLS; this runs with a service-role client (RLS bypass)
 * wired from the BFF route after admin authorization. Hand-typed minimal client
 * mirrors `promotionClaims.ts`. The promotion UPDATE + audit throw
 * the kit `DomainRpcError` so the handler maps a structured RPC RAISE instead of
 * flattening every failure to a generic 502.
 */

interface AdminPromoQuery extends PromiseLike<{ data: unknown; error: unknown }> {
  select(columns: string): AdminPromoQuery;
  eq(column: string, value: unknown): AdminPromoQuery;
  in(column: string, values: unknown[]): AdminPromoQuery;
  order(column: string, options?: { ascending?: boolean }): AdminPromoQuery;
  limit(count: number): AdminPromoQuery;
  update(values: Record<string, unknown>): AdminPromoQuery;
  insert(values: Record<string, unknown>): AdminPromoQuery;
}

export interface AdminPromotionsSupabaseClient {
  from(table: string): AdminPromoQuery;
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

type Row = Record<string, unknown>;

export function createSupabaseAdminPromotionsDataPort(
  client: AdminPromotionsSupabaseClient,
): AdminPromotionsDataPort {
  // Every currency below denominates a decision taken NOW - which price list to write,
  // what a promotion would charge today - so it is what this deployment settles in, never
  // a currency stored on a row. From `process.env`, since the ambient profile reads the
  // Node-empty `import.meta.env`.
  const settlement = readSettlementProfile(process.env);

  return {
    async listPromotions(): Promise<AdminPromotion[]> {
      const { data, error } = await client
        .from("promotions")
        .select("*")
        .order("created_at", { ascending: true });
      if (error) throw asError(error, "promotions_list_failed");
      const rows = Array.isArray(data) ? (data as Row[]) : [];
      const mirrors = new Map<string, Row>();
      for (const row of rows) {
        if (row.promotion_engine_version !== "promotion-engine.v2") continue;
        if (typeof row.v2_mirror_of === "string") mirrors.set(row.v2_mirror_of, row);
      }
      const needsUnitTargets = [...mirrors.values()].some(isTargetPercentageMirror);
      const bandEntries = needsUnitTargets ? await listSubscriptionBandEntries(client, settlement) : [];
      const currency = settlement.defaultCurrency;
      // Engine-v2 automatic mirrors preserve old checkout semantics during the
      // rollout; the legacy admin editor must keep showing exactly one row.
      return rows
        .filter((row) => row.promotion_engine_version !== "promotion-engine.v2")
        .map((row) => mapAdminPromotion(row, mirrors.get(String(row.id)), bandEntries, currency));
    },

    async updatePromotion(id: string, updates: AdminPromotionUpdatePayload): Promise<void> {
      const { data: linkedRows, error: linkedError } = await client
        .from("promotions")
        .select("id")
        .eq("v2_mirror_of", id)
        .limit(1);
      if (linkedError) throw asDomainRpcError(linkedError, "promotion_management_check_failed");
      if (Array.isArray(linkedRows) && linkedRows.length > 0) {
        throw new DomainRpcError("P0001", "system_managed_promotion_read_only");
      }
      const { data: legacyRows, error: legacyError } = await client
        .from("promotions")
        .select(
          "promotion_engine_version, v2_mirror_of, trigger_type, discount_type, discount_value, eligibility",
        )
        .eq("id", id)
        .limit(1);
      if (legacyError) throw asDomainRpcError(legacyError, "promotion_management_check_failed");
      const legacyRow = Array.isArray(legacyRows) ? legacyRows[0] as Row | undefined : undefined;
      if (legacyRow && isTechnicalFirstSubscriptionLegacy(legacyRow)) {
        throw new DomainRpcError("P0001", "system_managed_promotion_read_only");
      }
      // The v2 mirror row is directly addressable only for the deliberate
      // human-operator activate/pause control (runbook
      // PROMOTION_V2_PRODUCTION_ACTIVATION step c). Its semantics stay immutable
      // on this route: anything beyond a status flip is rejected.
      if (legacyRow && isEngineV2MirrorRow(legacyRow) && !isStatusOnlyUpdate(updates)) {
        throw new DomainRpcError("P0001", "system_managed_mirror_status_only");
      }
      const { error } = await client
        .from("promotions")
        .update(toPromotionUpdate(updates))
        .eq("id", id);
      if (error) throw asDomainRpcError(error, "promotion_update_failed");
    },

    async listSubscriptionBand(): Promise<AdminSubscriptionBandEntry[]> {
      return listSubscriptionBandEntries(client, settlement);
    },

    async setSubscriptionBandPercent(percent) {
      const { data, error } = await client.rpc("admin_set_subscription_band_percent", {
        p_pct: percent,
      });
      if (error) throw asError(error, "subscription_band_set_failed");
      const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
      return {
        updatedSkuCount: Number(row?.updated_sku_count ?? 0),
        appliedPercent: Number(row?.applied_percent ?? percent),
      };
    },

    async getShippingFlatMinor(): Promise<number> {
      const { data, error } = await client
        .from("commerce_settings")
        .select("value_minor")
        .eq("key", "shipping_flat_minor");
      if (error) throw asError(error, "shipping_rate_read_failed");
      const rows = Array.isArray(data) ? (data as Row[]) : [];
      const value = rows[0]?.value_minor;
      return typeof value === "number" && value >= 0 ? value : 0;
    },

    async setShippingFlatMinor(minor: number): Promise<void> {
      // The row is seeded by migration, so an UPDATE is sufficient (no upsert needed).
      const { error } = await client
        .from("commerce_settings")
        .update({ value_minor: minor, updated_at: new Date().toISOString() })
        .eq("key", "shipping_flat_minor");
      if (error) throw asError(error, "shipping_rate_set_failed");
    },

    async setCatalogPrice(input): Promise<void> {
      const { data, error } = await client.rpc("admin_set_catalog_price", {
        p_actor_id: input.actorId,
        p_sku: input.sku,
        p_price_mode: "one_time",
        p_unit_price_minor: input.unitPriceMinor,
        // The RPC keeps this as the caller's own parameter on purpose (no default,
        // "this function never chose one") and reads the region itself.
        p_currency: settlement.defaultCurrency,
        p_mode: "commit",
        p_source: "admin_console",
      });
      if (error) throw asError(error, "catalog_price_set_failed");
      // RPC returns { sku, idempotent, dryRun }; a missing/falsy sku echo means the
      // write did not land (e.g. sku_not_found surfaces as an error above, but guard).
      const row = (Array.isArray(data) ? data[0] : data) as Row | undefined;
      if (!row || row.sku == null) throw new Error("catalog_price_set_failed");
    },

    async recordPromotionAudit(entry: AdminPromotionsAuditEntry): Promise<void> {
      // Non-repudiable audit through the `record_admin_audit_event` fn (re-derives
      // actor_kind from admin_users, cooperates with the fn-only audit guard).
      // Replaces the old best-effort direct `admin_audit_events` INSERT.
      const { error } = await client.rpc("record_admin_audit_event", {
        p_actor_id: entry.actorId,
        p_action: entry.action,
        p_source: "admin_console",
        p_entity_type: "promotion",
        p_entity_id: entry.promotionId,
        p_old: null,
        p_new: { promotion_id: entry.promotionId, ...entry.newValue },
      });
      if (error) throw asDomainRpcError(error, "promotion_audit_failed");
    },
  };
}

function isEngineV2MirrorRow(row: Row): boolean {
  return row.promotion_engine_version === "promotion-engine.v2" &&
    typeof row.v2_mirror_of === "string" && row.v2_mirror_of.length > 0;
}

function isStatusOnlyUpdate(updates: AdminPromotionUpdatePayload): boolean {
  return updates.status !== undefined &&
    Object.entries(updates).every(([key, value]) => key === "status" || value === undefined);
}

function toPromotionUpdate(updates: AdminPromotionUpdatePayload): Record<string, unknown> {
  const update: Record<string, unknown> = {};
  if (updates.name !== undefined) update.name = updates.name;
  if (updates.discountValue !== undefined) update.discount_value = updates.discountValue;
  if (updates.stackingRule !== undefined) update.stacking_rule = updates.stackingRule;
  if (updates.status !== undefined) update.status = updates.status;
  if (updates.eligibility !== undefined) update.eligibility = updates.eligibility;
  if (updates.validFrom !== undefined) update.valid_from = updates.validFrom;
  if (updates.validTo !== undefined) update.valid_to = updates.validTo;
  if (updates.redemptionLimitGlobal !== undefined) {
    update.redemption_limit_global = updates.redemptionLimitGlobal;
  }
  if (updates.redemptionLimitPerCustomer !== undefined) {
    update.redemption_limit_per_customer = updates.redemptionLimitPerCustomer;
  }
  return update;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}

/** Wrap a PostgREST/RPC error as a kit `DomainRpcError` carrying its SQLSTATE, so
 *  the handler maps a structured RAISE (e.g. 42501) instead of flattening it. */
function asDomainRpcError(error: unknown, fallback: string): DomainRpcError {
  const pg = error as { code?: string; message?: string } | null;
  return new DomainRpcError(pg?.code, pg?.message ?? fallback);
}
