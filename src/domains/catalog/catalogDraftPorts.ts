import type {
  CatalogDraftApplyResult, CatalogDraftGetQuery, CatalogDraftListQuery,
  CatalogDraftPage, CatalogDraftRecord, CatalogDraftRefusal,
} from "./catalogDraftContracts.js";

/** Portable adapters accept this actor only after the injected operator authorizer succeeds. */
export interface CatalogDraftOperator { actorId: string }
export interface CatalogDraftStorePort {
  apply(input: { canonicalCommand: string; fingerprint: string; actorId: string }): Promise<CatalogDraftApplyResult>;
  get(query: CatalogDraftGetQuery, actorId: string): Promise<CatalogDraftRecord | null>;
  list(query: CatalogDraftListQuery, actorId: string): Promise<CatalogDraftPage>;
}
export class CatalogDraftStoreError extends Error {
  constructor(readonly refusal: CatalogDraftRefusal) {
    super(refusal.reason);
    this.name = "CatalogDraftStoreError";
  }
}
