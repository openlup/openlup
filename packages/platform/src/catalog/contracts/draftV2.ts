import type { CatalogDraftPayload, CatalogDraftCommand, CatalogDraftSummary, CatalogDraftRefusal } from "./draft.js";
import type { CatalogQuantity } from "./productTypes.js";

/** One immediate positive gross base replacement. Expectations are wholly null or wholly set.
 * @experimental
 */
export interface CatalogDraftPriceOperationV2 {
  schemaVersion: 1;
  commandKey: string;
  variantId: string;
  priceListId: string;
  mode: "one_time";
  minQty: 1;
  amountKind: "gross";
  unitPriceMinor: number;
  expected: { entryId: null; unitPriceMinor: null } | { entryId: string; unitPriceMinor: number };
}
/** @experimental */
export type CatalogAttributeScalarValue = string | boolean | CatalogQuantity
  | { namespace: string; id: string } | Readonly<Record<string, string>>;
/** @experimental */
export type CatalogAttributeValue = CatalogAttributeScalarValue | readonly CatalogAttributeScalarValue[];
/** Immutable v2 data; later versions never reinterpret or rewrite this payload.
 * @experimental
 */
export interface CatalogDraftPayloadV2 {
  schemaVersion: 2;
  product: CatalogDraftPayload["product"] & { attributes?: Record<string, CatalogAttributeValue> };
  skus: (Omit<CatalogDraftPayload["skus"][number], "priceRef"> & {
    attributes?: Record<string, CatalogAttributeValue>;
    priceOperations?: CatalogDraftPriceOperationV2[];
  })[];
}
/** @experimental */
export interface CatalogDraftCommandV2 {
  schemaVersion: 2; action: "create" | "revise" | "abandon" | "resume";
  draftId: string; commandKey: string; expectedRevision: number; payload?: CatalogDraftPayloadV2;
}
/** @experimental */
export type CatalogDraftStoredPayload = CatalogDraftPayload | CatalogDraftPayloadV2;
/** @experimental */
export type CatalogDraftStoredCommand = CatalogDraftCommand | CatalogDraftCommandV2;
/** @experimental */
export interface CatalogDraftStoredRecord extends CatalogDraftSummary { payload: CatalogDraftStoredPayload }
/** @experimental */
export type CatalogDraftStoredApplyResult = { outcome: "committed" | "replayed"; record: CatalogDraftStoredRecord } | CatalogDraftRefusal;
