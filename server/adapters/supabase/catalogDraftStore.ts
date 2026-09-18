import {
  catalogDraftApplyResultSchema,
  catalogDraftGetQuerySchema,
  catalogDraftListQuerySchema,
  catalogDraftPageSchema,
  catalogDraftRecordSchema,
  type CatalogDraftRefusal,
} from "../../../src/domains/catalog/catalogDraftContracts.js";
import { CatalogDraftStoreError, type CatalogDraftStorePort } from "../../../src/domains/catalog/catalogDraftPorts.js";

export interface CatalogDraftRpcClient {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{
    data: unknown; error: { code?: string; message?: string } | null;
  }>;
}

/** Requires the administrator's authenticated session; SQL derives the actor. */
export function createSupabaseCatalogDraftStore(client: CatalogDraftRpcClient): CatalogDraftStorePort {
  async function call(name: string, args: Record<string, unknown>): Promise<unknown> {
    try {
      const result = await client.rpc(name, args);
      if (result.error) throw new CatalogDraftStoreError(refusal(result.error));
      return result.data;
    } catch (error) {
      if (error instanceof CatalogDraftStoreError) throw error;
      throw new CatalogDraftStoreError(refusal(error));
    }
  }
  return {
    async apply(request) {
      try {
        const result = await call("catalog_draft_apply", {
          p_canonical_command: request.canonicalCommand, p_fingerprint: request.fingerprint,
        });
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
      const result = await call("catalog_draft_get", {
        p_draft_id: input.data.draftId, p_revision: input.data.revision ?? null,
        p_command_key: input.data.commandKey ?? null,
      });
      const parsed = catalogDraftRecordSchema.nullable().safeParse(result);
      if (!parsed.success) throw new CatalogDraftStoreError({ outcome: "dependency_unavailable", reason: "invalid_store_response" });
      return parsed.data;
    },
    async list(query) {
      const input = catalogDraftListQuerySchema.safeParse(query);
      if (!input.success) throw new CatalogDraftStoreError({ outcome: "validation_issue", reason: "invalid_list_query" });
      const result = await call("catalog_draft_list", {
        p_after_draft_id: input.data.afterDraftId ?? null, p_limit: input.data.limit,
      });
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
