import type { CatalogPublicationRulesModule } from "../../../src/catalog/catalogPublicationRules.js";
import type { categoryDocument } from "./categoryDocumentInput.js";
import { categoryDocumentSchema } from "./categoryDocument.js";

type Document = ReturnType<typeof categoryDocument> & { name: string };
const canonical = (value: unknown) => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry);
function identifyDocument(value: unknown) {
  const { schemaVersion, id, productSlug, revisionNo, name } = value as Document;
  return { schemaId: schemaVersion, documentRef: id, productSlug, revisionNo, name };
}
const rules: CatalogPublicationRulesModule = {
  identifyDocument,
  inspectDocument(canonicalText) {
    const document: unknown = JSON.parse(canonicalText);
    if (!categoryDocumentSchema.safeParse(document).success) return null;
    return { ...identifyDocument(document), canonicallyEncoded: canonical(document) === canonicalText };
  },
  matchesDocument(value, canonicalText) {
    return categoryDocumentSchema.safeParse(value).success && canonical(value) === canonicalText;
  },
  validateContent: () => [],
  validateSkuAmounts: ({ netGrams }) => BigInt(netGrams) <= 9_999_999n,
  validateProduct: (_product, skus) => skus.some(sku => sku.isAddon) ? ["package_unsupported"] : [],
  deriveSkuFacts: () => ({ derived: 12 }),
  classifySkuChange: () => "compatible",
};
export default rules;
