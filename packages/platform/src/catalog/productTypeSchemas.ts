import type { CatalogProductTypeDefinition, CatalogProductTypeInput, CatalogProductTypeRegistry } from "./contracts/productTypes.js";
import { catalogDefinitionMetadataSchema, catalogProductTypeIssues } from "./productTypeIssues.js";
export { catalogNamespacedKeySchema, catalogDimensionKeySchema, catalogQuantityDimensionSchema, catalogQuantitySchema, catalogOptionValueSchema, catalogProductTypeRefSchema, catalogProductTypeIssues } from "./productTypeIssues.js";
export { canonicalCatalogOption, validateCatalogQuantity } from "./contracts/productTypes.js";
export type { CatalogQuantity, CatalogOptionValue, CatalogDraftIssue, CatalogProductTypeDefinition, CatalogProductTypeRegistry } from "./contracts/productTypes.js";

/** Definitions are installed by composition, never supplied as executable draft data. */
export function createCatalogProductTypeRegistry(definitions: readonly CatalogProductTypeInput[]): CatalogProductTypeRegistry {
  const issue = catalogProductTypeIssues(definitions)[0];
  if (issue) throw Object.assign(new Error("invalid_catalog_type_definition"), { code: "invalid_catalog_type_definition", issue });
  const installed = new Map<string, CatalogProductTypeDefinition>();
  for (const definition of definitions) {
    const { validateContent, ...metadata } = definition;
    const parsed = catalogDefinitionMetadataSchema.parse(metadata);
    function freeze(value: object): void {
      for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
      Object.freeze(value);
    }
    freeze(parsed);
    installed.set(`${parsed.key}@${parsed.version}`, Object.freeze({ ...parsed, validateContent }));
  }
  return Object.freeze({ resolve: (ref: { key: string; version: number }) => installed.get(`${ref.key}@${ref.version}`) });
}
