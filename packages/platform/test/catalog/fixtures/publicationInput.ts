import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "../../../src/catalog/contracts/draft.js";
import type { CatalogDraftPayloadV3 } from "../../../src/catalog/contracts/draftV3.js";
import { createCatalogProductTypeRegistry } from "../../../src/catalog/productTypeSchemas.js";
import { catalogPublicationClaim, compileCatalogPublication, type CatalogPublicationCompileInput } from "../../../src/catalog/publicationValidation.js";
import type { CatalogPublicationEvidence } from "../../../src/catalog/publicationEvidence.js";
import { loadCatalogPublicationRules } from "../../../src/catalog/publicationRules.js";
import { catalogDefinitionDigest } from "../../../src/catalog/catalogDefinitionDigest.js";

const productId = "10000000-0000-4000-8000-000000000001", skuId = "20000000-0000-4000-8000-000000000001";
const draftId = "30000000-0000-4000-8000-000000000001", documentId = "40000000-0000-4000-8000-000000000001";
export const artifact = `
const wire = value => JSON.stringify(value, (_key, entry) => entry && typeof entry === "object" && !Array.isArray(entry)
  ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : entry);
module.exports = {
  validateContent: () => [],
  validateProduct: () => [],
  validateMembershipChange: (_sku, change) => change.offerVersion !== "example:frozen",
  identifyDocument(document) {
    const { schemaVersion, id, productSlug, revisionNo, name } = document;
    return { schemaId: "example:document.v" + schemaVersion, documentRef: id, productSlug, revisionNo, name };
  },
  inspectDocument(canonicalText) {
    const document = JSON.parse(canonicalText);
    return { ...this.identifyDocument(document), canonicallyEncoded: wire(document) === canonicalText };
  },
  matchesDocument: (document, canonicalText) => wire(document) === canonicalText,
  deriveSkuFacts: canonicalText => ({ derived: JSON.parse(canonicalText).derived }),
  classifySkuChange: () => "compatible",
};`;
export function setupRules(source: string | Uint8Array = artifact) {
  const bytes = typeof source === "string" ? Buffer.from(source) : source;
  const validatorRef = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const rules = loadCatalogPublicationRules(validatorRef, bytes);
  const registry = createCatalogProductTypeRegistry([{ key: "example:article", version: 1,
    units: [{ code: "openlup:g", dimension: "mass", integral: false }, { code: "openlup:kg", dimension: "mass", integral: false }],
    netContentUnits: ["openlup:g"], dimensions: [], axes: [], validatorRef,
    validateContent: () => [{ path: "", code: "legacy_validator_must_not_run" }] }]);
  const definition = registry.resolve({ key: "example:article", version: 1 })!;
  return { rules, registry, definition, installedDefinitionDigest: catalogDefinitionDigest(definition) };
}
const prepared = setupRules();

export type PublicationFixture = CatalogPublicationCompileInput & {
  payload: CatalogDraftPayloadV3;
  registry: typeof prepared.registry;
  record: CatalogPublicationCompileInput["record"] & { payload: CatalogDraftPayloadV3 };
  evidence: CatalogPublicationEvidence & { drafts: CatalogPublicationEvidence["drafts"][number][] };
};

export function input(): PublicationFixture {
  const document = { schemaVersion: 1, id: "example:document", productSlug: "article", revisionNo: 1, name: "Synthetic article", derived: 12 }, canonicalText = canonicalCatalogDraftJson(document), digest = createHash("sha256").update(canonicalText).digest("hex");
  const facts = { skuCode: "ARTICLE", title: "Synthetic article", minQuantity: 1, isAddon: false, facts: { derived: 12 } };
  const payload: CatalogDraftPayloadV3 = { schemaVersion: 3, product: { id: productId, type: { key: prepared.definition.key, version: 1 }, dimensions: [], slug: "article", primarySkuId: skuId,
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
  const record = { draftId, productId, revision: 1, status: "open" as const, commandKey: "draft:first", fingerprint: "b".repeat(64),
    actorId: "operator:synthetic", createdAt: "2026-01-01T00:00:00Z", payload };
  return { payload, record, expectedHead: null, ...prepared,
    evidence: { head: null, product: null, skus: [], documents: [], documentRevisionHighWater: 0,
      drafts: [{ record, receipt: catalogPublicationClaim(record), head: recordHead(record) }] },
    observations: { presentationReadiness: async () => ({ ready: true, reasons: [] }) } };
}

export function recordHead({ draftId, productId, revision, status }: CatalogPublicationEvidence["drafts"][number]["record"]) {
  return { draftId, productId, revision, status };
}
export async function revision(): Promise<PublicationFixture> {
  const initial = input();
  const retained = await compileCatalogPublication(initial);
  const payload = structuredClone(initial.payload);
  delete payload.product.primarySkuId;
  payload.product.sharedContent = { schemaVersion: 1, catalogAction: "revise", presentation: { title: "Updated" },
    offerMemberships: [], requestedModes: [], publicationSkus: [] };
  payload.skus = [];
  payload.publication.operations = [{ op: "set_product_presentation", productSlug: "article", presentation: { title: "Updated" } }];
  const record = { ...initial.record, revision: 2, commandKey: "draft:second", fingerprint: "c".repeat(64), payload };
  const head = { publicationId: "50000000-0000-4000-8000-000000000001", revision: 1, documentDigest: retained.product.document!.digest };
  const evidence = { head, product: retained.product, skus: retained.skus, documents: retained.documents, documentRevisionHighWater: 1,
    drafts: [{ record, receipt: catalogPublicationClaim(record), head: recordHead(record) }] };
  return { ...initial, payload, record, evidence, expectedHead: head };
}
