import { createHash } from "node:crypto";
import { z } from "./validation.js";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";
import { catalogPublicationDraftPayloadSchema, catalogPublicationDraftRecordSchema, catalogDraftV3ValidationPayload } from "./draftV3Schemas.js";
import { isValidGtin, catalogDocumentRevisionRefSchema } from "./foundationSchemas.js";
import { canonicalizeCatalogCombinationV2 } from "./variantCombination.js";
import { CATALOG_QUANTITY_UNITS, canonicalizeCatalogQuantity, parseCatalogQuantity } from "@openlup/core/catalog";
import type { CatalogDraftIssue, CatalogProductTypeDefinition, CatalogQuantity } from "./contracts/productTypes.js";
import type { CatalogDraftPayloadV3, CatalogDraftPublicationStoredRecord, CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogDraftClaimV3, CatalogDraftMediaClaimV3 } from "./contracts/draftV3.js";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./contracts/publication.js";
import { CATALOG_PUBLICATION_LIMITS } from "./contracts/publication.js";
import { CatalogPublicationError, publicationRefuse } from "./publicationError.js";
import { catalogPublishedProductSchema, catalogPublishedSkuSchema, comparePublicationText, publicationContent,
  publicationDigest, publicationJson, publicationReadinessVerdict } from "./publicationCodec.js";
import { resolvePublicationRules, type CatalogPublicationRulesHandle, type CatalogPublicationRulesModule } from "./publicationRules.js";
import { validateCatalogDraftV2 } from "./draftV2Validation.js";
import type { CatalogAttributeReferencePort } from "./attributeReferencePort.js";
import type { CatalogDraftPayloadV2 } from "./contracts/draftV2.js";
import { catalogDefinitionDigest } from "./catalogDefinitionDigest.js";
import type { CatalogHeadRef } from "./contracts/lifecycle.js";
import type { CatalogPublicationEvidence, CatalogPublicationDraftEvidence, CatalogPublicationDocument, CatalogCandidatePublicationDeps } from "./publicationEvidence.js";
import { enablesSku, requiredPromotions, sealedPresentation } from "./publicationDraft.js";

export interface CatalogPublicationCompileInput {
  record: CatalogDraftPublicationStoredRecord;
  definition: CatalogProductTypeDefinition;
  installedDefinitionDigest: string;
  expectedHead: CatalogHeadRef | null;
  evidence: CatalogPublicationEvidence | null;
  rules?: CatalogPublicationRulesHandle | undefined;
  attributeReferences?: CatalogAttributeReferencePort | undefined;
  validatePrices?: ((payload: CatalogDraftPayloadV2) => Promise<readonly CatalogDraftIssue[]>) | undefined;
  capacity?: number;
  observations?: Pick<CatalogCandidatePublicationDeps, "presentationReadiness" | "verifyMedia" | "assessActivation"> | undefined;
}
export function catalogPublicationClaim(record: CatalogDraftPublicationStoredRecord): CatalogDraftClaimV3 {
  return { draftId: record.draftId, revision: record.revision, commandKey: record.commandKey, fingerprint: record.fingerprint };
}
const equal = (a: unknown, b: unknown): boolean => publicationJson(a) === publicationJson(b);
const need = (condition: unknown, reason: string): void => { if (!condition) publicationRefuse(reason); };
function assertCatalogAction(payload: CatalogDraftPayloadV3, action: "create" | "revise") {
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
  const header = z.object({ skus: z.array(z.object({ netContent: z.unknown().optional(), grossMass: z.unknown().optional() })) }).safeParse(payload);
  if (!header.success) return;
  for (const sku of header.data.skus) {
    const value = sku.netContent;
    if (value && typeof value === "object" && "dimension" in value && value.dimension === "mass")
      catalogPublicationIntegralGrams(value as CatalogQuantity, definition);
  }
}
type AmountBinding = { definition: CatalogProductTypeDefinition; rules: Pick<CatalogPublicationRulesModule, "validateSkuAmounts"> };

/** @experimental */
export function catalogPublicationPreparationIssues(payload: CatalogDraftPayloadV3, binding?: AmountBinding) {
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
export function catalogPublicationAffected(payload: CatalogDraftPayloadV3) {
  let wholeProduct = false;
  const created = new Set<string>(), admitted = new Set<string>(), enabling = new Set<string>();
  for (const op of payload.publication.operations) {
    if (op.op === "create_sku") created.add(op.skuCode);
    if (op.op === "set_offer_membership" && op.admitted) admitted.add(op.skuCode);
    if (enablesSku(op)) enabling.add(op.skuCode);
    if ((op.op === "move_document_pointer" || op.op === "set_product_status" && op.status === "active")
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
  need(createHash("sha256").update(canonicalText).digest("hex") === reference.digest, "catalog_publication_v3_document_digest_mismatch");
  let documentInfo: ReturnType<CatalogPublicationRulesModule["inspectDocument"]>;
  try {
    documentInfo = rules.inspectDocument(canonicalText);
    need(documentInfo?.productSlug === slug && documentInfo.documentRef === reference.documentRef
      && documentInfo.revisionNo === reference.revisionNo && documentInfo.schemaId === reference.schemaId, "catalog_publication_v3_document_invalid");
  } catch { return publicationRefuse("catalog_publication_v3_document_invalid"); }
  need(documentInfo.canonicallyEncoded === true, "catalog_publication_v3_document_not_canonical");
  return documentInfo;
}
function matchesAuthoredDocument(document: unknown, canonicalText: string, rules: CatalogPublicationRulesModule) {
  try { return rules.matchesDocument(document, canonicalText) === true; }
  catch { return false; }
}
function documentSkuFacts(document: CatalogPublicationDocument, sku: CatalogPublishedSku, rules: CatalogPublicationRulesModule): CatalogPublicationFacts {
  return rules.deriveSkuFacts(document.canonicalText, sku);
}
type PublicationOperation = CatalogDraftPayloadV3["publication"]["operations"][number];

function assertSkuCreationDocument(operation: Extract<PublicationOperation, { op: "create_sku" }>,
  authored: CatalogDraftPayloadV3["product"]["documentRevision"], current: CatalogPublishedProduct["document"] | undefined = authored) {
  need(operation.documentRevisionNo === current?.revisionNo && equal(authored, current), "catalog_publication_v3_compile_document_stale");
}

function assertMaterializedSkuSource(sku: CatalogPublishedSku | undefined, source: CatalogDraftPayloadV3["skus"][number]) {
  need(sku && sku.id === source.id && sku.productId === source.productId
    && equal(source.netContent, sku.netContent) && equal(source.options, sku.options), "catalog_publication_operation_source_mismatch");
}

function skuCreationFacts(operation: Extract<PublicationOperation, { op: "create_sku" }>,
  source: { sku: CatalogDraftPayloadV3["skus"][number]; source: CatalogDraftPublicationStoredRecord }, productId: string): CatalogPublishedSku {
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
    need(rules.validateMembershipChange(sku, row) === true, "catalog_publication_membership_change_not_allowed");
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

function publicationAuthorship(record: CatalogDraftPublicationStoredRecord, payload: CatalogDraftPayloadV3,
  retained: readonly CatalogPublicationDraftEvidence[], rules: CatalogPublicationRulesModule | undefined, missingEvidence: boolean) {
  const slug = payload.product.slug!;
  const explicit = payload.publication.evidence.drafts ?? [];
  const sources = [record, ...retained.map(entry => entry.record)];
  const incoming = new Map(payload.skus.map(sku => [sku.code, sku]));
  const declared = new Set(explicit.map(claim => claim.draftId));
  const registrations = new Map(payload.publication.operations.flatMap(operation =>
    operation.op === "register_document_revision" ? [[operation.revisionId, operation] as const] : []));
  const proven = new Map(retained.map(entry => [entry.record, entry.head]));
  function requireCurrent(source: CatalogDraftPublicationStoredRecord) {
    const head = proven.get(source);
    need(head?.draftId === source.draftId && head.productId === source.productId
      && head.revision === source.revision && head.status === "open", "catalog_publication_draft_advanced");
  }
  function sku(code: string, allowRetained = false) {
    const candidates = sources.flatMap(source => {
      if (source !== record && !allowRetained && !declared.has(source.draftId)) return [];
      if (source.payload.schemaVersion !== 3) return [];
      const value = source === record ? incoming.get(code) : source.payload.skus.find(sku => sku.code === code);
      return value ? [{ source, payload: source.payload, sku: value }] : [];
    });
    const acting = candidates.filter(row => row.source === record || declared.has(row.source.draftId));
    if (!allowRetained) need(acting.length <= 1, "catalog_publication_operation_source_ambiguous");
    const selected = acting[0] ?? (allowRetained ? candidates[0] : undefined);
    if (!selected) {
      if (missingEvidence) return undefined;
      return publicationRefuse("catalog_publication_operation_source_missing");
    }
    need(selected.sku.productId === payload.product.id, "catalog_publication_operation_source_mismatch");
    if (selected.source !== record && allowRetained) requireCurrent(selected.source);
    return selected;
  }
  function document(operation: Extract<PublicationOperation, { op: "register_document_revision" }>): CatalogPublicationDocument | undefined {
    const { provenance: given } = operation;
    const provenance = given.source === "current_draft"
      ? { draftId: record.draftId, draftRevision: record.revision, draftCommandKey: record.commandKey, draftFingerprint: record.fingerprint }
      : { draftId: given.draftId, draftRevision: given.draftRevision, draftCommandKey: given.draftCommandKey, draftFingerprint: given.draftFingerprint };
    const source = sources.find(source => source.draftId === provenance.draftId && source.revision === provenance.draftRevision
      && source.commandKey === provenance.draftCommandKey && source.fingerprint === provenance.draftFingerprint);
    const reference = source?.payload.schemaVersion === 3 ? source.payload.product.documentRevision : undefined;
    if (reference && rules) checkedDocument(operation.canonicalText, { ...operation, schemaId: reference.schemaId }, slug, rules);
    else need(createHash("sha256").update(operation.canonicalText).digest("hex") === operation.digest,
      "catalog_publication_v3_document_digest_mismatch");
    if (!source && missingEvidence) return undefined;
    if (source?.payload.schemaVersion !== 3 || source.productId !== payload.product.id) return publicationRefuse("catalog_publication_document_source_missing");
    if (!reference || reference.id !== operation.revisionId || reference.revisionNo !== operation.revisionNo
      || reference.documentRef !== operation.documentRef || reference.sourceRef !== operation.sourceRef || reference.digest !== operation.digest)
      return publicationRefuse("catalog_publication_document_source_mismatch");
    if (rules && source.payload.product.sharedContent.document !== undefined)
      need(matchesAuthoredDocument(source.payload.product.sharedContent.document, operation.canonicalText, rules), "catalog_publication_v3_document_invalid");
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
        const authored = payload.product.sharedContent.document;
        if (authored !== undefined) {
          let name: string | undefined;
          try { name = rules.identifyDocument(authored)?.name; }
          catch { /* The installed rules could not read the authored name. */ }
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
  return { document, productOperation, skuOperation, sku };
}

type PublicationMode = "preview" | "first-decision" | "compile";
type PublicationPhase = "structural" | "activation";

function receiptMatches(evidence: CatalogPublicationDraftEvidence, record: CatalogDraftPublicationStoredRecord) {
  return evidence.record.status === "open" && evidence.record.productId === record.productId
    && equal(catalogPublicationClaim(evidence.record), evidence.receipt);
}
function boundDrafts(record: CatalogDraftPublicationStoredRecord, payload: CatalogDraftPayloadV3, evidence: CatalogPublicationEvidence) {
  const seen = new Set<string>();
  const retained = [];
  let candidateFound = false;
  for (const entry of evidence.drafts) {
    const decoded = catalogPublicationDraftRecordSchema.safeParse(entry.record);
    if (!decoded.success) return publicationRefuse("catalog_publication_read_invalid", "dependency_unavailable");
    const source = decoded.data;
    const key = `${source.draftId}@${source.revision}`;
    need(!seen.has(key) && receiptMatches(entry, record) && equal(source.payload.product.type, payload.product.type),
      "catalog_publication_source_mismatch");
    seen.add(key);
    const candidate = source.draftId === record.draftId && source.revision === record.revision;
    const explicit = payload.publication.evidence.drafts?.find(claim => claim.draftId === source.draftId && claim.revision === source.revision);
    if (candidate || explicit) {
      need(equal(candidate ? catalogPublicationClaim(record) : explicit, entry.receipt), "catalog_publication_source_mismatch");
      if (explicit) need(equal(explicit, entry.receipt), "catalog_publication_source_mismatch");
      need(entry.head?.draftId === source.draftId && entry.head.productId === source.productId
        && entry.head.revision === source.revision && entry.head.status === "open", "catalog_publication_draft_advanced");
    }
    if (candidate) {
      need(equal(source.payload, payload), "catalog_publication_source_mismatch");
      candidateFound = true;
    } else retained.push({ ...entry, record: source });
  }
  need(candidateFound && (payload.publication.evidence.drafts ?? []).every(claim => seen.has(`${claim.draftId}@${claim.revision}`)),
    "catalog_publication_source_mismatch");
  return retained;
}

async function observe<T>(read: () => Promise<T | undefined>): Promise<T | undefined> {
  try { return await read(); } catch { return undefined; }
}

/** Interpret one sealed intent. A writer can consume the ordered operations
 * and price obligations after successful evaluation against its guarded facts.
 */
export async function evaluateCatalogPublication(input: CatalogPublicationCompileInput, mode: PublicationMode) {
  const structural: CatalogDraftIssue[] = [], activationIssues: CatalogDraftIssue[] = [];
  const position: { phase: PublicationPhase } = { phase: "structural" };
  let activating = false;
  let failure: CatalogPublicationError | undefined;
  const pending: (CatalogDraftIssue & { channel?: "one_time" | "subscription" })[] = [];
  try {
    const compiled = await planPublication();
    return { compiled, structural, activationIssues, activating, pending, failure, phase: position.phase };
  } catch (error) {
    if (!(error instanceof CatalogPublicationError)) throw error;
    const issues = position.phase === "structural" ? structural : activationIssues;
    const issue = { path: "publication", code: error.code };
    if (error.outcome === "dependency_unavailable") issues.push(issue);
    else { failure = error; issues.unshift(issue); }
    return { compiled: undefined, structural, activationIssues, activating, pending, failure, phase: position.phase };
  }

  async function planPublication() {
    const { record, definition, expectedHead, evidence, observations, rules: handle } = input;
    need(input.installedDefinitionDigest === catalogDefinitionDigest(definition), "catalog_definition_drift");
    const rules = handle && resolvePublicationRules(handle, definition.validatorRef);
    need(record.payload.schemaVersion === 3, "catalog_publication_source_invalid");
    const canonicalPayload = canonicalCatalogDraftJson(record.payload);
    // Check the temporary numeric domain before strict positive-quantity decoding,
    // so zero, negative, fractional and overflow all have the same stable refusal.
    assertCatalogPublicationMassInputs(record.payload, definition);
    const decoded = catalogPublicationDraftPayloadSchema.safeParse(record.payload);
    if (!decoded.success) return publicationRefuse("candidate_invalid");
    const payload = decoded.data;
    need(equal(payload.product.type, { key: definition.key, version: definition.version }), "catalog_definition_drift");
    const authoredIssues = catalogPublicationPreparationIssues(payload, { definition, rules: rules ?? {} });
    if (authoredIssues.length) { structural.push(...authoredIssues); return; }
    const missingState = expectedHead !== null && evidence === null;
    const retainedState = evidence ?? { product: null, skus: [], documents: [], documentRevisionHighWater: 0 };
    if (!rules || !evidence) structural.push({ path: "publication", code: "publication_preparation_unavailable" });
    const validationPayload = catalogDraftV3ValidationPayload(payload);
    const priceOperations = payload.skus.flatMap(sku => sku.priceOperations ?? []);
    async function checkPrices() {
      if (mode === "first-decision" || !priceOperations.length) return;
      const prices = await observe(() => input.validatePrices?.({
        ...validationPayload, product: { ...validationPayload.product, sharedContent: publicationContent(payload.product.sharedContent) },
      }) ?? Promise.resolve(undefined));
      if (!prices) structural.push({ path: "skus", code: "price_validation_unavailable" });
      else if (prices.length) {
        const hard = prices.find(issue => !publicationIssueUnavailable(issue));
        if (hard) publicationRefuse(hard.code);
        structural.push(...prices);
      }
    }
    const validation = await validateCatalogDraftV2(validationPayload, { resolve: () => ({ ...definition,
      validateContent: rules ? content => rules.validateContent(content) : () => [] }) }, input.attributeReferences);
    const draftIssues = validation.valid ? validation.readiness.publication.issues : validation.issues;
    const unresolved = unresolvedPublicationDraftIssues(draftIssues, retainedState);
    for (const issue of unresolved) {
      if (issue.code === "attribute_reference_unresolved"
        || missingState && (issue.code === "primary_sku_missing" || issue.code === "sku_missing")) {
        structural.push({ path: issue.path, code: "publication_evidence_unavailable" });
      } else {
        structural.unshift(issue);
        return;
      }
    }
    need(record.productId === payload.product.id && record.status === "open", "catalog_publication_source_invalid");
    need(canonicalCatalogDraftJson(payload) === canonicalPayload, "catalog_publication_source_mismatch");
    if (evidence) {
      need(equal(evidence.head, expectedHead) && (evidence.product?.document?.digest ?? null) === (expectedHead?.documentDigest ?? null),
        "catalog_publication_source_mismatch");
      need(Number.isSafeInteger(evidence.documentRevisionHighWater) && evidence.documentRevisionHighWater >= 0
        && evidence.documents.every(row => row.reference.revisionNo <= evidence.documentRevisionHighWater), "catalog_publication_source_mismatch");
    }
    const retained = evidence ? boundDrafts(record, payload, evidence) : [];
    need(retainedState.skus.length === 0 || retainedState.product !== null, "catalog_publication_source_invalid");
    if (retainedState.product !== null && !catalogPublishedProductSchema.safeParse(retainedState.product).success)
      publicationRefuse("catalog_publication_read_invalid", "dependency_unavailable");
    need(retainedState.skus.every(sku => sku.productId === payload.product.id), "catalog_publication_scope_expansion");
    const retainedIds = new Set<string>(), retainedCodes = new Set<string>();
    for (const sku of retainedState.skus) {
      need(!retainedIds.has(sku.id) && !retainedCodes.has(sku.code) && catalogPublishedSkuSchema.safeParse(sku).success,
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
    const documents = retainedState.documents.map(document => structuredClone(document));
    const authorship = publicationAuthorship(record, payload, retained, rules, !evidence);
    const created = new Set<string>(), identities = new Set<string>();
    const combination = (options: CatalogPublishedSku["options"]) => Buffer.from(canonicalizeCatalogCombinationV2({
      definition: input.definition, axes: payload.product.dimensions, options,
    }).combinationDigest).toString("hex");
    let existingCombinations: Set<string> | undefined;
    const registered = new Set<string>(), moved = new Set<string>();
    const incoming = new Map(payload.skus.map(sku => [sku.code, sku]));
    const gtins = new Set(retainedState.skus.flatMap(sku => sku.identifiers.filter(identifier => identifier.scheme === "gs1:gtin").map(identifier => identifier.value.padStart(14, "0"))));
    if (product) need(product.id === payload.product.id && product.slug === slug && equal(product.type, payload.product.type), "catalog_publication_product_identity_conflict");
    assertCatalogAction(payload, expectedHead === null ? "create" : "revise");
    if (product && payload.product.primarySkuId)
      need(product.primarySkuId === payload.product.primarySkuId, "current_primary_mismatch");
    const authoredDocument = payload.product.documentRevision;
    need(authoredDocument, "document_reference_missing");
    const documentsById = new Map<string, CatalogPublicationDocument>();
    const documentsByRevision = new Map<number, CatalogPublicationDocument>();
    for (const document of documents) {
      const retainedReference = document.reference;
      const parsed = catalogDocumentRevisionRefSchema.safeParse(retainedReference);
      need(parsed.success && document.reference.productId === payload.product.id
        && !documentsById.has(document.reference.id) && !documentsByRevision.has(document.reference.revisionNo),
      "catalog_publication_document_source_mismatch");
      documentsById.set(document.reference.id, document);
      documentsByRevision.set(document.reference.revisionNo, document);
      if (rules) checkedDocument(document.canonicalText, document.reference, slug, rules);
    }
    function knownProduct(): CatalogPublishedProduct { return product ?? publicationRefuse("catalog_publication_v3_compile_product_absent"); }
    const knownSku = (code: string) => prefixSku(skus, code);
    function documentAt(no: number): CatalogPublicationDocument {
      return documentsByRevision.get(no) ?? publicationRefuse("catalog_publication_v3_compile_document_absent");
    }
    function selectedDocument(reference: CatalogPublishedProduct["document"] | undefined): CatalogPublicationDocument | undefined {
      if (!reference) return;
      const selected = documentsById.get(reference.id);
      if (selected) need(equal(selected.reference, reference), "catalog_publication_document_source_mismatch");
      else if (!structural.some(issue => issue.code === "catalog_publication_document_bytes_unavailable"))
        structural.push({ path: "product.documentRevision", code: "catalog_publication_document_bytes_unavailable" });
      return selected;
    }
    const beforeDocument = selectedDocument(product?.document);
    const currentDocument = () => selectedDocument(knownProduct().document);
    const media = new Map(payload.publication.evidence.media?.map(claim => [claim.skuCode, claim]));
    const verifiedMedia: CatalogDraftMediaClaimV3[] = [];
    const authoredPresentation = payload.product.sharedContent.presentation;
    const readRoute = async (presentation: CatalogPublicationFacts) => {
      const verdict = publicationReadinessVerdict.safeParse(await observe(() => observations?.presentationReadiness?.(record.productId, structuredClone(presentation)) ?? Promise.resolve(undefined)));
      if (!verdict.success) structural.push({ path: "product.sharedContent.presentation", code: "catalog_publication_presentation_unavailable" });
      else if (!verdict.data.ready) publicationRefuse(verdict.data.reasons[0]!);
    };
    for (const [code, claim] of media) {
      const authored = incoming.get(code);
      if (!authored && skus.has(code)) publicationRefuse("catalog_publication_draft_advanced", "conflict");
      need(authored && !catalogPublicationMediaIssue(authoredPresentation.mediaRef, authored.assetRefs ?? [], claim),
        "catalog_publication_media_evidence_mismatch");
    }
    activating = affected.enabling.size > 0;
    const activationCodes = new Set(affected.enabling);
    for (const sku of skus.values()) {
      if (sku.status === "active" && (sku.sellableStandalone || sku.sellableInSubscription) && affected.source(sku.code))
        activationCodes.add(sku.code);
    }
    if (mode !== "first-decision") {
      for (const code of activationCodes) {
        const source = authorship.sku(code, true);
        if (!source) continue;
        if (!missingState) assertMaterializedSkuSource(skus.get(code), source.sku);
        need(source.sku.netContent, "catalog_publication_operation_source_mismatch");
        assertCatalogPublicationGrossMass(source.sku.netContent!, source.sku.grossMass ?? null, definition);
      }
      for (const [code, claim] of media) {
        const accepted = await observe(() => observations?.verifyMedia?.(structuredClone(claim), expectedHead) ?? Promise.resolve(undefined));
        if (accepted === true) verifiedMedia.push(claim);
        else if (accepted === false) publicationRefuse("catalog_publication_media_readiness_unproven");
        else structural.push({ path: `publication.evidence.media.${code}`, code: "catalog_publication_media_validation_unavailable" });
      }
    }
    const writesPresentation = payload.publication.operations.some(operation => operation.op === "set_product_presentation");
    if (!writesPresentation) {
      const authoredRoute = Object.keys(authoredPresentation).length > 0;
      if (authoredRoute) await readRoute(authoredPresentation);
      if (product?.presentation && (!authoredRoute || !equal(product.presentation, authoredPresentation))) await readRoute(product.presentation);
    }
    let highWater = retainedState.documentRevisionHighWater;
    let createdProduct: CatalogPublishedProduct | undefined;
    const createdSkus = new Map<string, CatalogPublishedSku>();
    for (const operation of payload.publication.operations) {
      if ("productSlug" in operation) authorship.productOperation(operation);
      const source = "skuCode" in operation && operation.op !== "set_derived_sku_facts" ? authorship.skuOperation(operation) : undefined;
      const entry = operation.op === "register_document_revision" ? authorship.document(operation) : undefined;
      if (operation.op === "create_sku" && source) assertSkuCreationDocument(operation, source.payload.product.documentRevision);
      if (operation.op === "set_product_presentation" && operation.presentation !== null) {
        if (!missingState) knownProduct();
        await readRoute(operation.presentation);
      }
      if (missingState || "skuCode" in operation && !source && operation.op !== "set_derived_sku_facts") continue;
      if (operation.op === "create_product") {
        need(product === null && operation.productId === payload.product.id, "catalog_publication_v3_compile_product_conflict");
        product = { id: operation.productId, slug, name: operation.name, status: "draft", type: payload.product.type,
          axes: [...payload.product.dimensions], attributes: payload.product.attributes ?? {}, primarySkuId: null, document: null,
          presentation: null, source: claim, content: publicationContent(payload.product.sharedContent) };
        if (mode === "compile") createdProduct = structuredClone(product);
      } else if (operation.op === "register_document_revision") {
        if (!entry) continue;
        knownProduct();
        const byId = documentsById.get(operation.revisionId), byRevision = documentsByRevision.get(operation.revisionNo);
        if (byId || byRevision) need(byId === byRevision && equal(byId, entry), "catalog_publication_v3_compile_document_conflict");
        else {
          need(operation.revisionNo === highWater + 1, "catalog_publication_document_revision_sequence");
          documents.push(entry);
          documentsById.set(entry.reference.id, entry);
          documentsByRevision.set(entry.reference.revisionNo, entry);
          highWater++;
        }
        registered.add(entry.reference.id);
      } else if (operation.op === "move_document_pointer") {
        const document = documentAt(operation.documentRevisionNo);
        need(document.reference.productId === knownProduct().id && equal(payload.product.documentRevision, document.reference), "catalog_publication_document_source_mismatch");
        knownProduct().document = document.reference;
        if (registered.has(document.reference.id)) moved.add(document.reference.id);
      } else if (operation.op === "create_sku") {
        need(!skus.has(operation.skuCode) && ![...skus.values()].some(sku => sku.id === operation.skuId), "catalog_publication_v3_compile_sku_conflict");
        const sku = skuCreationFacts(operation, source!, knownProduct().id);
        existingCombinations ??= new Set([...skus.values()].map(existing => combination(existing.options)));
        const identity = combination(sku.options);
        need(!existingCombinations.has(identity), "duplicate_combination");
        assertSkuCreationDocument(operation, source!.payload.product.documentRevision, knownProduct().document);
        existingCombinations.add(identity);
        const selected = currentDocument();
        if (rules && selected) need(equal(documentSkuFacts(selected, sku, rules), sku.facts), "catalog_publication_v3_compile_derived_facts_mismatch");
        skus.set(sku.code, sku); created.add(sku.code);
        if (mode === "compile") createdSkus.set(sku.code, structuredClone(sku));
      } else if (operation.op === "create_identifier") {
        const sku = knownSku(operation.skuCode);
        need(created.has(sku.code), "catalog_publication_identifier_requires_created_sku");
        const { op: _op, skuCode: _code, ...identifier } = operation;
        if (identifier.scheme === "gs1:gtin") {
          need(isValidGtin(identifier.value) && !gtins.has(identifier.value.padStart(14, "0")), "catalog_publication_v3_compile_identifier_conflict");
          gtins.add(identifier.value.padStart(14, "0"));
        }
        need(!identifier.isPrimary || identifier.scheme === "gs1:gtin" && identifier.packagingLevel === "unit" && !sku.identifiers.some(value => value.isPrimary), "catalog_publication_identifier_primary_invalid");
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
        if (on && mode === "first-decision") assertMaterializedSkuSource(materialized, source!.sku);
        need(!on || sku.status !== "archived" && materialized?.status !== "archived", "catalog_publication_v3_compile_sku_archived");
        applySkuPrefix(sku, operation, rules);
      } else if (operation.op === "set_sku_status") {
        const sku = knownSku(operation.skuCode);
        if (operation.status === "archived") need(!sku.sellableStandalone && !sku.sellableInSubscription && knownProduct().primarySkuId !== sku.id, "catalog_publication_v3_compile_archive_refused");
        else need(payload.publication.operations.some(other => other.op === "set_eligibility" && other.skuCode === sku.code
          && (other.sellableStandalone || other.sellableInSubscription)), "catalog_publication_activation_requires_explicit_eligibility");
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
        const original = originalById.get(sku.id);
        assertDerivedSource(operation, original, authoredDocument?.revisionNo);
        need(knownProduct().document?.revisionNo === operation.documentRevisionNo, "catalog_publication_derived_source_mismatch");
        const selected = currentDocument();
        if (rules && selected) need(equal(documentSkuFacts(selected, sku, rules), operation.facts), "catalog_publication_v3_compile_derived_facts_mismatch");
        applySkuPrefix(sku, operation, rules);
      } else { const _exhaustive: never = operation; publicationRefuse("catalog_publication_operation_invalid"); }
      knownProduct();
    }
    if (missingState) { await checkPrices(); return; }
    const result = knownProduct();
    if (payload.product.documentRevision) need(equal(payload.product.documentRevision, result.document), "catalog_publication_document_source_mismatch");
    if (retainedState.product?.document && !equal(retainedState.product.document, authoredDocument) && !moved.has(authoredDocument!.id))
      publicationRefuse("catalog_publication_v3_document_reference_stale", "conflict");
    const afterDocument = currentDocument();
    if (rules && afterDocument && payload.product.sharedContent.document !== undefined)
      need(matchesAuthoredDocument(payload.product.sharedContent.document, afterDocument.canonicalText, rules), "catalog_publication_document_source_mismatch");
    result.attributes = payload.product.attributes ?? result.attributes; result.axes = [...payload.product.dimensions];
    result.content = publicationContent(payload.product.sharedContent); result.source = claim;
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
      const draft = incoming.get(sku.code);
      if (draft && !created.has(sku.code)) {
        need(draft.id === sku.id && draft.productId === sku.productId && equal(draft.netContent, sku.netContent)
          && equal(draft.options, sku.options), "sku_identity_change_requires_new_sku");
        for (const identifier of draft.identifiers ?? []) {
          need(sku.identifiers.some(stored => identifier.scheme === "gs1:gtin" && stored.scheme === "gs1:gtin"
            ? isValidGtin(identifier.value) && identifier.value.padStart(14, "0") === stored.value.padStart(14, "0")
            : matchesAuthoredIdentifier(identifier, stored)), "catalog_publication_identifier_source_mismatch");
        }
        const after = { ...sku, attributes: draft.attributes ?? sku.attributes, grossMass: draft.grossMass ?? sku.grossMass, assetRefs: draft.assetRefs ?? sku.assetRefs };
        Object.assign(sku, after);
      }
      const before = originalById.get(sku.id);
      if (before && rules && afterDocument && beforeDocument && (productPhysicalChange || !equal(
        [before.netContent, before.options, before.attributes, before.facts, before.grossMass, before.assetRefs],
        [sku.netContent, sku.options, sku.attributes, sku.facts, sku.grossMass, sku.assetRefs]))) {
        need(rules.classifySkuChange(before, sku, { beforeProduct: retainedState.product!, afterProduct: result,
          beforeDocument, afterDocument }) === "compatible", "sku_identity_change_requires_new_sku");
      }
      need(sku.netContent.dimension === "mass", "catalog_publication_mass_required_until_mc5");
      catalogPublicationIntegralGrams(sku.netContent, input.definition);
      if (rules && afterDocument) need(equal(documentSkuFacts(afterDocument, sku, rules), sku.facts),
        "catalog_publication_v3_compile_derived_facts_mismatch");
      const key = combination(sku.options);
      need(!identities.has(key), "duplicate_combination"); identities.add(key);
      publicationJson(catalogPublishedSkuSchema.parse(sku), CATALOG_PUBLICATION_LIMITS.skuBytes);
    }
    need(skus.size <= (input.capacity ?? 50_000), "product_capacity_exceeded");
    need(result.primarySkuId && result.document && (retainedState.product !== null || result.presentation), "catalog_publication_v3_structural_readiness_failed");
    need(equal(sealedPresentation(result.presentation), payload.product.sharedContent.presentation), "catalog_publication_presentation_effect_missing");
    const primary = [...skus.values()].find(sku => sku.id === result.primarySkuId);
    need(primary && primary.status !== "archived", "catalog_publication_v3_compile_primary_foreign");
    const promotions = requiredPromotions(payload.publication.operations, retainedState);
    need((!promotions.product || result.status === "active") && promotions.skus.every(code => skus.get(code)?.status === "active"),
      "catalog_publication_activation_effect_missing");
    if (rules && afterDocument) {
      const issues = rules.validateProduct(result, [...skus.values()], documents);
      need(Array.isArray(issues) && issues.length === 0, "catalog_publication_adopter_validation_failed");
    }
    const sorted = [...skus.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const changed = original !== publicationJson(materialState(result, sorted));
    for (const sku of sorted) {
      const before = originalById.get(sku.id);
      // An omitted derived cache effect has this publication's draft/receipt as
      // its effect provenance. Keep the retained physical/media source available.
      if (before && incoming.has(sku.code) && !equal(before, sku)) sku.source = claim;
    }
    if (!changed && retainedState.product) { result.source = retainedState.product.source; result.content = retainedState.product.content; }
    need(changed || payload.publication.kind === "compensation" && payload.publication.operations.length > 0, "catalog_publication_v3_compile_change_noop");
    const operations = payload.publication.operations;
    const priced = sorted.filter(affected.priced);
    const compiled = { product: catalogPublishedProductSchema.parse(result), skus: sorted, documents, operations, createdProduct, createdSkus,
      priceOperations, changed,
      pricedSkuCodes: priced.map(sku => sku.code), activationSourceCodes: [...activationCodes], activating };
    if (mode === "first-decision") return compiled;

    // Late observations run after structural evaluation. Unknown observations
    // accumulate so that a later definite refusal still wins.
    for (const sku of sorted) if (activationCodes.has(sku.code)) {
      const problem = catalogPublicationMediaIssue(result.presentation?.mediaRef, sku.assetRefs, media.get(sku.code));
      if (problem === "media_readiness_unknown")
        activationIssues.push({ path: "publication.evidence.media", code: "catalog_publication_media_validation_unavailable" });
      else need(!problem, "catalog_publication_media_readiness_unproven");
    }
    await checkPrices();
    position.phase = "activation";
    for (const sku of priced) {
      need(sku.status !== "archived", "catalog_publication_v3_compile_sku_archived");
      assertCatalogPublicationGrossMass(sku.netContent, sku.grossMass, definition);
      need(sku.identifiers.some(identifier => identifier.scheme === "gs1:gtin" && identifier.isPrimary && identifier.packagingLevel === "unit")
        && sku.logisticsRef && sku.memberships.some(row => row.admitted), "catalog_publication_v3_activation_readiness_failed");
    }
    if (operations.some(operation => operation.op === "set_product_status" && operation.status === "active")) {
      need(primary?.status === "active" && (primary.sellableStandalone || primary.sellableInSubscription), "catalog_publication_v3_active_primary_required");
      need(result.presentation, "catalog_publication_v3_presentation_required");
    }
    if (activating || priced.length) {
      const verdict = publicationReadinessVerdict.safeParse(await observe(() =>
        observations?.assessActivation?.(structuredClone({ product: compiled.product, skus: compiled.skus }), expectedHead, structuredClone(verifiedMedia)) ?? Promise.resolve(undefined)));
      if (!verdict.success) activationIssues.push({ path: "publication", code: "activation_unknown" });
      else if (!verdict.data.ready) publicationRefuse(verdict.data.reasons[0]!);
    }
    if (mode === "preview" && !activating && !priced.length) {
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
    return compiled;
  }
}

export async function compileCatalogPublication(input: CatalogPublicationCompileInput, mode: Exclude<PublicationMode, "preview"> = "compile") {
  const result = await evaluateCatalogPublication(input, mode);
  if (result.failure) throw result.failure;
  const issues = [...result.structural, ...result.activationIssues];
  const hard = issues.find(issue => !publicationIssueUnavailable(issue));
  if (hard) return publicationRefuse(hard.code);
  if (issues.length || !result.compiled) return publicationRefuse(issues[0]?.code ?? "publication_preparation_unavailable", "dependency_unavailable");
  return result.compiled;
}

export function publicationIssueUnavailable(issue: CatalogDraftIssue): boolean {
  return issue.code.endsWith("_unavailable") || issue.code === "activation_unknown";
}
