import { catalogDefinitionMetadataSchema, catalogProductTypeIssues } from "./productTypeIssues.js";
import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { CatalogProductTypeInput } from "./contracts/productTypes.js";
/** Labels and callbacks are never definition identity. Runtime schemas bound the metadata. */
/** @experimental */
export function catalogDefinitionJson(definition: CatalogProductTypeInput): string {
  const issue = catalogProductTypeIssues([definition])[0];
  if (issue) throw Object.assign(new Error("invalid_catalog_type_definition"), { issue });
  function metadata(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(metadata);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key, child]) => key !== "labels" && child !== undefined).map(([key, child]) => [key, metadata(child)]));
  }
  const { validateContent: _callback, ...definitionMetadata } = definition;
  return canonicalCatalogDraftJson(metadata(catalogDefinitionMetadataSchema.parse(definitionMetadata)));
}

/** The same canonical metadata bytes are used by installation and registry checks.
 * @experimental
 */
export function catalogDefinitionDigest(definition: CatalogProductTypeInput): string {
  return createHash("sha256").update(catalogDefinitionJson(definition)).digest("hex");
}
