import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";
import { catalogDraftPayloadSchema } from "../../src/catalog/draftSchemas.js";
import { catalogDraftPayloadV2Schema } from "../../src/catalog/draftV2Schemas.js";
import { catalogDraftPayloadV3Schema, catalogDraftPublicationStoredPayloadSchema, extractCatalogDraftPublicationInputs, resolveCatalogDraftProvenance } from "../../src/catalog/draftV3Schemas.js";
import { createCatalogCandidateService } from "../../src/catalog/candidate.js";
import { createCatalogProductTypeRegistry } from "../../src/catalog/productTypeSchemas.js";
import { catalogDefinitionDigest } from "../../src/catalog/catalogDefinitionDigest.js";
import type { CatalogDraftPayloadV3, CatalogDraftPublicationStoredRecord } from "../../src/catalog/contracts/draftV3.js";

const productId = "10000000-0000-4000-8000-000000000001", skuId = "20000000-0000-4000-8000-000000000001";
const draftId = "30000000-0000-4000-8000-000000000001", documentId = "40000000-0000-4000-8000-000000000001";
const definition = { key: "example:article", version: 1, units: [{ code: "openlup:g", dimension: "mass" as const, integral: false }],
  netContentUnits: ["openlup:g"], dimensions: [], validatorRef: `sha256:${"a".repeat(64)}`, validateContent: () => [] };
const netContent = { dimension: "mass" as const, unit: "openlup:g", unscaled: "100", scale: 0 };
function payload(): CatalogDraftPayloadV3 {
  return { schemaVersion: 3, product: { id: productId, type: { key: definition.key, version: 1 }, dimensions: [], slug: "article", primarySkuId: skuId,
    sharedContent: { schemaVersion: 1, catalogAction: "create", document: { names: { en: "Synthetic é" } }, presentation: { routePath: { en: "/article" } },
      offerMemberships: [{ skuCode: "ARTICLE", offerVersion: "example:offer", admitted: false }], requestedModes: [{ skuCode: "ARTICLE", modes: [] }],
      publicationSkus: [{ skuCode: "ARTICLE", title: "Synthetic", minQuantity: 1, isAddon: false, facts: { example: true } }] } },
    skus: [{ id: skuId, productId, code: "ARTICLE", options: {}, netContent,
      priceOperations: [{ schemaVersion: 1, commandKey: "price:first", variantId: skuId, priceListId: documentId, mode: "one_time", minQty: 1,
        amountKind: "gross", unitPriceMinor: 1200, expected: { entryId: null, unitPriceMinor: null } }] }],
    publication: { kind: "release", evidence: {}, operations: [
      { op: "create_product", productId, productSlug: "article", name: "Synthetic" },
      { op: "register_document_revision", productSlug: "article", revisionId: documentId, revisionNo: 1,
        documentRef: "example:document", sourceRef: "example:source", canonicalText: "{}", digest: "a".repeat(64), provenance: { source: "current_draft" } },
      { op: "create_sku", skuId, productSlug: "article", documentRevisionNo: 1, ...{ skuCode: "ARTICLE", title: "Synthetic", minQuantity: 1, isAddon: false, facts: {} } },
      { op: "create_identifier", skuCode: "ARTICLE", scheme: "gs1:gtin", issuer: "example", value: "5901234123457", packagingLevel: "unit", quantity: 1, isPrimary: true, label: null, sourceRef: null },
      { op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: false, sellableInSubscription: false },
      { op: "set_derived_sku_facts", skuCode: "OMITTED", documentRevisionNo: 1, netContent, facts: { derived: 10 } },
      { op: "set_derived_sku_facts", skuCode: "OMITTED", documentRevisionNo: 1, netContent, facts: { derived: 11 } },
    ] } };
}
const record = (data: CatalogDraftPayloadV3): CatalogDraftPublicationStoredRecord => ({ draftId, productId, revision: 1, status: "open", commandKey: "draft:first",
  fingerprint: "b".repeat(64), actorId: "operator:synthetic", createdAt: "2026-01-01T00:00:00Z", payload: data });
it("catalog_draft_v3_schema_and_canonical_bytes", () => {
  const data = payload(), text = canonicalCatalogDraftJson(data);
  expect(canonicalCatalogDraftJson(catalogDraftPayloadV3Schema.parse(JSON.parse(text)))).toBe(text);
  expect(extractCatalogDraftPublicationInputs(data)).toEqual({ content: data.product.sharedContent, publication: data.publication });
  expect(extractCatalogDraftPublicationInputs(data).publication.operations.slice(-2)).toEqual(data.publication.operations.slice(-2));
  expect(catalogDraftPublicationStoredPayloadSchema.safeParse({ ...data, schemaVersion: 4 }).success).toBe(false);
  expect(() => extractCatalogDraftPublicationInputs({ ...data, publication: { ...data.publication, extra: true } })).toThrow();
  expect(() => extractCatalogDraftPublicationInputs({ ...data, product: { ...data.product, sharedContent: { ...data.product.sharedContent, extra: true } } })).toThrow();
  const cycle: Record<string, unknown> = {}; cycle.loop = cycle;
  expect(() => extractCatalogDraftPublicationInputs(cycle)).toThrow();
  const unsafe = payload(); Object.defineProperty(unsafe.product.sharedContent, "document", { get: () => { throw new Error("must not run"); } });
  expect(() => extractCatalogDraftPublicationInputs(unsafe)).toThrow("draft_json_invalid");
});
it("catalog_draft_v3_preserves_v1_and_v2_bytes", () => {
  const { publication: _publication, ...base } = payload();
  const v2 = { ...base, schemaVersion: 2 as const }, v1 = { ...base, schemaVersion: 1 as const, skus: base.skus.map(({ priceOperations: _prices, ...sku }) => ({ ...sku, priceRef: "example:price" })) };
  for (const [value, schema] of [[v1, catalogDraftPayloadSchema], [v2, catalogDraftPayloadV2Schema]] as const) {
    const bytes = canonicalCatalogDraftJson(value), fingerprint = createHash("sha256").update(bytes).digest("hex");
    expect(canonicalCatalogDraftJson(schema.parse(value))).toBe(bytes);
    expect(canonicalCatalogDraftJson(catalogDraftPublicationStoredPayloadSchema.parse(value))).toBe(bytes);
    expect(createHash("sha256").update(canonicalCatalogDraftJson(catalogDraftPublicationStoredPayloadSchema.parse(value))).digest("hex")).toBe(fingerprint);
    expect(schema.safeParse(payload()).success).toBe(false);
  }
});
it("catalog_draft_v3_preserves_ordered_identifier_and_eligibility_guards", () => {
  const original = payload();
  for (const operations of [original.publication.operations.slice(3),
    [...original.publication.operations, { op: "set_sku_status", skuCode: "ARTICLE", status: "active" }],
    [...original.publication.operations, original.publication.operations[3]],
    [...original.publication.operations, { op: "unknown" }]]) {
    expect(catalogDraftPayloadV3Schema.safeParse({ ...original, publication: { ...original.publication, operations } }).success).toBe(false);
  }
  original.publication.operations.push({ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: true, sellableInSubscription: false },
    { op: "set_sku_status", skuCode: "ARTICLE", status: "active" });
  expect(catalogDraftPayloadV3Schema.safeParse(original).success).toBe(true);
  for (const delta of [{ unitPriceMinor: 0 }, { validFrom: "2026-01-01T00:00:00Z" }, { mode: "subscription" }]) {
    const bad = payload(); Object.assign(bad.skus[0].priceOperations![0], delta);
    expect(catalogDraftPayloadV3Schema.safeParse(bad).success).toBe(false);
  }
});
it("catalog_draft_v3_provenance_resolves_without_self_fingerprint", () => {
  const data = payload(), stored = record(data);
  expect(resolveCatalogDraftProvenance({ source: "current_draft" }, stored)).toEqual({ draftId, draftRevision: 1, draftCommandKey: stored.commandKey, draftFingerprint: stored.fingerprint });
  const retained = { source: "retained_draft" as const, draftId: documentId, draftRevision: 2, draftCommandKey: "prior", draftFingerprint: "c".repeat(64) };
  data.publication.operations[1] = { ...(data.publication.operations[1] as Extract<typeof data.publication.operations[number], { op: "register_document_revision" }>), provenance: retained };
  expect(catalogDraftPayloadV3Schema.safeParse(data).success).toBe(false);
  data.publication.evidence.drafts = [{ draftId: retained.draftId, revision: 2, commandKey: "prior", fingerprint: retained.draftFingerprint }];
  expect(catalogDraftPayloadV3Schema.safeParse(data).success).toBe(true);
  const { source: _source, ...tuple } = retained;
  expect(resolveCatalogDraftProvenance(retained, stored)).toEqual(tuple);
});
it("catalog_candidate_digest_covers_v3_publication_inputs", async () => {
  let data = payload();
  const deps = { readDraft: async () => record(data), registry: createCatalogProductTypeRegistry([definition]), installedDefinitionDigest: async () => catalogDefinitionDigest(definition),
    currentHead: async () => ({ outcome: "unpublished" as const }), resolveHead: async () => null, validatePrices: async () => [] };
  const service = createCatalogCandidateService(deps), query = { draftId, draftRevision: 1, expectedHead: null };
  const original = await service.prepareCandidate(query);
  expect(original.issues).toEqual([]);
  expect(await createCatalogCandidateService(deps).validate(original.candidateRef)).toEqual(original);
  const mutations: ((value: CatalogDraftPayloadV3) => void)[] = [
    value => { value.publication.operations.reverse(); },
    value => { const operations = value.publication.operations; [operations[5], operations[6]] = [operations[6], operations[5]]; },
    value => { const operation = value.publication.operations[5]; if (operation.op === "set_derived_sku_facts") operation.netContent = { ...operation.netContent, unscaled: "101" }; },
    value => {
      const operation = value.publication.operations[1];
      if (operation.op === "register_document_revision") operation.provenance = { source: "retained_draft", draftId: documentId, draftRevision: 2, draftCommandKey: "prior", draftFingerprint: "c".repeat(64) };
      value.publication.evidence.drafts = [{ draftId: documentId, revision: 2, commandKey: "prior", fingerprint: "c".repeat(64) }];
    },
    value => { value.publication.operations.push({ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: true, sellableInSubscription: false }); },
    value => { value.publication.operations.pop(); },
    value => { value.publication.evidence.media = [{ skuCode: "ARTICLE", mediaRef: "example:media", assetRefs: [], revisionDigest: "d".repeat(64) }]; },
    value => { value.product.sharedContent.requestedModes[0].modes.push("one_time"); },
    value => { value.product.sharedContent.document = { names: { en: "Changed" } }; },
    value => { value.publication.kind = "compensation"; },
  ];
  for (const mutate of mutations) {
    data = payload(); mutate(data);
    // Ordering is covered even when a changed prefix is invalid: schema refusal must not silently sort it.
    if (!catalogDraftPayloadV3Schema.safeParse(data).success) {
      await expect(service.validate(original.candidateRef)).rejects.toMatchObject({ code: "candidate_invalid" });
    } else {
      expect((await service.validate(original.candidateRef)).candidateDigest).not.toBe(original.candidateDigest);
      await expect(service.compareCandidate({ ...original, expectedHead: null })).rejects.toMatchObject({ code: "candidate_digest_mismatch" });
    }
  }
});
