import { catalogDefinitionMetadataSchema, catalogProductTypeIssues } from "./productTypeIssues.js";
import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import type { CatalogProductTypeInput } from "./contracts/productTypes.js";
/** Labels and callbacks are never definition identity. Runtime schemas bound the metadata. */
export function catalogDefinitionDigest(definition: CatalogProductTypeInput): string {
  const issue = catalogProductTypeIssues([definition])[0];
  if (issue) throw Object.assign(new Error("invalid_catalog_type_definition"), { issue });
  function metadata(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(metadata);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key, child]) => key !== "labels" && child !== undefined).map(([key, child]) => [key, metadata(child)]));
  }
  const { validateContent: _callback, ...definitionMetadata } = definition;
  return createHash("sha256").update(canonicalCatalogDraftJson(metadata(catalogDefinitionMetadataSchema.parse(definitionMetadata)))).digest("hex");
}
