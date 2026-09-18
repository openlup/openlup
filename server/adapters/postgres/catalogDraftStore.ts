import {
  catalogDraftApplyResultSchema,
  catalogDraftGetQuerySchema,
  catalogDraftListQuerySchema,
  catalogDraftPageSchema,
  catalogDraftRecordSchema,
  type CatalogDraftRefusal,
} from "../../../src/domains/catalog/catalogDraftContracts.js";
import { CatalogDraftStoreError, type CatalogDraftStorePort } from "../../../src/domains/catalog/catalogDraftPorts.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

/** Dark owner-only storage. Composition must verify the operator before use. */
export function createPostgresCatalogDraftStore(client: PgQueryExecutor): CatalogDraftStorePort {
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

function refusal(error: unknown): CatalogDraftRefusal {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "42501") return { outcome: "unauthorized", reason: "operator_required" };
  if (code === "22023") return { outcome: "validation_issue", reason: "invalid_store_request" };
  if (code === "23505") return { outcome: "conflict", reason: "identity_reserved" };
  return { outcome: "dependency_unavailable", reason: "store_unavailable" };
}
