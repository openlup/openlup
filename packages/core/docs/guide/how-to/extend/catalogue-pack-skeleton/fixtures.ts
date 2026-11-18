import { createHash } from "node:crypto";
import type {
  CatalogDraftPayloadV3, CatalogDraftPayloadV4, CatalogDraftPayloadV5,
} from "@openlup/platform/catalog";
import type { CatalogConformanceSource } from "@openlup/platform/catalog/testing";
import { pack } from "./pack.ts";

const type = { key: pack.types[0].key, version: pack.types[0].version };
const productId = "00000000-0000-4000-8000-000000000001";
const skuId = "00000000-0000-4000-8000-000000000002";
const document = { title: "Notebook" };
const canonicalText = JSON.stringify(document);
const documentRevision = {
  id: "00000000-0000-4000-8000-000000000003", productId, revisionNo: 1,
  schemaId: "stationery:document", documentRef: "stationery:notebook/1", sourceRef: "fixture:notebook",
  digest: createHash("sha256").update(canonicalText).digest("hex"),
};
const count = { dimension: "count", unit: "stationery:each", unscaled: "1", scale: 0 } as const;
const mass = { dimension: "mass", unit: "stationery:gram", unscaled: "220", scale: 0 } as const;
const options = { lined: { kind: "boolean", value: true } } as const;

export const draft = {
  schemaVersion: 3,
  product: { id: productId, type, slug: "notebook", dimensions: ["lined"], primarySkuId: skuId, documentRevision,
    sharedContent: { schemaVersion: 1, catalogAction: "create", document, presentation: {},
      offerMemberships: [], requestedModes: [], publicationSkus: [] } },
  skus: [{ id: skuId, productId, code: "NOTEBOOK", options, attributes: { lined: true }, netContent: count, grossMass: mass,
    priceOperations: [{ schemaVersion: 1, commandKey: "fixture-price", variantId: skuId,
      priceListId: "00000000-0000-4000-8000-000000000004", mode: "one_time", minQty: 1, amountKind: "gross",
      unitPriceMinor: 399, expected: { entryId: null, unitPriceMinor: null } }] }],
  publication: { kind: "release", evidence: {}, operations: [
    { op: "create_product", productId, productSlug: "notebook", name: "Notebook" },
    { op: "register_document_revision", productSlug: "notebook", revisionId: documentRevision.id,
      revisionNo: documentRevision.revisionNo, documentRef: documentRevision.documentRef, sourceRef: documentRevision.sourceRef,
      canonicalText, digest: documentRevision.digest, provenance: { source: "current_draft" } },
  ] },
} satisfies CatalogDraftPayloadV3;
const draftV4: CatalogDraftPayloadV4 = { ...draft, schemaVersion: 4 };
const draftV5: CatalogDraftPayloadV5 = { ...draftV4, schemaVersion: 5 };

export const fixtures = {
  drafts: [draft, draftV4, draftV5],
  quantities: [{ type, value: count }, { type, value: mass, targetUnit: "stationery:gram" }],
  attributes: [{ type, input: { skus: [{ id: skuId, attributes: { lined: true } }] }, publicationRevision: "1" }],
  combinations: [{ type, input: { axes: ["lined"], typed: true, retained: [],
    incoming: [{ skuId, state: "active", optionValues: options }] } }],
  profileChecks: [{ cadenceDays: 120, lines: [{ id: skuId, type, quantity: 1 }] }],
  refusals: [{ name: "prepaid selection", capability: "prepaid",
    expectedCode: "prepaid_unsupported", observedCode: "prepaid_unsupported", zeroEffects: true }],
} satisfies Omit<CatalogConformanceSource["packs"][number], "pack">;
