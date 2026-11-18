import type { CatalogDraftSummary } from "./draft.js";
import type { CatalogDraftPayloadV4 } from "./lifecycleV2.js";
import type { CatalogBoundObligationsV2 } from "./lifecycleV2.js";
/** Uses the same authoritative, complete obligation result as lifecycle archive.
 * @experimental
 */
export interface CatalogWithdrawalImpactPort {
  report(skuId: string): Promise<CatalogBoundObligationsV2>;
}
/** A declared pair is immutable publication provenance. No implicit graph traversal.
 * @experimental
 */
export interface CatalogSkuSuccessor {
  predecessorSkuId: string;
  successorSkuId: string;
  publicationId: string;
}

/** Successor declarations are bound to the original authored operation.
 * @experimental
 */
export interface CatalogDraftPayloadV5 extends Omit<CatalogDraftPayloadV4, "schemaVersion" | "publication"> {
  schemaVersion: 5;
  publication: Omit<import("./lifecycleV2.js").CatalogDraftPayloadV4["publication"], "operations"> & {
    operations: (Exclude<import("./lifecycleV2.js").CatalogDraftPublicationOperationV4, { op: "create_sku" }>
      | (Extract<import("./lifecycleV2.js").CatalogDraftPublicationOperationV4, { op: "create_sku" }> & { successorOf?: string }))[];
  };
}
/** @experimental */
export interface CatalogDraftCommandV5 {
  schemaVersion: 5; action: "create" | "revise" | "abandon" | "resume";
  draftId: string; commandKey: string; expectedRevision: number; payload?: CatalogDraftPayloadV5;
}
/** @experimental */
export type CatalogSuccessorStoredCommand = import("./lifecycleV2.js").CatalogLifecycleStoredCommand | CatalogDraftCommandV5;
/** @experimental */
export interface CatalogSuccessorStoredRecord extends CatalogDraftSummary {
  payload: import("./lifecycleV2.js").CatalogLifecycleStoredPayload | CatalogDraftPayloadV5;
}

/** Versioned manifest adds declarations without changing product or SKU facts.
 * @experimental
 */
export interface CatalogFullPublicationV4 {
  outcome: "page"; schemaVersion: 4;
  head: import("./lifecycle.js").CatalogHeadRef;
  product: import("./lifecycleV2.js").CatalogPublishedProductV3;
  items: { reference: import("./publication.js").CatalogSkuRevisionRef; facts: import("./lifecycleV2.js").CatalogPublishedSkuV3 }[];
  successors: { successorSkuId: string; successorOf: string }[];
  nextCursor: string | null;
}
