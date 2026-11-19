import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createCatalogCandidateService, type CatalogCandidateDeps } from "../../src/catalog/candidate.js";
import { catalogDefinitionDigest } from "../../src/catalog/catalogDefinitionDigest.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";
import { CATALOG_PUBLICATION_LIMITS } from "../../src/catalog/contracts/publication.js";
import { catalogPublicationManifestSchema, publicationDigest, publicationJson } from "../../src/catalog/publicationCodec.js";
import { loadCatalogPublicationRules } from "../../src/catalog/publicationRules.js";
import { compileCatalogPublication } from "../../src/catalog/publicationValidation.js";
import { compileCatalogPublicationDraft } from "../../src/catalog/publicationDraft.js";
import type { CatalogCandidatePublicationDeps } from "../../src/catalog/publicationEvidence.js";
import { artifact, input, revision, setupRules, type PublicationFixture } from "./fixtures/publicationInput.js";

type Fixture = PublicationFixture;
type Verdict = [preview: string | null, firstDecision: string | null, compile: string | null];
type Case = { id: string; fixture?: "revision"; arrange?: (data: Fixture) => void; expected?: Verdict;
  readiness?: CatalogCandidatePublicationDeps["presentationReadiness"]; media?: CatalogCandidatePublicationDeps["verifyMedia"];
  activationReady?: boolean };
const ready = async () => ({ ready: true, reasons: [] });
const routeConflict = async () => ({ ready: false, reasons: ["duplicate_route"] });
const reason = (code: string): Verdict => [code, code, code];
const operation = (data: Fixture, name: string, patch: object) =>
  Object.assign(data.payload.publication.operations.find(value => value.op === name)!, patch);

function activate(data: Fixture, kind: "eligibility" | "membership", gross = true) {
  const sku = structuredClone(input().payload.skus[0]!);
  sku.logisticsRef = "example:logistics";
  const grossMass = { ...sku.netContent!, unscaled: "110" };
  if (gross) sku.grossMass = grossMass;
  const storedSku = data.evidence!.skus[0]!;
  Object.assign(storedSku, { status: "active", sellableStandalone: true, logisticsRef: sku.logisticsRef, grossMass });
  data.evidence!.product!.status = "active";
  data.payload.skus.push(sku);
  const membership = { skuCode: sku.code!, admitted: true, offerVersion: "example:open" };
  data.payload.product.sharedContent.offerMemberships = [membership];
  data.payload.product.sharedContent.requestedModes = [{ skuCode: sku.code!, modes: ["one_time"] }];
  data.payload.publication.operations.push({ op: "set_offer_membership", ...membership });
  if (kind === "eligibility") data.payload.publication.operations.push({
    op: "set_eligibility", skuCode: sku.code!, sellableStandalone: true, sellableInSubscription: false,
  });
}

function media(data: Fixture, skuCode = "ARTICLE") {
  data.payload.product.sharedContent.presentation = { mediaRef: "example:media" };
  operation(data, "set_product_presentation", { presentation: data.payload.product.sharedContent.presentation });
  data.payload.publication.evidence.media = [{ skuCode, mediaRef: "example:media", assetRefs: [], revisionDigest: "d".repeat(64) }];
}

function facade(data: Fixture, deps?: Partial<CatalogCandidatePublicationDeps>, legacy = false) {
  const wiring: CatalogCandidateDeps = { readDraft: async () => data.record, registry: data.registry,
    installedDefinitionDigest: async () => data.installedDefinitionDigest, resolveHead: async () => data.expectedHead,
    currentHead: async () => data.expectedHead ? { outcome: "found", head: data.expectedHead, documentRef: "example:document", observations: [] }
      : { outcome: "unpublished" } };
  if (!legacy) wiring.publication = { rules: data.rules!, readEvidence: async () => data.evidence,
    ...data.observations, ...deps };
  return createCatalogCandidateService(wiring);
}

const cases: Case[] = [
  { id: "D-031 create registers its first exact document" },
  { id: "D-033 presentation-only revise retains the omitted roster and primary", fixture: "revision" },
  { id: "D-030 rejects missing unit GTIN on a dark SKU", arrange: data => { data.payload.skus[0]!.identifiers = []; },
    expected: reason("unit_trade_identifier_missing") },
  { id: "D-034 publication fact intent names an incoming SKU", arrange: data => {
    data.payload.product.sharedContent.publicationSkus.push({ ...data.payload.product.sharedContent.publicationSkus[0]!, skuCode: "STRAY" });
  }, expected: reason("intent_sku_absent") },
  { id: "D-034 membership intent names an incoming SKU", arrange: data => {
    data.payload.product.sharedContent.offerMemberships.push({ skuCode: "STRAY", offerVersion: "example:open", admitted: false });
  }, expected: reason("intent_sku_absent") },
  { id: "D-034 requested-mode intent names an incoming SKU", arrange: data => {
    data.payload.product.sharedContent.requestedModes.push({ skuCode: "STRAY", modes: [] });
  }, expected: reason("intent_sku_absent") },
  { id: "D-039 J-1 create action must agree with its draft", arrange: data => { data.payload.product.sharedContent.catalogAction = "revise"; },
    expected: reason("catalog_action_conflict") },
  { id: "D-039 create name must agree with the installed document", arrange: data => operation(data, "create_product", { name: "Unrelated" }),
    expected: reason("catalog_publication_product_name_source_mismatch") },
  { id: "D-040 an exact registered document can supply the create name", arrange: data => { delete data.payload.product.sharedContent.document; } },
  { id: "D-041 H-1 create SKU binds the authored document revision", arrange: data => operation(data, "create_sku", { documentRevisionNo: 2 }),
    expected: reason("catalog_publication_v3_compile_document_stale") },
  { id: "D-041 binds the earlier effective pointer", arrange: data => {
    const operations = data.payload.publication.operations;
    [operations[2], operations[3]] = [operations[3]!, operations[2]!];
  }, expected: reason("catalog_publication_v3_compile_document_stale") },
  { id: "D-045 document sourceRef is bound despite the same UUID", arrange: data => operation(data, "register_document_revision", { sourceRef: "example:wrong" }),
    expected: reason("catalog_publication_document_source_mismatch") },
  { id: "D-046 digest precedes document decoding", arrange: data => operation(data, "register_document_revision", { canonicalText: "not JSON" }),
    expected: reason("catalog_publication_v3_document_digest_mismatch") },
  { id: "D-046 identity precedes canonicality", arrange: data => {
    const canonicalText = ' { "schemaVersion": 8 } ';
    const digest = createHash("sha256").update(canonicalText).digest("hex");
    data.payload.product.documentRevision!.digest = digest;
    operation(data, "register_document_revision", { canonicalText, digest });
  }, expected: reason("catalog_publication_v3_document_invalid") },
  { id: "D-046 right identity still requires canonical bytes", arrange: data => {
    const canonicalText = " " + canonicalCatalogDraftJson(data.payload.product.sharedContent.document);
    const digest = createHash("sha256").update(canonicalText).digest("hex");
    data.payload.product.documentRevision!.digest = digest;
    operation(data, "register_document_revision", { canonicalText, digest });
  }, expected: reason("catalog_publication_v3_document_not_canonical") },
  { id: "D-064 receipt key is independent of the draft and head", arrange: data => { data.evidence!.drafts[0]!.receipt.commandKey = "draft:wrong"; },
    expected: reason("catalog_publication_source_mismatch") },
  { id: "D-064 receipt fingerprint is independent of the draft and head", arrange: data => { data.evidence!.drafts[0]!.receipt.fingerprint = "a".repeat(64); },
    expected: reason("catalog_publication_source_mismatch") },
  { id: "D-065 valid receipt still requires the correct open-head owner", arrange: data => { data.evidence!.drafts[0]!.head!.productId = "wrong"; },
    expected: reason("catalog_publication_draft_advanced") },
  { id: "D-032 G-5 enabling checks authored gross even when retained gross and gate are green", fixture: "revision",
    arrange: data => activate(data, "eligibility", false),
    expected: ["catalog_publication_gross_mass_required", null, "catalog_publication_gross_mass_required"] },
  { id: "D-069 J-2 admitted membership on an already eligible SKU uses authored gross", fixture: "revision",
    arrange: data => activate(data, "membership", false),
    expected: ["catalog_publication_gross_mass_required", null, "catalog_publication_gross_mass_required"] },
  { id: "D-073 J-2 orphan claim refuses even on a dark batch", arrange: data => media(data, "ORPHAN"),
    expected: reason("catalog_publication_media_evidence_mismatch") },
  { id: "D-075 compares media sets in the carrier order", arrange: data => {
    media(data);
    data.payload.publication.evidence.media![0]!.assetRefs = ["\u{10000}", "\ue000"];
    data.payload.skus[0]!.assetRefs = ["\ue000", "\u{10000}"];
  }, media: async () => true },
  { id: "D-076 WB-2 retained asset omission needs new media proof", fixture: "revision", arrange: data => {
    activate(data, "eligibility");
    data.evidence!.skus[0]!.assetRefs.push("example:retained");
    data.payload.product.sharedContent.presentation = { mediaRef: "example:media" };
    operation(data, "set_product_presentation", { presentation: data.payload.product.sharedContent.presentation });
  }, expected: ["catalog_publication_media_validation_unavailable", null, "catalog_publication_media_validation_unavailable"] },
  { id: "D-076 H-2 positive activation never replaces rejected proof", fixture: "revision", arrange: data => {
    activate(data, "eligibility"); media(data);
  }, media: async () => false, expected: ["catalog_publication_media_readiness_unproven", null, "catalog_publication_media_readiness_unproven"] },
  { id: "D-076 proven authored claim reaches activation", fixture: "revision", arrange: data => {
    activate(data, "eligibility"); media(data);
  }, media: async () => true, activationReady: true },
  { id: "D-085 frozen membership no-op refuses at its own prefix", fixture: "revision", arrange: data => {
    const sku = structuredClone(input().payload.skus[0]!);
    data.payload.skus = [sku];
    const intent = { skuCode: sku.code!, offerVersion: "example:frozen", admitted: false };
    data.evidence!.skus[0]!.memberships = [{ offerVersion: intent.offerVersion, admitted: false }];
    data.payload.product.sharedContent.offerMemberships = [intent];
    data.payload.publication.operations.push({ op: "set_offer_membership", ...intent });
  }, expected: reason("catalog_publication_membership_change_not_allowed") },
  { id: "D-088 J-3 intermediate route checked before clear and a later archive refusal", fixture: "revision", arrange: data => {
    data.payload.product.sharedContent.presentation = {};
    operation(data, "set_product_presentation", { presentation: {} });
    data.payload.skus = [structuredClone(input().payload.skus[0]!)];
    data.payload.publication.operations.push({ op: "set_product_presentation", productSlug: "article", presentation: null },
      { op: "set_sku_status", skuCode: "ARTICLE", status: "archived" });
  }, readiness: routeConflict, expected: reason("duplicate_route") },
  { id: "D-032 unknown route cannot hide later hard prefix failure", fixture: "revision", arrange: data => {
    data.payload.skus = [structuredClone(input().payload.skus[0]!)];
    data.payload.publication.operations.push({ op: "set_sku_status", skuCode: "ARTICLE", status: "archived" });
  }, readiness: async () => null, expected: reason("catalog_publication_v3_compile_archive_refused") },
  { id: "D-036 new SKU intent cannot disappear without an effect", arrange: data => {
    const sku = { ...data.payload.skus[0]!, id: "20000000-0000-4000-8000-000000000002", code: "SECOND",
      identifiers: [{ scheme: "gs1:gtin", issuer: "example", value: "4006381333931", packagingLevel: "unit" as const }] };
    data.payload.skus.push(sku);
    data.payload.product.dimensions = ["style"];
    data.definition = { ...data.definition, dimensions: [{ key: "style", kind: "choice", values: ["one", "two"] }],
      axes: [{ key: "style", attributeKey: "style" }],
      attributes: [{ key: "style", scope: "variant", valueType: { kind: "enum", values: [{ id: "one" }, { id: "two" }] },
        filterable: false, facetable: false, public: true, required: false, cardinality: { min: 0, max: 1 }, displayOrder: 0, labels: {} }] };
    data.registry = { resolve: () => data.definition };
    data.installedDefinitionDigest = catalogDefinitionDigest(data.definition);
    data.payload.skus[0]!.options = { "style": { kind: "choice", value: "one" } };
    data.payload.skus[1]!.options = { "style": { kind: "choice", value: "two" } };
  }, expected: reason("catalog_publication_sku_effect_missing") },
  { id: "D-052 create must materialize every authored identifier", arrange: data => {
    data.payload.publication.operations = data.payload.publication.operations.filter(value => value.op !== "create_identifier");
  }, expected: reason("catalog_publication_identifier_effect_missing") },
  { id: "D-061 authored gross below net is a hard dark refusal", arrange: data => {
    data.payload.skus[0]!.grossMass = { dimension: "mass", unit: "openlup:kg", unscaled: "99", scale: 3 };
  }, expected: reason("catalog_publication_gross_below_net") },
  { id: "D-077 absent requested modes allow explicit withdrawal", fixture: "revision", arrange: data => {
    activate(data, "eligibility");
    data.payload.product.sharedContent.requestedModes = [];
    operation(data, "set_eligibility", { sellableStandalone: false });
  } },
  { id: "D-078 unknown retained bytes cannot hide a hard archive refusal", fixture: "revision", arrange: data => {
    data.evidence.documents = [];
    data.payload.skus = [structuredClone(input().payload.skus[0]!)];
    data.payload.publication.operations.push({ op: "set_sku_status", skuCode: "ARTICLE", status: "archived" });
  }, expected: reason("catalog_publication_v3_compile_archive_refused") },
  { id: "D-089 retained route participates on a revision with no presentation write", fixture: "revision", arrange: data => {
    data.payload.product.sharedContent.presentation = {};
    data.payload.publication.operations = [{ op: "set_product_status", productSlug: "article", status: "archived" }];
  }, readiness: routeConflict, expected: reason("duplicate_route") },
  { id: "D-076 unresolved explicit dark proof stays unknown", arrange: data => media(data),
    expected: ["catalog_publication_media_validation_unavailable", null, "catalog_publication_media_validation_unavailable"] },
  { id: "D-094 malformed positive route verdict is unavailable", readiness: async () => ({ ready: true, reasons: ["malformed"] }),
    expected: reason("catalog_publication_presentation_unavailable") },
];

it.each(cases)("shared evaluator parity $id", async ({ fixture, arrange, expected = [null, null, null], readiness, media: proof, activationReady }) => {
  const data = fixture === "revision" ? await revision() : input();
  arrange?.(data);
  const assessActivation = vi.fn<NonNullable<CatalogCandidatePublicationDeps["assessActivation"]>>(ready);
  const observations = { presentationReadiness: vi.fn(readiness ?? ready), ...(proof ? { verifyMedia: proof } : {}), assessActivation };
  const service = facade(data, observations);
  const query = { draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: data.expectedHead };
  const before = canonicalCatalogDraftJson(data.payload);
  const preview = await service.prepareCandidate(query);
  expect(await service.validate(preview.candidateRef)).toEqual(preview);
  expect(await service.compareCandidate({ ...preview, expectedHead: data.expectedHead })).toEqual(preview);
  expect(preview.issues.find(issue => !issue.code.endsWith("_unavailable"))?.code ?? preview.issues[0]?.code ?? null).toBe(expected[0]);
  for (const [index, mode] of ["first-decision", "compile"].entries()) {
    const result = compileCatalogPublication({ ...data, observations }, mode as "first-decision" | "compile");
    if (expected[index + 1]) await expect(result).rejects.toMatchObject({ code: expected[index + 1] });
    else await expect(result).resolves.toHaveProperty("product.id", data.record.productId);
  }
  expect(canonicalCatalogDraftJson(data.payload)).toBe(before);
  if (activationReady) {
    expect(preview.preparation?.activation.outcome).toBe("ready");
    expect(assessActivation).toHaveBeenCalledTimes(4);
  }
  for (const [state, , verified] of assessActivation.mock.calls) {
    expect(Object.keys(state).sort()).toEqual(["product", "skus"]);
    if (activationReady) expect(verified).toEqual(data.payload.publication.evidence.media);
  }
});

it("J-7 K-1 L-1 refuses different executable bytes and a copied handle under the installed digest", async () => {
  const data = input(), declared = data.definition.validatorRef!;
  const alternate = artifact.replace('classifySkuChange: () => "compatible"', 'classifySkuChange: () => "material"');
  expect(() => loadCatalogPublicationRules(declared, Buffer.from(alternate))).toThrow("catalog_publication_rules_digest_mismatch");
  await expect(compileCatalogPublication({ ...data, rules: Object.freeze({ ...data.rules }) }))
    .rejects.toMatchObject({ code: "catalog_publication_rules_binding_mismatch" });
  await expect(compileCatalogPublication({ ...data, rules: setupRules(alternate).rules }))
    .rejects.toMatchObject({ code: "catalog_publication_rules_binding_mismatch" });
  await expect(compileCatalogPublication(data)).resolves.toHaveProperty("product.id", data.record.productId);
});

it("D-032 legacy facade wiring reports unknown across all three methods", async () => {
  const data = await revision();
  activate(data, "eligibility");
  const service = facade(data, undefined, true);
  const prepared = await service.prepareCandidate({ draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: data.expectedHead });
  expect(prepared.preparation).toMatchObject({ structural: { outcome: "unknown" }, activation: { outcome: "unknown" } });
  expect(prepared.issues).toContainEqual({ path: "publication", code: "publication_preparation_unavailable" });
  expect(await service.validate(prepared.candidateRef)).toEqual(prepared);
  expect(await service.compareCandidate({ ...prepared, expectedHead: data.expectedHead })).toEqual(prepared);
});

it("K-3 document-free published content round-trips while the authored draft retains its document", async () => {
  const data = input();
  const { product, skus } = await compileCatalogPublication(data);
  const manifest = { schemaVersion: 2, product, skus: [{ skuId: skus[0]!.id,
    revisionId: "50000000-0000-4000-8000-000000000002", revision: 1, digest: publicationDigest(skus[0]) }] };
  expect(catalogPublicationManifestSchema.parse(JSON.parse(publicationJson(manifest)))).toEqual(manifest);
  const document = data.payload.product.sharedContent.document;
  expect(document).toBeDefined();
  expect(product.content).not.toHaveProperty("document");
  expect(product.document).toEqual(data.payload.product.documentRevision);
  expect(catalogPublicationManifestSchema.safeParse({ ...manifest, product: { ...product, content: { ...product.content, document } } }).success).toBe(false);
});

it("cycle1 publication envelope exact UTF-8 boundary", () => {
  const limit = CATALOG_PUBLICATION_LIMITS.skuBytes;
  const text = "é".repeat((limit - 2) / 2);
  expect(Buffer.byteLength(publicationJson(text, limit))).toBe(limit);
  expect(() => publicationJson(text + "x", limit)).toThrow("catalog_publication_envelope_too_large");
});

it("W33 complete generated promotions must be present in the sealed draft", async () => {
  const data = await revision();
  activate(data, "eligibility");
  data.evidence.product!.status = "draft";
  data.evidence.skus[0]!.status = "draft";
  data.observations = { presentationReadiness: ready };
  await expect(compileCatalogPublication(data, "first-decision")).rejects.toThrow("catalog_publication_activation_effect_missing");
  data.record.payload = compileCatalogPublicationDraft(data.payload, data.payload.product.sharedContent.presentation, data.evidence);
  expect((await compileCatalogPublication(data, "first-decision")).operations.filter(operation =>
    operation.op === "set_product_status" || operation.op === "set_sku_status").map(operation => operation.op))
    .toEqual(["set_sku_status", "set_product_status"]);
});

it("a valid hash still requires a self-contained executable", () => {
  const bytes = Buffer.from('const ambient = require("missing");\n' + artifact);
  const digest = createHash("sha256").update(bytes).digest("hex");
  expect(() => loadCatalogPublicationRules(`sha256:${digest}`, bytes)).toThrow("catalog_publication_rules_module_invalid");
});
