import { compileCatalogPublication } from "../../src/catalog/publicationValidation.js";
import { input as publicationInput, registry as publicationRegistry } from "./fixtures/publicationInput.js";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { createCatalogCandidateService, type CatalogCandidateDeps } from "../../src/catalog/candidate.js";
import { catalogDefinitionDigest } from "../../src/catalog/catalogDefinitionDigest.js";
import { createCatalogProductTypeRegistry } from "../../src/catalog/productTypeSchemas.js";
import { validateCatalogDraftV2 } from "../../src/catalog/draftV2Validation.js";
import { catalogDraftPriceOperationV2Schema, catalogDraftPayloadV2Schema, catalogDraftStoredCommandSchema } from "../../src/catalog/draftV2Schemas.js";
import type { CatalogDraftPayloadV2, CatalogDraftStoredRecord } from "../../src/catalog/contracts/draftV2.js";
import type { CatalogHeadRef } from "../../src/catalog/contracts/lifecycle.js";

const draftId = "10000000-0000-4000-8000-000000000001", productId = "20000000-0000-4000-8000-000000000001";
const skuId = "30000000-0000-4000-8000-000000000001", listId = "40000000-0000-4000-8000-000000000001";
const definition = { key: "example:article", version: 1, units: [{ code: "openlup:piece", dimension: "count" as const, integral: true }],
  netContentUnits: ["openlup:piece"], dimensions: [], validatorRef: `sha256:${"a".repeat(64)}`,
  attributes: [{ key: "title", scope: "product" as const, valueType: { kind: "text" as const, maxLength: 120 }, required: true,
    cardinality: { min: 1, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }], validateContent: () => [] };
const operation = { schemaVersion: 1 as const, commandKey: "price:first", variantId: skuId, priceListId: listId,
  mode: "one_time" as const, minQty: 1 as const, amountKind: "gross" as const, unitPriceMinor: 1200,
  expected: { entryId: null, unitPriceMinor: null } };
const payload = (): CatalogDraftPayloadV2 => ({ schemaVersion: 2, product: { id: productId, type: { key: definition.key, version: 1 },
  dimensions: [], slug: "synthetic-article", primarySkuId: skuId, sharedContent: {}, attributes: { title: "Synthetic title" } },
  skus: [{ id: skuId, productId, code: "SYNTHETIC-ONE", options: {}, netContent: { dimension: "count", unit: "openlup:piece", unscaled: "1", scale: 0 }, priceOperations: [operation] }] });
function setup() {
  let data = payload(), draftRevision = 1, head: CatalogHeadRef | null = null, installed = catalogDefinitionDigest(definition);
  const record = (): CatalogDraftStoredRecord => ({ draftId, productId, revision: draftRevision, status: "open", payload: structuredClone(data),
    commandKey: "draft:first", fingerprint: "a".repeat(64), actorId: "operator:synthetic", createdAt: "2026-01-01T00:00:00Z" });
  const deps: CatalogCandidateDeps = { readDraft: async (_id, revision) => revision === undefined || revision === draftRevision ? record() : null,
    registry: createCatalogProductTypeRegistry([definition]), installedDefinitionDigest: async () => installed,
    currentHead: async () => head ? { outcome: "found", head, documentRef: "synthetic-document", observations: [] } : { outcome: "unpublished" },
    resolveHead: async identity => head && head.publicationId === identity.publicationId && head.revision === identity.revision ? head : null,
    validatePrices: async () => [] };
  return { deps, service: createCatalogCandidateService(deps), setPayload: (value: CatalogDraftPayloadV2) => { data = value; },
    setRevision: (value: number) => { draftRevision = value; }, setHead: (value: CatalogHeadRef | null) => { head = value; },
    setInstalled: (value: string) => { installed = value; } };
}
describe("self-contained catalogue preview", () => {
  it("catalog_candidate_requires_complete_publication_facts", async () => {
    const f = setup(), incomplete: CatalogDraftPayloadV2 = { schemaVersion: 2, product: { id: productId, type: { key: definition.key, version: 1 }, dimensions: [] }, skus: [] };
    expect(await validateCatalogDraftV2(incomplete, f.deps.registry)).toMatchObject({ valid: true, readiness: { publication: { status: "incomplete" }, commercial: { status: "inactive" } } });
    f.setPayload(incomplete);
    const preview = await f.service.prepareCandidate({ draftId, draftRevision: 1, expectedHead: null });
    expect(preview.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["primary_sku_missing", "content_missing", "attribute_required_missing"]));
    f.setPayload(payload());
    expect((await f.service.prepareCandidate({ draftId, draftRevision: 1, expectedHead: null })).issues).toEqual([]);
    delete f.deps.validatePrices;
    expect((await f.service.prepareCandidate({ draftId, draftRevision: 1, expectedHead: null })).issues).toContainEqual({ path: "skus", code: "price_validation_unavailable" });
    const foreign = payload(); foreign.product.documentRevision = { productId: skuId, id: listId, revisionNo: 1, schemaId: "example:document",
      documentRef: "synthetic:document", sourceRef: "synthetic:source", digest: "a".repeat(64) };
    expect(catalogDraftPayloadV2Schema.safeParse(foreign).success).toBe(false);
    foreign.product.documentRevision.productId = productId;
    f.setPayload(foreign);
    f.deps.validatePrices = async () => [];
    expect((await f.service.prepareCandidate({ draftId, draftRevision: 1, expectedHead: null })).issues)
      .toContainEqual({ path: "product.documentRevision", code: "document_validation_unavailable" });
    f.deps.readDocument = async reference => ({ ...reference, productId: skuId });
    expect((await f.service.prepareCandidate({ draftId, draftRevision: 1, expectedHead: null })).issues)
      .toContainEqual({ path: "product.documentRevision", code: "document_reference_invalid" });
  });
  it("catalog_candidate_refuses_definition_drift", async () => {
    const f = setup(); await f.service.prepareCandidate({ draftId, draftRevision: 1, expectedHead: null });
    f.setInstalled("b".repeat(64));
    await expect(f.service.prepareCandidate({ draftId, draftRevision: 1, expectedHead: null })).rejects.toMatchObject({ code: "catalog_definition_drift" });
    f.setInstalled(catalogDefinitionDigest(definition));
    const registry = createCatalogProductTypeRegistry([{ ...definition, validatorRef: `sha256:${"b".repeat(64)}` }]);
    await expect(createCatalogCandidateService({ ...f.deps, registry }).prepareCandidate({ draftId, draftRevision: 1, expectedHead: null }))
      .rejects.toMatchObject({ code: "catalog_definition_drift" });
  });
  it("catalog_candidate_reference_is_self_contained", async () => {
    const f = setup(), query = { draftId, draftRevision: 1, expectedHead: null };
    const first = await f.service.prepareCandidate(query);
    expect(first.candidateRef).toBe(`v1:${draftId}@1/unpublished`);
    expect(await createCatalogCandidateService({ ...f.deps }).validate(first.candidateRef)).toEqual(first);
    expect(await f.service.compareCandidate({ ...first, expectedHead: null })).toEqual(first);
    await expect(f.service.compareCandidate({ ...first, candidateDigest: "0".repeat(64), expectedHead: null })).rejects.toMatchObject({ code: "candidate_digest_mismatch" });
    await expect(f.service.validate(first.candidateRef.replace("v1:", "v2:"))).rejects.toMatchObject({ code: "candidate_invalid" });
    const secondPayload = payload(); secondPayload.skus[0].priceOperations![0].unitPriceMinor = 1300;
    f.setPayload(secondPayload); f.setRevision(2);
    const second = await f.service.prepareCandidate({ ...query, draftRevision: 2 });
    expect(second.candidateDigest).not.toBe(first.candidateDigest);
    await expect(f.service.validate(first.candidateRef)).rejects.toMatchObject({ code: "candidate_invalid" });
    const head = { publicationId: listId, revision: 1, documentDigest: "c".repeat(64) };
    f.setHead(head);
    const headed = await f.service.prepareCandidate({ ...query, draftRevision: 2, expectedHead: head });
    expect(headed.candidateRef).toBe(`v1:${draftId}@2/${listId}@1`);
    expect(headed.candidateDigest).not.toBe(second.candidateDigest);
    expect(await createCatalogCandidateService({ ...f.deps }).validate(headed.candidateRef)).toEqual(headed);
    const fresh = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import {readFileSync} from 'node:fs';
      import {createCatalogCandidateService,createCatalogProductTypeRegistry,catalogDefinitionDigest} from '@openlup/platform/catalog';
      const {record,head,metadata,reference}=JSON.parse(readFileSync(0,'utf8'));
      const definition={...metadata,validateContent:()=>[]};
      const service=createCatalogCandidateService({readDraft:async()=>record,registry:createCatalogProductTypeRegistry([definition]),
        installedDefinitionDigest:async()=>catalogDefinitionDigest(definition),currentHead:async()=>({outcome:'found',head,documentRef:'synthetic',observations:[]}),
        resolveHead:async()=>head,validatePrices:async()=>[]});
      process.stdout.write(JSON.stringify(await service.validate(reference)));
    `], { encoding: "utf8", input: JSON.stringify({ record: await f.deps.readDraft(draftId, 2), head, metadata: definition, reference: headed.candidateRef }) });
    expect(JSON.parse(fresh)).toEqual(headed);
    await expect(f.service.compareCandidate({ ...headed, expectedHead: { ...head, documentDigest: "d".repeat(64) } })).rejects.toMatchObject({ code: "head_conflict" });
    await expect(f.service.prepareCandidate({ ...query, draftRevision: 2, expectedHead: { ...head, documentDigest: "d".repeat(64) } })).rejects.toMatchObject({ code: "head_conflict" });
    f.setHead({ ...head, revision: 2 });
    await expect(f.service.validate(headed.candidateRef)).rejects.toMatchObject({ code: "head_conflict" });
  });
  it("keeps the exact donor price command grammar and refuses unknown payload versions", () => {
    expect(catalogDraftPriceOperationV2Schema.parse(operation)).toEqual(operation);
    expect(catalogDraftPriceOperationV2Schema.parse({ ...operation, expected: { entryId: listId, unitPriceMinor: 0 } })).toMatchObject({ expected: { unitPriceMinor: 0 } });
    for (const change of [{ unitPriceMinor: 0 }, { unitPriceMinor: 1.5 }, { unitPriceMinor: 2_147_483_648 }, { mode: "subscription" }, { minQty: 2 },
      { amountKind: "net" }, { validFrom: "2026-01-01T00:00:00Z" }, { expected: { entryId: null, unitPriceMinor: 1 } }])
      expect(catalogDraftPriceOperationV2Schema.safeParse({ ...operation, ...change }).success).toBe(false);
    expect(catalogDraftStoredCommandSchema.safeParse({ schemaVersion: 3, action: "create", draftId, commandKey: "future", expectedRevision: 0, payload: payload() }).success).toBe(false);
    expect(catalogDraftPayloadV2Schema.safeParse({ ...payload(), schemaVersion: 3 }).success).toBe(false);
  });
  it("reuses installed axis identity for equivalent-unit duplicates", async () => {
    const sized = { ...definition, units: [...definition.units,
      { code: "openlup:g", dimension: "mass" as const, integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1", scale: 0 } },
      { code: "openlup:kg", dimension: "mass" as const, integral: false, factor: { canonicalUnit: "openlup:g", unscaled: "1000", scale: 0 } }],
    dimensions: [{ key: "size", kind: "quantity" as const, dimension: "mass" as const, units: ["openlup:g", "openlup:kg"] }],
    axes: [{ key: "size", attributeKey: "size" }], attributes: [...definition.attributes,
      { key: "size", scope: "variant" as const, valueType: { kind: "quantity" as const, dimension: "mass" as const, units: ["openlup:g", "openlup:kg"] },
        required: false, cardinality: { min: 0, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 1, labels: {} }] };
    const draft = payload(); draft.product.dimensions = ["size"];
    draft.skus[0].options = { size: { kind: "quantity", value: { dimension: "mass", unit: "openlup:g", unscaled: "1000", scale: 0 } } };
    draft.skus.push({ ...draft.skus[0], id: listId, code: "SYNTHETIC-TWO", priceOperations: [],
      options: { size: { kind: "quantity", value: { dimension: "mass", unit: "openlup:kg", unscaled: "1", scale: 0 } } } });
    expect(await validateCatalogDraftV2(draft, createCatalogProductTypeRegistry([sized])))
      .toEqual({ valid: false, issues: [{ path: "skus.1.options", code: "duplicate_combination" }] });
  });
});

it.each([
  ["sealed new document", "staged", "pending", []],
  ["missing unit trade identifier", "blocked-input", "pending", ["unit_trade_identifier_missing"]],
  ["required binding unavailable", "unknown", "pending", ["publication_preparation_unavailable"]],
  ["hard issue with unavailable binding", "blocked-input", "pending", ["unit_trade_identifier_missing", "publication_preparation_unavailable"]],
  ["missing SKU code", "blocked-input", "pending", ["sku_code_missing"]],
  ["activation ready", "staged", "ready", []],
  ["activation blocked", "staged", "blocked-input", []],
  ["activation unknown", "staged", "unknown", []],
  ["activation without SKU promotion", "blocked-input", "blocked-input", ["catalog_publication_activation_effect_missing"]],
  ["activation without product promotion", "blocked-input", "blocked-input", ["catalog_publication_activation_effect_missing"]],
] as const)("the v3 facade reports preparation and activation for %s", async (mode, structural, activation, codes) => {
  const fixture = publicationInput(), { payload, record } = fixture;
  if (mode.includes("trade identifier") || mode.includes("hard issue")) delete payload.skus[0].identifiers;
  if (mode === "missing SKU code") {
    delete payload.skus[0].code;
    payload.product.sharedContent.publicationSkus = [];
    payload.product.sharedContent.requestedModes = [];
  }
  const prior = mode.startsWith("activation") ? compileCatalogPublication(fixture) : null;
  const head = prior ? { publicationId: listId, revision: 1, documentDigest: prior.product.document!.digest } : null;
  if (prior) {
    payload.product.sharedContent.catalogAction = "revise";
    const sku = payload.skus[0], skuCode = sku.code!;
    sku.grossMass = sku.netContent;
    sku.logisticsRef = "example:logistics";
    payload.product.sharedContent.requestedModes[0].modes = ["one_time"];
    payload.product.sharedContent.offerMemberships = [{ skuCode, offerVersion: "example:offer", admitted: true }];
    payload.publication.operations = [
      { op: "set_sku_metadata", skuCode, logisticsRef: sku.logisticsRef },
      { op: "set_offer_membership", ...payload.product.sharedContent.offerMemberships[0] },
      { op: "set_eligibility", skuCode, sellableStandalone: true, sellableInSubscription: false },
      { op: "set_sku_status", skuCode, status: "active" },
      { op: "set_product_status", productSlug: payload.product.slug!, status: "active" },
    ];
    if (mode === "activation without SKU promotion")
      payload.publication.operations = payload.publication.operations.filter(op => op.op !== "set_sku_status" && op.op !== "set_product_status");
    if (mode === "activation without product promotion")
      payload.publication.operations = payload.publication.operations.filter(op => op.op !== "set_product_status");
  }
  const deps = {
    readDraft: async () => structuredClone(record), registry: publicationRegistry,
    installedDefinitionDigest: async () => catalogDefinitionDigest(fixture.definition),
    currentHead: async () => head ? { outcome: "found" as const, head, documentRef: "example:document", observations: [] }
      : { outcome: "unpublished" as const },
    resolveHead: async () => head,
    ...(mode.includes("unavailable") ? {} : { publicationRules: fixture.rules }),
    readPublicationState: async () => prior && { ...prior, retainedSources: [] },
    presentationReadiness: async () => ({ ready: true, reasons: [] }),
    assessActivation: async () => mode === "activation unknown" ? null
      : mode === "activation blocked" ? { ready: false, reasons: ["installed_business_block"] } : { ready: true, reasons: [] },
  };
  const service = createCatalogCandidateService(deps);
  const prepared = await service.prepareCandidate({ draftId: record.draftId, draftRevision: record.revision, expectedHead: head });
  expect(prepared.preparation).toMatchObject({ structural: { outcome: structural }, activation: { outcome: activation } });
  expect(prepared.issues.map(issue => issue.code)).toEqual(expect.arrayContaining([...codes]));
  if (mode === "sealed new document") {
    expect(prepared.issues).toEqual([]);
    expect(prepared.preparation!.activation.issues.map(issue => issue.code)).toEqual(expect.arrayContaining(["gross_mass_missing", "logistics_reference_missing", "price_reference_missing"]));
  }
  if (mode === "missing SKU code") {
    expect(prepared.issues.map(issue => issue.code)).not.toContain("unit_trade_identifier_missing");
    expect(prepared.preparation!.activation.issues.some(issue => issue.path.startsWith("skus.0."))).toBe(false);
  }
  expect(await service.validate(prepared.candidateRef)).toEqual(prepared);
  expect(await service.compareCandidate({ ...prepared, expectedHead: head })).toEqual(prepared);
});

it.each([
  ["unknown route, missing effect", "blocked-input", "pending", "catalog_publication_identifier_effect_missing"],
  ["retained route collision", "blocked-input", "pending", "duplicate_route"],
  ["activation missing media", "staged", "unknown", "media_readiness_unknown"],
  ["activation with retained assets", "staged", "blocked-input", "media_reference_missing"],
  ["mismatched media claim", "staged", "pending", "media_readiness_mismatch"],
  ["new SKU without membership", "staged", "pending", "offer_membership_missing"],
] as const)("preparation preserves independent evidence through each facade method: %s", async (mode, structural, activation, code) => {
  const fixture = publicationInput(), { payload, record } = fixture;
  const content = payload.product.sharedContent, sku = payload.skus[0];
  if (mode.includes("media")) {
    content.presentation = { mediaRef: "example:media" };
    const presentation = payload.publication.operations.find(op => op.op === "set_product_presentation")!;
    if (presentation.op === "set_product_presentation") presentation.presentation = content.presentation;
    sku.assetRefs = ["actual"];
  }
  if (mode === "activation with retained assets") sku.assetRefs = ["retained"];
  if (mode === "mismatched media claim")
    payload.publication.evidence.media = [{ skuCode: sku.code!, mediaRef: "example:media", assetRefs: ["different"], revisionDigest: "b".repeat(64) }];
  if (mode === "unknown route, missing effect")
    payload.publication.operations = payload.publication.operations.filter(op => op.op !== "create_identifier");
  const prior = mode === "retained route collision" || mode.startsWith("activation") ? compileCatalogPublication(fixture) : null;
  const head = prior ? { publicationId: listId, revision: 1, documentDigest: prior.product.document!.digest } : null;
  if (prior) {
    content.catalogAction = "revise";
    sku.logisticsRef = "example:logistics";
    payload.publication.operations = [{ op: "set_sku_metadata", skuCode: sku.code!, logisticsRef: sku.logisticsRef }];
  }
  if (mode.startsWith("activation")) {
    if (mode === "activation with retained assets") delete sku.assetRefs;
    sku.grossMass = sku.netContent;
    content.requestedModes[0].modes = ["one_time"];
    content.offerMemberships = [{ skuCode: sku.code!, offerVersion: "example:offer", admitted: true }];
    payload.publication.operations.push({ op: "set_offer_membership", ...content.offerMemberships[0] },
      { op: "set_eligibility", skuCode: sku.code!, sellableStandalone: true, sellableInSubscription: false },
      { op: "set_sku_status", skuCode: sku.code!, status: "active" },
      { op: "set_product_status", productSlug: payload.product.slug!, status: "active" });
  }
  const service = createCatalogCandidateService({
    readDraft: async () => structuredClone(record), registry: publicationRegistry,
    installedDefinitionDigest: async () => catalogDefinitionDigest(fixture.definition),
    currentHead: async () => head ? { outcome: "found", head, documentRef: "example:document", observations: [] } : { outcome: "unpublished" },
    resolveHead: async () => head, publicationRules: fixture.rules,
    readPublicationState: async () => prior && { ...prior, retainedSources: [] },
    ...(mode === "unknown route, missing effect" ? {} : {
      presentationReadiness: async () => mode === "retained route collision" ? { ready: false, reasons: ["duplicate_route"] } : { ready: true, reasons: [] },
    }),
    assessActivation: async () => ({ ready: true, reasons: [] }),
  });
  const prepared = await service.prepareCandidate({ draftId: record.draftId, draftRevision: record.revision, expectedHead: head });
  for (const preview of [prepared, await service.validate(prepared.candidateRef), await service.compareCandidate({ ...prepared, expectedHead: head })]) {
    expect(preview.preparation).toMatchObject({ structural: { outcome: structural }, activation: { outcome: activation } });
    const issues = structural === "blocked-input" ? preview.preparation!.structural.issues : preview.preparation!.activation.issues;
    expect(issues.map(issue => issue.code)).toContain(code);
  }
});
