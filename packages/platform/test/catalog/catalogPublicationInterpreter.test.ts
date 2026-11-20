import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createCatalogCandidateService, type CatalogCandidateDeps } from "../../src/catalog/candidate.js";
import { createCatalogCandidateServiceWithPublication } from "../../src/catalog/candidateService.js";
import { catalogDefinitionDigest } from "../../src/catalog/catalogDefinitionDigest.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";
import { CATALOG_PUBLICATION_LIMITS } from "../../src/catalog/publicationContracts.js";
import { assertPublishedSkuDocumentExclusion, catalogPublicationManifestSchema, decodePublishedSku, decodeStoredPublicationSku, publicationDigest, publicationJson, SKU_PAGE_DEPTH } from "../../src/catalog/publicationCodec.js";
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

import { publicationPriceRefusalReason } from "../../src/catalog/publicationError.js";
import { publicationWireVectors } from "../../src/catalog/testing/publicationWireVectors.js";

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
  resolveHead?: CatalogCandidateDeps["resolveHead"];
  facadeRefusal?: string;
  draftAdvanced?: boolean;
  latestReadRejects?: boolean;
  routeCalls?: readonly [number, number, number];
  evidenceCalls?: number;
  evidenceRows?: (rows: Fixture["evidence"]["drafts"]) => void;
  message?: string;
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

function facade(data: Fixture, deps?: Partial<CatalogCandidatePublicationDeps>, legacy = false, record: PublicationDraftRecord = data.record, currentHead?: CatalogCandidateDeps["currentHead"], readDraft?: CatalogCandidateDeps["readDraft"], resolveHead?: CatalogCandidateDeps["resolveHead"]) {
  const wiring: CatalogCandidateDeps = { readDraft: async () => data.record, registry: data.registry,
    validatePrices: data.validatePrices,
    installedDefinitionDigest: async () => data.installedDefinitionDigest, resolveHead: resolveHead ?? (async () => data.expectedHead),
    currentHead: currentHead ?? (async () => data.expectedHead ? { outcome: "found", head: data.expectedHead, documentRef: "example:document", observations: [] }
      : { outcome: "unpublished" }) };
  return legacy ? createCatalogCandidateService(wiring) : createCatalogCandidateServiceWithPublication({ ...wiring, readDraft: readDraft ?? (async () => record) }, {
    readEvidence: async () => ({ ...data.evidence, drafts: [{ ...data.evidence.drafts[0]!, record }, ...data.evidence.drafts.slice(1)] }),
    ...data.observations, ...deps,
  });
}

it.each([
  ["validateContent", "product.sharedContent.title"],
  ["validateProduct", "product"],
  ["validatePrices", "skus.0.priceOperations.0"],
  ["presentationReadiness", "publication.operations.6"],
  ["assessActivation", "product"],
] as const)("keeps a platform-spelled code owned by %s", async (rule, path) => {
  const code = "head_conflict";
  const data = rule === "assessActivation" ? await revision() : input();
  const verdict = async () => ({ ready: false, reasons: [code] });
  if (rule === "validateContent" || rule === "validateProduct") {
    const issues = rule === "validateContent" ? [{ path: "title", code }] : [code];
    Object.assign(data, setupRules(artifact.replace(`${rule}: () => []`, `${rule}: () => ${JSON.stringify(issues)}`)));
  } else if (rule === "presentationReadiness") {
    data.observations = { ...data.observations, presentationReadiness: verdict };
  } else if (rule === "validatePrices") {
    withPrice(data);
    data.validatePrices = async () => [{ path, code }];
  } else {
    activate(data, "eligibility");
    media(data);
    data.observations = { ...data.observations, verifyMedia: async () => true, assessActivation: verdict };
  }
  const preview = await facade(data).prepareCandidate({ draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: data.expectedHead });
  const refusal = { code, path, message: `Fix the rule violation ${code} reported by ${rule} at ${path}.` };
  expect(preview.preparation?.activation.issues).toContainEqual(expect.objectContaining(refusal));
  await expect(compileCatalogPublication(data)).rejects.toMatchObject({
    outcome: "validation_issue", diagnostic: { kind: "adopterRule", rule, code, path }, message: refusal.message,
  });
});

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
  data.evidence.drafts.splice(1, 0, { record, receipt: claim, head: record });
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
const descendingDocument = { fr: "Article", en: "Item" };
const descendingWire = (value: Record<string, unknown>) =>
  JSON.stringify(Object.fromEntries(Object.entries(value).sort(([first], [second]) => first < second ? 1 : first > second ? -1 : 0)));
const descendingRules = artifact.replace("a < b ? -1 : a > b ? 1 : 0", "a < b ? 1 : a > b ? -1 : 0") + `
const identify = module.exports.identifyDocument;
module.exports.identifyDocument = document => "fr" in document
  ? { schemaId: "example:document.v1", documentRef: "example:document", productSlug: "article",
      revisionNo: 2, name: "Synthetic article" }
  : identify(document);
module.exports.deriveSkuFacts = () => ({ derived: 12 });
`;
function documentHistory(data: Fixture, listed: readonly (1 | 2 | 3)[], options: {
  active?: 1 | 3; unreadable?: 2; distinct?: boolean;
} = {}) {
  const reference = data.payload.product.documentRevision!;
  const first = input().payload.product.sharedContent.document;
  const values = { 1: first, 2: descendingDocument, 3: { ...first, revisionNo: 3 } };
  data.evidence.documents = listed.map(revisionNo => {
    const document = values[revisionNo];
    const canonicalText = descendingWire(document);
    const digest = createHash("sha256").update(canonicalText).digest("hex");
    const sealed = { ...reference, id: `40000000-0000-4000-8000-00000000000${revisionNo}`, revisionNo, digest };
    const record = structuredClone(data.record);
    record.draftId = `30000000-0000-4000-8000-00000000010${revisionNo}`;
    record.payload.product.documentRevision = sealed;
    record.payload.product.sharedContent.document = document;
    const receipt = catalogPublicationClaim(record);
    const available = revisionNo !== options.unreadable;
    if (available) data.evidence.drafts.push({ record, receipt, head: null });
    return { reference: sealed, canonicalText: available ? canonicalText : "",
      provenance: { draftId: receipt.draftId, draftRevision: receipt.revision,
        draftCommandKey: receipt.commandKey, draftFingerprint: receipt.fingerprint } };
  });
  const active = options.active ?? 3;
  const selected = data.evidence.documents.find(document => document.reference.revisionNo === active)!.reference;
  data.evidence.documentRevisionHighWater = active === 1 ? 2 : 3;
  data.expectedHead!.documentDigest = selected.digest;
  data.evidence.product!.document = selected;
  data.payload.product.documentRevision = selected;
  const presentation = { shortName: { en: "Item", fr: options.distinct ? "Example" : "Article" } };
  data.evidence.product!.presentation = structuredClone(presentation);
  data.evidence.product!.content.presentation = structuredClone(presentation);
  data.payload.product.sharedContent.presentation = structuredClone(presentation);
  data.payload.publication.kind = "compensation";
  operation(data, "set_product_presentation", { presentation });
}
const productRefusal = artifact.replace("validateProduct: () => []", 'validateProduct: () => ["product_rule_rejected"]');
const exactDocument = (data: Fixture) => canonicalCatalogDraftJson(data.payload.product.sharedContent.document);
const copiedPresentation = (data: Fixture, suffix = "") => {
  data.payload.product.sharedContent.presentation = { title: exactDocument(data) + suffix };
  operation(data, "set_product_presentation", { presentation: data.payload.product.sharedContent.presentation });
};
const unreadableHead = { publicationId: "head", revision: 1, documentDigest: "unavailable" };
function replaceDocument(data: Fixture, retained = false) {
  const reference = data.payload.product.documentRevision!;
  const prior = data.evidence.documents[0]!.canonicalText;
  const document = { ...input().payload.product.sharedContent.document, revisionNo: 2 };
  const canonicalText = canonicalCatalogDraftJson(document);
  const next = { ...reference, id: "40000000-0000-4000-8000-000000000002", revisionNo: 2,
    digest: createHash("sha256").update(canonicalText).digest("hex") };
  data.payload.product.documentRevision = next;
  data.payload.product.sharedContent.document = document;
  const source = { ...data.record, draftId: "30000000-0000-4000-8000-000000000003" };
  const claim = catalogPublicationClaim(source);
  if (retained) data.payload.publication.evidence.drafts = [claim];
  data.payload.publication.operations.unshift({ op: "register_document_revision", productSlug: "article", revisionId: next.id,
    revisionNo: next.revisionNo, documentRef: next.documentRef, sourceRef: next.sourceRef, canonicalText, digest: next.digest,
    provenance: retained ? { source: "retained_draft", draftId: claim.draftId, draftRevision: claim.revision,
      draftCommandKey: claim.commandKey, draftFingerprint: claim.fingerprint } : { source: "current_draft" } },
  { op: "move_document_pointer", productSlug: "article", documentRevisionNo: 2 });
  if (retained) data.evidence.drafts.push({ record: { ...source, payload: {} as typeof source.payload }, receipt: claim, head: source });
  return prior;
}
const movedHead = { publicationId: "50000000-0000-4000-8000-000000000007", revision: 4, documentDigest: "e".repeat(64) };
const beforeRoute = { readiness: routeConflict, routeCalls: [0, 0, 0] } as const;
const incompleteSkuRoster = {
  ...beforeRoute, expected: reason("catalog_publication_read_invalid"), outcome: "unknown",
  diagnostic: { phase: "structural", path: "publication", subject: "example:article" },
} as const;
function bindCallbackForAnotherType(data: Fixture) {
  const { validateContent: _rule, publicationRules: _installed, ...type } = data.definition;
  const pack = withCatalogPublicationRules({ id: "example:paired-rules", namespace: "example", version: 1, openlupRange: "1.x",
    taxClasses: [], capabilities: {}, types: [type, { ...type, key: "example:other" }] }, () => Buffer.from(artifact));
  data.definition = { ...data.definition, validateContent: pack.types[1]!.validateContent };
  data.registry = { resolve: () => data.definition };
}
const cases: Case[] = [
  { id: "a callback verified for another type cannot bind the selected definition", arrange: bindCallbackForAnotherType,
    expected: reason("catalog_publication_rules_binding_mismatch"), evidenceCalls: 0, ...beforeRoute,
    diagnostic: { phase: "structural", path: "product.type", subject: "example:article" } },
  { id: "Q-CROSS-TYPE-HEADED-GATE", fixture: "revision", arrange: bindCallbackForAnotherType, draftAdvanced: true,
    resolveHead: async () => { throw new Error("synthetic immutable head timeout"); },
    currentHead: async () => { throw new Error("synthetic current head timeout"); },
    expected: reason("catalog_publication_rules_binding_mismatch"), evidenceCalls: 0, ...beforeRoute,
    diagnostic: { phase: "structural", path: "product.type", subject: "example:article" } },
  { id: "retained activation media cannot be removed from the proposed presentation", fixture: "revision", arrange(data) {
    const retained = structuredClone(input().record);
    retained.draftId = "30000000-0000-4000-8000-000000000003";
    retained.payload.product.sharedContent.presentation = { mediaRef: "example:media" };
    const sku = data.evidence.skus[0]!;
    const grossMass = { ...sku.netContent, unscaled: "110" };
    retained.payload.skus[0]!.grossMass = grossMass;
    Object.assign(sku, { status: "active", sellableStandalone: true, grossMass, source: catalogPublicationClaim(retained) });
    data.evidence.product!.status = "active";
    data.evidence.product!.presentation = { mediaRef: "example:media" };
    data.evidence.drafts.splice(1, 0, { record: retained, receipt: catalogPublicationClaim(retained), head: retained });
    pointerBeforeRoute(data);
  }, expected: ["catalog_publication_media_readiness_unproven", "duplicate_route", "catalog_publication_media_readiness_unproven"],
  diagnostic: { phase: "activation", path: "publication.evidence.media", subject: "ARTICLE" },
  message: "Keep the selected draft's media reference", readiness: routeConflict, routeCalls: [0, 1, 0], outcome: "unknown" },
  ...(["unit", "case"] as const).map((packagingLevel): Case => ({
    id: `a ${packagingLevel} identifier refusal names the quantity field and its fix`, arrange(data) {
      operation(data, "create_identifier", { packagingLevel, quantity: packagingLevel === "unit" ? 2 : 1, isPrimary: false });
    }, expected: reason("candidate_invalid"), evidenceCalls: 0, ...beforeRoute,
    diagnostic: { phase: "structural", path: "publication.operations.4.quantity", subject: "example:article" },
    message: packagingLevel === "unit" ? "unit identifiers require quantity 1" : "case identifiers require at least 2 units",
  })),
  { id: "M-IDENTIFIER-BEFORE-SKU", arrange(data) {
    const operations = data.payload.publication.operations;
    operations.splice(3, 2, operations[4]!, operations[3]!);
  }, expected: reason("candidate_invalid"), evidenceCalls: 0, ...beforeRoute,
  diagnostic: { phase: "structural", path: "publication.operations.3", subject: "example:article" },
  message: "move the identifier after its SKU creation" },
  ...([
    ["a whitespace-only value", ["example:serial"], " \t ", "catalog_publication_identifier_blank", "Enter a nonblank value"],
    ["an issuer/value pair repeated across schemes", ["example:serial", "example:alternate"], "ABC", "catalog_publication_identifier_key_reused", "Use a distinct issuer and value pair"],
  ] as const).map(([id, schemes, value, code, remedy]): Case => ({
    id: `identifier admission refuses ${id}`,
    arrange(data) {
      const sku = data.payload.skus[0]!;
      const identifiers = schemes.map(scheme => ({ scheme, issuer: "example", value, packagingLevel: "unit" as const }));
      sku.identifiers!.push(...identifiers);
      data.payload.publication.operations.splice(5, 0, ...identifiers.map(identifier => ({
        op: "create_identifier" as const, skuCode: sku.code!, ...identifier, quantity: 1, isPrimary: false, label: null, sourceRef: null,
      })));
    },
    expected: reason(code),
    diagnostic: { phase: "structural", path: `publication.operations.${4 + schemes.length}`, subject: "ARTICLE" },
    message: `SKU ARTICLE. ${remedy}`,
  })),
  { id: "a repeated requested mode keeps its indexed field and fix", arrange(data) {
    data.payload.product.sharedContent.requestedModes[0]!.modes = ["one_time", "one_time"];
  }, expected: reason("candidate_invalid"), evidenceCalls: 0, ...beforeRoute,
  diagnostic: { phase: "structural", path: "product.sharedContent.requestedModes.0.modes", subject: "example:article" },
  message: "list each requested mode once" },
  ...([false, true] as const).map((occupied): Case => ({
    id: `an immutable-head timeout leaves a ${occupied ? "known route refusal" : "typed dependency issue"}`,
    fixture: "revision", resolveHead: async () => { throw new Error("synthetic immutable-head timeout"); },
    readiness: occupied ? routeConflict : ready, routeCalls: [1, 1, 1], evidenceCalls: 3,
    expected: reason(occupied ? "duplicate_route" : "publication_head_unavailable"),
    facadeRefusal: occupied ? "duplicate_route" : "candidate_dependency_unavailable",
    ...(occupied && { diagnostic: routeAt(0) }),
  })),
  { id: "a rejected latest draft read leaves a known route refusal visible", fixture: "revision",
    latestReadRejects: true, readiness: routeConflict, routeCalls: [1, 1, 1],
    expected: reason("duplicate_route"), diagnostic: routeAt(0) },
  { id: "a rejected latest draft read is a typed dependency refusal when the route passes", fixture: "revision",
    latestReadRejects: true, routeCalls: [1, 1, 1], outcome: "unknown",
    expected: reason("publication_head_unavailable") },
  ...(["membership", "presentation"] as const).map((later): Case => ({
    id: `the first derived value precedes a later ${later} mismatch`, fixture: "revision", arrange(data) {
      if (later === "membership") {
        activate(data, "membership");
        data.payload.product.sharedContent.offerMemberships = [];
      } else {
        data.payload.publication.operations.push({ op: "set_product_presentation", productSlug: "article", presentation: { title: "Unsealed" } });
      }
      data.payload.publication.operations.unshift({ op: "set_derived_sku_facts", skuCode: "ARTICLE", documentRevisionNo: 1,
        netContent: data.evidence.skus[0]!.netContent, facts: { derived: 13 } });
    }, expected: reason("catalog_publication_v3_compile_derived_facts_mismatch"),
    diagnostic: { phase: "structural", path: "publication.operations.0", subject: "ARTICLE" }, ...beforeRoute,
  })),
  { id: "binding precedes comparison with an advanced draft", fixture: "revision", substitute: true, draftAdvanced: true,
    expected: reason("catalog_publication_rules_binding_mismatch"),
    diagnostic: { phase: "structural", path: "product.type", subject: "example:article" }, evidenceCalls: 0, ...beforeRoute },
  ...(["before", "after"] as const).map((where): Case => ({
    id: `incomplete SKU roster with a malformed row ${where} the identifier mismatch`, fixture: "revision", arrange(data) {
      activate(data, "membership");
      data.payload.skus[0]!.identifiers![0]!.value = "4006381333931";
      data.evidence.skus = where === "before" ? [null!, ...data.evidence.skus] : [...data.evidence.skus, null!];
    }, ...incompleteSkuRoster,
  })),
  { id: "a decoded wrong retained document identity refuses before routes", fixture: "revision",
    rulesAsset: artifact.replace("...this.identifyDocument(document), canonicallyEncoded:", '...this.identifyDocument(document), documentRef: "example:wrong", canonicallyEncoded:'),
    expected: reason("catalog_publication_document_source_mismatch"),
    diagnostic: { phase: "structural", path: "product.documentRevision", subject: "example:article" }, ...beforeRoute },
  { id: "a verified claimed draft with a stale document reference refuses before routes", fixture: "revision", arrange(data) {
    const source = structuredClone(input().record);
    source.draftId = "30000000-0000-4000-8000-000000000003";
    source.payload.product.documentRevision!.digest = "f".repeat(64);
    const receipt = catalogPublicationClaim(source);
    data.evidence.drafts.push({ record: source, receipt, head: source });
    data.payload.publication.evidence.drafts = [receipt];
    data.payload.publication.operations.push({ op: "set_sku_metadata", skuCode: "ARTICLE", logisticsRef: null });
  }, expected: reason("catalog_publication_v3_document_reference_stale"),
  diagnostic: { phase: "structural", path: "product.documentRevision", subject: "example:article" }, ...beforeRoute },
  { id: "compensation excludes the exact prior document in the final retained content", fixture: "revision", arrange(data) {
    const prior = data.evidence.documents[0]!;
    const canonicalText = canonicalCatalogDraftJson({ ...input().payload.product.sharedContent.document, revisionNo: 2 });
    const reference = { ...prior.reference, id: "40000000-0000-4000-8000-000000000002", revisionNo: 2,
      digest: createHash("sha256").update(canonicalText).digest("hex") };
    data.evidence.documents = [prior, { ...prior, canonicalText, reference }];
    data.evidence.documentRevisionHighWater = 2;
    data.expectedHead!.documentDigest = reference.digest;
    data.payload.product.documentRevision = reference;
    data.evidence.product!.document = reference;
    data.evidence.product!.content.publicationSkus[0]!.title = prior.canonicalText;
    data.payload.publication.kind = "compensation";
    data.payload.product.sharedContent.presentation = structuredClone(data.evidence.product!.presentation ?? {});
    operation(data, "set_product_presentation", { presentation: data.payload.product.sharedContent.presentation });
  }, expected: reason("catalog_publication_document_text_copied"), routeCalls: [1, 1, 1],
  diagnostic: { phase: "structural", path: "product.content.publicationSkus.0.title", subject: "example:article" } },
  { id: "an unsupported operation key keeps its admission path", fixture: "revision", arrange(data) {
    operation(data, "set_product_presentation", { unsupportedField: true });
    data.evidence.drafts[0]!.receipt.commandKey = "draft:wrong";
  }, expected: reason("candidate_invalid"), evidenceCalls: 0, ...beforeRoute,
  diagnostic: { ...routeAt(0), path: "publication.operations.0.unsupportedField" }, message: "Remove the unsupported field" },
  { id: "a v4 unsupported operation keeps its original index after a lifecycle operation", fixture: "revision",
    governed(data) {
      operation(data, "set_product_presentation", { op: "unsupported" });
      const governed = governedDraft(data);
      governed.publication.operations.unshift({ op: "restore_product", productSlug: "article", expectedState: "withdrawn" });
      return governed;
    }, expected: reason("candidate_invalid"), evidenceCalls: 0, ...beforeRoute,
    diagnostic: { ...routeAt(1), path: "publication.operations.1.op" }, message: "Use a supported publication operation" },
  { id: "phase-1 binding precedes moved lineage and routes", fixture: "revision", substitute: true,
    arrange: data => { data.evidence.head = movedHead; },
    currentHead: async () => ({ outcome: "found", head: movedHead, documentRef: "example:moved", observations: [] }),
    expected: reason("catalog_publication_rules_binding_mismatch"), diagnostic: { phase: "structural", path: "product.type", subject: "example:article" },
    evidenceCalls: 0, ...beforeRoute },
  { id: "phase-1 operation grammar precedes receipt and route", fixture: "revision", arrange: data => {
    data.payload.product.sharedContent.presentation = {};
    operation(data, "set_product_presentation", { presentation: { extra: true } });
    data.evidence.drafts[0]!.receipt.commandKey = "draft:wrong";
  }, expected: reason("catalog_publication_presentation_invalid"),
  diagnostic: { ...routeAt(0), path: "publication.operations.0.presentation.extra" }, evidenceCalls: 0, ...beforeRoute },
  { id: "phase-1 checksum precedes receipt and route", arrange: data => {
    operation(data, "register_document_revision", { canonicalText: "changed bytes" });
    data.evidence.drafts[0]!.receipt.commandKey = "draft:wrong";
  }, expected: reason("catalog_publication_v3_document_digest_mismatch"), diagnostic: routeAt(1), evidenceCalls: 0, ...beforeRoute },
  ...(["digest", "revision"] as const).map((kind): Case => ({
    id: `phase-2 stale ${kind} precedes route`, fixture: "revision", arrange(data) {
      const reference = data.payload.product.documentRevision!;
      if (kind === "digest") reference.digest = "d".repeat(64);
      else Object.assign(reference, { id: "40000000-0000-4000-8000-000000000004", revisionNo: 4 });
    }, expected: reason("catalog_publication_v3_document_reference_stale"),
    diagnostic: { phase: "structural", path: "product.documentRevision", subject: "example:article" }, ...beforeRoute,
  })),
  { id: "phase-2 malformed row preserves known receipt refusal", fixture: "revision",
    arrange: data => { data.evidence.drafts[0]!.receipt.commandKey = "draft:wrong"; },
    evidenceRows: rows => { rows.unshift(null!); }, expected: reason("catalog_publication_source_mismatch"),
    diagnostic: { phase: "structural", path: "publication", subject: "example:article" }, ...beforeRoute },
  { id: "phase-2 draft head binds before routes", fixture: "revision", arrange: data => {
    data.evidence.drafts[0]!.head!.revision++;
  }, expected: reason("catalog_publication_draft_advanced"), diagnostic: { phase: "structural", path: "publication", subject: "example:article" }, ...beforeRoute },
  { id: "phase-3 derived value precedes route", fixture: "revision", arrange: data => {
    data.payload.publication.operations.push({ op: "set_derived_sku_facts", skuCode: "ARTICLE", documentRevisionNo: 1,
      netContent: data.evidence.skus[0]!.netContent, facts: { derived: 13 } });
  }, expected: reason("catalog_publication_v3_compile_derived_facts_mismatch"),
    diagnostic: { phase: "structural", path: "publication.operations.1", subject: "ARTICLE" }, ...beforeRoute },
  { id: "phase-4 physical identifier precedes route", fixture: "revision", arrange: data => {
    activate(data, "membership"); data.payload.skus[0]!.identifiers![0]!.value = "4006381333931";
  }, expected: reason("catalog_publication_identifier_source_mismatch"),
    diagnostic: { phase: "structural", path: "skus.0", subject: "ARTICLE" }, ...beforeRoute },
  { id: "phase-4 media tuple precedes route", fixture: "revision", arrange: data => {
    retainedMedia(data); data.payload.publication.evidence.media![0]!.mediaRef = "example:other";
  }, expected: reason("catalog_publication_media_evidence_mismatch"),
    diagnostic: { phase: "structural", path: "publication.evidence.media", subject: "ARTICLE" }, ...beforeRoute },
  { id: "phase-5 activation prerequisites precede route in activation modes", fixture: "revision",
    arrange: data => activate(data, "eligibility", false), readiness: routeConflict,
    expected: ["catalog_publication_gross_mass_required", "duplicate_route", "catalog_publication_gross_mass_required"], routeCalls: [0, 1, 0] },
  { id: "phase-6 earlier archive refusal precedes a later route", fixture: "revision", arrange: data => {
    data.payload.skus = [structuredClone(input().payload.skus[0]!)];
    data.payload.publication.operations.unshift({ op: "set_sku_status", skuCode: "ARTICLE", status: "archived" });
  }, expected: reason("catalog_publication_v3_compile_archive_refused"),
    diagnostic: { phase: "structural", path: "publication.operations.0", subject: "ARTICLE" }, ...beforeRoute },
  { id: "phase-7 structural effects cannot precede an earlier route", arrange: data => {
    data.payload.publication.operations = data.payload.publication.operations.filter(value => value.op !== "create_identifier");
  }, readiness: routeConflict, expected: reason("duplicate_route"), routeCalls: [1, 1, 1] },
  { id: "phase-8 price verdict cannot precede an earlier route", arrange: data => {
    withPrice(data);
    data.validatePrices = async () => [{ path: "skus.0.priceOperations.0", code: "price_list_not_found" }];
  }, readiness: routeConflict, expected: reason("duplicate_route"), routeCalls: [1, 1, 1] },
  { id: "an unverified registration and pointer preserve an independent route refusal", fixture: "revision",
    arrange: data => { replaceDocument(data, true); }, readiness: routeConflict, expected: reason("duplicate_route"),
    diagnostic: routeAt(2), routeCalls: [1, 1, 1] },
  { id: "an unresolved registration is unknown when the route is clear", fixture: "revision",
    arrange: data => { replaceDocument(data, true); }, expected: reason("catalog_publication_read_invalid"), outcome: "unknown",
    routeCalls: [1, 1, 1] },
  { id: "a null draft row preserves an independent route refusal", fixture: "revision",
    evidenceRows: rows => { rows.unshift(null!); }, readiness: routeConflict, expected: reason("duplicate_route"),
    diagnostic: routeAt(0), routeCalls: [1, 1, 1] },
  { id: "a refused retained document read preserves an independent route refusal", fixture: "revision",
    rulesAsset: artifact.replace("inspectDocument(canonicalText) {", "inspectDocument(canonicalText) { return null;"),
    arrange: pointerBeforeRoute, readiness: routeConflict, expected: reason("duplicate_route"), diagnostic: routeAt(1), routeCalls: [1, 1, 1] },
  { id: "prior document text stays excluded after pointer replacement", fixture: "revision", arrange: data => {
    const prior = replaceDocument(data);
    data.payload.product.sharedContent.presentation = { title: prior };
    operation(data, "set_product_presentation", { presentation: { title: prior } });
  }, expected: reason("catalog_publication_document_text_copied"),
    diagnostic: { phase: "structural", path: "product.presentation.title", subject: "example:article" } },
  ...([
    ["async () => { throw Error('rule rejected'); }", "invalid_result", "rules must be synchronous and pure: validateContent returned a Promise"],
    ["() => ({ then(_resolve, reject) { reject('rule rejected'); } })", "invalid_result", "rules must be synchronous and pure: validateContent returned a Promise"],
    ["() => { throw { get message() { throw Error('secondary throw'); } }; }", "throw", "Return an array of field issues"],
  ] as const).map(([hook, cause, message]): Case => ({
    id: `rule dispatch contains invalid execution (${hook})`, rulesAsset: artifact.replace("validateContent: () => []", `validateContent: ${hook}`),
    expected: reason("catalog_publication_rule_failed"), evidenceCalls: 0, ...beforeRoute, message,
    diagnostic: { phase: "structural", path: "product.sharedContent", subject: "example:article", hook: "validateContent", cause },
  })),
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
  { id: "U-R3-HOST-CANONICAL", rulesAsset: descendingRules.replace("revisionNo: 2, name:", "revisionNo: 1, name:"), arrange(data) {
    const canonicalText = descendingWire(descendingDocument);
    const digest = createHash("sha256").update(canonicalText).digest("hex");
    expect(digest).not.toBe(publicationDigest(descendingDocument));
    data.payload.product.documentRevision!.digest = digest;
    data.payload.product.sharedContent.document = descendingDocument;
    const presentation = { shortName: { en: "Item", fr: "Article" } };
    data.payload.product.sharedContent.presentation = presentation;
    operation(data, "register_document_revision", { canonicalText, digest });
    operation(data, "set_product_presentation", { presentation });
  }, expected: reason("catalog_publication_document_text_copied"),
  diagnostic: { phase: "structural", path: "product.presentation.shortName", subject: "example:article" }, routeCalls: [1, 1, 1] },
  { id: "R3 compensation cannot finalise content while revision 2 is unreadable", fixture: "revision",
    rulesAsset: descendingRules, arrange: data => documentHistory(data, [1, 2, 3], { unreadable: 2 }),
    expected: reason("catalog_publication_document_bytes_unavailable"), outcome: "unknown",
    diagnostic: { phase: "structural", path: "product.presentation", subject: "example:article" }, routeCalls: [1, 1, 1] },
  { id: "R3 compensation excludes a re-encoded copy of readable revision 2", fixture: "revision",
    rulesAsset: descendingRules, arrange: data => documentHistory(data, [1, 2, 3]),
    expected: reason("catalog_publication_document_text_copied"),
    diagnostic: { phase: "structural", path: "product.presentation.shortName", subject: "example:article" }, routeCalls: [1, 1, 1] },
  { id: "W-R3-HIGH-WATER withholds a copy of unlisted revision 2 at high-water 2", fixture: "revision",
    rulesAsset: descendingRules, arrange: data => documentHistory(data, [1], { active: 1 }),
    expected: reason("catalog_publication_document_bytes_unavailable"), outcome: "unknown",
    diagnostic: { phase: "structural", path: "product.presentation", subject: "example:article" }, routeCalls: [1, 1, 1] },
  { id: "W-R3-OLDER-GAP withholds compensation because revision 1 is unlisted at high-water 3", fixture: "revision",
    rulesAsset: descendingRules, arrange: data => documentHistory(data, [2, 3], { distinct: true }),
    expected: reason("catalog_publication_document_bytes_unavailable"), outcome: "unknown",
    diagnostic: { phase: "structural", path: "product.presentation", subject: "example:article" }, routeCalls: [1, 1, 1] },
  { id: "W-R3-COMPLETE admits distinct compensation with a complete listing", fixture: "revision",
    rulesAsset: descendingRules, arrange: data => documentHistory(data, [1, 2, 3], { distinct: true }), routeCalls: [1, 1, 1] },
  { id: "R3 unavailable history leaves an independent route refusal visible", fixture: "revision",
    rulesAsset: descendingRules, arrange: data => documentHistory(data, [1, 2, 3], { unreadable: 2 }), readiness: routeConflict,
    expected: reason("duplicate_route"), diagnostic: routeAt(0), routeCalls: [1, 1, 1] },
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
      diagnostic: { phase: "structural", path: index === 2 ? "product.sharedContent.presentation.advertisedWeightsG.0"
        : "product.sharedContent.presentation.advertisedWeightsG", subject: "example:article" } }
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
  { id: "Z-1 incomplete SKU roster stops before checking presentation effects", fixture: "revision", arrange(data) {
    data.evidence.skus.unshift(null!);
    data.payload.publication.operations = [{ op: "set_product_status", productSlug: "article", status: "archived" }];
  }, ...incompleteSkuRoster },
  { id: "D-030 rejects missing unit GTIN on a dark SKU", arrange: data => { data.payload.skus[0]!.identifiers = []; },
    expected: reason("unit_trade_identifier_missing"),
    diagnostic: { path: "skus.0.identifiers", phase: "structural", subject: "ARTICLE" } },
  { id: "A-3 a withdrawn product and SKU require restore before becoming sellable", fixture: "revision",
    arrange: withdrawnDraft, governed: governedDraft, expected: reason("catalog_lifecycle_fresh_sale_refused") },
  { id: "B-5 restore after the enabling prefix is too late", fixture: "revision", arrange: withdrawnDraft,
    governed: data => restoredDraft(data, false), expected: reason("catalog_lifecycle_fresh_sale_refused") },
  { id: "B-5 eligible after both authoritative states are restored", fixture: "revision", arrange: withdrawnDraft,
    governed: data => restoredDraft(data, true) },
  { id: "Y-1 incomplete SKU roster stops before the ordered restore and eligibility checks", fixture: "revision", arrange(data) {
    withdrawnDraft(data);
    data.evidence.skus.unshift(null!);
  }, governed: data => restoredDraft(data, true), ...incompleteSkuRoster },
  { id: "A-4 a presentation field cannot carry the authored document", arrange: data => {
    data.payload.product.sharedContent.presentation = { copy: data.payload.product.sharedContent.document! };
    operation(data, "set_product_presentation", { presentation: data.payload.product.sharedContent.presentation });
  }, expected: reason("catalog_publication_presentation_invalid"), ...beforeRoute },
  { id: "A-4 an SKU fact cannot carry the authored document", arrange: data => {
    const facts = { derived: data.payload.product.sharedContent.document! };
    data.payload.product.sharedContent.publicationSkus[0]!.facts = facts;
    operation(data, "create_sku", { facts });
  }, expected: reason("catalog_publication_document_text_copied"), ...beforeRoute },
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
  ...([
    { scope: "variant", complete: "A-12 omitted SKU attributes keep the effective projection byte bound",
      partial: "M-ATTRIBUTE-BOUND incomplete SKU roster", path: "/skus/0/attributes/label", subject: "ARTICLE" },
    { scope: "product", complete: "Q-PRODUCT-ATTRIBUTE-CONTROL", partial: "Q-PRODUCT-ATTRIBUTE incomplete SKU roster",
      path: "/productAttributes/label", subject: "example:article" },
  ] as const).flatMap(({ scope, complete, partial, path, subject }) => [complete, partial].map((id): Case => ({
    id, fixture: "revision", arrange(data) {
      data.definition = { ...data.definition, attributes: [{ key: "label", scope, public: true,
        valueType: { kind: "text", maxLength: 2048 }, required: false, cardinality: { min: 0, max: 1 },
        filterable: false, facetable: false, displayOrder: 0, labels: {} }] };
      data.registry = { resolve: () => data.definition };
      data.installedDefinitionDigest = catalogDefinitionDigest(data.definition);
      const retained = scope === "product" ? data.evidence.product! : data.evidence.skus[0]!;
      retained.attributes = { label: "é".repeat(1025) };
      if (id === partial) data.evidence.skus.unshift(null as never);
    },
    ...(id === partial ? incompleteSkuRoster : {
      expected: reason("attribute_projection_text_too_large"), routeCalls: [1, 1, 1],
      outcome: "blocked-input", diagnostic: { phase: "structural", path, subject },
    }),
  }))),
  ...["V-RETAINED-AXIS", "W-RETAINED-AXIS incomplete SKU roster"].map((id): Case => ({ id, fixture: "revision", arrange(data) {
    data.definition = { ...data.definition, dimensions: [{ key: "style", kind: "choice", values: ["one", "two"] }],
      axes: [{ key: "style", attributeKey: "style" }],
      attributes: [{ key: "style", scope: "variant", valueType: { kind: "enum", values: [{ id: "one" }, { id: "two" }] },
        filterable: false, facetable: false, public: true, required: false, cardinality: { min: 0, max: 1 }, displayOrder: 0, labels: {} }] };
    data.registry = { resolve: () => data.definition };
    data.installedDefinitionDigest = catalogDefinitionDigest(data.definition);
    data.payload.product.dimensions = ["style"];
    if (id !== "V-RETAINED-AXIS") data.evidence.skus.unshift(null as never);
  }, ...(id === "V-RETAINED-AXIS"
    ? { expected: reason("option_missing"), diagnostic: { phase: "structural", path: "options.style", subject: "ARTICLE" } }
    : incompleteSkuRoster) })),
  { id: "W-RETAINED-FACTS incomplete SKU roster stops before checking derived facts", fixture: "revision", arrange(data) {
    data.evidence.skus[0]!.facts = { derived: 13 };
    data.evidence.skus.unshift(null as never);
  }, ...incompleteSkuRoster },
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
  { id: "D-040 registered bytes can supply the create name while the canonical value is unavailable",
    arrange: data => { delete data.payload.product.sharedContent.document; }, outcome: "unknown",
    expected: reason("catalog_publication_document_bytes_unavailable"),
    diagnostic: { phase: "structural", path: "product.presentation", subject: "example:article" } },
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
  }, expected: reason("catalog_publication_document_source_mismatch") },
  { id: "D-046 right identity still requires canonical bytes", arrange: data => {
    const canonicalText = " " + canonicalCatalogDraftJson(data.payload.product.sharedContent.document);
    const digest = createHash("sha256").update(canonicalText).digest("hex");
    data.payload.product.documentRevision!.digest = digest;
    operation(data, "register_document_revision", { canonicalText, digest });
  }, expected: reason("catalog_publication_v3_document_not_canonical") },
  { id: "phase-2 candidate receipt binds before routes", arrange: data => { data.evidence.drafts[0]!.receipt.commandKey = "draft:wrong"; },
    expected: reason("catalog_publication_source_mismatch"), ...beforeRoute },
  { id: "D-064 receipt fingerprint is independent of the draft and head", arrange: data => { data.evidence!.drafts[0]!.receipt.fingerprint = "a".repeat(64); },
    expected: reason("catalog_publication_source_mismatch") },
  { id: "D-065 valid receipt still requires the correct open-head owner", arrange: data => { data.evidence!.drafts[0]!.head!.productId = "10000000-0000-4000-8000-000000000009"; },
    expected: reason("catalog_publication_draft_advanced") },
  { id: "D-032 G-5 enabling checks authored gross even when retained gross and gate are green", fixture: "revision",
    arrange: data => activate(data, "eligibility", false),
    expected: ["catalog_publication_gross_mass_required", null, "catalog_publication_gross_mass_required"],
    diagnostic: { phase: "activation", path: "skus.0.grossMass", subject: "ARTICLE" },
    message: "supply the gross mass for this SKU", outcome: "unknown", routeCalls: [0, 1, 0] },
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
  }, media: async () => false, expected: ["catalog_publication_media_readiness_unproven", null, "catalog_publication_media_readiness_unproven"],
  diagnostic: { phase: "activation", path: "publication.evidence.media", subject: "ARTICLE" },
  outcome: "unknown", routeCalls: [0, 1, 0] },
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

it.each(cases)("shared evaluator parity $id", async ({ fixture, arrange, expected = [null, null, null], readiness, media: proof, activationReady, governed, priceListRefusal, outcome, diagnostic, rulesAsset, substitute, currentHead, resolveHead, facadeRefusal, draftAdvanced, latestReadRejects, routeCalls, evidenceCalls, evidenceRows, preserve, evaluation, message }) => {
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
  evidenceRows?.(evidence.drafts);
  if (governed && !data.validatePrices) data.validatePrices = async () => [];
  const readEvidence = vi.fn(async () => evidence);
  const current = currentHead && vi.fn(currentHead);
  const rejectLatest = async () => { throw new Error("synthetic read timeout"); };
  const readDraft = draftAdvanced || latestReadRejects ? vi.fn(async (_id: string, revision?: number) => {
    if (revision !== undefined) return data.record;
    if (latestReadRejects) return rejectLatest();
    return { ...data.record, revision: data.record.revision + 1 };
  }) : undefined;
  const immutableHead = resolveHead && vi.fn(resolveHead);
  const decisionHead = resolveHead && vi.fn(async () => ({ head: data.expectedHead, unavailable: true }));
  const service = facade(data, { ...observations, readEvidence, ...(evaluation && { evaluation }) }, false, record, current, readDraft, immutableHead);
  const checkRouteCalls = (expectedCalls?: number) => {
    if (expectedCalls !== undefined) expect(observations.presentationReadiness).toHaveBeenCalledTimes(expectedCalls);
    observations.presentationReadiness.mockClear();
  };
  const query = { draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: data.expectedHead };
  const before = canonicalCatalogDraftJson(record.payload);
  const candidateRef = `v1:${query.draftId}@${query.draftRevision}/${data.expectedHead ? `${data.expectedHead.publicationId}@${data.expectedHead.revision}` : "unpublished"}`;
  let preview;
  if (facadeRefusal) {
    const refusal = { code: facadeRefusal, ...(diagnostic && { diagnostic }) };
    await expect(service.prepareCandidate(query)).rejects.toMatchObject(refusal);
    checkRouteCalls(routeCalls?.[0]);
    await expect(service.validate(candidateRef)).rejects.toMatchObject(refusal);
    checkRouteCalls(routeCalls?.[0]);
    await expect(service.compareCandidate({ candidateRef, candidateDigest: "0".repeat(64), expectedHead: data.expectedHead }))
      .rejects.toMatchObject(refusal);
  } else {
    preview = await service.prepareCandidate(query);
    checkRouteCalls(routeCalls?.[0]);
    expect(await service.validate(preview.candidateRef)).toEqual(preview);
    checkRouteCalls(routeCalls?.[0]);
    expect(await service.compareCandidate({ ...preview, expectedHead: data.expectedHead })).toEqual(preview);
    expect(preview.issues.find(issue => !issue.code.endsWith("_unavailable"))?.code ?? preview.issues[0]?.code ?? null).toBe(expected[0]);
    if (outcome) expect(preview?.preparation?.structural.outcome).toBe(outcome);
    if (expected[0] === "catalog_publication_read_invalid")
      expect(preview.preparation?.activation.outcome).toBe("unknown");
    if (diagnostic) {
      if (diagnostic.phase === "activation") expect(preview?.preparation?.activation.outcome).toBe("blocked-input");
      const issues = diagnostic.phase === "activation" ? preview.preparation?.activation.issues : preview.preparation?.structural.issues;
      expect(issues?.[0]).toEqual(expect.objectContaining({ code: expected[0], ...diagnostic }));
      if (message) expect(issues?.[0]?.message).toContain(message);
    }
  }
  checkRouteCalls(routeCalls?.[0]);
  if (evidenceCalls !== undefined) expect(readEvidence).toHaveBeenCalledTimes(evidenceCalls);
  if (expected[0] === "catalog_publication_rules_binding_mismatch") {
    if (immutableHead) expect(immutableHead).not.toHaveBeenCalled();
    if (current) expect(current).not.toHaveBeenCalled();
  }
  if (draftAdvanced) expect(readDraft?.mock.calls.every(([, revision]) => revision === record.revision)).toBe(true);
  expect(replacement).not.toHaveBeenCalled();
  if (rulesAsset && diagnostic?.cause) expect(() => loadCatalogRules(Buffer.from(rulesAsset)).validateContent({}))
    .toThrow(expect.objectContaining({ code: expected[0], diagnostic: expect.objectContaining({ hook: diagnostic.hook, cause: diagnostic.cause }),
      ...(message && { message: expect.stringContaining(message) }) }));
  for (const [index, mode] of ["first-decision", "compile"].entries()) {
    const result = compileCatalogPublication({ ...data, record, evidence, observations,
      ...(latestReadRejects && { readCurrentHead: rejectLatest }),
      ...(decisionHead && { readCurrentHead: decisionHead }),
      ...(evaluation && { evaluation }) }, mode as "first-decision" | "compile");
    const decisionReason = expected[index + 1];
    if (decisionReason) await expect(result).rejects.toMatchObject({ code: decisionReason,
      ...(decisionReason === expected[0] && diagnostic && { diagnostic, ...(message && { message: expect.stringContaining(message) }) }),
      ...((decisionReason.endsWith("_unavailable") || decisionReason === "catalog_publication_read_invalid") && { outcome: "dependency_unavailable" }) });
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
  if (decisionHead && expected[0] === "catalog_publication_rules_binding_mismatch") expect(decisionHead).not.toHaveBeenCalled();
  expect(canonicalCatalogDraftJson(record.payload)).toBe(before);
  if (priceListRefusal) expect(preview?.preparation?.structural.issues).toContainEqual({ code: "price_list_not_found", phase: "pricing",
    path: "skus.0.priceOperations.0", subject: priceList,
    message: "Fix the rule violation price_list_not_found reported by validatePrices at skus.0.priceOperations.0." });
  if (activationReady) {
    expect(preview?.preparation?.activation.outcome).toBe("ready");
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

it.each([
  { field: "publicationId", stale: "50000000-0000-4000-8000-000000000002" },
  { field: "revision", stale: 2 },
  { field: "documentDigest", stale: "d".repeat(64) },
])("T-1 a reader cannot replace the caller's $field", async ({ field, stale }) => {
  const data = await revision();
  const actual = data.expectedHead!;
  const expectedHead = { ...actual, [field]: stale };
  const readCurrentHead = vi.fn(async () => ({ head: actual, expectedHead: actual, unavailable: false }));
  const presentationReadiness = vi.fn(ready);
  await expect(facade(data).prepareCandidate({
    draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead,
  })).rejects.toMatchObject({ code: "head_conflict" });
  for (const mode of ["first-decision", "compile"] as const) {
    await expect(compileCatalogPublication({
      ...data, expectedHead, readCurrentHead, observations: { presentationReadiness },
    }, mode)).rejects.toMatchObject({ code: "head_conflict", outcome: "conflict" });
  }
  expect(readCurrentHead).toHaveBeenCalledTimes(2);
  expect(presentationReadiness).not.toHaveBeenCalled();
});

it("T-1 the facade completes a partial head before requesting evidence", async () => {
  const data = await revision();
  const expectedHead = data.expectedHead!;
  const readEvidence = vi.fn<CatalogCandidatePublicationDeps["readEvidence"]>(async () => data.evidence);
  const resolveHead = vi.fn<CatalogCandidateDeps["resolveHead"]>(async () => expectedHead);
  const currentHead = vi.fn<CatalogCandidateDeps["currentHead"]>(async () => ({
    outcome: "found", head: expectedHead, documentRef: "example:document", observations: [],
  }));
  const service = facade(data, { readEvidence }, false, data.record, currentHead, undefined, resolveHead);
  const prepared = await service.prepareCandidate({
    draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead,
  });
  expect(prepared.preparation?.structural.outcome).toBe("staged");
  resolveHead.mockClear();
  readEvidence.mockClear();
  expect(await service.validate(prepared.candidateRef)).toEqual(prepared);
  expect(resolveHead).toHaveBeenCalledExactlyOnceWith({
    publicationId: expectedHead.publicationId, revision: expectedHead.revision,
  });
  expect(readEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedHead }));
  readEvidence.mockClear();
  currentHead.mockRejectedValueOnce(new Error("synthetic current head timeout"));
  const unavailable = await service.validate(prepared.candidateRef);
  expect(unavailable.issues).toEqual([{ code: "publication_head_unavailable", path: "publication" }]);
  expect(readEvidence).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ expectedHead }));
});

it("U-UNRESOLVED-DIGEST refuses to seal until the immutable head is readable", async () => {
  const data = await revision();
  const readHead = vi.fn<CatalogCandidateDeps["currentHead"]>(async () => ({
    outcome: "found", head: data.expectedHead!, documentRef: "example:document", observations: [],
  }));
  const resolveHead = vi.fn<CatalogCandidateDeps["resolveHead"]>(async () => data.expectedHead);
  const service = facade(data, undefined, false, data.record, readHead, undefined, resolveHead);
  const prepared = await service.prepareCandidate({
    draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: data.expectedHead,
  });
  resolveHead.mockResolvedValueOnce(null);
  readHead.mockRejectedValueOnce(new Error("synthetic current head timeout"));
  await expect(service.validate(prepared.candidateRef)).rejects.toMatchObject({ code: "candidate_dependency_unavailable" });
  await expect(service.compareCandidate({ ...prepared, expectedHead: data.expectedHead })).resolves.toEqual(prepared);
});

it.each([false, true])("V-COMPARE-HEAD-OUTAGE refuses a contradictory caller head, outage=%s", async outage => {
  const data = input();
  const currentHead = vi.fn<CatalogCandidateDeps["currentHead"]>(async () => ({ outcome: "unpublished" }));
  const service = facade(data, undefined, false, data.record, currentHead);
  const preview = await service.prepareCandidate({ draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: null });
  currentHead.mockClear();
  if (outage) currentHead.mockResolvedValue({ outcome: "unsupported", reason: "publication_not_supported" });
  await expect(service.compareCandidate({ ...preview, expectedHead: movedHead })).rejects.toMatchObject({ code: "head_conflict" });
  expect(currentHead).not.toHaveBeenCalled();
});

it("U-COMPARE-MALFORMED uses head_conflict on the publication route", async () => {
  const data = await revision();
  const service = facade(data);
  const preview = await service.prepareCandidate({
    draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: data.expectedHead,
  });
  await expect(service.compareCandidate({ ...preview, expectedHead: {} as typeof movedHead }))
    .rejects.toMatchObject({ code: "head_conflict" });
  await expect(service.prepareCandidate({ draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: {} as typeof movedHead }))
    .rejects.toMatchObject({ code: "head_conflict" });
});

it("U-HEAD-READ-ALIASES keeps the expected head independent of the evidence reader", async () => {
  const data = await revision();
  const expectedHead = data.expectedHead!;
  const otherHead = { ...expectedHead, publicationId: movedHead.publicationId };
  const readEvidence = vi.fn<CatalogCandidatePublicationDeps["readEvidence"]>(async request => {
    Object.assign(request.expectedHead!, otherHead);
    return { ...data.evidence, head: otherHead };
  });
  const service = facade(data, { readEvidence });
  await expect(service.prepareCandidate({ draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead }))
    .rejects.toMatchObject({ code: "head_conflict" });
  const { evidence: _evidence, ...decision } = data;
  for (const mode of ["first-decision", "compile"] as const) {
    await expect(compileCatalogPublication({ ...decision, observations: { readEvidence } }, mode))
      .rejects.toMatchObject({ code: "head_conflict" });
  }
  expect(expectedHead.publicationId).not.toBe(otherHead.publicationId);
});

it("Q-PRICE-READ-ALIASES-SEALED-EFFECT discards a price reader mutation", async () => {
  const data = input();
  withPrice(data);
  const validatePrices = vi.fn<NonNullable<CatalogCandidateDeps["validatePrices"]>>(async payload => {
    const price = payload.skus[0]!.priceOperations![0]!;
    expect(price.unitPriceMinor).toBe(100);
    price.unitPriceMinor = 101;
    return [];
  });
  for (const mode of ["first-decision", "compile"] as const) {
    const effects = await compileCatalogPublication({ ...data, validatePrices }, mode);
    expect(effects.priceOperations).toMatchObject([{ unitPriceMinor: 100 }]);
  }
  expect(validatePrices).toHaveBeenCalledTimes(1);
  expect(validatePrices.mock.calls[0]?.[0].skus[0]?.priceOperations?.[0]?.unitPriceMinor).toBe(101);
  expect(data.payload.skus[0]?.priceOperations?.[0]?.unitPriceMinor).toBe(100);
});

it("a supplied invalid optional hook refuses before the installer executor", async () => {
  const definition = { ...input().definition };
  delete definition.validatorRef;
  const malformed = Buffer.from(artifact + "\nmodule.exports.validateMembershipChange = false;");
  const query = vi.fn();
  const install = async () => installCatalogDefinitions({ query }, withCatalogPublicationRules({
    id: "example:rules", namespace: "example", version: 1, openlupRange: "1.x", types: [definition], taxClasses: [], capabilities: {},
  }, () => malformed));
  await expect(install()).rejects.toMatchObject({ code: "catalog_publication_rules_module_invalid",
    diagnostic: { hook: "validateMembershipChange" }, message: expect.stringContaining("Export it as a function or omit it.") });
  expect(query).not.toHaveBeenCalled();
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
  expect(prepared.preparation?.structural.issues).toContainEqual(expect.objectContaining({ code: "publication_preparation_unavailable" }));
  expect(await service.validate(prepared.candidateRef)).toEqual(prepared);
  expect(await service.compareCandidate({ ...prepared, expectedHead: data.expectedHead })).toEqual(prepared);
});

it("the released v2 facade runs its configured validator without publication preparation", async () => {
  const data = input();
  const callback = vi.fn(() => [{ path: "", code: "unexpected_callback" }]);
  data.registry = { resolve: () => ({ ...data.definition, validateContent: callback }) };
  const { publication: _publication, ...payload } = data.payload;
  const record = { ...data.record, payload: { ...payload, schemaVersion: 2 as const } };
  const service = createCatalogCandidateService({ registry: data.registry, readDraft: async () => record,
    installedDefinitionDigest: async () => data.installedDefinitionDigest,
    currentHead: async () => ({ outcome: "unpublished" }), resolveHead: async () => null });
  const preview = await service.prepareCandidate({ draftId: record.draftId, draftRevision: record.revision, expectedHead: null });
  expect(preview.issues).toContainEqual({ code: "unexpected_callback", path: "product.sharedContent" });
  expect(preview?.preparation?.structural.outcome).toBe("unknown");
  expect(await service.validate(preview.candidateRef)).toEqual(preview);
  expect(await service.compareCandidate({ ...preview, expectedHead: null })).toEqual(preview);
  expect(callback).toHaveBeenCalledTimes(3);
});

it("K-3 document-free published content round-trips while the authored draft retains its document", async () => {
  const data = input();
  const { product, skus } = await compileCatalogPublication(data);
  const manifest = { schemaVersion: 2, product, skus: [{ skuId: skus[0]!.id,
    revisionId: "50000000-0000-4000-8000-000000000002", revision: 1, digest: publicationDigest(skus[0]) }] };
  expect(catalogPublicationManifestSchema().parse(JSON.parse(publicationJson(manifest)))).toEqual(manifest);
  const document = data.payload.product.sharedContent.document;
  expect(document).toBeDefined();
  expect(product.content).not.toHaveProperty("document");
  expect(product.document).toEqual(data.payload.product.documentRevision);
  expect(catalogPublicationManifestSchema().safeParse({ ...manifest, product: { ...product, content: { ...product.content, document } } }).success).toBe(false);
  const disguisedPresentation = { ...product.content, presentation: { copy: document } };
  expect(catalogPublicationManifestSchema().safeParse({ ...manifest, product: { ...product, content: disguisedPresentation } }).success).toBe(false);
  const text = exactDocument(data);
  const display = (title: string) => ({ ...manifest, product: { ...product, presentation: { title } } });
  expect(catalogPublicationManifestSchema().safeParse(display(text)).error?.issues[0]?.path).toEqual(["product", "presentation", "title"]);
  expect(catalogPublicationManifestSchema().safeParse(display(text + " ")).success).toBe(true);
  const priorText = `{"revision":0}`;
  const priorDigest = createHash("sha256").update(priorText).digest("hex");
  expect(catalogPublicationManifestSchema(new Set([priorDigest])).safeParse(display(priorText)).error?.issues[0]?.path)
    .toEqual(["product", "presentation", "title"]);
  expect(() => assertPublishedSkuDocumentExclusion({ ...skus[0]!, facts: { derived: document! } },
    new Set([product.document!.digest]))).toThrow(/copied document/);
});

it.each([
  { id: "N-EXACT-OBJECT-COPY", field: "shortName", document: { fr: "Article", en: "Item" },
    exact: { shortName: { en: "Item", fr: "Article" } }, different: { shortName: { en: "Item", fr: "Example" } } },
  { id: "O-EXACT-CANONICAL-STRING", field: "title", document: { title: 'An "example" title' },
    exact: { title: canonicalCatalogDraftJson({ title: 'An "example" title' }) }, different: { title: 'Another "example" title' } },
])("$id excludes the canonical display value from compile and the manifest", async ({ field, document, exact, different }) => {
  const data = { ...input(), ...setupRules(artifact + `
module.exports.identifyDocument = () => ({
  schemaId: "example:document.v1", documentRef: "example:document", productSlug: "article",
  revisionNo: 1, name: "Synthetic article",
});
module.exports.deriveSkuFacts = () => ({ derived: 12 });`) };
  Object.assign(data.payload.product.sharedContent, { document });
  const canonicalText = canonicalCatalogDraftJson(document);
  const digest = createHash("sha256").update(canonicalText).digest("hex");
  data.payload.product.documentRevision!.digest = digest;
  operation(data, "register_document_revision", { canonicalText, digest });
  const setPresentation = (presentation: typeof exact | typeof different) => {
    Object.assign(data.payload.product.sharedContent, { presentation });
    operation(data, "set_product_presentation", { presentation });
  };

  setPresentation(exact);
  await expect(compileCatalogPublication(data)).rejects.toMatchObject({
    code: "catalog_publication_document_text_copied", diagnostic: { path: `product.presentation.${field}` },
  });

  setPresentation(different);
  const { product, skus } = await compileCatalogPublication(data);
  const manifest = { schemaVersion: 2, product, skus: [{ skuId: skus[0]!.id,
    revisionId: "50000000-0000-4000-8000-000000000002", revision: 1, digest: publicationDigest(skus[0]) }] };
  const historicalCodec = catalogPublicationManifestSchema(new Set([digest]));
  expect(historicalCodec.safeParse(manifest).success).toBe(true);
  const display = (presentation: NonNullable<typeof product.presentation>) =>
    ({ ...manifest, product: { ...product, document: input().payload.product.documentRevision!, presentation } });
  expect(historicalCodec.safeParse(display(exact)).error?.issues[0])
    .toMatchObject({ path: ["product", "presentation", field], message: "catalog_publication_document_text_copied" });

  if (field === "title") return;
  const weights = [125, 250];
  const arrayCodec = catalogPublicationManifestSchema(new Set([publicationDigest(weights)]));
  expect(arrayCodec.safeParse(display({ advertisedWeightsG: weights })).error?.issues[0]?.path)
    .toEqual(["product", "presentation", "advertisedWeightsG"]);
  expect(arrayCodec.safeParse(display({ advertisedWeightsG: [125, 500] })).success).toBe(true);
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
  expect(() => publicationDigest(value, bytes - 1)).toThrow(expect.objectContaining({ code: "catalog_publication_envelope_too_large" }));
  expect(publicationDigest(value, bytes)).toBe(publicationDigest(value, bytes + 1));

  const limit = CATALOG_PUBLICATION_LIMITS.skuBytes;
  const exactLimit = "é".repeat((limit - 2) / 2);
  expect(Buffer.byteLength(publicationJson(exactLimit, limit))).toBe(limit);
  expect(() => publicationJson(exactLimit + "x", limit)).toThrow(expect.objectContaining({ code: "catalog_publication_envelope_too_large" }));
});

it("W33 complete generated promotions must be present in the sealed draft", async () => {
  const data = await revision();
  activate(data, "eligibility");
  data.evidence.product!.status = "draft";
  data.evidence.skus[0]!.status = "draft";
  data.observations = { presentationReadiness: ready };
  await expect(compileCatalogPublication(data, "first-decision")).rejects.toThrow(expect.objectContaining({ code: "catalog_publication_activation_effect_missing" }));
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
    expect(() => assertCatalogPublicationPreparation(data.payload)).toThrow(expect.objectContaining({ code: "commerce_product_slug_unsupported" }));
  }
});

it("W17_V5-1856_predicate_precedence_boundary", () => {
  const { definition } = input();
  const net = { dimension: "mass" as const, unit: "openlup:g", unscaled: "9007199254740993", scale: 9 };
  for (const [unscaled, accepts] of [["9007199254740992", false], ["9007199254740993", true], ["9007199254740994", true]] as const) {
    const compare = () => assertCatalogPublicationGrossMass(net, { ...net, unscaled }, definition);
    if (accepts) expect(compare).not.toThrow();
    else expect(compare).toThrow(expect.objectContaining({ code: "catalog_publication_gross_below_net" }));
  }
  expect(() => assertCatalogPublicationGrossMass({ ...net, unscaled: "100", scale: 0 },
    { ...net, unit: "openlup:kg", unscaled: "1", scale: 1 }, definition)).not.toThrow();
});

it("runs the shared shape vectors through the published and stored SKU decoders", async () => {
  const { skus: [sku] } = await compileCatalogPublication(input());
  for (const vector of publicationWireVectors.filter(vector => vector.targetBytes === undefined)) {
    const value = vector.apply(sku!);
    if (vector.valid) {
      const decoded = decodePublishedSku(value, "skus.0");
      const bytes = publicationJson(decoded, CATALOG_PUBLICATION_LIMITS.skuBytes, SKU_PAGE_DEPTH);
      expect(decodeStoredPublicationSku(bytes), vector.name).toEqual(value);
      expect(() => publicationJson({ items: [{ facts: decoded }] }), vector.name).not.toThrow();
    } else {
      expect(() => decodePublishedSku(value, "skus.0"), vector.name).toThrow();
    }
  }
});

it("checks the exact and one-byte-over UTF-8 limits on the final evaluator output after binding the receipt", async () => {
  for (const vector of publicationWireVectors.filter(vector => vector.targetBytes !== undefined)) {
    const data = await revision();
    const retained = data.evidence.skus[0]!;
    const grossMass = { ...retained.netContent, unscaled: "120" };
    data.payload.skus.push({ ...input().payload.skus[0]!, grossMass });
    data.record.commandKey = "k".repeat(240);
    data.evidence.drafts[0]!.receipt = catalogPublicationClaim(data.record);
    const issuingSku = { ...retained, grossMass, source: catalogPublicationClaim(data.record) };
    retained.facts = (vector.apply(issuingSku) as typeof issuingSku).facts;
    Object.assign(data, setupRules(artifact + "\nmodule.exports.deriveSkuFacts = (_text, sku) => sku.facts;"));
    expect(Buffer.byteLength(publicationJson({ ...retained, grossMass }))).toBeLessThan(CATALOG_PUBLICATION_LIMITS.skuBytes);

    const evaluation = compileCatalogPublication(data, "first-decision");
    if (vector.valid) {
      const { skus: [finalSku] } = await evaluation;
      expect(finalSku!.source).toEqual(catalogPublicationClaim(data.record));
      const wire = publicationJson(finalSku, CATALOG_PUBLICATION_LIMITS.skuBytes, SKU_PAGE_DEPTH);
      expect(Buffer.byteLength(wire)).toBe(vector.targetBytes);
      expect(decodeStoredPublicationSku(wire)).toEqual(finalSku);
    } else {
      await expect(evaluation).rejects.toMatchObject({
        code: "catalog_publication_sku_too_large", diagnostic: { subject: retained.code, path: "skus" },
        message: "Reduce the facts or details for SKU ARTICLE and prepare the publication again.",
      });
    }
  }
});

it("explains how to order primary SKU selection before activation", async () => {
  const data = input();
  data.payload.publication.operations = data.payload.publication.operations.filter(operation => operation.op !== "set_primary_sku");
  const activation = data.payload.publication.operations.length;
  data.payload.publication.operations.push({ op: "set_product_status", productSlug: "article", status: "active" });
  await expect(compileCatalogPublication(data, "first-decision")).rejects.toMatchObject({
    code: "catalog_publication_v3_compile_product_incomplete",
    diagnostic: { path: `publication.operations.${activation}` },
    message: "Set the document and the primary SKU before activation. Select a primary SKU or move set_primary_sku before set_product_status.",
  });
});

it("refuses a whole-gram amount whose authored scale cannot be issued natively", async () => {
  const data = input();
  const netContent = { dimension: "mass", unit: "openlup:g", unscaled: "1000", scale: 1 } as const;
  data.payload.skus[0]!.netContent = netContent;
  const query = { draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: null };
  const diagnostic = { code: "catalog_publication_net_weight_unsupported", path: "skus.netContent", subject: "ARTICLE",
    message: expect.stringContaining("whole grams at scale 0") };
  const preview = await facade(data).prepareCandidate(query);
  expect(preview.preparation?.structural.issues).toContainEqual(expect.objectContaining(diagnostic));
  const { message, ...field } = diagnostic;
  for (const mode of ["first-decision", "compile"] as const)
    await expect(compileCatalogPublication(data, mode)).rejects.toMatchObject({ code: field.code, diagnostic: field, message });
  expect(data.payload.skus[0]!.netContent).toEqual(netContent);
});

it.each([
  ["document", "catalog_publication_document_required"],
  ["primarySkuId", "catalog_publication_primary_sku_required"],
] as const)("gives a typed preparation refusal for a missing native product %s", async (field, code) => {
  const data = input();
  const skip = field === "document" ? ["move_document_pointer", "create_sku", "set_primary_sku",
    "create_identifier", "set_eligibility", "set_sku_metadata", "set_offer_membership", "set_derived_sku_facts", "set_sku_status"] : ["set_primary_sku"];
  data.payload.publication.operations = data.payload.publication.operations.filter(operation => !skip.includes(operation.op));
  await expect(compileCatalogPublication(data)).rejects.toMatchObject({ code, diagnostic: { path: `product.${field}` } });
});

it("refuses a nested reserved key in published intent at its exact field", async () => {
  const data = input();
  data.payload.product.sharedContent.publicationSkus[0]!.facts = { neutral: [{ canoniCAL__text: false }] };
  const preview = await facade(data).prepareCandidate({ draftId: data.record.draftId, draftRevision: data.record.revision, expectedHead: null });
  expect(preview.preparation?.structural.issues).toContainEqual(expect.objectContaining({
    code: "catalog_publication_reserved_carrier", path: "product.sharedContent.publicationSkus.0.facts.neutral.0.canoniCAL__text",
  }));
});

it.each(['"scalar"', '{"label":"article"} true'])("refuses registration text %s before calling document rules", async canonicalText => {
  const data = input();
  const digest = createHash("sha256").update(canonicalText).digest("hex");
  operation(data, "register_document_revision", { canonicalText, digest });
  data.payload.product.documentRevision!.digest = digest;
  await expect(compileCatalogPublication(data)).rejects.toMatchObject({ code: "catalog_publication_v3_document_invalid",
    diagnostic: { path: expect.stringMatching(/^publication\.operations\.\d+\.canonicalText$/u) } });
});

it("requires a remedy at the production table for every platform code", () => {
  const file = fileURLToPath(new URL("../../src/catalog/publicationError.ts", import.meta.url));
  const config = fileURLToPath(new URL("../../tsconfig.build.json", import.meta.url));
  const options = { ...ts.getParsedCommandLineOfConfigFile(config, {}, {
    ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(String(diagnostic.messageText)); },
  })!.options, noEmit: true, types: ["node"] };
  const host = ts.createCompilerHost(options);
  const readFile = host.readFile.bind(host);
  const source = readFileSync(file, "utf8");
  const sentinel = "unmapped_refusal_sentinel";
  const extended = source.replace(/(export type PlatformCode\s*=)/u, `$1 "${sentinel}" |`);
  const table = "const publicationRefusals = {";
  const check = (replacement: string) => {
    host.readFile = name => name === file ? replacement : readFile(name);
    return ts.getPreEmitDiagnostics(ts.createProgram([file], options, host));
  };

  const diagnostics = check(extended);
  const missing = diagnostics.find(item => item.file?.fileName === file && item.code === 1360
    && ts.flattenDiagnosticMessageText(item.messageText, "\n").includes(sentinel));
  expect(missing).toBeDefined();
  const line = missing!.file!.getLineAndCharacterOfPosition(missing!.start!).line;
  expect(extended.split("\n")[line]).toContain("satisfies Record<PlatformCode, Remedy>");
  const fixed = extended.replace(table, `${table}\n  ${sentinel}: { fix: "Supply the missing value." },`);
  expect(check(fixed).map(item => ts.flattenDiagnosticMessageText(item.messageText, "\n"))).toEqual([]);
}, 30_000);

it("recognizes every price refusal literal emitted by the SQL claim and apply routines", () => {
  const sql = readFileSync(new URL("../../../../db/platform/migrations/20261123191000_catalog_publication_commands.sql", import.meta.url), "utf8");
  const claim = sql.split("CREATE FUNCTION public.catalog_price_setup_claim(")[1]!.split("\n$$;")[0]!;
  const apply = sql.split("CREATE FUNCTION public.catalog_price_setup_apply_claimed(")[1]!.split("\n$$;")[0]!;
  const caseRefusals = apply.match(/v_refusal\s*:=\s*CASE([\s\S]+?)\bEND;/u)?.[1] ?? "";
  const literals = [
    ...claim.matchAll(/'reason',\s*'([a-z_]+)'/gu),
    ...caseRefusals.matchAll(/\bTHEN\s*'([a-z_]+)'/gu),
    ...apply.matchAll(/\bv_refusal\s*:=\s*'([a-z_]+)'/gu),
  ].map(match => match[1]!);
  expect([...new Set(literals)].sort()).toEqual([...publicationPriceRefusalReason.options].sort());
});
