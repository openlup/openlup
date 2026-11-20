import { createHash } from "node:crypto";
import { canonicalizeCatalogQuantity, parseCatalogQuantity, type CatalogQuantityUnit } from "@openlup/core/catalog";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import type { CatalogOptionValue, CatalogProductTypeInput } from "./contracts/productTypes.js";
import type { CatalogCombinationCode, CatalogCombinationIdentityV2 } from "./contracts/variantAxes.js";
import { catalogDimensionKeySchema, catalogNamespacedKeySchema, catalogOptionValueSchema, catalogQuantityDimensionSchema } from "./productTypeSchemas.js";
import { z } from "./validation.js";

// Keep field closure; Core owns the V2 decimal grammar and canonical numeric bounds.
const quantityOptionV2Schema = z.object({
  kind: z.literal("quantity"),
  value: z.object({ dimension: catalogQuantityDimensionSchema, unit: catalogNamespacedKeySchema,
    unscaled: z.unknown(), scale: z.unknown() }).strict(),
}).strict();

type Refuse = (code: CatalogCombinationCode, path: string) => never;

export function combinationFindingPointer(parts: readonly PropertyKey[]): string {
  return parts.map(part => `/${String(part).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

export function selectCombinationAxes(
  definition: CatalogProductTypeInput, axes: readonly string[], path: (key: string, index: number) => string, refuse: Refuse,
): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const [index, key] of axes.entries()) {
    if (selected.has(key)) refuse("duplicate_axis", path(key, index));
    selected.add(key);
    if (!catalogDimensionKeySchema.safeParse(key).success || !definition.axes?.some(axis => axis.key === key))
      refuse("axis_not_installed", path(key, index));
  }
  return selected;
}

export function canonicalizeCombinationOptions(
  definition: CatalogProductTypeInput, selected: ReadonlySet<string>, options: Readonly<Record<string, CatalogOptionValue>>,
  path: (key?: string) => string, refuse: Refuse,
): CatalogCombinationIdentityV2 {
  if (!options || typeof options !== "object" || Array.isArray(options)) refuse("option_invalid", path());
  for (const key of Object.keys(options)) if (!selected.has(key)) refuse("option_not_selected", path(key));
  const entries = [...selected].sort().map(key => {
    if (!Object.hasOwn(options, key)) return refuse("option_missing", path(key));
    const value = options[key];
    const parsed = value?.kind === "quantity" ? quantityOptionV2Schema.safeParse(value) : catalogOptionValueSchema.safeParse(value);
    if (!parsed.success) return refuse("option_invalid", path(key));
    const option = parsed.data;
    const axis = definition.axes!.find(axis => axis.key === key)!;
    const attribute = definition.attributes?.find(attribute => attribute.key === axis.attributeKey);
    const dimension = definition.dimensions.find(dimension => dimension.key === key);
    if (!attribute || attribute.scope !== "variant" || !dimension || dimension.kind !== option.kind)
      return refuse("option_invalid", path(key));
    const valueType = attribute.valueType;
    if (option.kind === "choice" && dimension.kind === "choice" && valueType.kind === "enum"
      && dimension.values.includes(option.value) && valueType.values.some(value => value.id === option.value))
      return [key, "choice", option.value];
    if (option.kind === "boolean" && valueType.kind === "boolean") return [key, "boolean", option.value];
    if (option.kind !== "quantity" || dimension.kind !== "quantity" || valueType.kind !== "quantity"
      || dimension.dimension !== option.value.dimension || valueType.dimension !== option.value.dimension
      || !dimension.units.includes(option.value.unit) || !valueType.units.includes(option.value.unit))
      return refuse("option_invalid", path(key));
    const units: CatalogQuantityUnit[] = definition.units.filter(unit => unit.code === option.value.unit).map(unit => {
      if (!unit.factor) return refuse("unit_factor_missing", path(key));
      return { ...unit, factor: unit.factor };
    });
    const quantity = canonicalizeCatalogQuantity(parseCatalogQuantity(option.value, units), units);
    return [key, "quantity", quantity.dimension, quantity.unit, quantity.unscaled, quantity.scale];
  });
  const canonicalOptionBytes = Buffer.from(canonicalCatalogDraftJson(["catalog-combination", 2, entries]), "utf8");
  return { version: 2, canonicalOptionBytes, combinationDigest: createHash("sha256").update(canonicalOptionBytes).digest() };
}

/** Validate the draft's selected axes and complete SKU options at their own locations. */
export function validateDraftCombinations(
  definition: CatalogProductTypeInput, draft: Pick<CatalogDraftPayloadV2, "product" | "skus">, refuse: Refuse,
  jsonPointers = false,
): void {
  const axes = draft.product.dimensions;
  const selected = jsonPointers
    ? selectCombinationAxes(definition, axes, (_, index) => `/product/dimensions/${index}`, refuse)
    : undefined;
  const combinations = new Set<string>();
  for (const [index, sku] of draft.skus.entries()) {
    if (axes.some(key => !Object.hasOwn(sku.options, key))) continue;
    // The released validator checks axes only when it reaches a complete SKU.
    const skuAxes = selected ?? selectCombinationAxes(definition, axes, key => `skus.${index}.axes.${key}`, refuse);
    const path = jsonPointers ? `/skus/${index}/options` : `skus.${index}.options`;
    const identity = canonicalizeCombinationOptions(definition, skuAxes, sku.options,
      key => key === undefined ? path : path + (jsonPointers ? combinationFindingPointer([key]) : `.${key}`), refuse);
    const bytes = Buffer.from(identity.canonicalOptionBytes).toString("hex");
    if (combinations.has(bytes)) refuse("duplicate_combination", path);
    combinations.add(bytes);
  }
}
