import {
  catalogDraftApplyResultSchema, catalogDraftRecordSchema,
  catalogDraftGetQuerySchema,
  catalogDraftListQuerySchema,
  catalogDraftPageSchema,
  type CatalogDraftRefusal,
} from "./draftSchemas.js";
import { catalogDraftStoredApplyResultSchema, catalogDraftStoredRecordSchema } from "./draftV2Schemas.js";
import type { CatalogDraftStoredRecord } from "./contracts/draftV2.js";
import type { CatalogDraftPublicationStoredRecord } from "./contracts/draftV3.js";
import { catalogDraftPublicationStoredApplyResultSchema, catalogDraftPublicationStoredRecordSchema } from "./draftV3Schemas.js";
import { catalogDraftCommandV4Schema, lifecycleStoredRecordSchema, lifecycleStoredResultSchema } from "./lifecycleDraftSchemas.js";
import type { CatalogLifecycleDraftStorePort } from "./draftPorts.js";
import type { PublicationDraftRecord } from "./publicationIntent.js";
import type { z } from "./validation.js";
import { CatalogDraftStoreError, type CatalogDraftStorePort } from "./draftPorts.js";
import type { PgQueryExecutor } from "../data/index.js";

/** Dark owner-only storage. Composition must verify the operator before use. */
function draftStore<Record extends PublicationDraftRecord>(client: PgQueryExecutor, schemas: {
  record: z.ZodType<Record>; result: z.ZodType<{ outcome: "committed" | "replayed"; record: Record } | CatalogDraftRefusal>;
}, maxVersion: number): CatalogDraftStorePort<Record> {
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
        let command: { schemaVersion?: unknown } | null = null;
        try { command = JSON.parse(request.canonicalCommand); } catch { /* SQL retains malformed-input refusals. */ }
        const version = command?.schemaVersion;
        if (typeof version === "number" && (version > maxVersion
          || version === 4 && !catalogDraftCommandV4Schema.safeParse(command).success))
          return { outcome: "validation_issue", reason: "command_invalid" };
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
  return draftStore(client, { record: catalogDraftRecordSchema, result: catalogDraftApplyResultSchema }, 1);
}
/** Opt-in native reader/adapter for retained v1 and v2 payloads.
 * @experimental
 */
export function createPostgresCatalogDraftStoreV2(client: PgQueryExecutor): CatalogDraftStorePort<CatalogDraftStoredRecord> {
  return draftStore(client, { record: catalogDraftStoredRecordSchema, result: catalogDraftStoredApplyResultSchema }, 2);
}

/** Explicit v3 opt-in; the v1 and v2 adapters retain their version boundaries.
 * @experimental
 */
export function createPostgresCatalogDraftStoreV3(client: PgQueryExecutor): CatalogDraftStorePort<CatalogDraftPublicationStoredRecord> {
  return draftStore(client, { record: catalogDraftPublicationStoredRecordSchema, result: catalogDraftPublicationStoredApplyResultSchema }, 3);
}

function refusal(error: unknown): CatalogDraftRefusal {
  const code = error && typeof error === "object" && "code" in error ? error.code : null;
  if (code === "42501") return { outcome: "unauthorized", reason: "operator_required" };
  if (code === "22023") return { outcome: "validation_issue", reason: "invalid_store_request" };
  if (code === "23505") return { outcome: "conflict", reason: "identity_reserved" };
  return { outcome: "dependency_unavailable", reason: "store_unavailable" };
}

/** Opt in to governed draft writes and exact stored revisions on list.
 * @experimental
 */
export function createPostgresCatalogDraftStoreV4(client: PgQueryExecutor): CatalogLifecycleDraftStorePort {
  const store = draftStore(client, { record: lifecycleStoredRecordSchema, result: lifecycleStoredResultSchema }, 4);
  return {
    ...store,
    async list(query, actorId) {
      const page = await store.list(query, actorId);
      if (!page.items.length) return { ...page, items: [] };
      let rows: Record<string, unknown>[];
      try {
        ({ rows } = await client.query(
          `SELECT d.ord::int AS ord, public.catalog_draft_get(d.draft_id, d.revision, $3::text) AS result
           FROM unnest($1::uuid[], $2::integer[]) WITH ORDINALITY AS d(draft_id, revision, ord)
           ORDER BY d.ord`,
          [
            page.items.map(summary => summary.draftId),
            page.items.map(summary => summary.revision),
            null,
          ],
        ));
      } catch (error) {
        if (error instanceof CatalogDraftStoreError) throw error;
        throw new CatalogDraftStoreError(refusal(error));
      }
      if (rows.length !== page.items.length) {
        throw new CatalogDraftStoreError({ outcome: "dependency_unavailable", reason: "invalid_store_response" });
      }
      const items = page.items.map((summary, index) => {
        const row = rows[index];
        if (!row || !("result" in row) || row.ord !== index + 1) {
          throw new CatalogDraftStoreError({ outcome: "dependency_unavailable", reason: "invalid_store_response" });
        }
        const parsed = lifecycleStoredRecordSchema.nullable().safeParse(row.result);
        if (!parsed.success) {
          throw new CatalogDraftStoreError({ outcome: "dependency_unavailable", reason: "invalid_store_response" });
        }
        const record = parsed.data;
        if (!record || record.draftId !== summary.draftId || record.revision !== summary.revision
          || record.fingerprint !== summary.fingerprint)
          throw new CatalogDraftStoreError({ outcome: "dependency_unavailable", reason: "invalid_store_response" });
        return record;
      });
      return { ...page, items };
    },
  };
}
