import type { CatalogPublicationRulesModule } from "../../../src/catalog/publicationRules.js";
import type { categoryDocument } from "./categoryDocumentInput.js";
import { productDocumentV2Schema } from "./categoryDocument.js";

type Document = ReturnType<typeof categoryDocument> & { name: string };
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
function identifyDocument(value: unknown) {
  const { schemaVersion, id, productSlug, revisionNo, name } = value as Document;
  return { schemaId: schemaVersion, documentRef: id, productSlug, revisionNo, name };
}
function validateDocument(value: unknown) {
  const { name: _name, ...category } = value as Document;
  productDocumentV2Schema.parse(category);
}
const rules: CatalogPublicationRulesModule = {
  identifyDocument,
  inspectDocument(canonicalText) {
    const document: unknown = JSON.parse(canonicalText);
    validateDocument(document);
    return { ...identifyDocument(document), canonicallyEncoded: canonical(document) === canonicalText };
  },
  matchesDocument(value, canonicalText) {
    validateDocument(value);
    return canonical(value) === canonicalText;
  },
  validateContent: () => [],
  validateSkuAmounts: ({ netGrams }) => BigInt(netGrams) <= 9_999_999n,
  validateProduct: (_product, skus) => skus.some(sku => sku.isAddon) ? ["package_unsupported"] : [],
  deriveSkuFacts: () => ({ derived: 12 }),
  classifySkuChange: () => "compatible",
};
export default rules;
