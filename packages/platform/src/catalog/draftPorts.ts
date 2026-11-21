import type {
  CatalogDraftGetQuery, CatalogDraftListQuery,
  CatalogDraftPage, CatalogDraftRefusal,
  CatalogDraftRecord,
} from "./draftSchemas.js";
import type { PublicationDraftRecord } from "./publicationIntent.js";
import type { CatalogLifecycleDraftPage } from "./lifecycleDraftSchemas.js";

/** Portable adapters accept this actor only after the injected operator authorizer succeeds. */
export interface CatalogDraftOperator { actorId: string }
export interface CatalogDraftStorePort<Record extends PublicationDraftRecord = CatalogDraftRecord, Page extends CatalogDraftPage = CatalogDraftPage> {
  apply(input: { canonicalCommand: string; fingerprint: string; actorId: string }): Promise<{ outcome: "committed" | "replayed"; record: Record } | CatalogDraftRefusal>;
  get(query: CatalogDraftGetQuery, actorId: string): Promise<Record | null>;
  list(query: CatalogDraftListQuery, actorId: string): Promise<Page>;
}
export class CatalogDraftStoreError extends Error {
  constructor(readonly refusal: CatalogDraftRefusal) {
    super(refusal.reason);
    this.name = "CatalogDraftStoreError";
  }
}

/** @experimental */
export type CatalogLifecycleDraftStorePort = CatalogDraftStorePort<PublicationDraftRecord, CatalogLifecycleDraftPage>;
