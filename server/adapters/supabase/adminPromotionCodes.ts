import type {
  PromotionCodeBenefit,
  PromotionCodeSummary,
  PromotionCodesListRequest,
} from "../../../src/domains/commerce/adminPromotionCodesContracts.js";
import { DomainRpcError } from "../../_lib/admin-domain/rpcErrors.js";
import type {
  AdminPromotionCodesDataPort,
  PromotionCodeCreateResult,
  PromotionCodeUpdateResult,
} from "../../domains/commerce/adminPromotionCodesDataPort.js";

export interface AdminPromotionCodesSupabaseClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: unknown }>;
}

type Row = Record<string, unknown>;

export function createSupabaseAdminPromotionCodesDataPort(
  client: AdminPromotionCodesSupabaseClient,
): AdminPromotionCodesDataPort {
  return {
    async list(actorId, input) {
      const cursor = decodeCursor(input.cursor);
      const [listResult, compatibilityResult] = await Promise.all([
        client.rpc("admin_promotion_codes_list", {
          p_actor_id: actorId,
          p_query: input.q ?? null,
          p_status: input.status,
          p_scope: input.scope,
          p_cursor_created_at: cursor?.createdAt ?? null,
          p_cursor_id: cursor?.id ?? null,
          p_limit: input.limit + 1,
        }),
        client.rpc("admin_promotion_codes_legacy_compatibility", {
          p_actor_id: actorId,
        }),
      ]);
      if (listResult.error) throw asDomainRpcError(listResult.error, "promotion_codes_list_failed");
      if (compatibilityResult.error) {
        throw asDomainRpcError(compatibilityResult.error, "promotion_codes_legacy_compatibility_failed");
      }
      const data = listResult.data;
      const rows = Array.isArray(data) ? (data as Row[]) : [];
      const page = rows.slice(0, input.limit);
      const next = rows.length > input.limit ? page.at(-1) : undefined;
      const compatibility = asRow(compatibilityResult.data);
      return {
        codes: page.map(mapSummary),
        nextCursor: next ? encodeCursor(String(next.created_at), String(next.id)) : null,
        legacyCompatibility: {
          ready: compatibility.ready === true,
          unprojectedCount: Number(compatibility.unprojectedCount ?? 0),
          collisionGroupCount: Number(compatibility.collisionGroupCount ?? 0),
        },
      };
    },

    async definition(actorId, id) {
      const { data, error } = await client.rpc("admin_promotion_code_definition", {
        p_actor_id: actorId,
        p_code_id: id,
      });
      if (error) throw asDomainRpcError(error, "promotion_code_definition_failed");
      const row = asRow(data);
      return {
        benefits: (Array.isArray(row.benefits) ? row.benefits : []) as PromotionCodeBenefit[],
        scopes: (Array.isArray(row.scopes) ? row.scopes : []) as PromotionCodeSummary["scopes"],
        minimumReferenceMinor: Number(row.minimum_reference_minor ?? 0),
        revision: Number(row.revision),
        status: row.status as PromotionCodeSummary["status"],
        validFrom: String(row.valid_from),
        validTo: typeof row.valid_to === "string" ? row.valid_to : null,
        promotionEngineVersion: row.promotion_engine_version as "promotion-engine.v1" | "promotion-engine.v2",
      };
    },

    async create(input): Promise<PromotionCodeCreateResult> {
      const request = input.request;
      const { data, error } = await client.rpc("admin_promotion_code_create", {
        p_actor_id: input.actorId,
        p_code: input.resolvedCode,
        p_name: request.name,
        p_description: request.description,
        p_scopes: request.scopes,
        p_valid_from: request.validFrom,
        p_valid_to: request.validTo,
        p_minimum_reference_minor: request.minimumReferenceMinor,
        p_redemption_limit_global: request.redemptionLimitGlobal,
        p_redemption_limit_per_customer: request.redemptionLimitPerCustomer,
        p_status: request.status,
        p_benefits: request.benefits,
        p_idempotency_key: request.idempotencyKey,
        p_request_fingerprint: input.requestFingerprint,
        p_source: "admin_console",
      });
      if (error) throw asDomainRpcError(error, "promotion_code_create_failed");
      return mapCreateResult(data);
    },

    async update(input): Promise<PromotionCodeUpdateResult> {
      const { data, error } = await client.rpc("admin_promotion_code_update", {
        p_actor_id: input.actorId,
        p_code_id: input.request.id,
        p_expected_revision: input.request.expectedRevision,
        p_updates: input.request.updates,
        p_idempotency_key: input.request.idempotencyKey,
        p_request_fingerprint: input.requestFingerprint,
        p_source: "admin_console",
      });
      if (error) throw asDomainRpcError(error, "promotion_code_update_failed");
      const row = asRow(data);
      return {
        id: String(row.id),
        status: row.status as PromotionCodeUpdateResult["status"],
        idempotent: row.idempotent === true,
        revision: Number(row.revision),
      };
    },
  };
}

function mapSummary(row: Row): PromotionCodeSummary {
  return {
    id: String(row.id),
    code: String(row.code),
    name: String(row.name),
    description: typeof row.admin_description === "string" ? row.admin_description : null,
    benefits: (Array.isArray(row.benefits) ? row.benefits : []) as PromotionCodeBenefit[],
    promotionEngineVersion: row.promotion_engine_version as PromotionCodeSummary["promotionEngineVersion"],
    scopes: (Array.isArray(row.scopes) ? row.scopes : []) as PromotionCodeSummary["scopes"],
    status: row.status as PromotionCodeSummary["status"],
    effectiveStatus: row.effective_status as PromotionCodeSummary["effectiveStatus"],
    validFrom: String(row.valid_from),
    validTo: typeof row.valid_to === "string" ? row.valid_to : null,
    minimumReferenceMinor: Number(row.minimum_reference_minor),
    redemptionLimitGlobal: nullableNumber(row.redemption_limit_global),
    redemptionLimitPerCustomer: nullableNumber(row.redemption_limit_per_customer),
    redeemedCount: Number(row.redeemed_count ?? 0),
    reservedCount: Number(row.reserved_count ?? 0),
    remainingCount: nullableNumber(row.remaining_count),
    createdAt: String(row.created_at),
    revision: Number(row.revision),
  };
}

function mapCreateResult(data: unknown): PromotionCodeCreateResult {
  const row = asRow(data);
  return {
    id: String(row.id),
    code: String(row.code),
    status: row.status as PromotionCodeCreateResult["status"],
    idempotent: row.idempotent === true,
    revision: Number(row.revision),
  };
}

function asRow(data: unknown): Row {
  const value = Array.isArray(data) ? data[0] : data;
  if (!value || typeof value !== "object") throw new Error("promotion_code_rpc_invalid_response");
  return value as Row;
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

interface CursorValue { createdAt: string; id: string }

function encodeCursor(createdAt: string, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt, id }), "utf8").toString("base64url");
}

function decodeCursor(cursor: PromotionCodesListRequest["cursor"]): CursorValue | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Row;
    if (
      typeof parsed.createdAt !== "string"
      || Number.isNaN(Date.parse(parsed.createdAt))
      || typeof parsed.id !== "string"
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(parsed.id)
    ) throw new Error();
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new DomainRpcError("22023", "promotion_code_cursor_invalid");
  }
}

function asDomainRpcError(error: unknown, fallback: string): DomainRpcError {
  const pg = error as { code?: string; message?: string } | null;
  return new DomainRpcError(pg?.code, pg?.message ?? fallback);
}
