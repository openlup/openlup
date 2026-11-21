import type { CatalogOptionValue, CatalogProductTypeInput } from "./contracts/productTypes.js";
import type { CatalogCombinationChangeV2, CatalogCombinationCode, CatalogCombinationIdentityV2,
  CatalogRetainedCombinationV2 } from "./contracts/variantAxes.js";
import { canonicalizeCombinationOptions, selectCombinationAxes, skuIdPathErrors } from "./combinationOptions.js";

/** @experimental */
export class CatalogCombinationError extends Error {
  constructor(readonly code: CatalogCombinationCode, readonly path: string) {
    super(code); this.name = "CatalogCombinationError";
  }
}
const refuse = (code: CatalogCombinationCode, path: string): never => { throw new CatalogCombinationError(code, path); };

function refuseSkuId(code: CatalogCombinationCode, skuId: string): never {
  const error = new CatalogCombinationError(code, skuId);
  skuIdPathErrors.add(error);
  throw error;
}

/** Installed definition metadata and selected axes must be rebound by LC2 inside its transaction.
 * @experimental
 */
export function canonicalizeCatalogCombinationV2(input: {
  definition: CatalogProductTypeInput;
  axes: readonly string[];
  options: Readonly<Record<string, CatalogOptionValue>>;
}): CatalogCombinationIdentityV2 {
  const selected = selectCombinationAxes(input.definition, input.axes, key => `axes.${key}`, refuse);
  return canonicalizeCombinationOptions(input.definition, selected, input.options, key => key === undefined ? "options" : `options.${key}`, refuse);
}

/** Compare authoritative bytes after a digest conflict; a collision never merges identities.
 * @experimental
 */
export function classifyCatalogCombinationConflictV2(left: CatalogCombinationIdentityV2, right: CatalogCombinationIdentityV2):
  "distinct" | "duplicate" | "collision" {
  if (!Buffer.from(left.combinationDigest).equals(right.combinationDigest)) return "distinct";
  return Buffer.from(left.canonicalOptionBytes).equals(right.canonicalOptionBytes) ? "duplicate" : "collision";
}

/** Pure LC2 preparation, without locks, persistence, publication authority or capacity configuration.
 * @experimental
 */
export function validateCatalogCombinationChangesV2(input: {
  definition: CatalogProductTypeInput; axes: readonly string[]; typed: boolean;
  retained: readonly CatalogRetainedCombinationV2[]; incoming: readonly CatalogCombinationChangeV2[];
  capacity?: number;
}): readonly CatalogRetainedCombinationV2[] {
  if (input.incoming.length > 10_000) refuse("sku_payload_limit", "incoming");
  const capacity = input.capacity ?? 50_000;
  if (!Number.isSafeInteger(capacity) || capacity < 1) refuse("product_capacity_invalid", "capacity");
  const effective = new Map<string, CatalogRetainedCombinationV2>();
  for (const fact of input.retained) {
    if (effective.has(fact.skuId)) refuseSkuId("duplicate_sku_id", fact.skuId);
    effective.set(fact.skuId, fact);
  }
  const changed = new Set<string>();
  for (const change of input.incoming) {
    if (changed.has(change.skuId)) refuseSkuId("duplicate_sku_id", change.skuId);
    changed.add(change.skuId);
    const retained = effective.get(change.skuId);
    const options = change.optionValues === undefined ? retained?.optionValues ?? null : change.optionValues;
    const identity = change.optionValues === undefined && retained ? retained.identity
      : options === null ? null : canonicalizeCatalogCombinationV2({ ...input, options });
    if (retained?.identity && (!identity
      || !Buffer.from(retained.identity.canonicalOptionBytes).equals(identity.canonicalOptionBytes)))
      refuseSkuId("sku_identity_change_requires_new_sku", change.skuId);
    effective.set(change.skuId, { skuId: change.skuId, state: change.state, optionValues: options, identity });
  }
  if (effective.size > capacity) refuse("product_capacity_exceeded", "skus");
  const occupied = new Map<string, CatalogCombinationIdentityV2>();
  for (const fact of effective.values()) {
    // Revalidate omitted active typed SKUs too: incremental writes cannot hide unmapped rows.
    if (input.typed && fact.state === "active") {
      if (!fact.optionValues || !fact.identity) return refuseSkuId("option_missing", fact.skuId);
      const identity = canonicalizeCatalogCombinationV2({ ...input, options: fact.optionValues });
      if (classifyCatalogCombinationConflictV2(identity, fact.identity) !== "duplicate")
        refuseSkuId("combination_identity_integrity_failed", fact.skuId);
    }
    if (fact.state !== "active" || !fact.identity) continue;
    const digest = Buffer.from(fact.identity.combinationDigest).toString("hex");
    const other = occupied.get(digest);
    if (other) refuseSkuId(classifyCatalogCombinationConflictV2(other, fact.identity) === "duplicate"
      ? "duplicate_combination" : "combination_identity_integrity_failed", fact.skuId);
    occupied.set(digest, fact.identity);
  }
  return [...effective.values()];
}
