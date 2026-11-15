import { createHash } from "node:crypto";
import { canonicalizeCatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { CatalogOptionValue, CatalogProductTypeInput } from "./contracts/productTypes.js";
import type { CatalogCombinationChangeV2, CatalogCombinationCode, CatalogCombinationIdentityV2,
  CatalogRetainedCombinationV2 } from "./contracts/variantAxes.js";
import { catalogDimensionKeySchema, catalogOptionValueSchema } from "./productTypeSchemas.js";

export class CatalogCombinationError extends Error {
  constructor(readonly code: CatalogCombinationCode, readonly path: string) {
    super(code); this.name = "CatalogCombinationError";
  }
}
const refuse = (code: CatalogCombinationCode, path: string): never => { throw new CatalogCombinationError(code, path); };

/** Installed definition metadata and selected axes must be rebound by LC2 inside its transaction. */
export function canonicalizeCatalogCombinationV2(input: {
  definition: CatalogProductTypeInput;
  axes: readonly string[];
  options: Readonly<Record<string, CatalogOptionValue>>;
}): CatalogCombinationIdentityV2 {
  const { definition, axes, options } = input;
  const selected = new Set<string>();
  for (const key of axes) {
    if (selected.has(key)) refuse("duplicate_axis", `axes.${key}`);
    selected.add(key);
    if (!catalogDimensionKeySchema.safeParse(key).success || !definition.axes?.some(axis => axis.key === key))
      refuse("axis_not_installed", `axes.${key}`);
  }
  if (!options || typeof options !== "object" || Array.isArray(options)) refuse("option_invalid", "options");
  for (const key of Object.keys(options)) if (!selected.has(key)) refuse("option_not_selected", `options.${key}`);
  const entries = [...selected].sort().map(key => {
    if (!Object.hasOwn(options, key)) return refuse("option_missing", `options.${key}`);
    const parsed = catalogOptionValueSchema.safeParse(options[key]);
    if (!parsed.success) return refuse("option_invalid", `options.${key}`);
    const option = parsed.data;
    const axis = definition.axes!.find(axis => axis.key === key)!;
    const attribute = definition.attributes?.find(attribute => attribute.key === axis.attributeKey);
    const dimension = definition.dimensions.find(dimension => dimension.key === key);
    if (!attribute || attribute.scope !== "variant" || !dimension || dimension.kind !== option.kind)
      return refuse("option_invalid", `options.${key}`);
    const valueType = attribute.valueType;
    if (option.kind === "choice" && dimension.kind === "choice" && valueType.kind === "enum"
      && dimension.values.includes(option.value) && valueType.values.some(value => value.id === option.value))
      return [key, "choice", option.value];
    if (option.kind === "boolean" && valueType.kind === "boolean") return [key, "boolean", option.value];
    if (option.kind !== "quantity" || dimension.kind !== "quantity" || valueType.kind !== "quantity"
      || dimension.dimension !== option.value.dimension || valueType.dimension !== option.value.dimension
      || !dimension.units.includes(option.value.unit) || !valueType.units.includes(option.value.unit))
      return refuse("option_invalid", `options.${key}`);
    const units: CatalogQuantityUnit[] = definition.units.filter(unit => unit.code === option.value.unit).map(unit => {
      if (!unit.factor) return refuse("unit_factor_missing", `options.${key}`);
      return { ...unit, factor: unit.factor };
    });
    const quantity = canonicalizeCatalogQuantity(option.value, units);
    return [key, "quantity", quantity.dimension, quantity.unit, quantity.unscaled, quantity.scale];
  });
  const canonicalOptionBytes = Buffer.from(canonicalCatalogDraftJson(["catalog-combination", 2, entries]), "utf8");
  return { version: 2, canonicalOptionBytes, combinationDigest: createHash("sha256").update(canonicalOptionBytes).digest() };
}

/** Compare authoritative bytes after a digest conflict; a collision never merges identities. */
export function classifyCatalogCombinationConflictV2(left: CatalogCombinationIdentityV2, right: CatalogCombinationIdentityV2):
  "distinct" | "duplicate" | "collision" {
  if (!Buffer.from(left.combinationDigest).equals(right.combinationDigest)) return "distinct";
  return Buffer.from(left.canonicalOptionBytes).equals(right.canonicalOptionBytes) ? "duplicate" : "collision";
}

/** Pure LC2 preparation, without locks, persistence, publication authority or capacity configuration. */
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
    if (effective.has(fact.skuId)) refuse("duplicate_sku_id", fact.skuId);
    effective.set(fact.skuId, fact);
  }
  const changed = new Set<string>();
  for (const change of input.incoming) {
    if (changed.has(change.skuId)) refuse("duplicate_sku_id", change.skuId);
    changed.add(change.skuId);
    const retained = effective.get(change.skuId);
    const options = change.optionValues === undefined ? retained?.optionValues ?? null : change.optionValues;
    const identity = change.optionValues === undefined && retained ? retained.identity
      : options === null ? null : canonicalizeCatalogCombinationV2({ ...input, options });
    if (retained?.identity && (!identity
      || !Buffer.from(retained.identity.canonicalOptionBytes).equals(identity.canonicalOptionBytes)))
      refuse("sku_identity_change_requires_new_sku", change.skuId);
    effective.set(change.skuId, { skuId: change.skuId, state: change.state, optionValues: options, identity });
  }
  if (effective.size > capacity) refuse("product_capacity_exceeded", "skus");
  const occupied = new Map<string, CatalogCombinationIdentityV2>();
  for (const fact of effective.values()) {
    // Revalidate omitted active typed SKUs too: incremental writes cannot hide unmapped rows.
    if (input.typed && fact.state === "active") {
      if (!fact.optionValues || !fact.identity) return refuse("option_missing", fact.skuId);
      const identity = canonicalizeCatalogCombinationV2({ ...input, options: fact.optionValues });
      if (classifyCatalogCombinationConflictV2(identity, fact.identity) !== "duplicate")
        refuse("sku_identity_change_requires_new_sku", fact.skuId);
    }
    if (fact.state !== "active" || !fact.identity) continue;
    const digest = Buffer.from(fact.identity.combinationDigest).toString("hex");
    const other = occupied.get(digest);
    if (other) refuse(classifyCatalogCombinationConflictV2(other, fact.identity) === "duplicate"
      ? "duplicate_combination" : "combination_digest_collision", fact.skuId);
    occupied.set(digest, fact.identity);
  }
  return [...effective.values()];
}
