import type {
  CatalogDraftGetQuery, CatalogDraftListQuery,
  CatalogDraftPage, CatalogDraftRefusal,
  CatalogDraftRecord,
} from "./draftSchemas.js";
import type { CatalogDraftStoredRecord } from "./contracts/draftV2.js";

/** Portable adapters accept this actor only after the injected operator authorizer succeeds. */
export interface CatalogDraftOperator { actorId: string }
export interface CatalogDraftStorePort<Record extends CatalogDraftStoredRecord = CatalogDraftRecord> {
  apply(input: { canonicalCommand: string; fingerprint: string; actorId: string }): Promise<{ outcome: "committed" | "replayed"; record: Record } | CatalogDraftRefusal>;
  get(query: CatalogDraftGetQuery, actorId: string): Promise<Record | null>;
  list(query: CatalogDraftListQuery, actorId: string): Promise<CatalogDraftPage>;
}
export class CatalogDraftStoreError extends Error {
  constructor(readonly refusal: CatalogDraftRefusal) {
    super(refusal.reason);
    this.name = "CatalogDraftStoreError";
  }
}
