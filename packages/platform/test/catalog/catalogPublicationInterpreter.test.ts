import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createCatalogCandidateService, type CatalogCandidateDeps } from "../../src/catalog/candidate.js";
import { createCatalogCandidateServiceWithPublication } from "../../src/catalog/candidateService.js";
import { catalogDefinitionDigest } from "../../src/catalog/catalogDefinitionDigest.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";
import { CATALOG_PUBLICATION_LIMITS } from "../../src/catalog/contracts/publication.js";
import { catalogPublicationManifestSchema, catalogPublishedSkuSchema, publicationDigest, publicationJson } from "../../src/catalog/publicationCodec.js";
import { loadCatalogPublicationRules } from "../../src/catalog/publicationRules.js";
import { loadCatalogRules, withCatalogPublicationRules } from "../../src/catalog/catalogPublicationRules.js";
import type { CatalogCandidateIssue } from "../../src/catalog/contracts/candidate.js";
import { installCatalogDefinitions } from "../../src/catalog/installCatalogDefinitions.js";
import { catalogPackManifest } from "../../src/catalog/catalogPackManifest.js";
import { assertCatalogPublicationGrossMass, assertCatalogPublicationPreparation, catalogPublicationClaim, compileCatalogPublication } from "../../src/catalog/publicationValidation.js";
import type { PublicationDraftRecord, PublicationIntent } from "../../src/catalog/publicationIntent.js";
import { compileCatalogPublicationDraft } from "../../src/catalog/publicationDraft.js";
import type { CatalogCandidatePublicationDeps } from "../../src/catalog/publicationEvidence.js";
import { artifact, input, revision, setupRules, type PublicationFixture } from "./fixtures/publicationInput.js";

type Fixture = PublicationFixture;
type Verdict = [preview: string | null, firstDecision: string | null, compile: string | null];
type Case = { id: string; fixture?: "revision"; arrange?: (data: Fixture) => void; expected?: Verdict;
  readiness?: CatalogCandidatePublicationDeps["presentationReadiness"]; media?: CatalogCandidatePublicationDeps["verifyMedia"];
  activationReady?: boolean; governed?: (data: Fixture) => PublicationIntent & { schemaVersion: 4 };
  priceListRefusal?: boolean;
  outcome?: "blocked-input" | "unknown";
  diagnostic?: Partial<CatalogCandidateIssue>;
  rulesAsset?: string;
  substitute?: boolean;
  currentHead?: CatalogCandidateDeps["currentHead"];
  routeCalls?: readonly [number, number, number];
  evidenceCalls?: number;
  preserve?: boolean;
  evaluation?: CatalogCandidatePublicationDeps["evaluation"];
};
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

function facade(data: Fixture, deps?: Partial<CatalogCandidatePublicationDeps>, legacy = false, record: PublicationDraftRecord = data.record, currentHead?: CatalogCandidateDeps["currentHead"]) {
  const wiring: CatalogCandidateDeps = { readDraft: async () => data.record, registry: data.registry,
    validatePrices: data.validatePrices,
    installedDefinitionDigest: async () => data.installedDefinitionDigest, resolveHead: async () => data.expectedHead,
    currentHead: currentHead ?? (async () => data.expectedHead ? { outcome: "found", head: data.expectedHead, documentRef: "example:document", observations: [] }
      : { outcome: "unpublished" }) };
  return legacy ? createCatalogCandidateService(wiring) : createCatalogCandidateServiceWithPublication({ ...wiring, readDraft: async () => record }, {
    readEvidence: async () => ({ ...data.evidence, drafts: [{ ...data.evidence.drafts[0]!, record }, ...data.evidence.drafts.slice(1)] }),
    ...data.observations, ...deps,
  });
}

const priceList = "60000000-0000-4000-8000-000000000001";
function withPrice(data: Fixture) {
  const sku = data.payload.skus[0]!;
  sku.priceOperations = [{ schemaVersion: 1, commandKey: "example:price", priceListId: priceList, variantId: sku.id,
    mode: "one_time", minQty: 1, amountKind: "gross", unitPriceMinor: 100, expected: { entryId: null, unitPriceMinor: null } }];
}
function governedDraft(data: Fixture) { return { ...data.payload, schemaVersion: 4 as const }; }
function withdrawnDraft(data: Fixture) {
  activate(data, "eligibility");
  data.evidence.skus[0]!.sellableStandalone = false;
  data.evidence.lifecycle = { product: "withdrawn", skus: { ARTICLE: { state: "withdrawn" } } };
  withPrice(data);
}
function restoredDraft(data: Fixture, beforeEligibility: boolean) {
  const draft = governedDraft(data), operations = [...draft.publication.operations];
  const restoreAt = beforeEligibility ? operations.findIndex(op => op.op === "set_eligibility") : operations.length;
  operations.splice(restoreAt, 0, { op: "restore_product", productSlug: "article", expectedState: "withdrawn" },
    { op: "restore_sku", skuCode: "ARTICLE", expectedState: "withdrawn" });
  return { ...draft, publication: { ...draft.publication, operations } };
}
function retainedMedia(data: Fixture) {
  media(data);
  const record = { ...input().record, draftId: "30000000-0000-4000-8000-000000000002" };
  record.payload.product.sharedContent.presentation = { mediaRef: "example:media" };
  const claim = catalogPublicationClaim(record);
  data.evidence.skus[0]!.source = claim;
  data.evidence.drafts.push({ record, receipt: claim, head: record });
}
const routeAt = (index: number): Partial<CatalogCandidateIssue> =>
  ({ phase: "structural", path: `publication.operations.${index}`, subject: "example:article" });
function pointerBeforeRoute(data: Fixture) {
  data.payload.publication.operations.unshift({ op: "move_document_pointer", productSlug: "article", documentRevisionNo: 1 });
}
function withdraw(data: Fixture) {
  const product = data.evidence.product!;
  const sku = data.evidence.skus[0]!;
  product.status = "active";
  Object.assign(sku, { status: "active", sellableStandalone: true, sellableInSubscription: true });
  data.evidence.lifecycle = { product: "active", skus: { ARTICLE: { state: "active" } } };
  data.payload.product.sharedContent.presentation = structuredClone(product.content.presentation);
  return { ...governedDraft(data), publication: { ...data.payload.publication, operations: [
    { op: "set_product_lifecycle" as const, productSlug: "article", expectedState: "active" as const,
      state: "withdrawn" as const, children: [{ skuCode: "ARTICLE", expectedState: "active" as const }] },
  ] } };
}
const productRefusal = artifact.replace("validateProduct: () => []", 'validateProduct: () => ["product_rule_rejected"]');
const exactDocument = (data: Fixture) => canonicalCatalogDraftJson(data.payload.product.sharedContent.document);
const copiedPresentation = (data: Fixture, suffix = "") => {
  data.payload.product.sharedContent.presentation = { title: exactDocument(data) + suffix };
  operation(data, "set_product_presentation", { presentation: data.payload.product.sharedContent.presentation });
};
const unreadableHead = { publicationId: "head", revision: 1, documentDigest: "unavailable" };
const cases: Case[] = [
  { id: "the selected definition rejects replacement callbacks before evidence", substitute: true,
    expected: reason("catalog_publication_rules_binding_mismatch"), diagnostic: { phase: "structural", path: "product.type", subject: "example:article" },
    routeCalls: [0, 0, 0], evidenceCalls: 0 },
  { id: "saved membership is checked before an earlier colliding route", fixture: "revision", arrange: data => {
    activate(data, "membership");
    data.payload.product.sharedContent.offerMemberships = [];
  }, readiness: routeConflict, expected: reason("catalog_publication_membership_source_mismatch"),
  diagnostic: { phase: "structural", path: "publication.operations.1", subject: "ARTICLE" }, routeCalls: [0, 0, 0] },
  { id: "valid saved membership exposes the colliding route", fixture: "revision", arrange: data => activate(data, "membership"),
    readiness: routeConflict, expected: reason("duplicate_route"), diagnostic: routeAt(0), routeCalls: [1, 1, 1] },
  { id: "materialized identity is checked before an earlier colliding route", fixture: "revision", arrange: data => {
    activate(data, "eligibility");
    data.payload.skus[0]!.netContent!.unscaled = "101";
  }, readiness: routeConflict, expected: reason("catalog_publication_operation_source_mismatch"),
  diagnostic: { phase: "structural", path: "skus.0", subject: "ARTICLE" }, routeCalls: [0, 0, 0] },
  { id: "valid materialized identity exposes the colliding route", fixture: "revision", arrange: data => activate(data, "eligibility"),
    readiness: routeConflict, expected: reason("duplicate_route"), diagnostic: routeAt(0), routeCalls: [1, 1, 1] },
  ...(["absent", "malformed"] as const).flatMap(kind => [true, false].map(collision => ({
    id: `a ${kind} document read after a pointer ${collision ? "allows a route refusal" : "reports an unavailable check"}`,
    fixture: "revision" as const, arrange(data: Fixture) {
      pointerBeforeRoute(data);
      if (kind === "absent") data.evidence.documents = [];
      else Reflect.deleteProperty(data.evidence.documents[0]!, "canonicalText");
    }, ...(collision && { readiness: routeConflict }),
    expected: reason(collision ? "duplicate_route" : "catalog_publication_document_bytes_unavailable"),
    diagnostic: collision ? routeAt(1) : { phase: "structural" as const, path: "product.documentRevision", subject: "example:article" },
    outcome: collision ? "blocked-input" as const : "unknown" as const, routeCalls: [1, 1, 1] as const,
  }))),
  { id: "a certified wrong document tuple refuses before routes", fixture: "revision", arrange: data => {
    pointerBeforeRoute(data);
    data.evidence.documents[0]!.reference.documentRef = "example:other";
  }, readiness: routeConflict, expected: reason("catalog_publication_document_source_mismatch"),
  diagnostic: { phase: "structural", path: "product.documentRevision", subject: "example:article" }, routeCalls: [0, 0, 0] },
  { id: "an unreadable head cannot hide an independent route collision", fixture: "revision",
    arrange: data => { pointerBeforeRoute(data); data.evidence.head = unreadableHead; }, readiness: routeConflict,
    currentHead: async () => ({ outcome: "found", head: unreadableHead, documentRef: "example:document", observations: [] }),
    expected: reason("duplicate_route"), diagnostic: routeAt(1), routeCalls: [1, 1, 1] },
  { id: "an unreadable head leaves preparation unknown if the route passes", fixture: "revision",
    arrange: data => { pointerBeforeRoute(data); data.evidence.head = unreadableHead; },
    currentHead: async () => ({ outcome: "found", head: unreadableHead, documentRef: "example:document", observations: [] }),
    expected: reason("catalog_publication_read_invalid"), outcome: "unknown",
    diagnostic: { phase: "structural", path: "publication", subject: "example:article" }, routeCalls: [1, 1, 1] },
  { id: "a legacy wire cannot bypass a withdrawn authoritative head", fixture: "revision", arrange: withdrawnDraft,
    expected: reason("catalog_lifecycle_raw_status_fenced"), diagnostic: { phase: "structural", path: "publication", subject: "example:article" },
    routeCalls: [0, 0, 0] },
  { id: "an incomplete authoritative roster is unavailable", fixture: "revision", arrange: data => {
    withdrawnDraft(data); data.evidence.lifecycle!.skus = {};
  }, governed: governedDraft, expected: reason("catalog_lifecycle_evidence_unavailable"), outcome: "unknown",
  diagnostic: { phase: "structural", path: "publication", subject: "example:article" }, routeCalls: [1, 1, 1] },
  { id: "a governed withdrawal preserves the retained content and provenance", fixture: "revision", governed: withdraw,
    rulesAsset: productRefusal, preserve: true, routeCalls: [0, 0, 0] },
  { id: "a governed withdrawal refuses an unrelated overlay", fixture: "revision", governed: data => {
    const payload = withdraw(data);
    payload.product.sharedContent.presentation = { title: "Unrelated edit" };
    return payload;
  }, rulesAsset: productRefusal, expected: reason("catalog_lifecycle_withdrawal_overlay_refused"),
    diagnostic: { phase: "structural", path: "product", subject: "example:article" }, routeCalls: [0, 0, 0] },
  { id: "the published codec rejects an exact copy of the selected document", arrange: data => copiedPresentation(data),
    expected: reason("catalog_publication_document_text_copied"),
    diagnostic: { phase: "structural", path: "product.presentation.title", subject: "example:article" }, routeCalls: [1, 1, 1] },
  { id: "the published codec accepts distinct JSON-looking display text", arrange: data => copiedPresentation(data, " "), routeCalls: [1, 1, 1] },
  ...[[100, 100], [200, 100], [10_000_000], [1, 9_999_999]].map((weights, index): Case => ({
    id: `presentation requires ascending distinct supported weights (${weights.join(", ")})`,
    arrange(data) {
      data.payload.product.sharedContent.presentation = { advertisedWeightsG: weights };
      operation(data, "set_product_presentation", { presentation: data.payload.product.sharedContent.presentation });
    }, ...(index < 3 ? { expected: reason("catalog_publication_presentation_invalid"), routeCalls: [0, 0, 0],
      diagnostic: { phase: "structural", path: "product.sharedContent.presentation.advertisedWeightsG", subject: "example:article" } }
      : { routeCalls: [1, 1, 1] }),
  })),
  { id: "a newer same-code retained row cannot hide its actual SKU", fixture: "revision", arrange: data => {
    retainedMedia(data);
    const newer = structuredClone(data.evidence.drafts[1]!);
    newer.record.draftId = "30000000-0000-4000-8000-000000000003";
    newer.record.payload.skus[0]!.id = "20000000-0000-4000-8000-000000000009";
    newer.record.payload.product.primarySkuId = newer.record.payload.skus[0]!.id;
    newer.receipt = catalogPublicationClaim(newer.record);
    newer.head = newer.record;
    data.evidence.drafts.splice(1, 0, newer);
  }, media: async () => true, routeCalls: [1, 1, 1] },
  { id: "pure hooks share the explicit instant, locale and time zone", evaluation: {
    evaluatedAt: "2001-01-01T00:00:00Z", locale: "en-GB", timeZone: "UTC" },
    rulesAsset: artifact.replace("validateContent: () => []", `validateContent: (_content, evaluation) =>
      evaluation.evaluatedAt === "2001-01-01T00:00:00Z" && evaluation.locale === "en-GB" && evaluation.timeZone === "UTC"
      ? [] : [{ path: "", code: "wrong_context" }]`), routeCalls: [1, 1, 1] },
  { id: "D-031 create registers its first exact document" },
  { id: "D-033 presentation-only revise retains the omitted roster and primary", fixture: "revision" },
  { id: "D-030 rejects missing unit GTIN on a dark SKU", arrange: data => { data.payload.skus[0]!.identifiers = []; },
    expected: reason("unit_trade_identifier_missing"),
    diagnostic: { path: "skus.0.identifiers", phase: "structural", subject: "ARTICLE" } },
  { id: "A-3 a withdrawn product and SKU require restore before becoming sellable", fixture: "revision",
    arrange: withdrawnDraft, governed: governedDraft, expected: reason("catalog_lifecycle_fresh_sale_refused") },
  { id: "B-5 restore after the enabling prefix is too late", fixture: "revision", arrange: withdrawnDraft,
    governed: data => restoredDraft(data, false), expected: reason("catalog_lifecycle_fresh_sale_refused") },
  { id: "B-5 eligible after both authoritative states are restored", fixture: "revision", arrange: withdrawnDraft,
    governed: data => restoredDraft(data, true) },
  { id: "A-4 a presentation field cannot carry the authored document", arrange: data => {
    data.payload.product.sharedContent.presentation = { copy: data.payload.product.sharedContent.document! };
    operation(data, "set_product_presentation", { presentation: data.payload.product.sharedContent.presentation });
  }, expected: reason("catalog_publication_presentation_invalid") },
  { id: "A-4 an SKU fact cannot carry the authored document", arrange: data => {
    const facts = { derived: data.payload.product.sharedContent.document! };
    data.payload.product.sharedContent.publicationSkus[0]!.facts = facts;
    operation(data, "create_sku", { facts });
  }, expected: reason("catalog_publication_facts_invalid") },
  { id: "A-5 zero mass reaches the same ingress refusal", arrange: data => { data.payload.skus[0]!.netContent!.unscaled = "0"; },
    expected: reason("catalog_publication_integral_grams_required"),
    diagnostic: { path: "skus.0.netContent", phase: "structural", subject: "ARTICLE" } },
  { id: "A-6 module state cannot survive repeated phase observations",
    rulesAsset: `let calls = 0; ${artifact.replace("validateContent: () => []", 'validateContent: () => ++calls === 1 ? [] : [{ path: "", code: "state_leaked" }]')}` },
  ...([
    ["throw new Error('unexpected input');", "throw"],
    ["return undefined;", "undefined_result"],
    ["return null;", "invalid_result"],
    ["return [{ path: '<operator>', code: 'untrusted message' }];", "invalid_result"],
    ["return Date.now();", "realm_limit"],
    ["return Math.random();", "realm_limit"],
    ["return require('example:dependency');", "realm_limit"],
  ] as const).map(([body, cause]): Case => ({ id: `B-1 local and publication dispatch report ${body}`,
    rulesAsset: artifact.replace("validateContent: () => []", `validateContent: () => { ${body} }`),
    expected: reason("catalog_publication_rule_failed"),
    diagnostic: { path: "product.sharedContent", phase: "structural", subject: "example:article", hook: "validateContent", cause } })),
  { id: "A-7 an invalid retained read cannot hide the authored route refusal", fixture: "revision",
    arrange: data => { data.evidence.product!.name = ""; }, readiness: routeConflict, expected: reason("duplicate_route"),
    outcome: "blocked-input" },
  { id: "A-7 an invalid retained read is unavailable when the authored route passes", fixture: "revision",
    arrange: data => { data.evidence.product!.name = ""; }, expected: reason("catalog_publication_read_invalid"), outcome: "unknown" },
  { id: "A-8 retained media follows the selected receipt and authored tuple", fixture: "revision",
    arrange: retainedMedia, media: async () => true },
  { id: "A-8 a different retained media tuple refuses", fixture: "revision", arrange: data => {
    retainedMedia(data);
    data.payload.publication.evidence.media![0]!.mediaRef = "example:different";
  }, media: async () => true, expected: reason("catalog_publication_media_evidence_mismatch") },
  { id: "A-8 a different retained receipt refuses", fixture: "revision", arrange: data => {
    retainedMedia(data);
    data.evidence.drafts[1]!.receipt = { ...data.evidence.drafts[1]!.receipt, fingerprint: "f".repeat(64) };
  }, media: async () => true, expected: reason("catalog_publication_source_mismatch") },
  { id: "A-10 installed rules keep their configured refusal", rulesAsset: artifact.replace("validateProduct: () => []", 'validateProduct: () => ["package_unsupported"]'),
    expected: reason("package_unsupported"), diagnostic: { path: "product", phase: "structural", subject: "example:article" } },
  { id: "A-12 omitted SKU attributes keep the effective projection byte bound", fixture: "revision", arrange: data => {
    data.definition = { ...data.definition, attributes: [{ key: "label", scope: "variant", public: true,
      valueType: { kind: "text", maxLength: 2048 }, required: false, cardinality: { min: 0, max: 1 },
      filterable: false, facetable: false, displayOrder: 0, labels: {} }] };
    data.registry = { resolve: () => data.definition };
    data.installedDefinitionDigest = catalogDefinitionDigest(data.definition);
    data.evidence.skus[0]!.attributes = { label: "é".repeat(1025) };
  }, expected: reason("attribute_projection_text_too_large") },
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
    const canonicalText = " " + canonicalCatalogDraftJson({ ...data.payload.product.sharedContent.document, schemaVersion: 8 });
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
  { id: "D-065 valid receipt still requires the correct open-head owner", arrange: data => { data.evidence!.drafts[0]!.head!.productId = "10000000-0000-4000-8000-000000000009"; },
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
  { id: "governed create stages with its price before activation", arrange: withPrice, governed: governedDraft },
  { id: "governed first activation requires an already materialized SKU", arrange: data => {
    withPrice(data);
    data.payload.product.sharedContent.requestedModes = [{ skuCode: "ARTICLE", modes: ["one_time"] }];
    data.payload.publication.operations.push({ op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: true, sellableInSubscription: false });
  }, governed: governedDraft, expected: reason("catalog_publication_operation_source_mismatch") },
  { id: "governed lifecycle compares expected state at its ordered prefix", fixture: "revision", arrange: data => {
    data.evidence.lifecycle = { product: "active", skus: { ARTICLE: { state: "active" } } };
  }, governed: data => ({ ...governedDraft(data), publication: { ...data.payload.publication,
    operations: [...data.payload.publication.operations, { op: "set_product_lifecycle", productSlug: "article",
      expectedState: "draft", state: "archived", children: [] }] } }), expected: reason("catalog_lifecycle_state_conflict") },
  { id: "pricing names the selected list and next action", arrange: data => {
    withPrice(data);
    data.validatePrices = async () => [{ path: "skus.0.priceOperations.0", code: "price_list_not_found" }];
  }, expected: ["price_list_not_found", null, "price_list_not_found"], priceListRefusal: true },
  { id: "D-094 malformed positive route verdict is unavailable", readiness: async () => ({ ready: true, reasons: ["malformed"] }),
    expected: reason("catalog_publication_presentation_unavailable") },
];

it.each(cases)("shared evaluator parity $id", async ({ fixture, arrange, expected = [null, null, null], readiness, media: proof, activationReady, governed, priceListRefusal, outcome, diagnostic, rulesAsset, substitute, currentHead, routeCalls, evidenceCalls, preserve, evaluation }) => {
  const bound = rulesAsset === undefined ? {} : setupRules(rulesAsset);
  const data = fixture === "revision" ? await revision() : { ...input(), ...bound };
  if (fixture === "revision") Object.assign(data, bound);
  arrange?.(data);
  const replacement = vi.fn(() => [{ path: "", code: "replacement_called" }]);
  if (substitute) {
    data.definition = { ...data.definition, validateContent: replacement };
    data.registry = { resolve: () => data.definition };
  }
  const assessActivation = vi.fn<NonNullable<CatalogCandidatePublicationDeps["assessActivation"]>>(ready);
  const verifyMedia = proof && vi.fn(proof);
  const observations = { presentationReadiness: vi.fn(readiness ?? ready), ...(verifyMedia ? { verifyMedia } : {}), assessActivation };
  const record = governed ? { ...data.record, payload: governed(data) } : data.record;
  const evidence = { ...data.evidence, drafts: [{ ...data.evidence.drafts[0]!, record }, ...data.evidence.drafts.slice(1)] };
  if (governed && !data.validatePrices) data.validatePrices = async () => [];
  const readEvidence = vi.fn(async () => evidence);
  const service = facade(data, { ...observations, readEvidence, ...(evaluation && { evaluation }) }, false, record, currentHead);
  const checkRouteCalls = (expectedCalls?: number) => {
    if (expectedCalls !== undefined) expect(observations.presentationReadiness).toHaveBeenCalledTimes(expectedCalls);
    observations.presentationReadiness.mockClear();
  };
  const query = { draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: data.expectedHead };
  const before = canonicalCatalogDraftJson(record.payload);
  const preview = await service.prepareCandidate(query);
  checkRouteCalls(routeCalls?.[0]);
  expect(await service.validate(preview.candidateRef)).toEqual(preview);
  checkRouteCalls(routeCalls?.[0]);
  expect(await service.compareCandidate({ ...preview, expectedHead: data.expectedHead })).toEqual(preview);
  checkRouteCalls(routeCalls?.[0]);
  expect(readEvidence).toHaveBeenCalledTimes(evidenceCalls ?? (substitute ? 0 : readEvidence.mock.calls.length));
  expect(replacement).not.toHaveBeenCalled();
  expect(preview.issues.find(issue => !issue.code.endsWith("_unavailable"))?.code ?? preview.issues[0]?.code ?? null).toBe(expected[0]);
  if (outcome) expect(preview.preparation?.structural.outcome).toBe(outcome);
  if (diagnostic) {
    const issues = preview.preparation?.structural.issues;
    expect(issues?.[0]).toEqual(expect.objectContaining({ code: expected[0], ...diagnostic }));
  }
  if (rulesAsset && diagnostic?.cause) expect(() => loadCatalogRules(Buffer.from(rulesAsset)).validateContent({}))
    .toThrow(expect.objectContaining({ code: expected[0], diagnostic: expect.objectContaining({ hook: diagnostic.hook, cause: diagnostic.cause }) }));
  for (const [index, mode] of ["first-decision", "compile"].entries()) {
    const result = compileCatalogPublication({ ...data, record, evidence, observations, ...(evaluation && { evaluation }) }, mode as "first-decision" | "compile");
    if (expected[index + 1]) await expect(result).rejects.toMatchObject({ code: expected[index + 1],
      ...(diagnostic && { diagnostic }), ...(outcome === "unknown" && { outcome: "dependency_unavailable" }) });
    else {
      const compiled = await result;
      expect(compiled.product.id).toBe(data.record.productId);
      if (preserve) {
        expect(compiled.product).toMatchObject({ content: data.evidence.product!.content, source: data.evidence.product!.source });
        expect(compiled.skus).toMatchObject([{ facts: data.evidence.skus[0]!.facts, source: data.evidence.skus[0]!.source,
          sellableStandalone: false, sellableInSubscription: false }]);
        expect(compiled.lifecycle?.product).toBe("withdrawn");
      }
    }
    checkRouteCalls(routeCalls?.[index + 1]);
  }
  expect(canonicalCatalogDraftJson(record.payload)).toBe(before);
  if (priceListRefusal) expect(preview.preparation?.structural.issues).toContainEqual({ code: "price_list_not_found", phase: "pricing",
    path: "skus.0.priceOperations.0", subject: priceList,
    message: "Select an installed price list for this price change, then prepare the draft again." });
  if (activationReady) {
    expect(preview.preparation?.activation.outcome).toBe("ready");
    expect(assessActivation).toHaveBeenCalledTimes(4);
  }
  if (verifyMedia && expected.every(code => code === null))
    expect(verifyMedia.mock.calls).toEqual(Array.from({ length: 4 }, () => [data.payload.publication.evidence.media![0], data.expectedHead]));
  for (const [state, , verified] of assessActivation.mock.calls) {
    expect(Object.keys(state).sort()).toEqual(["product", "skus"]);
    if (activationReady) expect(verified).toEqual(data.payload.publication.evidence.media);
  }
});

it("rules install rejects executable bytes that differ from the declared digest", async () => {
  const data = input(), declared = data.definition.validatorRef!;
  const alternate = artifact.replace("validateContent: () => []", 'validateContent: () => [{ path: "title", code: "title_required" }]');
  expect(() => loadCatalogPublicationRules(declared, Buffer.from(alternate))).toThrow(/attach the build to the product type/);
  await expect(compileCatalogPublication({ ...data, ...setupRules(alternate) })).rejects.toMatchObject({ code: "title_required" });
  await expect(compileCatalogPublication(data)).resolves.toHaveProperty("product.id", data.record.productId);
});

it("A-1 installation requires the verified bytes even after a pack is reconstructed", async () => {
  const data = input();
  const { validateContent: _inline, validatorRef: _pin, ...definition } = data.definition;
  const pack = withCatalogPublicationRules({ id: "example:rules", namespace: "example", version: 1,
    openlupRange: "1.x", types: [definition], taxClasses: [], capabilities: {} }, () => Buffer.from(artifact));
  const manifestDigest = catalogPackManifest(pack).digest;
  const query = vi.fn(async () => ({ rows: [{ receipt: { manifestDigest } }] }));
  const detached = { ...pack, types: [{ ...pack.types[0]!, validateContent: () => [] }] };
  await expect(installCatalogDefinitions({ query }, detached)).rejects.toMatchObject({ code: "catalog_publication_rules_binding_mismatch" });
  expect(query).not.toHaveBeenCalled();
  await expect(installCatalogDefinitions({ query }, { ...pack })).resolves.toMatchObject({ manifestDigest });
  expect(query).toHaveBeenCalledOnce();
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

it("the released v2 facade refuses a substituted callback at the installed identity", async () => {
  const data = input();
  const callback = vi.fn(() => [{ path: "", code: "unexpected_callback" }]);
  data.registry = { resolve: () => ({ ...data.definition, validateContent: callback }) };
  const { publication: _publication, ...payload } = data.payload;
  const record = { ...data.record, payload: { ...payload, schemaVersion: 2 as const } };
  const service = createCatalogCandidateService({ registry: data.registry, readDraft: async () => record,
    installedDefinitionDigest: async () => data.installedDefinitionDigest,
    currentHead: async () => ({ outcome: "unpublished" }), resolveHead: async () => null });
  const preview = await service.prepareCandidate({ draftId: record.draftId, draftRevision: record.revision, expectedHead: null });
  expect(preview.preparation?.structural).toMatchObject({ outcome: "blocked-input", issues: [
    { code: "catalog_publication_rules_binding_mismatch", path: "product.type", phase: "structural", subject: "example:article" },
  ] });
  expect(await service.validate(preview.candidateRef)).toEqual(preview);
  expect(await service.compareCandidate({ ...preview, expectedHead: null })).toEqual(preview);
  expect(callback).not.toHaveBeenCalled();
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
  const disguisedPresentation = { ...product.content, presentation: { copy: document } };
  expect(catalogPublicationManifestSchema.safeParse({ ...manifest, product: { ...product, content: disguisedPresentation } }).success).toBe(false);
  const text = exactDocument(data);
  const display = (title: string) => ({ ...manifest, product: { ...product, presentation: { title } } });
  expect(catalogPublicationManifestSchema.safeParse(display(text)).error?.issues[0]?.path).toEqual(["product", "presentation", "title"]);
  expect(catalogPublicationManifestSchema.safeParse(display(text + " ")).success).toBe(true);
  expect(catalogPublishedSkuSchema.safeParse({ ...skus[0], facts: { derived: document } }).success).toBe(false);
});

it("local dispatch decodes every installed hook result before transport", () => {
  const identity = '{ schemaId: "example:document", documentRef: "example:first", productSlug: "article", revisionNo: 1 }';
  const examples = {
    validateContent: ["[]", "[{ path: '<input>', code: 'refused' }]"],
    validateProduct: ['["not_ready"]', '["unsafe reason!"]'],
    inspectDocument: ['null', '{ ...' + identity + ', canonicallyEncoded: "yes" }'],
    identifyDocument: [identity, '{ ...' + identity + ', revisionNo: 0 }'],
    matchesDocument: ["false", "1"],
    deriveSkuFacts: ['{ computed: null }', '{ computed: NaN }'],
    classifySkuChange: ['"compatible"', '"yes"'],
    validateMembershipChange: ["false", '"false"'],
    validateSkuAmounts: ["true", "[]"],
  };
  for (const [hook, [valid, invalid]] of Object.entries(examples)) {
    const rules = (value: string) => loadCatalogRules(Buffer.from(artifact + `\nmodule.exports.${hook} = () => (${value});`)) as unknown as
      Record<string, (...args: unknown[]) => unknown>;
    expect(rules(valid!)[hook]!()).toBeDefined();
    expect(() => rules(invalid!)[hook]!()).toThrow(expect.objectContaining({ code: "catalog_publication_rule_failed",
      diagnostic: expect.objectContaining({ hook, cause: "invalid_result" }) }));
  }
});

it("cycle1 publication envelope exact UTF-8 boundary", () => {
  const value = { text: "é" }, text = canonicalCatalogDraftJson(value), bytes = Buffer.byteLength(text);
  expect(() => publicationDigest(value, bytes - 1)).toThrow("catalog_publication_envelope_too_large");
  expect(publicationDigest(value, bytes)).toBe(publicationDigest(value, bytes + 1));

  const limit = CATALOG_PUBLICATION_LIMITS.skuBytes;
  const exactLimit = "é".repeat((limit - 2) / 2);
  expect(Buffer.byteLength(publicationJson(exactLimit, limit))).toBe(limit);
  expect(() => publicationJson(exactLimit + "x", limit)).toThrow("catalog_publication_envelope_too_large");
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
  expect(() => loadCatalogPublicationRules(`sha256:${digest}`, bytes)).toThrow(/Product rule module failed.*Remove require/);
});

it.each(["compatible", "material", "inconclusive"] as const)("W25 retained physical change classified as %s", async classification => {
  const installed = setupRules(artifact.replace('classifySkuChange: () => "compatible"', `classifySkuChange: () => "${classification}"`));
  const data = await revision(installed);
  const sku = structuredClone(input().payload.skus[0]!);
  sku.grossMass = { ...sku.netContent!, unscaled: "110" };
  data.payload.skus = [sku];
  const result = compileCatalogPublication(data);
  if (classification === "compatible") await expect(result).resolves.toMatchObject({ skus: [{ id: sku.id, grossMass: sku.grossMass }] });
  else await expect(result).rejects.toMatchObject({ code: "sku_identity_change_requires_new_sku" });
});

it.each(["W50_V6-N001_predicate_precedence_boundary", "W50_V6-N002_predicate_precedence_boundary"])("%s", () => {
  const data = input();
  for (const slug of ["a", "0", "z0_a-b", "a".repeat(64)]) {
    data.payload.product.slug = slug;
    expect(() => assertCatalogPublicationPreparation(data.payload)).not.toThrow();
  }
  for (const slug of [undefined, null, 4, {}, "", "a".repeat(65), "A", "_a", "-a", " a", "a ", "a\na", "ą", "a.b", "a/b"]) {
    Object.assign(data.payload.product, { slug });
    expect(() => assertCatalogPublicationPreparation(data.payload)).toThrow("commerce_product_slug_unsupported");
  }
});

it("W17_V5-1856_predicate_precedence_boundary", () => {
  const { definition } = input();
  const net = { dimension: "mass" as const, unit: "openlup:g", unscaled: "9007199254740993", scale: 9 };
  for (const [unscaled, accepts] of [["9007199254740992", false], ["9007199254740993", true], ["9007199254740994", true]] as const) {
    const compare = () => assertCatalogPublicationGrossMass(net, { ...net, unscaled }, definition);
    if (accepts) expect(compare).not.toThrow();
    else expect(compare).toThrow("catalog_publication_gross_below_net");
  }
  expect(() => assertCatalogPublicationGrossMass({ ...net, unscaled: "100", scale: 0 },
    { ...net, unit: "openlup:kg", unscaled: "1", scale: 1 }, definition)).not.toThrow();
});
