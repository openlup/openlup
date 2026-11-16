import {
  catalogDraftApplyResultSchema, catalogDraftRecordSchema,
  catalogDraftGetQuerySchema,
  catalogDraftListQuerySchema,
  catalogDraftPageSchema,
  type CatalogDraftRefusal,
} from "./draftSchemas.js";
import { catalogDraftStoredApplyResultSchema, catalogDraftStoredRecordSchema } from "./draftV2Schemas.js";
import type { CatalogDraftStoredRecord } from "./contracts/draftV2.js";
import type { z } from "./validation.js";
import { CatalogDraftStoreError, type CatalogDraftStorePort } from "./draftPorts.js";
import type { PgQueryExecutor } from "../data/index.js";

/** Dark owner-only storage. Composition must verify the operator before use. */
function draftStore<Record extends CatalogDraftStoredRecord>(client: PgQueryExecutor, schemas: {
  record: z.ZodType<Record>; result: z.ZodType<{ outcome: "committed" | "replayed"; record: Record } | CatalogDraftRefusal>;
}, v2: boolean): CatalogDraftStorePort<Record> {
  const { record: catalogDraftRecordSchema, result: catalogDraftApplyResultSchema } = schemas;
  async function call(sql: string, values: unknown[]): Promise<unknown> {
    try {
      const { rows } = await client.query(sql, values);
      if (rows.length !== 1 || !("result" in rows[0]!)) {
        throw new CatalogDraftStoreError({ outcome: "dependency_unavailable", reason: "invalid_store_response" });
      }
      return rows[0]!.result;
    } catch (error) {
      if (error instanceof CatalogDraftStoreError) throw error;
      throw new CatalogDraftStoreError(refusal(error));
    }
  }
  return {
    async apply(request) {
      try {
        if (!v2) {
          let version: unknown;
          try { version = JSON.parse(request.canonicalCommand)?.schemaVersion; } catch { /* SQL retains legacy malformed-input refusals. */ }
          if (version === 2) return { outcome: "validation_issue", reason: "command_invalid" };
        }
        const result = await call(
          "SELECT public.catalog_draft_apply($1::text, $2::text, $3::text) AS result",
          [request.canonicalCommand, request.fingerprint, request.actorId],
        );
        const parsed = catalogDraftApplyResultSchema.safeParse(result);
        if (!parsed.success) return { outcome: "dependency_unavailable", reason: "invalid_store_response" };
        return parsed.data;
      } catch (error) {
        return error instanceof CatalogDraftStoreError ? error.refusal : refusal(error);
      }
    },
    async get(query) {
      const input = catalogDraftGetQuerySchema.safeParse(query);
      if (!input.success) throw new CatalogDraftStoreError({ outcome: "validation_issue", reason: "invalid_get_query" });
      const result = await call(
        "SELECT public.catalog_draft_get($1::uuid, $2::integer, $3::text) AS result",
        [input.data.draftId, input.data.revision ?? null, input.data.commandKey ?? null],
      );
      const parsed = catalogDraftRecordSchema.nullable().safeParse(result);
      if (!parsed.success) throw new CatalogDraftStoreError({ outcome: "dependency_unavailable", reason: "invalid_store_response" });
      return parsed.data;
    },
    async list(query) {
      const input = catalogDraftListQuerySchema.safeParse(query);
      if (!input.success) throw new CatalogDraftStoreError({ outcome: "validation_issue", reason: "invalid_list_query" });
      const result = await call(
        "SELECT public.catalog_draft_list($1::uuid, $2::integer) AS result",
        [input.data.afterDraftId ?? null, input.data.limit],
      );
      const parsed = catalogDraftPageSchema.safeParse(result);
      if (!parsed.success) throw new CatalogDraftStoreError({ outcome: "dependency_unavailable", reason: "invalid_store_response" });
      return parsed.data;
    },
  };
}

/** Existing v1 reader/adapter. A v2 command requires the explicit v2 adapter. */
export function createPostgresCatalogDraftStore(client: PgQueryExecutor): CatalogDraftStorePort {
  return draftStore(client, { record: catalogDraftRecordSchema, result: catalogDraftApplyResultSchema }, false);
}
/** Opt-in native reader/adapter for retained v1 and v2 payloads. */
export function createPostgresCatalogDraftStoreV2(client: PgQueryExecutor): CatalogDraftStorePort<CatalogDraftStoredRecord> {
  return draftStore(client, { record: catalogDraftStoredRecordSchema, result: catalogDraftStoredApplyResultSchema }, true);
}

function refusal(error: unknown): CatalogDraftRefusal {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "42501") return { outcome: "unauthorized", reason: "operator_required" };
  if (code === "22023") return { outcome: "validation_issue", reason: "invalid_store_request" };
  if (code === "23505") return { outcome: "conflict", reason: "identity_reserved" };
  return { outcome: "dependency_unavailable", reason: "store_unavailable" };
}
