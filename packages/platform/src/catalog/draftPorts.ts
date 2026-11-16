import type {
  CatalogDraftGetQuery, CatalogDraftListQuery,
  CatalogDraftPage, CatalogDraftRefusal,
} from "./draftSchemas.js";
import type { CatalogDraftStoredApplyResult, CatalogDraftStoredRecord } from "./contracts/draftV2.js";

/** Portable adapters accept this actor only after the injected operator authorizer succeeds. */
export interface CatalogDraftOperator { actorId: string }
export interface CatalogDraftStorePort {
  apply(input: { canonicalCommand: string; fingerprint: string; actorId: string }): Promise<CatalogDraftStoredApplyResult>;
  get(query: CatalogDraftGetQuery, actorId: string): Promise<CatalogDraftStoredRecord | null>;
  list(query: CatalogDraftListQuery, actorId: string): Promise<CatalogDraftPage>;
}
export class CatalogDraftStoreError extends Error {
  constructor(readonly refusal: CatalogDraftRefusal) {
    super(refusal.reason);
    this.name = "CatalogDraftStoreError";
  }
}
