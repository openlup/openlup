import { createHash } from "node:crypto";
import { z } from "./validation.js";
import { catalogDraftSummarySchema } from "./draftSchemas.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { isValidGtin, catalogDocumentRevisionRefSchema } from "./foundationSchemas.js";
import { canonicalizeCatalogCombinationV2 } from "./variantCombination.js";
import { CATALOG_QUANTITY_UNITS, canonicalizeCatalogQuantity, parseCatalogQuantity } from "@openlup/core/catalog";
import type { CatalogDraftIssue, CatalogProductTypeDefinition, CatalogQuantity } from "./contracts/productTypes.js";
import type { CatalogDraftPayloadV3, CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogDraftClaimV3, CatalogDraftMediaClaimV3 } from "./contracts/draftV3.js";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./contracts/publication.js";
import { CATALOG_PUBLICATION_LIMITS } from "./contracts/publication.js";
import { CatalogPublicationError, publicationDiagnostic, publicationIssue, publicationRefuse } from "./publicationError.js";
import { assertPublishedFacts, assertPublishedPresentation, assertPublishedSkuDocumentExclusion, catalogPublishedProductSchema, catalogPublishedSkuSchema, comparePublicationText, decodePublishedProduct, publicationContent,
  publicationDigest, publicationJson, publicationReadinessVerdict } from "./publicationCodec.js";
import { resolvePublicationRules, ruleProduct, ruleSku } from "./publicationRules.js";
import type { CatalogPublicationRulesModule, CatalogRulesContext } from "./catalogPublicationRules.js";
import { validateCatalogDraftV2 } from "./draftV2Validation.js";
import { validateCatalogAttributes } from "./attributeValidation.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import type { CatalogCandidateIssue } from "./contracts/candidate.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import type { CatalogHeadRef } from "./contracts/lifecycle.js";
import { publicationHeadSchema, type CatalogPublicationEvidence, type CatalogPublicationDraftEvidence, type CatalogPublicationDocument, type CatalogCandidatePublicationDeps } from "./publicationEvidence.js";
import { isLifecycleOperation, lifecycleTransition, publicationIntent, readPublicationDraftRecord,
  lifecycleEvidenceSchema, lifecycleWithdrawalOnly, type PublicationDraftRecord, type PublicationIntent, type PublicationLifecycleOperation, type PublicationOperation } from "./publicationIntent.js";
import { enablesSku, requiredPromotions, sealedPresentation } from "./publicationDraft.js";

export interface CatalogPublicationCompileInput {
  record: PublicationDraftRecord;
  definition: CatalogProductTypeDefinition;
  installedDefinitionDigest: string;
  expectedHead: CatalogHeadRef | null;
  readCurrentHead?: () => Promise<CatalogHeadRef | null | undefined>;
  evidence?: CatalogPublicationEvidence | null;
  evaluation?: CatalogRulesContext;
  attributeReferences?: CatalogAttributeReferencePort | undefined;
  validatePrices?: ((payload: CatalogDraftPayloadV2) => Promise<readonly CatalogDraftIssue[]>) | undefined;
  capacity?: number;
  observations?: Partial<Pick<CatalogCandidatePublicationDeps, "readEvidence" | "presentationReadiness" | "verifyMedia" | "assessActivation">> | undefined;
}
export function catalogPublicationClaim(record: PublicationDraftRecord): CatalogDraftClaimV3 {
  return { draftId: record.draftId, revision: record.revision, commandKey: record.commandKey, fingerprint: record.fingerprint };
}
const equal = (a: unknown, b: unknown): boolean => publicationJson(a) === publicationJson(b);
const need = (condition: unknown, reason: string): void => { if (!condition) publicationRefuse(reason); };
function assertCatalogAction(payload: PublicationIntent, action: "create" | "revise") {
  need(payload.product.sharedContent.catalogAction === action, "catalog_action_conflict");
}
const authoredSlug = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/u);
/** Temporary native publication boundary, until versioned quantity readers land. */
export function catalogPublicationIntegralGrams(quantity: CatalogQuantity, definition: CatalogProductTypeDefinition): string {
  const reason = "catalog_publication_integral_grams_required";
  try {
    const units = definition.units.flatMap(unit => {
      const known = CATALOG_QUANTITY_UNITS.find(value => value.code === unit.code);
      return known ? [known] : unit.factor ? [{ ...unit, factor: unit.factor }] : [];
    });
    const value = canonicalizeCatalogQuantity(parseCatalogQuantity(quantity, units), units);
    const divisor = 10n ** BigInt(value.scale), unscaled = BigInt(value.unscaled);
    need(value.dimension === "mass" && value.unit === "openlup:g" && unscaled > 0n && unscaled % divisor === 0n, reason);
    const grams = unscaled / divisor, maximum = 2_147_483_647n;
    need(grams <= maximum, reason);
    return grams.toString();
  } catch { return publicationRefuse(reason); }
}
export function assertCatalogPublicationMassInputs(payload: unknown, definition: CatalogProductTypeDefinition): void {
  const header = z.object({ skus: z.array(z.object({ code: z.string().optional(), netContent: z.unknown().optional() })) }).safeParse(payload);
  if (!header.success) return;
  for (const [index, sku] of header.data.skus.entries()) {
    const value = sku.netContent;
    if (value && typeof value === "object" && "dimension" in value && value.dimension === "mass") {
      try { catalogPublicationIntegralGrams(value as CatalogQuantity, definition); }
      catch (error) {
        if (!(error instanceof CatalogPublicationError)) throw error;
        throw new CatalogPublicationError(error.code, error.outcome,
          publicationIssue(error.code, "structural", `skus.${index}.netContent`, sku.code ?? definition.key));
      }
    }
  }
}
type AmountBinding = { definition: CatalogProductTypeDefinition; rules: Pick<CatalogPublicationRulesModule, "validateSkuAmounts"> };

/** @experimental */
export function catalogPublicationPreparationIssues(payload: PublicationIntent, binding?: AmountBinding) {
  const issues: { path: string; code: string }[] = [];
  const add = (path: string, code: string) => issues.push({ path, code });
  if (!authoredSlug.safeParse(payload.product.slug).success) add("product.slug", "commerce_product_slug_unsupported");
  const codes = new Set(payload.skus.map(sku => sku.code));
  const content = payload.product.sharedContent;
  for (const key of ["publicationSkus", "requestedModes", "offerMemberships"] as const)
    if (content[key].some(intent => !codes.has(intent.skuCode))) add(`product.sharedContent.${key}`, "intent_sku_absent");
  payload.skus.forEach((sku, index) => {
    const path = `skus.${index}`;
    if (!sku.code) { add(`${path}.code`, "sku_code_missing"); return; }
    if (!sku.identifiers?.some(identifier => identifier.scheme === "gs1:gtin"
      && identifier.packagingLevel === "unit" && isValidGtin(identifier.value))) add(`${path}.identifiers`, "unit_trade_identifier_missing");
    if (!binding || sku.netContent?.dimension !== "mass") return;
    try {
      if (sku.grossMass) assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass, binding.definition);
      const netGrams = catalogPublicationIntegralGrams(sku.netContent, binding.definition);
      if (binding.rules.validateSkuAmounts && binding.rules.validateSkuAmounts({ code: sku.code, netGrams }) !== true)
        add(`${path}.netContent`, "catalog_publication_authored_amounts_invalid");
    } catch (error) {
      if (!(error instanceof CatalogPublicationError)) throw error;
      if (error.code === "catalog_publication_rule_failed") {
        throw new CatalogPublicationError(error.code, error.outcome,
          publicationDiagnostic(error, "structural", `${path}.netContent`, sku.code));
      }
      add(`${path}.${error.code.startsWith("catalog_publication_gross") ? "grossMass" : "netContent"}`, error.code);
    }
  });
  return issues;
}
/** Hard preparation guard, independent of dark/activation readiness.
 * @experimental
 */
export function assertCatalogPublicationPreparation(payload: CatalogDraftPayloadV3, binding?: AmountBinding): void {
  const [first] = catalogPublicationPreparationIssues(payload, binding);
  if (first) publicationRefuse(first.code);
}
/** Exact scaled comparison after owner-defined conversion, with no rounding or Number arithmetic.
 * @experimental
 */
export function assertCatalogPublicationGrossMass(net: CatalogQuantity, gross: CatalogQuantity | null, definition: CatalogProductTypeDefinition): void {
  need(net.dimension === "mass", "catalog_publication_mass_required_until_mc5");
  need(gross?.dimension === "mass", "catalog_publication_gross_mass_required");
  const units = definition.units.flatMap(unit => {
    const known = CATALOG_QUANTITY_UNITS.find(value => value.code === unit.code);
    return known ? [known] : unit.factor ? [{ ...unit, factor: unit.factor }] : [];
  });
  try {
    const n = canonicalizeCatalogQuantity(parseCatalogQuantity(net, units), units);
    const g = canonicalizeCatalogQuantity(parseCatalogQuantity(gross!, units), units);
    need(g.dimension === "mass" && n.unit === g.unit && BigInt(g.unscaled) > 0n, "catalog_publication_gross_mass_invalid");
    need(BigInt(g.unscaled) * 10n ** BigInt(n.scale) >= BigInt(n.unscaled) * 10n ** BigInt(g.scale), "catalog_publication_gross_below_net");
  } catch (error) { if (error instanceof CatalogPublicationError) throw error; publicationRefuse("catalog_publication_gross_mass_invalid"); }
}

export function unresolvedPublicationDraftIssues<T extends { code: string }>(issues: readonly T[],
  retained: Pick<CatalogPublicationEvidence, "product" | "skus">): T[] {
  return issues.filter(issue => !(issue.code === "primary_sku_missing" && retained.product?.primarySkuId
    || issue.code === "sku_missing" && retained.skus.length > 0));
}

/** @experimental */
export function catalogPublicationAffected(payload: PublicationIntent) {
  let wholeProduct = false;
  const created = new Set<string>(), admitted = new Set<string>(), enabling = new Set<string>();
  for (const op of payload.publication.operations) {
    if (op.op === "create_sku") created.add(op.skuCode);
    if (op.op === "set_offer_membership" && op.admitted) admitted.add(op.skuCode);
    if (op.op === "set_eligibility" && enablesSku(op)) enabling.add(op.skuCode);
    if ((op.op === "move_document_pointer" || op.op === "set_product_status" && op.status === "active"
      || op.op === "set_product_lifecycle" && op.state === "active" || op.op === "restore_product")
      && op.productSlug === payload.product.slug) wholeProduct = true;
  }
  const structural = (code: string) => wholeProduct || created.has(code) || admitted.has(code);
  return { structural, enabling,
    source: (code: string) => wholeProduct || admitted.has(code),
    priced: (sku: CatalogPublishedSku) => enabling.has(sku.code) || structural(sku.code) && sku.status === "active"
      && (sku.sellableStandalone || sku.sellableInSubscription) && sku.memberships.some(row => row.admitted),
  };
}
function matchesAuthoredIdentifier(
  authored: NonNullable<CatalogDraftPayloadV3["skus"][number]["identifiers"]>[number],
  published: Pick<CatalogPublishedSku["identifiers"][number], "scheme" | "issuer" | "value" | "packagingLevel" | "quantity">,
) {
  return authored.scheme === published.scheme && authored.issuer === published.issuer
    && (authored.scheme === "gs1:gtin" ? isValidGtin(authored.value) && authored.value.padStart(14, "0") === published.value.padStart(14, "0")
      : authored.value === published.value)
    && authored.packagingLevel === published.packagingLevel && (authored.quantity ?? 1) === published.quantity;
}
/** Checks a sealed media claim against the presentation and SKU before consulting installed evidence.
 * @experimental
 */
export function catalogPublicationMediaIssue(mediaRef: unknown, assets: readonly string[],
  claim?: NonNullable<CatalogDraftPayloadV3["publication"]["evidence"]["media"]>[number]) {
  if (!mediaRef && !assets.length && !claim) return null;
  if (typeof mediaRef !== "string" || !mediaRef) return "media_reference_missing";
  if (!claim) return "media_readiness_unknown";
  // The draft seal retains its established order. Compare both sets using the
  // database order without changing signed or persisted bytes.
  return claim.mediaRef === mediaRef && equal([...assets].sort(comparePublicationText), [...claim.assetRefs].sort(comparePublicationText))
    ? null : "media_readiness_mismatch";
}
function checkedDocument(canonicalText: string, reference: Pick<CatalogPublicationDocument["reference"], "digest" | "documentRef" | "revisionNo" | "schemaId">,
  slug: string, rules: CatalogPublicationRulesModule) {
  const documentInfo = rules.inspectDocument(canonicalText);
  if (!documentInfo) return publicationRefuse("catalog_publication_v3_document_invalid");
  need(documentInfo.productSlug === slug && documentInfo.documentRef === reference.documentRef
    && documentInfo.revisionNo === reference.revisionNo && documentInfo.schemaId === reference.schemaId,
  "catalog_publication_document_source_mismatch");
  need(documentInfo.canonicallyEncoded === true, "catalog_publication_v3_document_not_canonical");
  return documentInfo;
}
function matchesAuthoredDocument(authoredValue: unknown, canonicalText: string, rules: CatalogPublicationRulesModule) {
  return rules.matchesDocument(authoredValue, canonicalText) === true;
}
function documentSkuFacts(document: Pick<CatalogPublicationDocument, "canonicalText">, sku: CatalogPublishedSku, rules: CatalogPublicationRulesModule): CatalogPublicationFacts {
  return rules.deriveSkuFacts(document.canonicalText, ruleSku(sku));
}


function assertSkuCreationDocument(operation: Extract<PublicationOperation, { op: "create_sku" }>,
  authored: CatalogDraftPayloadV3["product"]["documentRevision"], current: CatalogPublishedProduct["document"] | undefined = authored) {
  need(operation.documentRevisionNo === current?.revisionNo && equal(authored, current), "catalog_publication_v3_compile_document_stale");
}

function assertMaterializedSkuSource(sku: CatalogPublishedSku | undefined, source: CatalogDraftPayloadV3["skus"][number]) {
  need(sku && sku.id === source.id && sku.productId === source.productId
    && source.netContent && equal(source.netContent, sku.netContent) && equal(source.options, sku.options), "catalog_publication_operation_source_mismatch");
  for (const identifier of source.identifiers ?? []) {
    need(sku!.identifiers.some(stored => identifier.scheme === "gs1:gtin" && stored.scheme === "gs1:gtin"
      ? isValidGtin(identifier.value) && identifier.value.padStart(14, "0") === stored.value.padStart(14, "0")
      : matchesAuthoredIdentifier(identifier, stored)), "catalog_publication_identifier_source_mismatch");
  }
}

function skuCreationFacts(operation: Extract<PublicationOperation, { op: "create_sku" }>,
  source: { sku: CatalogDraftPayloadV3["skus"][number]; source: PublicationDraftRecord }, productId: string): CatalogPublishedSku {
  const { sku } = source;
  need(sku.netContent?.dimension === "mass", "catalog_publication_mass_required_until_mc5");
  return { id: operation.skuId, productId, code: operation.skuCode, title: operation.title,
    status: "draft", minQuantity: operation.minQuantity, isAddon: operation.isAddon, sellableStandalone: false, sellableInSubscription: false,
    netContent: sku.netContent!, grossMass: sku.grossMass ?? null, options: sku.options, attributes: sku.attributes ?? {},
    facts: operation.facts, identifiers: [], assetRefs: sku.assetRefs ?? [], logisticsRef: null, memberships: [], source: catalogPublicationClaim(source.source) };
}

function applyMembershipChange(rules: CatalogPublicationRulesModule | undefined, sku: CatalogPublishedSku,
  { offerVersion, admitted }: Extract<PublicationOperation, { op: "set_offer_membership" }>) {
  const row = { offerVersion, admitted };
  if (rules?.validateMembershipChange)
    need(rules.validateMembershipChange(ruleSku(sku), row) === true, "catalog_publication_membership_change_not_allowed");
  const index = sku.memberships.findIndex(value => value.offerVersion === offerVersion);
  if (index < 0) sku.memberships.push(row); else sku.memberships[index] = row;
  sku.memberships.sort((a, b) => comparePublicationText(a.offerVersion, b.offerVersion));
}

function prefixSku(skus: ReadonlyMap<string, CatalogPublishedSku>, code: string): CatalogPublishedSku {
  return skus.get(code) ?? publicationRefuse("catalog_publication_v3_compile_sku_absent");
}

function applySkuPrefix(sku: CatalogPublishedSku, operation: PublicationOperation, rules: CatalogPublicationRulesModule | undefined) {
  switch (operation.op) {
    case "create_identifier": {
      const { op: _op, skuCode: _code, ...identifier } = operation;
      sku.identifiers.push(identifier);
      break;
    }
    case "set_eligibility":
      sku.sellableStandalone = operation.sellableStandalone; sku.sellableInSubscription = operation.sellableInSubscription;
      break;
    case "set_sku_status": sku.status = operation.status; break;
    case "set_offer_membership": applyMembershipChange(rules, sku, operation); break;
    case "set_sku_metadata": sku.logisticsRef = operation.logisticsRef; break;
    case "set_derived_sku_facts": sku.facts = operation.facts; break;
  }
}

function assertDerivedSource(operation: Extract<PublicationOperation, { op: "set_derived_sku_facts" }>,
  original: Pick<CatalogPublishedSku, "netContent"> | undefined, authoredRevision: number | undefined) {
  need(original && equal(original.netContent, operation.netContent) && operation.documentRevisionNo === authoredRevision,
    "catalog_publication_derived_source_mismatch");
}

function publicationAuthorship(record: PublicationDraftRecord, payload: PublicationIntent,
  retained: readonly CatalogPublicationDraftEvidence[], materialized: ReadonlyMap<string, CatalogPublishedSku>,
  rules: CatalogPublicationRulesModule | undefined, missingEvidence: boolean, onUnavailable: () => void) {
  const slug = payload.product.slug!;
  const explicit = payload.publication.evidence.drafts ?? [];
  const sources = [record, ...retained.map(entry => entry.record)];
  const intents = new Map(sources.map(source => [source, source === record ? payload : publicationIntent(source.payload)!]));
  const incoming = new Map(payload.skus.map(sku => [sku.code, sku]));
  const declared = new Set(explicit.map(claim => `${claim.draftId}@${claim.revision}`));
  const isDeclared = (source: PublicationDraftRecord) => declared.has(`${source.draftId}@${source.revision}`);
  const registrations = new Map(payload.publication.operations.flatMap(operation =>
    operation.op === "register_document_revision" ? [[operation.revisionId, operation] as const] : []));
  const proven = new Map(retained.map(entry => [entry.record, entry]));
  function requireCurrent(source: PublicationDraftRecord) {
    const entry = proven.get(source);
    if (!entry || !bindDraftObservation(entry, source, record)) {
      onUnavailable();
      return false;
    }
    return true;
  }
  function sku(code: string, allowRetained = false, missingReason = "catalog_publication_operation_source_missing") {
    const candidates = sources.flatMap(source => {
      if (source !== record && !allowRetained && !isDeclared(source)) return [];
      const intent = intents.get(source)!;
      const value = source === record ? incoming.get(code) : intent.skus.find(sku => sku.code === code);
      return value ? [{ source, payload: intent, sku: value }] : [];
    });
    const acting = candidates.filter(row => row.source === record || isDeclared(row.source));
    if (!allowRetained) need(acting.length <= 1, "catalog_publication_operation_source_ambiguous");
    const actual = materialized.get(code);
    // Select the materialized identity before using history's recency order.
    const preferred = allowRetained ? [...acting].sort((left, right) => comparePublicationText(left.source.draftId, right.source.draftId))[0] : acting[0];
    const selected = preferred ?? (allowRetained ? candidates.find(row =>
      row.sku.id === actual?.id && row.sku.productId === actual.productId && row.source.productId === actual.productId) : undefined);
    if (!selected) {
      if (missingEvidence) return undefined;
      return publicationRefuse(missingReason);
    }
    need(selected.sku.productId === payload.product.id, "catalog_publication_operation_source_mismatch");
    if (selected.source !== record && allowRetained && !isDeclared(selected.source) && !requireCurrent(selected.source)) return undefined;
    return selected;
  }
  function documentSource(operation: Extract<PublicationOperation, { op: "register_document_revision" }>) {
    const { provenance: given } = operation;
    const provenance = given.source === "current_draft"
      ? { draftId: record.draftId, draftRevision: record.revision, draftCommandKey: record.commandKey, draftFingerprint: record.fingerprint }
      : { draftId: given.draftId, draftRevision: given.draftRevision, draftCommandKey: given.draftCommandKey, draftFingerprint: given.draftFingerprint };
    const source = sources.find(source => source.draftId === provenance.draftId && source.revision === provenance.draftRevision
      && source.commandKey === provenance.draftCommandKey && source.fingerprint === provenance.draftFingerprint);
    return { source, provenance };
  }
  function document(operation: Extract<PublicationOperation, { op: "register_document_revision" }>): CatalogPublicationDocument | undefined {
    const { source, provenance } = documentSource(operation);
    const intent = source && intents.get(source);
    const reference = intent?.product.documentRevision;
    if (reference && rules) checkedDocument(operation.canonicalText, { ...operation, schemaId: reference.schemaId }, slug, rules);
    if (!source && missingEvidence) return undefined;
    if (!source || !intent || source.productId !== payload.product.id) return publicationRefuse("catalog_publication_document_source_missing");
    if (!reference || reference.id !== operation.revisionId || reference.revisionNo !== operation.revisionNo
      || reference.documentRef !== operation.documentRef || reference.sourceRef !== operation.sourceRef || reference.digest !== operation.digest)
      return publicationRefuse("catalog_publication_document_source_mismatch");
    if (rules && intent.product.sharedContent.document !== undefined)
      need(matchesAuthoredDocument(intent.product.sharedContent.document, operation.canonicalText, rules), "catalog_publication_v3_document_invalid");
    return { reference, canonicalText: operation.canonicalText, provenance };
  }
  function productOperation(operation: Extract<PublicationOperation, { productSlug: string }>) {
    need(operation.productSlug === slug, "catalog_publication_scope_expansion");
    if (operation.op === "create_product") {
      assertCatalogAction(payload, "create");
      need(operation.productId === payload.product.id, "catalog_publication_v3_compile_product_conflict");
      if (rules) {
        const reference = payload.product.documentRevision!;
        const registration = registrations.get(reference.id);
        if (payload.product.sharedContent.document !== undefined) {
          const name = rules.identifyDocument(payload.product.sharedContent.document)?.name;
          need(name === operation.name, "catalog_publication_product_name_source_mismatch");
        } else if (registration) {
          const info = checkedDocument(registration.canonicalText, reference, slug, rules);
          need(info.name === operation.name, "catalog_publication_product_name_source_mismatch");
        } else publicationRefuse("catalog_publication_document_source_missing");
      }
    }
    if (operation.op === "move_document_pointer")
      need(operation.documentRevisionNo === payload.product.documentRevision?.revisionNo, "catalog_publication_document_source_mismatch");
    if (operation.op === "set_product_presentation")
      need(equal(sealedPresentation(operation.presentation), payload.product.sharedContent.presentation), "catalog_publication_presentation_source_mismatch");
  }
  function skuOperation(operation: Extract<PublicationOperation, { skuCode: string }>) {
    const source = sku(operation.skuCode);
    if (!source) return undefined;
    const content = source.payload.product.sharedContent;
    if (operation.op === "create_sku") {
      const authored = content.publicationSkus.find(sku => sku.skuCode === operation.skuCode);
      need(source!.sku.id === operation.skuId && authored && equal(authored, {
        skuCode: operation.skuCode, title: operation.title, minQuantity: operation.minQuantity, isAddon: operation.isAddon, facts: operation.facts,
      }), "catalog_publication_operation_source_mismatch");
    }
    if (operation.op === "create_identifier")
      need(source!.sku.identifiers?.some(identifier => matchesAuthoredIdentifier(identifier, operation)), "catalog_publication_identifier_source_mismatch");
    if (operation.op === "set_primary_sku")
      need(source.payload.product.primarySkuId === source!.sku.id, "catalog_publication_v3_compile_primary_foreign");
    if (operation.op === "set_eligibility") {
      const modes = content.requestedModes.find(value => value.skuCode === operation.skuCode)?.modes ?? [];
      need(operation.sellableStandalone === modes.includes("one_time") && operation.sellableInSubscription === modes.includes("subscription"),
        "catalog_publication_eligibility_source_mismatch");
    }
    if (operation.op === "set_offer_membership")
      need(content.offerMemberships.some(row => equal(row, { skuCode: operation.skuCode, offerVersion: operation.offerVersion, admitted: operation.admitted })),
        "catalog_publication_membership_source_mismatch");
    if (operation.op === "set_sku_metadata")
      need(operation.logisticsRef === (source.sku.logisticsRef ?? null), "catalog_publication_logistics_source_mismatch");
    return source;
  }
  return { document, documentSource, productOperation, skuOperation, sku };
}

type PublicationMode = "preview" | "first-decision" | "compile";
type PublicationPhase = "structural" | "activation";
type EvaluationIssue = { diagnostic: CatalogCandidateIssue; outcome: CatalogPublicationError["outcome"] };
const unavailable = (diagnostic: CatalogCandidateIssue): EvaluationIssue => ({ diagnostic, outcome: "dependency_unavailable" });
const isUnavailable = (issue: EvaluationIssue): boolean => issue.outcome === "dependency_unavailable";

const draftReceipt = catalogDraftSummarySchema.pick({ draftId: true, revision: true, commandKey: true, fingerprint: true }).strip();
const draftHead = catalogDraftSummarySchema.pick({ draftId: true, productId: true, revision: true, status: true }).strip();
const documentProvenance = z.object({ draftId: draftReceipt.shape.draftId, draftRevision: draftReceipt.shape.revision,
  draftCommandKey: draftReceipt.shape.commandKey, draftFingerprint: draftReceipt.shape.fingerprint });
function bindDraftObservation(entry: CatalogPublicationDraftEvidence, source: PublicationDraftRecord,
  candidate: PublicationDraftRecord, claim?: CatalogDraftClaimV3) {
  const receipt = draftReceipt.safeParse(entry.receipt);
  const head = draftHead.safeParse(entry.head);
  need(source.status === "open" && source.productId === candidate.productId
    && equal(source.payload.product.type, candidate.payload.product.type), "catalog_publication_source_mismatch");
  if (receipt.success) {
    need(equal(catalogPublicationClaim(source), receipt.data) && (!claim || equal(claim, receipt.data)), "catalog_publication_source_mismatch");
  }
  if (head.success) {
    need(head.data.draftId === source.draftId && head.data.productId === source.productId
      && head.data.revision === source.revision && head.data.status === "open", "catalog_publication_draft_advanced");
  }
  return receipt.success && head.success;
}
function boundDrafts(record: PublicationDraftRecord, payload: PublicationIntent, rows: readonly CatalogPublicationDraftEvidence[]) {
  const seen = new Set<string>();
  const retained: CatalogPublicationDraftEvidence[] = [];
  const claimed: PublicationDraftRecord[] = [];
  let candidateFound = false, incomplete = false;
  for (const entry of rows) {
    const source = readPublicationDraftRecord(entry?.record);
    if (!source) { incomplete = true; continue; }
    const key = `${source.draftId}@${source.revision}`;
    need(!seen.has(key), "catalog_publication_source_mismatch");
    seen.add(key);
    const candidate = source.draftId === record.draftId && source.revision === record.revision;
    const explicit = payload.publication.evidence.drafts?.find(claim => claim.draftId === source.draftId && claim.revision === source.revision);
    if (candidate) {
      need(equal(source.payload, record.payload), "catalog_publication_source_mismatch");
      candidateFound = true;
    }
    if (candidate || explicit) {
      const verified = bindDraftObservation(entry, source, record, explicit ?? catalogPublicationClaim(record));
      if (!verified) { incomplete = true; continue; }
    }
    if (!candidate) {
      retained.push({ ...entry, record: source });
      if (explicit) claimed.push(source);
    }
  }
  if (!incomplete)
    need(candidateFound && (payload.publication.evidence.drafts ?? []).every(claim => seen.has(`${claim.draftId}@${claim.revision}`)),
      "catalog_publication_source_mismatch");
  return { retained, claimed, incomplete };
}

async function observe<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try { return await read(); } catch { return undefined; }
}

/** Interpret one sealed intent. A writer can consume the ordered operations
 * and price obligations after successful evaluation against its guarded facts.
 */
export async function evaluateCatalogPublication(input: CatalogPublicationCompileInput, mode: PublicationMode) {
  const structural: EvaluationIssue[] = [], activationIssues: EvaluationIssue[] = [];
  const position = { phase: "structural" as PublicationPhase, path: "product", subject: input.definition.key };
  const missing = (code: string, path: string) => unavailable(publicationIssue(code, position.phase, path, position.subject));
  let activating = false;
  let failure: CatalogPublicationError | undefined;
  const pending: (CatalogDraftIssue & { channel?: "one_time" | "subscription" })[] = [];
  try {
    const compiled = await planPublication();
    return { compiled, structural, activationIssues, activating, pending, failure };
  } catch (error) {
    if (!(error instanceof CatalogPublicationError)) throw error;
    const diagnostic = publicationDiagnostic(error, position.phase, position.path, position.subject);
    const issues = diagnostic.phase === "activation" ? activationIssues : structural;
    const issue = { diagnostic, outcome: error.outcome };
    if (isUnavailable(issue)) issues.push(issue);
    else { failure = new CatalogPublicationError(error.code, error.outcome, diagnostic); issues.unshift(issue); }
    return { compiled: undefined, structural, activationIssues, activating, pending, failure };
  }


  async function planPublication() {
    let admitted!: Awaited<ReturnType<typeof admit>>;
    let bound!: Awaited<ReturnType<typeof bindEvidence>>;
    // Donor: P is supabase/migrations/20261012074153_catalog_propagation_product_publication.sql.
    // M is supabase/migrations/20261012074151_catalog_propagation_membership.sql.
    // T is catalogPropagationDraftCompiler.ts in the donor overlay (15ef3b8cf).
    // Admission precedes all lineage checks; bind and compare each source operation in supplied order.
    // Core-W compares publication lineage at write time (P:815–817).
    // Phase                    Modes               Donor at 15ef3b8cf
    const phases = [
      { run: async () => { admitted = await admit(); } },                                       // Admit                   all  P:420–442,482–485,745–747,808–809
      { run: async () => { bound = await bindEvidence(admitted); } },               // Bind reads              all  P:508–594 (draft heads: P:560–569)
      { run: () => bound.bindSources() },                                           // Saved-operation sources all  P:595–672
      { run: () => bound.checkPhysicalSources() },                                  // Media and identity      all  P:674–691, T:106–117
      { run: () => bound.checkActivationSources(), activation: true },               // Activation sources      P:263–292,502,548–558,683–697, T:133–152
      { run: () => bound.applyPrefixes() },                                         // Ordered effects         all  P:815–929, M:91–98
      { run: () => bound.checkStructuralResult() },                                 // Structural result       all  P:940–954
      { run: () => bound.checkActivationResult(), activation: true },                // Activation result       P:955–969
    ];
    for (const phase of phases) if (!phase.activation || mode !== "first-decision") await phase.run();
    if (mode === "preview") bound.addPending();
    return bound.result();
  }

  async function admit() {
    const { record, definition } = input;
    position.path = "product.type";
    need(input.installedDefinitionDigest === catalogDefinitionDigest(definition), "catalog_definition_drift");
    const rules = resolvePublicationRules(definition, input.evaluation ?? { evaluatedAt: record.createdAt }, mode !== "preview");
    position.path = "product";
    need(record.payload?.schemaVersion === 3 || record.payload?.schemaVersion === 4, "catalog_publication_source_invalid");
    let canonicalPayload: string;
    try { canonicalPayload = canonicalCatalogDraftJson(record.payload); }
    catch { return publicationRefuse("candidate_invalid"); }
    // Check the temporary numeric domain before strict positive-quantity decoding,
    // so zero, negative, fractional and overflow all have the same stable refusal.
    assertCatalogPublicationMassInputs(record.payload, definition);
    const intent = publicationIntent(record.payload, (path, unsupportedKey, fix) => {
      const code = "candidate_invalid";
      const message = fix ?? (unsupportedKey ? "Remove the unsupported field at this path, then prepare the draft again."
        : path.endsWith(".op") ? "Use a supported publication operation at this path, then prepare the draft again."
          : "Correct the draft value at this path, then prepare the draft again.");
      throw new CatalogPublicationError(code, "validation_issue", { ...publicationIssue(code, "structural", path, definition.key), message });
    });
    if (!intent) return publicationRefuse("candidate_invalid");
    const payload = intent;
    const governedIntent = payload.schemaVersion === 4;
    const withdrawalOnly = governedIntent && lifecycleWithdrawalOnly(payload);
    need(equal(payload.product.type, { key: definition.key, version: definition.version }), "catalog_definition_drift");
    const contextualIssue = (issue: CatalogDraftIssue, skus: readonly { code?: string }[] = payload.skus) =>
      publicationIssue(issue.code, "structural", issue.path,
        skus[Number(/^(?:skus\.|\/skus\/)(\d+)/u.exec(issue.path)?.[1])]?.code ?? definition.key);
    const authoredIssues = catalogPublicationPreparationIssues(payload, { definition, rules: withdrawalOnly ? {} : rules ?? {} });
    if (authoredIssues.length) {
      const first = contextualIssue(authoredIssues[0]!);
      throw new CatalogPublicationError(first.code, "validation_issue", first);
    }
    position.path = "product.sharedContent.presentation";
    const content = publicationContent(payload.product.sharedContent, definition.key);
    for (const [index, operation] of payload.publication.operations.entries()) {
      position.path = `publication.operations.${index}`;
      position.subject = "skuCode" in operation ? operation.skuCode : definition.key;
      if (operation.op === "set_product_presentation")
        assertPublishedPresentation(operation.presentation, `${position.path}.presentation`, position.subject);
      if (operation.op === "create_sku" || operation.op === "set_derived_sku_facts")
        assertPublishedFacts(operation.facts, `${position.path}.facts`, position.subject);
      if (operation.op === "create_identifier")
        need(!operation.isPrimary || operation.scheme === "gs1:gtin", "catalog_publication_identifier_primary_invalid");
      if (operation.op === "register_document_revision")
        need(createHash("sha256").update(operation.canonicalText).digest("hex") === operation.digest,
          "catalog_publication_v3_document_digest_mismatch");
    }
    position.subject = definition.key;
    const { publication: _publication, skus: intentSkus, ...base } = payload;
    const validationPayload: CatalogDraftPayloadV2 = { ...base, schemaVersion: 2,
      skus: intentSkus.map(({ demandPolicyRef: _policy, ...sku }) => sku) };
    position.path = "product.sharedContent";
    const validation = await validateCatalogDraftV2(validationPayload, { resolve: () => ({ ...definition,
      validateContent: !withdrawalOnly && rules ? rules.validateContent : () => [] }) }, input.attributeReferences);
    const draftIssues = validation.valid ? validation.readiness.publication.issues : validation.issues;
    if (!validation.valid) {
      const refusal = draftIssues.find(issue => issue.code !== "attribute_reference_unresolved");
      if (refusal) {
        const diagnostic = contextualIssue(refusal);
        throw new CatalogPublicationError(refusal.code, "validation_issue", diagnostic);
      }
    }
    return { payload, content, rules, governedIntent, withdrawalOnly, canonicalPayload, contextualIssue, validationPayload, draftIssues };
  }

  async function bindEvidence({ payload, content, rules, governedIntent, withdrawalOnly, canonicalPayload, contextualIssue,
    validationPayload, draftIssues }: Awaited<ReturnType<typeof admit>>) {
    const { record, definition, expectedHead, observations } = input;
    position.path = "publication";
    let current: CatalogHeadRef | null | undefined;
    try { current = await input.readCurrentHead?.(); }
    catch (error) {
      if (error instanceof CatalogPublicationError && error.outcome !== "dependency_unavailable") throw error;
    }
    if (current !== undefined && !equal(current, expectedHead)) publicationRefuse("head_conflict", "conflict");
    const evidence = input.evidence === undefined ? await observe(() => observations?.readEvidence?.({
      candidate: catalogPublicationClaim(record), productId: record.productId, expectedHead,
    }) ?? Promise.resolve(undefined)) ?? null : input.evidence;
    const head = evidence && publicationHeadSchema.nullable().safeParse(evidence.head);
    const recordedProduct = evidence && catalogPublishedProductSchema.nullable().safeParse(evidence.product);
    const skuRows = evidence && Array.isArray(evidence.skus) ? evidence.skus : undefined;
    const retainedSkus = skuRows?.flatMap(row => {
      const parsed = catalogPublishedSkuSchema.safeParse(row);
      return parsed.success ? [parsed.data] : [];
    }) ?? [];
    const recordedSkus = skuRows?.length === retainedSkus.length;
    const recordedDocuments = evidence && Array.isArray(evidence.documents);
    const highWaterAvailable = evidence && Number.isSafeInteger(evidence.documentRevisionHighWater) && evidence.documentRevisionHighWater >= 0;
    if (head?.success && !equal(head.data, expectedHead)) publicationRefuse("head_conflict", "conflict");
    if (evidence && (!head?.success || !recordedProduct?.success || !recordedSkus || !recordedDocuments || !highWaterAvailable))
      structural.push(missing("catalog_publication_read_invalid", "publication"));
    const sourceRead = evidence && Array.isArray(evidence.drafts) ? boundDrafts(record, payload, evidence.drafts) : undefined;
    const markSourceUnavailable = () => {
      if (!structural.some(issue => issue.diagnostic.code === "catalog_publication_read_invalid"))
        structural.push(missing("catalog_publication_read_invalid", "publication"));
    };
    if (evidence && (!sourceRead || sourceRead.incomplete)) markSourceUnavailable();
    const missingProduct = expectedHead !== null && !recordedProduct?.data;
    const missingSkuRoster = expectedHead !== null && !recordedSkus;
    const missingState = missingProduct || missingSkuRoster;
    const retainedState = {
      product: recordedProduct?.data ?? null,
      skus: retainedSkus,
      documents: recordedDocuments ? evidence.documents : [],
      documentRevisionHighWater: highWaterAvailable ? evidence.documentRevisionHighWater : 0,
    };
    if (!rules || !evidence) structural.push(missing("publication_preparation_unavailable", "publication"));
    if (input.readCurrentHead && current === undefined) structural.push(missing("publication_head_unavailable", "publication"));
    const governedState = evidence?.lifecycle;
    const states = governedState && lifecycleEvidenceSchema.safeParse(governedState).data;
    const governed = governedIntent || governedState !== undefined;
    const lifecycleAvailable = !expectedHead || Boolean(states && retainedState.skus.every(sku => states.skus[sku.code]));
    if (governed && !lifecycleAvailable)
      structural.push(missing("catalog_lifecycle_evidence_unavailable", "publication"));
    if (!governedIntent && states && lifecycleAvailable) publicationRefuse("catalog_lifecycle_raw_status_fenced");
    const priceOperations = payload.skus.flatMap(sku => sku.priceOperations ?? []);
    async function checkPrices() {
      if (!priceOperations.length) return;
      const prices = z.array(z.object({ path: z.string(), code: z.string() })).safeParse(await observe(() => input.validatePrices?.({
        ...validationPayload, product: { ...validationPayload.product, sharedContent: content },
      }) ?? Promise.resolve(undefined)));
      if (!prices.success) structural.push(missing("price_validation_unavailable", "skus"));
      else {
        for (const issue of prices.data) {
          const match = /^skus[./](\d+)[./]priceOperations[./](\d+)$/u.exec(issue.path);
          const selected = match ? validationPayload.skus[Number(match[1])]?.priceOperations?.[Number(match[2])]
            : priceOperations.length === 1 ? priceOperations[0] : undefined;
          const path = match && selected ? `skus.${match[1]}.priceOperations.${match[2]}` : "skus";
          const diagnostic = publicationIssue(issue.code, "pricing", path, selected?.priceListId);
          if (!issue.code.endsWith("_unavailable")) throw new CatalogPublicationError(issue.code, "validation_issue", diagnostic);
          structural.push(unavailable(diagnostic));
        }
      }
    }
    const unresolved = unresolvedPublicationDraftIssues(draftIssues, retainedState);
    for (const issue of unresolved) {
      if (issue.code === "attribute_reference_unresolved"
        || missingState && (issue.code === "primary_sku_missing" || issue.code === "sku_missing")) {
        structural.push(missing("publication_evidence_unavailable", issue.path));
      } else {
        const diagnostic = contextualIssue(issue);
        throw new CatalogPublicationError(issue.code, "validation_issue", diagnostic);
      }
    }
    need(record.productId === payload.product.id && record.status === "open", "catalog_publication_source_invalid");
    need(canonicalCatalogDraftJson(record.payload) === canonicalPayload, "catalog_publication_source_mismatch");
    position.path = "publication";
    if (head?.success && recordedProduct?.success)
      need((retainedState.product?.document?.digest ?? null) === (expectedHead?.documentDigest ?? null), "catalog_publication_source_mismatch");
    need(missingState || retainedState.skus.length === 0 || retainedState.product !== null, "catalog_publication_source_invalid");
    need(retainedState.skus.every(sku => sku.productId === payload.product.id), "catalog_publication_scope_expansion");
    const retainedIds = new Set<string>(), retainedCodes = new Set<string>();
    for (const sku of retainedState.skus) {
      need(!retainedIds.has(sku.id) && !retainedCodes.has(sku.code),
        "catalog_publication_sku_revision_invalid");
      retainedIds.add(sku.id); retainedCodes.add(sku.code);
    }
    const claim = catalogPublicationClaim(record), slug = payload.product.slug!;
    let product = retainedState.product === null ? null : structuredClone(retainedState.product);
    function materialState(product: CatalogPublishedProduct | null, rows: readonly CatalogPublishedSku[]) {
      const p = product && (({ source: _source, content: _content, ...facts }) => facts)(product);
      return { product: p, skus: [...rows].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(sku => ({ id: sku.id,
        digest: publicationDigest((({ source: _source, ...facts }) => facts)(sku), CATALOG_PUBLICATION_LIMITS.skuBytes) })) };
    }
    const original = publicationJson(materialState(product, retainedState.skus));
    const affected = catalogPublicationAffected(payload);
    const originalById = new Map(retainedState.skus.map(sku => [sku.id, sku] as const));
    const skus = new Map(retainedState.skus.map(sku => [sku.code, structuredClone(sku)]));
    const documents: CatalogPublicationDocument[] = [];
    const authorship = publicationAuthorship(record, payload, sourceRead?.retained ?? [], skus, rules, !sourceRead || sourceRead.incomplete, markSourceUnavailable);
    const created = new Set<string>(), identities = new Set<string>();
    const combination = (options: CatalogPublishedSku["options"]) => Buffer.from(canonicalizeCatalogCombinationV2({
      definition: input.definition, axes: payload.product.dimensions, options,
    }).combinationDigest).toString("hex");
    let existingCombinations: Set<string> | undefined;
    const unavailableRegistrations = new Set<number>();
    const incoming = new Map(payload.skus.map(sku => [sku.code, sku]));
    const gtins = new Set(retainedState.skus.flatMap(sku => sku.identifiers.filter(identifier => identifier.scheme === "gs1:gtin").map(identifier => identifier.value.padStart(14, "0"))));
    if (product) need(product.id === payload.product.id && product.slug === slug && equal(product.type, payload.product.type), "catalog_publication_product_identity_conflict");
    assertCatalogAction(payload, expectedHead === null ? "create" : "revise");
    if (product && payload.product.primarySkuId)
      need(product.primarySkuId === payload.product.primarySkuId, "current_primary_mismatch");
    const authoredDocument = payload.product.documentRevision ?? publicationRefuse("document_reference_missing");
    const beforeReference = product?.document;
    const operations = payload.publication.operations;
    function registrationFor(reference: CatalogPublicationDocument["reference"], source?: PublicationDraftRecord) {
      return operations.find((operation): operation is Extract<PublicationOperation, { op: "register_document_revision" }> =>
        operation.op === "register_document_revision"
        && operation.productSlug === slug && operation.revisionId === reference.id && operation.revisionNo === reference.revisionNo
        && operation.documentRef === reference.documentRef && operation.sourceRef === reference.sourceRef && operation.digest === reference.digest
        && (!source || (operation.provenance.source === "current_draft" ? source === record
          : operation.provenance.draftId === source.draftId && operation.provenance.draftRevision === source.revision)));
    }
    function bindDocumentReference(reference: CatalogPublicationDocument["reference"] | undefined, source?: PublicationDraftRecord) {
      const registration = reference && registrationFor(reference, source);
      if (!reference || reference.productId !== record.productId || beforeReference && !equal(beforeReference, reference)
        && (!registration || !operations.some(operation => operation.op === "move_document_pointer"
          && operation.productSlug === slug && operation.documentRevisionNo === reference.revisionNo))) {
        position.path = "product.documentRevision";
        publicationRefuse("catalog_publication_v3_document_reference_stale", "conflict");
      }
      return registration;
    }
    const selectedRegistration = bindDocumentReference(authoredDocument);
    for (const source of sourceRead?.claimed ?? [])
      bindDocumentReference(publicationIntent(source.payload)?.product.documentRevision, source);
    type DocumentRef = CatalogPublicationDocument["reference"];
    const documentsById = new Map<string, CatalogPublicationDocument>();
    const referencesByRevision = new Map<number, DocumentRef>();
    const referencesById = new Map<string, DocumentRef>();
    const addReference = (reference: DocumentRef) => {
      referencesById.set(reference.id, reference);
      referencesByRevision.set(reference.revisionNo, reference);
    };
    let documentReferencesIncomplete = !recordedDocuments;
    function readDocuments() {
      position.path = "product.documentRevision";
      const current = product?.document;
      for (const document of retainedState.documents) {
        const parsed = catalogDocumentRevisionRefSchema.safeParse(document?.reference);
        if (!parsed.success) {
          documentReferencesIncomplete = true;
          structural.push(missing("catalog_publication_read_invalid", position.path));
          continue;
        }
        const reference = parsed.data;
        need(reference.productId === payload.product.id && (!highWaterAvailable || reference.revisionNo <= retainedState.documentRevisionHighWater)
          && !referencesById.has(reference.id) && !referencesByRevision.has(reference.revisionNo), "catalog_publication_document_source_mismatch");
        if (current && (current.id === reference.id || current.revisionNo === reference.revisionNo))
          need(equal(current, reference), "catalog_publication_document_source_mismatch");
        addReference(reference);
        if (typeof document.canonicalText !== "string" || createHash("sha256").update(document.canonicalText).digest("hex") !== reference.digest) continue;
        if (rules && !withdrawalOnly) {
          try { checkedDocument(document.canonicalText, reference, slug, rules); }
          catch (error) {
            if (error instanceof CatalogPublicationError && (error.code === "catalog_publication_v3_document_invalid"
              || error.code === "catalog_publication_v3_document_not_canonical")) continue;
            throw error;
          }
        }
        const provenance = documentProvenance.safeParse(document.provenance);
        if (!provenance.success) continue;
        const selected = { canonicalText: document.canonicalText, reference, provenance: provenance.data };
        documents.push(selected);
        documentsById.set(reference.id, selected);
      }
      if (current) addReference(current);
    }
    function knownProduct(): CatalogPublishedProduct { return product ?? publicationRefuse("catalog_publication_v3_compile_product_absent"); }
    const knownSku = (code: string) => prefixSku(skus, code);
    function selectedDocument(reference: CatalogPublishedProduct["document"] | undefined, needed = !withdrawalOnly): CatalogPublicationDocument | undefined {
      if (!reference) return;
      const selected = documentsById.get(reference.id);
      if (!selected && needed && !structural.some(issue => issue.diagnostic.code === "catalog_publication_document_bytes_unavailable"))
        structural.push(missing("catalog_publication_document_bytes_unavailable", "product.documentRevision"));
      return selected;
    }
    const currentDocument = () => selectedDocument(knownProduct().document);
    readDocuments();
    const media = new Map(payload.publication.evidence.media?.map(claim => [claim.skuCode, claim]));
    const verifiedMedia: CatalogDraftMediaClaimV3[] = [];
    const authoredPresentation = payload.product.sharedContent.presentation;
    const readRoute = async (presentation: CatalogPublicationFacts) => {
      const verdict = publicationReadinessVerdict.safeParse(await observe(() => observations?.presentationReadiness?.(record.productId, structuredClone(presentation)) ?? Promise.resolve(undefined)));
      if (!verdict.success) structural.push(missing("catalog_publication_presentation_unavailable", "product.sharedContent.presentation"));
      else if (!verdict.data.ready) publicationRefuse(verdict.data.reasons[0]!);
    };

    const savedSources = new Map<number, NonNullable<ReturnType<typeof authorship.skuOperation>>>();
    const savedDocuments = new Map<number, CatalogPublicationDocument>();
    const activationCodes = new Set(affected.enabling);
    const matchedPhysicalSources = new Set<CatalogDraftPayloadV3["skus"][number]>();
    function bindPhysicalSource(code: string | undefined, source: CatalogDraftPayloadV3["skus"][number]) {
      if (matchedPhysicalSources.has(source)) return;
      const actual = code === undefined ? undefined : skus.get(code);
      if (!actual && missingSkuRoster && !originalById.has(source.id)) return;
      assertMaterializedSkuSource(actual, source);
      matchedPhysicalSources.add(source);
    }
    function atOperation(index: number, operation: PublicationOperation) {
      position.path = `publication.operations.${index}`;
      position.subject = "skuCode" in operation ? operation.skuCode : definition.key;
    }
    function bindSources() {
      // The registered bytes have passed their checksum in admission. Use the
      // selected bytes for derivation without running a later operation early.
      const selected = selectedRegistration && authorship.documentSource(selectedRegistration).source
        ? selectedRegistration : documentsById.get(authoredDocument.id);
      for (const [index, operation] of operations.entries()) {
        atOperation(index, operation);
        if ("productSlug" in operation) authorship.productOperation(operation);
        if (isLifecycleOperation(operation)) continue;
        if (operation.op === "set_derived_sku_facts") {
          const sku = skus.get(operation.skuCode);
          if (sku || !missingState) assertDerivedSource(operation, sku, authoredDocument.revisionNo);
          if (rules && selected && sku)
            need(equal(documentSkuFacts(selected, sku, rules), operation.facts), "catalog_publication_v3_compile_derived_facts_mismatch");
        } else if ("skuCode" in operation) {
          const source = authorship.skuOperation(operation);
          if (!source) continue;
          savedSources.set(index, source);
          if (operation.op === "create_sku") {
            assertSkuCreationDocument(operation, source.payload.product.documentRevision);
            if (rules && selected)
              need(equal(documentSkuFacts(selected, skuCreationFacts(operation, source, payload.product.id), rules), operation.facts),
                "catalog_publication_v3_compile_derived_facts_mismatch");
          }
        } else if (operation.op === "register_document_revision") {
          const document = authorship.document(operation);
          if (document) savedDocuments.set(index, document);
        }
      }
    }
    function checkPhysicalSources() {
      for (const [code, claim] of media) {
        position.path = "publication.evidence.media";
        position.subject = code;
        const source = authorship.sku(code, true, "catalog_publication_media_evidence_mismatch");
        if (!source) continue;
        if (source && source.source !== record) bindPhysicalSource(code, source.sku);
        need(source && !catalogPublicationMediaIssue(source.payload.product.sharedContent.presentation.mediaRef, source.sku.assetRefs ?? [], claim),
          "catalog_publication_media_evidence_mismatch");
      }
      for (const [index, sku] of payload.skus.entries()) {
        const actual = sku.code && skus.get(sku.code);
        const idMatch = originalById.get(sku.id);
        if (!actual && !idMatch) continue;
        position.path = `skus.${index}`;
        position.subject = sku.code ?? sku.id;
        bindPhysicalSource(sku.code, sku);
      }
      activating = affected.enabling.size > 0 || payload.publication.operations.some(op => op.op === "restore_product" || op.op === "restore_sku");
      for (const [index, operation] of payload.publication.operations.entries()) {
        if (operation.op !== "set_eligibility" || !enablesSku(operation)
          || missingSkuRoster && !skus.has(operation.skuCode)) continue;
        const source = savedSources.get(index);
        if (!source) continue;
        atOperation(index, operation);
        bindPhysicalSource(operation.skuCode, source.sku);
      }
      for (const sku of skus.values()) {
        if (sku.status === "active" && (sku.sellableStandalone || sku.sellableInSubscription) && affected.source(sku.code))
          activationCodes.add(sku.code);
      }
    }
    async function checkActivationSources() {
      const proposed = [...payload.publication.operations].reverse().find(operation => operation.op === "set_product_presentation");
      const presentation = proposed?.op === "set_product_presentation" ? proposed.presentation : product?.presentation;
      for (const code of activationCodes) {
        if (missingSkuRoster && !skus.has(code) || missingProduct && !presentation) continue;
        position.path = "skus";
        position.subject = code;
        const source = authorship.sku(code, true);
        if (!source) continue;
        bindPhysicalSource(code, source.sku);
        need(source.sku.netContent, "catalog_publication_operation_source_mismatch");
        assertCatalogPublicationGrossMass(source.sku.netContent!, source.sku.grossMass ?? null, definition);
        position.path = "publication.evidence.media";
        const assets = source.sku.assetRefs ?? [];
        const retainedReference = source.payload.product.sharedContent.presentation.mediaRef;
        if (source.source !== record && (retainedReference != null || assets.length)
          && (typeof retainedReference !== "string" || retainedReference !== presentation?.mediaRef)) {
          const code = "catalog_publication_media_readiness_unproven";
          throw new CatalogPublicationError(code, "validation_issue", {
            ...publicationIssue(code, "activation", position.path, position.subject),
            message: "Keep the selected draft's media reference in the proposed presentation.",
          });
        }
        const problem = catalogPublicationMediaIssue(presentation?.mediaRef, assets, media.get(code));
        if (problem === "media_readiness_unknown")
          activationIssues.push(unavailable(publicationIssue("catalog_publication_media_validation_unavailable", "activation", position.path, code)));
        else need(!problem, "catalog_publication_media_readiness_unproven");
      }
      position.path = "publication.evidence.media";
      for (const [code, claim] of media) {
        position.subject = code;
        const accepted = await observe(() => observations?.verifyMedia?.(structuredClone(claim), expectedHead) ?? Promise.resolve(undefined));
        if (accepted === true) verifiedMedia.push(claim);
        else if (accepted === false) publicationRefuse("catalog_publication_media_readiness_unproven");
        else structural.push(missing("catalog_publication_media_validation_unavailable", position.path));
      }
    }
    let productState = states?.product;
    const skuStates = new Map(Object.entries(states?.skus ?? {}));
    let lastChildWithdrawn = false;
    function applyLifecycle(operation: PublicationLifecycleOperation) {
      const restored = operation.op === "restore_product" || operation.op === "restore_sku";
      const after = restored ? "active" : operation.state;
      const row = "skuCode" in operation ? knownSku(operation.skuCode) : knownProduct();
      const before = "skuCode" in operation ? skuStates.get(operation.skuCode)?.state : productState;
      if (!before) {
        structural.push(missing("catalog_lifecycle_evidence_unavailable", "publication.operations"));
        return;
      }
      need(before === operation.expectedState, "catalog_lifecycle_state_conflict");
      need(lifecycleTransition(before, after, restored), "catalog_lifecycle_transition_refused");
      if ("skuCode" in operation) {
        const sku = row as CatalogPublishedSku;
        if (after === "archived")
          need(!sku.sellableStandalone && !sku.sellableInSubscription && knownProduct().primarySkuId !== sku.id,
            "catalog_publication_v3_compile_archive_refused");
        if (after === "withdrawn") {
          sku.sellableStandalone = false;
          sku.sellableInSubscription = false;
          lastChildWithdrawn ||= ![...skuStates].some(([code, entry]) => code !== operation.skuCode && entry.state === "active");
        }
        skuStates.set(operation.skuCode, { ...skuStates.get(operation.skuCode), state: after });
      } else {
        if (after === "active") need(knownProduct().document && knownProduct().primarySkuId, "catalog_publication_v3_compile_product_incomplete");
        if (operation.op === "set_product_lifecycle") {
          const children = after === "withdrawn" ? [...skus.keys()].sort().map(skuCode => ({
            skuCode, expectedState: skuStates.get(skuCode)?.state,
          })) : [];
          need(children.every(child => child.expectedState !== undefined) && equal(operation.children, children), "catalog_lifecycle_child_effects_mismatch");
          for (const { skuCode } of children) {
            const sku = knownSku(skuCode);
            sku.sellableStandalone = false;
            sku.sellableInSubscription = false;
            if (skuStates.get(skuCode)?.state === "active") skuStates.set(skuCode, { ...skuStates.get(skuCode), state: "withdrawn" });
          }
        }
        productState = after;
      }
      row.status = after === "withdrawn" ? "active" : after;
    }
    let highWater = retainedState.documentRevisionHighWater;
    async function applyPrefixes() {
      const writesPresentation = payload.publication.operations.some(operation => operation.op === "set_product_presentation");
      position.path = "product.sharedContent.presentation";
      position.subject = definition.key;
      if (!writesPresentation) {
        const authoredRoute = !withdrawalOnly && Object.keys(authoredPresentation).length > 0;
        if (authoredRoute) await readRoute(authoredPresentation);
        if (!withdrawalOnly && product?.presentation && (!authoredRoute || !equal(product.presentation, authoredPresentation))) await readRoute(product.presentation);
      }
      for (const [index, operation] of payload.publication.operations.entries()) {
        atOperation(index, operation);
        if (isLifecycleOperation(operation)) {
          if (!missingProduct && (!missingSkuRoster || "skuCode" in operation && skus.has(operation.skuCode)))
            applyLifecycle(operation);
          continue;
        }
        const source = savedSources.get(index);
        const entry = savedDocuments.get(index);
        if (operation.op === "set_product_presentation" && operation.presentation !== null) {
          if (!missingProduct) knownProduct();
          await readRoute(operation.presentation);
        }
        if (missingProduct) continue;
        if ("skuCode" in operation && operation.op !== "create_sku" && missingSkuRoster && !skus.has(operation.skuCode)) continue;
        if ("skuCode" in operation && !source && operation.op !== "set_derived_sku_facts") continue;
        if (operation.op === "create_product") {
          need(product === null && operation.productId === payload.product.id, "catalog_publication_v3_compile_product_conflict");
          product = { id: operation.productId, slug, name: operation.name, status: "draft", type: payload.product.type,
            axes: [...payload.product.dimensions], attributes: payload.product.attributes ?? {}, primarySkuId: null, document: null,
            presentation: null, source: claim, content };
          if (governed) productState = "draft";
        } else if (operation.op === "register_document_revision") {
          if (!entry) { unavailableRegistrations.add(operation.revisionNo); continue; }
          knownProduct();
          const byId = referencesById.get(operation.revisionId), byRevision = referencesByRevision.get(operation.revisionNo);
          if (byId || byRevision) {
            const previous = documentsById.get(operation.revisionId);
            need(byId === byRevision && equal(byId, entry.reference) && (!previous || equal(previous, entry)), "catalog_publication_v3_compile_document_conflict");
          } else {
            if (highWaterAvailable || expectedHead === null)
            need(operation.revisionNo === highWater + 1, "catalog_publication_document_revision_sequence");
            addReference(entry.reference);
            highWater++;
          }
          if (!documentsById.has(entry.reference.id)) documents.push(entry);
          documentsById.set(entry.reference.id, entry);
        } else if (operation.op === "move_document_pointer") {
          const reference = referencesByRevision.get(operation.documentRevisionNo);
          if (!reference && (documentReferencesIncomplete || unavailableRegistrations.has(operation.documentRevisionNo))) {
            if (operation.documentRevisionNo === authoredDocument.revisionNo) knownProduct().document = authoredDocument;
            continue;
          }
          if (!reference) return publicationRefuse("catalog_publication_v3_compile_document_absent");
          need(reference.productId === knownProduct().id && equal(payload.product.documentRevision, reference), "catalog_publication_document_source_mismatch");
          knownProduct().document = reference;
        } else if (operation.op === "create_sku") {
          need(!skus.has(operation.skuCode) && ![...skus.values()].some(sku => sku.id === operation.skuId), "catalog_publication_v3_compile_sku_conflict");
          const sku = skuCreationFacts(operation, source!, knownProduct().id);
          existingCombinations ??= new Set([...skus.values()].map(existing => combination(existing.options)));
          const identity = combination(sku.options);
          need(!existingCombinations.has(identity), "duplicate_combination");
          assertSkuCreationDocument(operation, source!.payload.product.documentRevision, knownProduct().document);
          existingCombinations.add(identity);
          skus.set(sku.code, sku); created.add(sku.code);
          if (governed) {
            const demandPolicyRef = incoming.get(sku.code)?.demandPolicyRef;
            skuStates.set(sku.code, { state: "draft", ...(demandPolicyRef === undefined ? {} : { demandPolicyRef }) });
          }
        } else if (operation.op === "create_identifier") {
          const sku = knownSku(operation.skuCode);
          need(created.has(sku.code), "catalog_publication_identifier_requires_created_sku");
          const { op: _op, skuCode: _code, ...identifier } = operation;
          if (identifier.scheme === "gs1:gtin") {
            need(!gtins.has(identifier.value.padStart(14, "0")), "catalog_publication_v3_compile_identifier_conflict");
            gtins.add(identifier.value.padStart(14, "0"));
          }
          need(!identifier.isPrimary || !sku.identifiers.some(value => value.isPrimary), "catalog_publication_identifier_primary_invalid");
          applySkuPrefix(sku, operation, rules);
        } else if (operation.op === "set_primary_sku") {
          const sku = knownSku(operation.skuCode);
          need(sku.productId === knownProduct().id && source!.sku.id === sku.id, "catalog_publication_v3_compile_primary_foreign");
          need(knownProduct().primarySkuId === null || knownProduct().primarySkuId === sku.id, "catalog_publication_v3_compile_primary_immutable");
          need(sku.status !== "archived", "catalog_publication_v3_compile_sku_archived");
          knownProduct().primarySkuId = sku.id;
        } else if (operation.op === "set_product_status") {
          if (operation.status === "active") need(knownProduct().document !== null && knownProduct().primarySkuId !== null, "catalog_publication_v3_compile_product_incomplete");
          knownProduct().status = operation.status;
        } else if (operation.op === "set_eligibility") {
          const sku = knownSku(operation.skuCode);
          const on = operation.sellableStandalone || operation.sellableInSubscription;
          const materialized = originalById.get(sku.id);
          if (on && governed) {
            const state = skuStates.get(sku.code)?.state;
            if (productState === undefined || state === undefined) {
              structural.push(missing("catalog_lifecycle_evidence_unavailable", position.path));
              continue;
            }
            need(productState === "active" && state === "active", "catalog_lifecycle_fresh_sale_refused");
          }
          need(!on || sku.status !== "archived" && materialized?.status !== "archived", "catalog_publication_v3_compile_sku_archived");
          applySkuPrefix(sku, operation, rules);
        } else if (operation.op === "set_sku_status") {
          const sku = knownSku(operation.skuCode);
          if (operation.status === "archived") need(!sku.sellableStandalone && !sku.sellableInSubscription && knownProduct().primarySkuId !== sku.id, "catalog_publication_v3_compile_archive_refused");
          applySkuPrefix(sku, operation, rules);
        } else if (operation.op === "set_offer_membership") {
          const sku = knownSku(operation.skuCode);
          applySkuPrefix(sku, operation, rules);
        } else if (operation.op === "set_product_presentation") {
          knownProduct().presentation = operation.presentation;
        } else if (operation.op === "set_sku_metadata") {
          const sku = knownSku(operation.skuCode);
          applySkuPrefix(sku, operation, rules);
        } else if (operation.op === "set_derived_sku_facts") {
          const sku = knownSku(operation.skuCode);
          need(knownProduct().document?.revisionNo === operation.documentRevisionNo, "catalog_publication_derived_source_mismatch");
          applySkuPrefix(sku, operation, rules);
        } else { const _exhaustive: never = operation; publicationRefuse("catalog_publication_operation_invalid"); }
        knownProduct();
      }
    }
    let assembled: Awaited<ReturnType<typeof structuralResult>>;
    async function checkStructuralResult() { assembled = await structuralResult(); }
    async function structuralResult() {
      position.path = "product";
      if (missingState) return;
      position.subject = definition.key;
      const result = knownProduct();
      if (lastChildWithdrawn) need(productState === "withdrawn"
        && payload.publication.operations.some(op => op.op === "set_product_lifecycle" && op.state === "withdrawn"),
      "catalog_lifecycle_last_active_child");
      if (payload.product.documentRevision) need(equal(payload.product.documentRevision, result.document), "catalog_publication_document_source_mismatch");
      const afterDocument = currentDocument();
      const documentDigests = new Set([...referencesById.values()].map(reference => reference.digest));
      if (result.document) documentDigests.add(result.document.digest);
      if (!withdrawalOnly && rules && afterDocument && payload.product.sharedContent.document !== undefined)
        need(matchesAuthoredDocument(payload.product.sharedContent.document, afterDocument.canonicalText, rules), "catalog_publication_document_source_mismatch");
      const productOverlay = { attributes: payload.product.attributes ?? result.attributes, axes: payload.product.dimensions };
      if (withdrawalOnly) need(equal(productOverlay, { attributes: result.attributes, axes: result.axes })
        && equal(payload.product.sharedContent.presentation, result.content.presentation), "catalog_lifecycle_withdrawal_overlay_refused");
      else {
        Object.assign(result, productOverlay);
        result.content = content;
        result.source = claim;
      }
      for (const [code, authored] of incoming) {
        const sku = skus.get(code!);
        need(sku, "catalog_publication_sku_effect_missing");
        if (created.has(code!)) need(authored.identifiers?.every(identifier =>
          sku!.identifiers.some(stored => matchesAuthoredIdentifier(identifier, stored))), "catalog_publication_identifier_effect_missing");
        if (authored.logisticsRef) need(sku!.logisticsRef === authored.logisticsRef, "catalog_publication_metadata_effect_missing");
      }
      for (const intent of payload.product.sharedContent.offerMemberships)
        need(skus.get(intent.skuCode)?.memberships.some(row => row.offerVersion === intent.offerVersion && row.admitted === intent.admitted),
          "catalog_publication_membership_effect_missing");
      const productPhysicalChange = retainedState.product !== null && !equal(
        [retainedState.product.type, retainedState.product.axes, retainedState.product.attributes, retainedState.product.document],
        [result.type, result.axes, result.attributes, result.document]);
      for (const sku of skus.values()) {
        position.path = "skus";
        position.subject = sku.code;
        const draft = incoming.get(sku.code);
        if (draft && !created.has(sku.code)) {
          const policyUnchanged = draft.demandPolicyRef === undefined || draft.demandPolicyRef === skuStates.get(sku.code)?.demandPolicyRef;
          if (!withdrawalOnly) need(policyUnchanged, "sku_identity_change_requires_new_sku");
          const overlay = { attributes: draft.attributes ?? sku.attributes, grossMass: draft.grossMass ?? sku.grossMass, assetRefs: draft.assetRefs ?? sku.assetRefs };
          if (withdrawalOnly) need(policyUnchanged && equal(overlay, { attributes: sku.attributes, grossMass: sku.grossMass, assetRefs: sku.assetRefs })
            && (draft.logisticsRef === undefined || draft.logisticsRef === sku.logisticsRef), "catalog_lifecycle_withdrawal_overlay_refused");
          else Object.assign(sku, overlay);
        }
        const before = originalById.get(sku.id);
        if (!withdrawalOnly && before && rules && afterDocument && (productPhysicalChange || !equal(
          [before.netContent, before.options, before.attributes, before.facts, before.grossMass, before.assetRefs],
          [sku.netContent, sku.options, sku.attributes, sku.facts, sku.grossMass, sku.assetRefs]))) {
          const beforeDocument = selectedDocument(beforeReference);
          if (beforeDocument) need(rules.classifySkuChange(ruleSku(before), ruleSku(sku), {
            beforeProduct: ruleProduct(retainedState.product!), afterProduct: ruleProduct(result),
            beforeDocument: beforeDocument.canonicalText, afterDocument: afterDocument.canonicalText,
          }) === "compatible", "sku_identity_change_requires_new_sku");
        }
        need(sku.netContent.dimension === "mass", "catalog_publication_mass_required_until_mc5");
        catalogPublicationIntegralGrams(sku.netContent, input.definition);
        if (!withdrawalOnly && rules && afterDocument) need(equal(documentSkuFacts(afterDocument, sku, rules), sku.facts),
          "catalog_publication_v3_compile_derived_facts_mismatch");
        if (governed && (sku.sellableStandalone || sku.sellableInSubscription)) {
          const state = skuStates.get(sku.code)?.state;
          if (productState === undefined || state === undefined) structural.push(missing("catalog_lifecycle_evidence_unavailable", position.path));
          else need(productState === "active" && state === "active", "catalog_lifecycle_fresh_sale_refused");
        }
        const key = combination(sku.options);
        need(!identities.has(key), "duplicate_combination"); identities.add(key);
        publicationJson(catalogPublishedSkuSchema.parse(sku), CATALOG_PUBLICATION_LIMITS.skuBytes);
      }
      position.path = "product";
      position.subject = definition.key;
      const retainedAttributes = [...skus.values()].filter(sku => incoming.get(sku.code)?.attributes === undefined);
      if (retainedAttributes.length || payload.product.attributes === undefined && Object.keys(result.attributes).length) {
        const validation = await validateCatalogAttributes(definition, { productAttributes: result.attributes,
          skus: retainedAttributes.map(({ id, attributes }) => ({ id, attributes })) }, input.attributeReferences);
        if (!validation.valid) {
          for (const issue of validation.issues) {
            if (issue.code === "attribute_reference_unresolved") structural.push(missing("publication_evidence_unavailable", issue.path));
            else throw new CatalogPublicationError(issue.code, "validation_issue", contextualIssue(issue, retainedAttributes));
          }
        }
      }
      need(skus.size <= (input.capacity ?? 50_000), "product_capacity_exceeded");
      need(result.primarySkuId && result.document && (retainedState.product !== null || result.presentation), "catalog_publication_v3_structural_readiness_failed");
      need(equal(sealedPresentation(result.presentation), payload.product.sharedContent.presentation), "catalog_publication_presentation_effect_missing");
      const primary = [...skus.values()].find(sku => sku.id === result.primarySkuId);
      need(primary && primary.status !== "archived", "catalog_publication_v3_compile_primary_foreign");
      const promotions = requiredPromotions(payload.publication.operations.filter(op => !isLifecycleOperation(op)), retainedState);
      need((!promotions.product || result.status === "active") && promotions.skus.every(code => skus.get(code)?.status === "active"),
        "catalog_publication_activation_effect_missing");
      const sorted = [...skus.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
      const lifecycle = governed && productState ? { product: productState, skus: Object.fromEntries([...skuStates].sort()) } : undefined;
      const changed = original !== publicationJson(materialState(result, sorted)) || Boolean(lifecycle && !equal(lifecycle, evidence?.lifecycle ?? null));
      for (const sku of sorted) {
        const before = originalById.get(sku.id);
        // An omitted derived cache effect has this publication's draft/receipt as
        // its effect provenance. Keep the retained physical/media source available.
        if (!withdrawalOnly && before && incoming.has(sku.code) && !equal(before, sku)) sku.source = claim;
        assertPublishedSkuDocumentExclusion(sku, documentDigests);
      }
      if (!changed && retainedState.product) { result.source = retainedState.product.source; result.content = retainedState.product.content; }
      const published = decodePublishedProduct(result, documentDigests);
      if (!withdrawalOnly && rules && afterDocument) {
        const [refusal] = rules.validateProduct(ruleProduct(published), [...skus.values()].map(ruleSku), documents.map(document => document.canonicalText));
        if (refusal) publicationRefuse(refusal);
      }
      need(changed || structural.some(isUnavailable) || payload.publication.kind === "compensation" && payload.publication.operations.length > 0, "catalog_publication_v3_compile_change_noop");
      const operations = payload.publication.operations;
      const priced = sorted.filter(affected.priced);
      const compiled = { product: published, skus: sorted, documents, operations,
        priceOperations, changed, lifecycle,
        pricedSkuCodes: priced.map(sku => sku.code), activationSourceCodes: [...activationCodes], activating };
      return { compiled, primary, priced };
    }

    async function checkActivationResult() {
      position.phase = "activation";
      position.path = "skus";
      position.subject = definition.key;
      if (!assembled) { await checkPrices(); return; }
      const { compiled, primary, priced } = assembled;
      const { product: result, operations } = compiled;
      await checkPrices();
      position.path = "skus";
      for (const sku of priced) {
        position.subject = sku.code;
        need(sku.status !== "archived", "catalog_publication_v3_compile_sku_archived");
        assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass, definition);
        need(sku.identifiers.some(identifier => identifier.scheme === "gs1:gtin" && identifier.isPrimary && identifier.packagingLevel === "unit")
          && sku.logisticsRef && sku.memberships.some(row => row.admitted), "catalog_publication_v3_activation_readiness_failed");
      }
      position.subject = definition.key;
      if (operations.some(operation => operation.op === "set_product_status" && operation.status === "active"
        || operation.op === "set_product_lifecycle" && operation.state === "active" || operation.op === "restore_product")) {
        need(primary?.status === "active" && (primary.sellableStandalone || primary.sellableInSubscription), "catalog_publication_v3_active_primary_required");
        need(result.presentation, "catalog_publication_v3_presentation_required");
      }
      if (activating || priced.length) {
        const verdict = publicationReadinessVerdict.safeParse(await observe(() =>
          observations?.assessActivation?.(structuredClone({ product: compiled.product, skus: compiled.skus }), expectedHead, structuredClone(verifiedMedia)) ?? Promise.resolve(undefined)));
        if (!verdict.success) activationIssues.push(missing("activation_unknown", "publication"));
        else if (!verdict.data.ready) publicationRefuse(verdict.data.reasons[0]!);
      }
    }
    function addPending() {
      if (!assembled || activating || assembled.priced.length) return;
      const result = assembled.compiled.product;
      for (const [index, sku] of payload.skus.entries()) {
        const path = `skus.${index}`;
        if (!sku.grossMass) pending.push({ path: `${path}.grossMass`, code: "gross_mass_missing" });
        if (!sku.logisticsRef) pending.push({ path: `${path}.logisticsRef`, code: "logistics_reference_missing" });
        if (!sku.priceOperations?.length) pending.push({ path: `${path}.priceOperations`, code: "price_reference_missing" });
        const modes = payload.product.sharedContent.requestedModes.find(intent => intent.skuCode === sku.code)?.modes;
        for (const channel of modes ?? []) pending.push({ path: `${path}.priceOperations`, code: "activation_not_assessed", channel });
        const mediaIssue = catalogPublicationMediaIssue(result.presentation?.mediaRef, skus.get(sku.code!)?.assetRefs ?? [], media.get(sku.code!));
        if (mediaIssue) pending.push({ path: `${path}.assetRefs`, code: mediaIssue });
      }
    }
    return { bindSources, checkPhysicalSources, checkActivationSources, applyPrefixes, checkStructuralResult, checkActivationResult,
      addPending, result: () => assembled?.compiled };
  }
}

export async function compileCatalogPublication(input: CatalogPublicationCompileInput, mode: Exclude<PublicationMode, "preview"> = "compile") {
  const result = await evaluateCatalogPublication(input, mode);
  if (result.failure) throw result.failure;
  const issues = [...result.structural, ...result.activationIssues];
  const issue = issues.find(entry => !isUnavailable(entry)) ?? issues[0];
  if (issue) throw new CatalogPublicationError(issue.diagnostic.code, issue.outcome, issue.diagnostic);
  if (!result.compiled) return publicationRefuse("publication_preparation_unavailable", "dependency_unavailable");
  return result.compiled;
}
