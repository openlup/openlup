import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "../../../src/catalog/contracts/draft.js";
import type { CatalogDraftPayloadV3 } from "../../../src/catalog/contracts/draftV3.js";
import { createCatalogProductTypeRegistry } from "../../../src/catalog/productTypeSchemas.js";
import type { CatalogPublicationCompileInput, CatalogPublicationRules } from "../../../src/catalog/publicationValidation.js";

const productId = "10000000-0000-4000-8000-000000000001", skuId = "20000000-0000-4000-8000-000000000001";
const draftId = "30000000-0000-4000-8000-000000000001", documentId = "40000000-0000-4000-8000-000000000001";
export const registry = createCatalogProductTypeRegistry([{ key: "example:article", version: 1,
  units: [{ code: "openlup:g", dimension: "mass", integral: false }, { code: "openlup:kg", dimension: "mass", integral: false }],
  netContentUnits: ["openlup:g"], dimensions: [], axes: [], validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] }]);
export const definition = registry.resolve({ key: "example:article", version: 1 })!;
export const rules: CatalogPublicationRules = { canonicalizeDocument: canonicalCatalogDraftJson,
  identifyDocument(document) {
    const { schemaVersion, id, productSlug, revisionNo, name } = document as { schemaVersion: number; id: string; productSlug: string; revisionNo: number; name: string };
    return { schemaId: `example:document.v${schemaVersion}`, documentRef: id, productSlug, revisionNo, name };
  }, inspectDocument(canonicalText) {
    const document = JSON.parse(canonicalText);
    return { ...this.identifyDocument(document), canonicallyEncoded: this.canonicalizeDocument(document) === canonicalText,
      contentDigest: createHash("sha256").update(canonicalCatalogDraftJson(document)).digest("hex") };
  }, deriveSkuFacts: canonicalText => ({ derived: JSON.parse(canonicalText).derived }),
  validateProduct: () => [], classifySkuChange: () => "compatible" };
export function input(): CatalogPublicationCompileInput {
  const document = { schemaVersion: 1, id: "example:document", productSlug: "article", revisionNo: 1, name: "Synthetic article", derived: 12 }, canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex");
  const facts = { skuCode: "ARTICLE", title: "Synthetic article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  const payload: CatalogDraftPayloadV3 = { schemaVersion: 3, product: { id: productId, type: { key: definition.key, version: 1 }, dimensions: [], slug: "article", primarySkuId: skuId,
    documentRevision: { id: documentId, productId, revisionNo: 1, schemaId: "example:document.v1", documentRef: "example:document", sourceRef: "example:source", digest },
    sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: {}, publicationSkus: [facts], requestedModes: [{ skuCode: "ARTICLE", modes: [] }], offerMemberships: [] } },
    skus: [{ id: skuId, productId, code: "ARTICLE", options: {}, netContent: { dimension: "mass", unit: "openlup:g", unscaled: "100", scale: 0 },
      identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit" }] }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId, productSlug: "article", name: "Synthetic article" },
      { op: "register_document_revision", productSlug: "article", revisionId: documentId, revisionNo: 1, documentRef: "example:document", sourceRef: "example:source", canonicalText, digest, provenance: { source: "current_draft" } },
      { op: "move_document_pointer", productSlug: "article", documentRevisionNo: 1 },
      { op: "create_sku", productSlug: "article", documentRevisionNo: 1, skuId, ...facts },
      { op: "create_identifier", skuCode: "ARTICLE", scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_primary_sku", productSlug: "article", skuCode: "ARTICLE" },
      { op: "set_product_presentation", productSlug: "article", presentation: {} },
    ] } };
  return { payload, record: { draftId, productId, revision: 1, status: "open", commandKey: "draft:first", fingerprint: "b".repeat(64),
    actorId: "operator:synthetic", createdAt: "2026-01-01T00:00:00Z", payload }, definition, product: null, skus: [], documents: [], retainedSources: [], rules };
}
