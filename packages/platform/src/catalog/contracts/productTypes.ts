import type { CatalogQuantity, CatalogQuantityDimension, CatalogUnitFactor } from "@openlup/core/catalog";
import type { AttributeDefinition, CatalogAxisDefinition } from "./attributes.js";
export type { CatalogQuantity, CatalogQuantityDimension } from "@openlup/core/catalog";
export type CatalogOptionValue =
  | { kind: "choice"; value: string }
  | { kind: "quantity"; value: CatalogQuantity }
  | { kind: "boolean"; value: boolean };
export type CatalogDraftIssue = { path: string; code: string };
export interface CatalogProductTypeRef { key: string; version: number }
export interface CatalogProductTypeDefinition extends CatalogProductTypeRef {
  units: { code: string; dimension: CatalogQuantityDimension; integral: boolean;
    /** @experimental */
    factor?: CatalogUnitFactor }[];
  netContentUnits: string[];
  dimensions: (
    | { key: string; kind: "choice"; values: string[] }
    | { key: string; kind: "quantity"; dimension: CatalogQuantityDimension; units: string[]; role?: "net_content" }
    | { key: string; kind: "boolean" }
  )[];
  /** @experimental */
  attributes?: readonly AttributeDefinition[];
  /** @experimental */
  axes?: readonly CatalogAxisDefinition[];
  /** @experimental */
  validatorRef?: string;
  /** @experimental */
  subscriptionProfileRef?: CatalogProductTypeRef;
  /** @experimental */
  taxClass?: string;
  /** @experimental */
  labels?: Readonly<Record<string, string>>;
  validateContent: (content: unknown) => readonly CatalogDraftIssue[];
}
/** Readonly authoring counterpart; the existing mutable definition API stays compatible. */
/** @experimental */
export type CatalogProductTypeInput = Omit<CatalogProductTypeDefinition, "units" | "netContentUnits" | "dimensions"> & {
  units: readonly CatalogProductTypeDefinition["units"][number][];
  netContentUnits: readonly string[];
  dimensions: readonly (
    | { key: string; kind: "choice"; values: readonly string[] }
    | { key: string; kind: "quantity"; dimension: CatalogQuantityDimension; units: readonly string[]; role?: "net_content" }
    | { key: string; kind: "boolean" }
  )[];
};
/** @experimental */
export interface CatalogTypeDefinitionV2 extends Omit<CatalogProductTypeInput, "validateContent"> {
  validatorRef: string;
  attributes: readonly AttributeDefinition[];
}
export interface CatalogProductTypeRegistry {
  resolve(ref: CatalogProductTypeRef): CatalogProductTypeDefinition | undefined;
}

export function validateCatalogQuantity(quantity: CatalogQuantity, definition: CatalogProductTypeDefinition): boolean {
  const unit = definition.units.find(({ code }) => code === quantity.unit);
  return !!unit && unit.dimension === quantity.dimension
    && (!unit.integral || BigInt(quantity.unscaled) % (10n ** BigInt(quantity.scale)) === 0n);
}

/** Decimal spelling cannot make two equal option values distinct. No unit conversion is inferred. */
export function canonicalCatalogOption(value: CatalogOptionValue): string {
  if (value.kind !== "quantity") return JSON.stringify(value);
  let { unscaled, scale } = value.value;
  while (scale > 0 && unscaled.endsWith("0")) { unscaled = unscaled.slice(0, -1); scale -= 1; }
  return JSON.stringify(["quantity", value.value.dimension, value.value.unit, unscaled, scale]);
}
