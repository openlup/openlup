import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { createCatalogCandidateService, type CatalogCandidateDeps } from "../../src/catalog/candidate.js";
import { catalogDefinitionDigest } from "../../src/catalog/catalogDefinitionDigest.js";
import { createCatalogProductTypeRegistry } from "../../src/catalog/productTypeSchemas.js";
import { validateCatalogDraftV2 } from "../../src/catalog/draftV2Validation.js";
import { catalogDraftPriceOperationV2Schema, catalogDraftPayloadV2Schema, catalogDraftStoredCommandSchema } from "../../src/catalog/draftV2Schemas.js";
import type { CatalogDraftPayloadV2, CatalogDraftStoredRecord } from "../../src/catalog/contracts/draftV2.js";
import type { CatalogHeadRef } from "../../src/catalog/contracts/lifecycle.js";
import type { CatalogCandidatePreview, CatalogCandidateQuery } from "../../src/catalog/contracts/candidate.js";
import { withCatalogPublicationRules } from "../../src/catalog/catalogPublicationRules.js";
import type { CatalogValidationPort } from "../../src/catalog/publicationPorts.js";
import { artifact, input, revision } from "./fixtures/publicationInput.js";
import { createCatalogCandidateServiceWithPublication } from "../../src/catalog/candidateService.js";
import { createPostgresCatalogPublicationCommands } from "../../src/catalog/catalogPublicationCommands.js";
import { createCatalogCandidateService as createReleasedCatalogCandidateService } from "./fixtures/releasedCandidate.js";

const draftId = "10000000-0000-4000-8000-000000000001", productId = "20000000-0000-4000-8000-000000000001";
const skuId = "30000000-0000-4000-8000-000000000001", listId = "40000000-0000-4000-8000-000000000001";
const definition = { key: "example:article", version: 1, units: [{ code: "openlup:piece", dimension: "count" as const, integral: true }],
  netContentUnits: ["openlup:piece"], dimensions: [], validatorRef: `sha256:${"a".repeat(64)}`,
  attributes: [{ key: "title", scope: "product" as const, valueType: { kind: "text" as const, maxLength: 120 }, required: true,
    cardinality: { min: 1, max: 1 }, filterable: false, facetable: false, public: true, displayOrder: 0, labels: {} }], validateContent: () => [] };
const operation = { schemaVersion: 1 as const, commandKey: "price:first", variantId: skuId, priceListId: listId,
  mode: "one_time" as const, minQty: 1 as const, amountKind: "gross" as const, unitPriceMinor: 1200,
  expected: { entryId: null, unitPriceMinor: null } };

it("reports each installed price-list refusal at its operation field during native Prepare", async () => {
  const { record, payload, registry, installedDefinitionDigest, evidence } = input();
  const actorId = "50000000-0000-4000-8000-000000000001";
  const lists = [
    { reason: "missing", code: "price_list_not_found" },
    { reason: "inactive", code: "price_list_not_active" },
    { reason: "out of window", code: "price_list_not_active" },
    { reason: "wrong currency", code: "price_list_not_active" },
    { reason: "valid", code: null },
  ].map((list, index) => ({ ...list, id: `60000000-0000-4000-8000-00000000000${index}` }));
  const sku = payload.skus[0]!;
  sku.priceOperations = lists.map(({ id, reason }) => ({ ...operation, variantId: sku.id, priceListId: id, commandKey: reason }));
  const query = vi.fn(async (sql: string, _args?: unknown[]) => {
    if (sql.includes("public.catalog_draft_get(")) return { rows: [{ result: record }] };
    if (sql.startsWith("SELECT public.catalog_draft_record(")) return { rows: [{ record }] };
    if (sql.startsWith("WITH selected AS")) return { rows: evidence.drafts };
    if (sql.includes("public.catalog_type_versions")) return { rows: [{ definition_digest: installedDefinitionDigest }] };
    if (sql.includes("AS live")) return { rows: [{ head: null, live: false }] };
    if (sql.includes("public.price_lists")) return { rows: lists.map(({ id, code }) => ({ id, code })) };
    return { rows: [] };
  });
  const api = createPostgresCatalogPublicationCommands({ registry, catalogPublicationOwner: { run: work => work({ query }) },
    authorizeHuman: async () => ({ ok: true, userId: actorId, role: "admin", isMachineActor: false }) });
  const preview = await api.prepareCandidate({ draftId: record.draftId, draftRevision: record.revision, expectedHead: null },
    (await api.authorize(null))!);
  expect(preview).toMatchObject({ preparation: { postStateDigest: expect.any(String) } });
  if (!("issues" in preview)) throw new Error(JSON.stringify(preview));
  expect(preview.issues.filter(({ code }) => code.startsWith("price_list_") || code === "price_validation_unavailable")).toEqual(
    lists.flatMap(({ code }, index) => code ? [{ path: `skus.0.priceOperations.${index}.priceListId`, code }] : []));
  expect(query).toHaveBeenNthCalledWith(1, "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
  expect(query).toHaveBeenCalledWith(expect.stringContaining("public.price_lists"), [lists.map(({ id }) => id)]);
});

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
type CandidateScenario = {
  name: string;
  setup?(deps: CatalogCandidateDeps): void;
  compareHead?: CatalogHeadRef;
  badSeal?: boolean;
  unpublished?: boolean;
  expected: readonly [string, string, string];
};
const matrixHead = { publicationId: listId, revision: 1, documentDigest: "c".repeat(64) };
const unsupportedHead = async () => ({ outcome: "unsupported" as const, reason: "publication_not_supported" as const });
const rejectedLookup = async () => { throw new Error("synthetic reader failure"); };
const timedOutLookup = async () => { throw new Error("synthetic reader timeout"); };
const same = (code: string) => [code, code, code] as const;
const candidateOutcomes: CandidateScenario[] = [
  { name: "headed success", expected: same("preview") },
  { name: "unpublished success", unpublished: true, expected: same("preview") },
  { name: "missing immutable draft", setup: deps => { deps.readDraft = async () => null; }, expected: same("candidate_invalid") },
  { name: "null latest draft", setup(deps) {
    const readDraft = deps.readDraft;
    deps.readDraft = async (id, revision) => revision === undefined ? null : readDraft(id, revision);
  }, expected: same("candidate_invalid") },
  { name: "different latest revision", setup(deps) {
    const readDraft = deps.readDraft;
    deps.readDraft = async (id, revision) => {
      const record = await readDraft(id, revision);
      return record && revision === undefined ? { ...record, revision: record.revision + 1 } : record;
    };
  }, expected: same("candidate_invalid") },
  { name: "null immutable head", setup: deps => { deps.resolveHead = async () => null; }, expected: same("head_conflict") },
  { name: "different immutable head", setup: deps => { deps.resolveHead = async () => ({ ...matrixHead, revision: 2 }); }, expected: same("head_conflict") },
  { name: "rejected immutable head", setup: deps => { deps.resolveHead = rejectedLookup; }, expected: same("candidate_dependency_unavailable") },
  { name: "current head timeout", setup: deps => { deps.currentHead = timedOutLookup; }, expected: same("candidate_dependency_unavailable") },
  { name: "latest draft timeout", setup(deps) {
    const readDraft = deps.readDraft;
    deps.readDraft = (id, revision) => revision === undefined ? timedOutLookup() : readDraft(id, revision);
  }, expected: same("candidate_dependency_unavailable") },
  { name: "unsupported current and missing immutable head", setup(deps) {
    deps.currentHead = unsupportedHead;
    deps.resolveHead = async () => null;
  }, expected: same("head_conflict") },
  { name: "malformed compare head", compareHead: {} as CatalogHeadRef, expected: ["preview", "preview", "head_conflict"] },
  { name: "contradictory compare head during outage", unpublished: true, compareHead: matrixHead,
    setup: deps => { deps.currentHead = unsupportedHead; }, expected: same("candidate_dependency_unavailable") },
  { name: "wrong candidate digest", badSeal: true, expected: ["preview", "preview", "candidate_digest_mismatch"] },
  { name: "installed definition drift", setup: deps => { deps.installedDefinitionDigest = async () => null; }, expected: same("catalog_definition_drift") },
  { name: "current head unavailable with missing installed definition", setup(deps) {
    deps.currentHead = unsupportedHead;
    deps.installedDefinitionDigest = async () => null;
  }, expected: same("candidate_dependency_unavailable") },
];

function legacyInput(version: 1 | 2, scenario: CandidateScenario) {
  const f = setup(), expectedHead = scenario.unpublished ? null : matrixHead;
  f.setHead(expectedHead);
  if (version === 1) {
    const readDraft = f.deps.readDraft;
    f.deps.readDraft = async (id, revision) => {
      const record = await readDraft(id, revision);
      if (record?.payload.schemaVersion !== 2) return record;
      const { attributes: _attributes, ...product } = record.payload.product;
      const skus = record.payload.skus.map(({ attributes: _attributes, priceOperations: _prices, ...sku }) => sku);
      return { ...record, payload: { schemaVersion: 1, product, skus } };
    };
  }
  return { deps: f.deps, query: { draftId, draftRevision: 1, expectedHead } };
}

async function ordinaryInput(version: 1 | 2 | 3, scenario: CandidateScenario) {
  if (version !== 3) return legacyInput(version, scenario);
  const data = scenario.unpublished ? input() : await revision();
  const { expectedHead } = data;
  const deps: CatalogCandidateDeps = {
    readDraft: async () => data.record,
    currentHead: async () => expectedHead
      ? { outcome: "found", head: expectedHead, documentRef: "example:document", observations: [] }
      : { outcome: "unpublished" },
    resolveHead: async identity => expectedHead && identity.publicationId === expectedHead.publicationId
      && identity.revision === expectedHead.revision ? expectedHead : null,
    registry: data.registry,
    installedDefinitionDigest: async () => data.installedDefinitionDigest,
    readDocument: async reference => reference,
    validatePrices: async () => [],
  };
  return { deps, query: { draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead } };
}

function traceReaders(deps: CatalogCandidateDeps, calls: unknown[][]): CatalogCandidateDeps {
  function trace<Args extends unknown[], Result>(name: string, read: (...args: Args) => Result) {
    return (...args: Args): Result => {
      calls.push([name, ...args]);
      return read(...args);
    };
  }
  return { ...deps,
    readDraft: trace("readDraft", deps.readDraft), resolveHead: trace("resolveHead", deps.resolveHead),
    currentHead: trace("currentHead", deps.currentHead),
    registry: { resolve: trace("registry.resolve", ref => deps.registry.resolve(ref)) },
    installedDefinitionDigest: trace("installedDefinitionDigest", deps.installedDefinitionDigest),
    ...(deps.readDocument && { readDocument: trace("readDocument", deps.readDocument) }),
    ...(deps.validatePrices && { validatePrices: trace("validatePrices", deps.validatePrices) }),
  };
}

async function candidateOutcome(operation: () => Promise<
  Pick<CatalogCandidatePreview, "candidateDigest" | "issues"> & Partial<CatalogCandidatePreview>
>) {
  try {
    const { preparation, ...preview } = await operation();
    return { code: "preview", preview, preparation };
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error)) throw error;
    return { code: error.code, name: error.name, message: error.message };
  }
}

function candidateCalls(service: ReturnType<typeof createCatalogCandidateService>, query: CatalogCandidateQuery,
  original: CatalogCandidatePreview, scenario: CandidateScenario) {
  return [
    () => service.prepareCandidate(query),
    () => service.validate(original.candidateRef),
    () => service.compareCandidate({ candidateRef: original.candidateRef,
      candidateDigest: scenario.badSeal ? "0".repeat(64) : original.candidateDigest,
      expectedHead: scenario.compareHead ?? query.expectedHead }),
  ];
}

describe.each([1, 2, 3] as const)("released v%s outcomes", version => {
  it.each(candidateOutcomes)("$name across prepare, validate and compare", async scenario => {
    const baseline = await ordinaryInput(version, scenario), candidate = await ordinaryInput(version, scenario);
    const original = await createReleasedCatalogCandidateService(baseline.deps).prepareCandidate(baseline.query);
    scenario.setup?.(baseline.deps);
    scenario.setup?.(candidate.deps);
    const releasedReads: unknown[][] = [], currentReads: unknown[][] = [];
    const released = createReleasedCatalogCandidateService(traceReaders(baseline.deps, releasedReads));
    const current = createCatalogCandidateService(traceReaders(candidate.deps, currentReads));
    const old = candidateCalls(released, baseline.query, original, scenario);
    const next = candidateCalls(current, candidate.query, original, scenario);
    const publicationReads = vi.fn(async () => null);
    const optedIn = version === 3 ? undefined : candidateCalls(
      createCatalogCandidateServiceWithPublication(candidate.deps, { readEvidence: publicationReads }),
      candidate.query, original, scenario,
    );
    for (const [index, call] of old.entries()) {
      releasedReads.length = 0;
      currentReads.length = 0;
      const { preparation: _baseline, ...expected } = await candidateOutcome(call);
      expect(expected.code).toBe(scenario.expected[index]);
      const { preparation, ...actual } = await candidateOutcome(next[index]!);
      expect(actual).toEqual(expected);
      expect(currentReads).toEqual(releasedReads);
      if (actual.code === "preview") expect(preparation).toMatchObject({
        structural: { outcome: "unknown" }, activation: { outcome: "unknown" },
      });
      if (optedIn) {
        const { preparation: _preparation, ...optedInOutcome } = await candidateOutcome(optedIn[index]!);
        expect(optedInOutcome).toEqual(expected);
      }
    }
    expect(publicationReads).not.toHaveBeenCalled();
  });
});

describe("self-contained catalogue preview", () => {
  it("keeps the released validation gate and distinguishes legacy validation from installed rules", async () => {
    const futureIssue = { path: "product", code: "application_issue", phase: "authoring" } as const;
    const { issues }: Pick<CatalogCandidatePreview, "issues"> = { issues: [futureIssue] };
    expect(issues).toEqual([futureIssue]);
    const f = setup(), query = { draftId, draftRevision: 1, expectedHead: null };
    const replacement = vi.fn(() => [{ path: "", code: "substituted_callback" }]);
    const legacy = createCatalogCandidateService({ ...f.deps, registry: createCatalogProductTypeRegistry([{ ...definition, validateContent: replacement }]) });
    const preview = await legacy.prepareCandidate(query);
    expect(preview.issues).toEqual([{ path: "product.sharedContent", code: "substituted_callback" }]);
    expect(preview.preparation?.structural.outcome).toBe("unknown");
    const releasedCaller = async (port: CatalogValidationPort) => (await port.validate(preview.candidateRef)).issues.length === 0;
    expect(await releasedCaller(legacy)).toBe(false);
    expect(await releasedCaller(f.service)).toBe(true);
    expect(await legacy.compareCandidate({ ...preview, expectedHead: null })).toEqual(preview);
    expect(replacement).toHaveBeenCalledTimes(3);
    const rules = artifact.replace("validateContent: () => []", 'validateContent: () => [{ path: "title", code: "installed_rule_refused" }]');
    const pack = withCatalogPublicationRules({ id: "example:rules", namespace: "example", version: 1, openlupRange: "1.x",
      types: [{ ...definition, validatorRef: undefined }], taxClasses: [], capabilities: {} }, () => Buffer.from(rules));
    const registry = createCatalogProductTypeRegistry(pack.types);
    f.setInstalled(catalogDefinitionDigest(pack.types[0]!));
    const verified = createCatalogCandidateService({ ...f.deps, registry });
    const refused = await verified.prepareCandidate(query);
    expect(refused.issues).toEqual([{ code: "installed_rule_refused", path: "product.sharedContent.title" }]);
    expect(refused.preparation?.structural.outcome).toBe("unknown");
    expect(await verified.validate(refused.candidateRef)).toEqual(refused);
    expect(await verified.compareCandidate({ ...refused, expectedHead: null })).toEqual(refused);
  });
  it("keeps legacy v3 draft, document and price issues in the released projection", async () => {
    const data = input(), { publicationRules: _mark, ...metadata } = data.definition;
    const legacy = { ...metadata, validateContent: () => [{ path: "title", code: "application_title_refused" }] };
    const service = createCatalogCandidateService({
      readDraft: async () => data.record,
      registry: createCatalogProductTypeRegistry([legacy]),
      installedDefinitionDigest: async () => catalogDefinitionDigest(legacy),
      currentHead: async () => ({ outcome: "unpublished" }),
      resolveHead: async () => null,
    });
    const result = await service.prepareCandidate({ draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: null });
    expect(result.issues).toEqual([
      { path: "product.sharedContent.title", code: "application_title_refused" },
      { path: "product.documentRevision", code: "document_validation_unavailable" },
    ]);
    expect(result.preparation?.activation.outcome).toBe("unknown");
    expect(await service.validate(result.candidateRef)).toEqual(result);
    const reference = data.record.payload.product.documentRevision!;
    reference.sourceRef = ` ${reference.sourceRef} `;
    expect(await service.compareCandidate({ ...result, expectedHead: null })).toEqual(result);
  });
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
    expect(first.candidateDigest).toBe("b62f8c7506313005d28915d062a149c79fa924ea993767508577a43bf0b594c7");
    expect(first.candidateRef).toBe(`v1:${draftId}@1/unpublished`);
    expect(await createCatalogCandidateService({ ...f.deps }).validate(first.candidateRef)).toEqual(first);
    expect(await f.service.compareCandidate({ ...first, expectedHead: null })).toEqual(first);
    await expect(f.service.compareCandidate({ ...first, candidateDigest: "0".repeat(64), expectedHead: null })).rejects.toMatchObject({ code: "candidate_digest_mismatch" });
    await expect(f.service.validate(first.candidateRef.replace("v1:", "v2:"))).rejects.toMatchObject({ code: "candidate_invalid" });
    const secondPayload = payload(); secondPayload.skus[0].priceOperations![0].unitPriceMinor = 1300;
    f.setPayload(secondPayload); f.setRevision(2);
    const second = await f.service.prepareCandidate({ ...query, draftRevision: 2 });
    expect(second.candidateDigest).toBe("d60dc4495e094bef721c8fd88ab40b8fa5dacf031a88275047bd2f76a1abc4d4");
    expect(second.candidateDigest).not.toBe(first.candidateDigest);
    await expect(f.service.validate(first.candidateRef)).rejects.toMatchObject({ code: "candidate_invalid" });
    const head = { publicationId: listId, revision: 1, documentDigest: "c".repeat(64) };
    f.setHead(head);
    const headed = await f.service.prepareCandidate({ ...query, draftRevision: 2, expectedHead: head });
    expect(headed.candidateDigest).toBe("6310994ecf37d79b9250dacba36922eaf2da317d285c6a81083ed591ce42bc0a");
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
  it.each([
    { id: "Q-LEGACY-IMMUTABLE-MISSING", lookup: "immutable", code: "head_conflict" },
    { id: "Q-LEGACY-LATEST-MISSING", lookup: "draft", code: "candidate_invalid" },
    { id: "an immutable lookup timeout", lookup: "immutable-timeout", code: "candidate_dependency_unavailable" },
    { id: "a current head timeout", lookup: "current", code: "candidate_dependency_unavailable" },
    { id: "a latest draft timeout", lookup: "draft-timeout", code: "candidate_dependency_unavailable" },
  ])("classifies $id in the released facade", async ({ lookup, code }) => {
    const f = setup(), head = { publicationId: listId, revision: 1, documentDigest: "c".repeat(64) };
    f.setHead(head);
    const query = { draftId, draftRevision: 1, expectedHead: head };
    const preview = await f.service.prepareCandidate(query);
    const readDraft = f.deps.readDraft;
    const timedOut = async () => { throw new Error("synthetic lineage timeout"); };
    if (lookup === "immutable") f.deps.resolveHead = async () => null;
    if (lookup === "immutable-timeout") f.deps.resolveHead = timedOut;
    if (lookup === "current") f.deps.currentHead = timedOut;
    if (lookup === "draft" || lookup === "draft-timeout")
      f.deps.readDraft = async (id, revision) => revision !== undefined ? readDraft(id, revision) : lookup === "draft" ? null : timedOut();
    await expect(f.service.prepareCandidate(query)).rejects.toMatchObject({ code });
    await expect(f.service.validate(preview.candidateRef)).rejects.toMatchObject({ code });
    await expect(f.service.compareCandidate({ ...preview, expectedHead: head })).rejects.toMatchObject({ code });
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
