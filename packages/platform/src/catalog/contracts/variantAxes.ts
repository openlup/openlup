import type { CatalogOptionValue } from "./productTypes.js";
import type { CatalogVariantState } from "./lifecycle.js";

/** V2 identity evidence computed by trusted server code, never a client digest. */
export interface CatalogCombinationIdentityV2 {
  readonly version: 2;
  readonly canonicalOptionBytes: Uint8Array;
  readonly combinationDigest: Uint8Array;
}
export type CatalogCombinationCode = "axis_not_installed" | "duplicate_axis" | "option_not_selected"
  | "option_missing" | "option_invalid" | "unit_factor_missing" | "sku_identity_change_requires_new_sku"
  | "duplicate_combination" | "combination_digest_collision" | "duplicate_sku_id"
  | "sku_payload_limit" | "product_capacity_exceeded" | "product_capacity_invalid";
/** Retained facts come from authoritative rows/history, scoped to one product. */
export interface CatalogRetainedCombinationV2 {
  readonly skuId: string;
  readonly state: CatalogVariantState;
  readonly optionValues: Readonly<Record<string, CatalogOptionValue>> | null;
  readonly identity: CatalogCombinationIdentityV2 | null;
}
/** Omitted options on an existing SKU preserve its retained values. */
export interface CatalogCombinationChangeV2 {
  readonly skuId: string;
  readonly state: CatalogVariantState;
  readonly optionValues?: Readonly<Record<string, CatalogOptionValue>> | null;
}
