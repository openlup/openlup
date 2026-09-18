import { z } from "../../lib/validation/zod.js";

export const catalogNamespacedKeySchema = z.string().max(120).regex(/^[a-z][a-z0-9.-]*:[a-z][a-z0-9._-]*$/u);
export const catalogDimensionKeySchema = z.string().max(64).regex(/^[a-z][a-z0-9_-]*$/u)
  .refine((key) => !["__proto__", "constructor", "prototype"].includes(key));
export const catalogQuantityDimensionSchema = z.enum(["mass", "volume", "count"]);
export const catalogQuantitySchema = z.object({
  dimension: catalogQuantityDimensionSchema,
  unscaled: z.string().regex(/^[1-9][0-9]{0,39}$/u),
  scale: z.number().int().min(0).max(12),
  unit: catalogNamespacedKeySchema,
}).strict();
export const catalogOptionValueSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), value: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal("quantity"), value: catalogQuantitySchema }).strict(),
  z.object({ kind: z.literal("boolean"), value: z.boolean() }).strict(),
]);
export const catalogProductTypeRefSchema = z.object({
  key: catalogNamespacedKeySchema,
  version: z.number().int().positive().max(2_147_483_647),
}).strict();
const unitSchema = z.object({
  code: catalogNamespacedKeySchema,
  dimension: catalogQuantityDimensionSchema,
  integral: z.boolean(),
}).strict();
const dimensionSchema = z.discriminatedUnion("kind", [
  z.object({ key: catalogDimensionKeySchema, kind: z.literal("choice"), values: z.array(z.string().min(1).max(120)).min(1).max(1000) }).strict(),
  z.object({ key: catalogDimensionKeySchema, kind: z.literal("quantity"), dimension: catalogQuantityDimensionSchema, units: z.array(catalogNamespacedKeySchema).min(1).max(32) }).strict(),
  z.object({ key: catalogDimensionKeySchema, kind: z.literal("boolean") }).strict(),
]);
const definitionSchema = catalogProductTypeRefSchema.extend({
  units: z.array(unitSchema).max(64),
  netContentUnits: z.array(catalogNamespacedKeySchema).min(1).max(64),
  dimensions: z.array(dimensionSchema).max(16),
}).strict();
export type CatalogQuantity = z.infer<typeof catalogQuantitySchema>;
export type CatalogOptionValue = z.infer<typeof catalogOptionValueSchema>;
export type CatalogDraftIssue = { path: string; code: string };
export type CatalogProductTypeDefinition = z.infer<typeof definitionSchema> & {
  validateContent: (content: unknown) => readonly CatalogDraftIssue[];
};
export interface CatalogProductTypeRegistry {
  resolve(ref: z.infer<typeof catalogProductTypeRefSchema>): CatalogProductTypeDefinition | undefined;
}

/** Definitions are installed by composition, never supplied as executable draft data. */
export function createCatalogProductTypeRegistry(definitions: readonly CatalogProductTypeDefinition[]): CatalogProductTypeRegistry {
  const installed = new Map<string, CatalogProductTypeDefinition>();
  for (const definition of definitions) {
    const { validateContent, ...metadata } = definition;
    const parsed = definitionSchema.parse(metadata);
    const units = new Map(parsed.units.map((unit) => [unit.code, unit]));
    const identity = `${parsed.key}@${parsed.version}`;
    if (typeof validateContent !== "function" || installed.has(identity)
      || units.size !== parsed.units.length
      || new Set(parsed.dimensions.map(({ key }) => key)).size !== parsed.dimensions.length
      || new Set(parsed.netContentUnits).size !== parsed.netContentUnits.length
      || parsed.netContentUnits.some((code) => !units.has(code))) throw new Error("invalid_catalog_type_definition");
    for (const dimension of parsed.dimensions) {
      if (dimension.kind === "choice" && new Set(dimension.values).size !== dimension.values.length) throw new Error("invalid_catalog_type_definition");
      if (dimension.kind === "quantity" && (new Set(dimension.units).size !== dimension.units.length
        || dimension.units.some((code) => units.get(code)?.dimension !== dimension.dimension))) throw new Error("invalid_catalog_type_definition");
    }
    function freeze(value: object): void {
      for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
      Object.freeze(value);
    }
    freeze(parsed);
    installed.set(identity, Object.freeze({ ...parsed, validateContent }));
  }
  return Object.freeze({ resolve: (ref: z.infer<typeof catalogProductTypeRefSchema>) => installed.get(`${ref.key}@${ref.version}`) });
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
