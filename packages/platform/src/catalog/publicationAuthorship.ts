import { z } from "./validation.js";
import { catalogDraftSummarySchema } from "./draftSchemas.js";
import type { CatalogDraftClaimV3 } from "./contracts/draftV3.js";
import type { CatalogPublishedSku } from "./publicationContracts.js";
import { publicationRefuse, type PlatformCode } from "./publicationError.js";
import { comparePublicationText } from "./publicationCodec.js";
import type { CatalogPublicationRulesModule } from "./catalogPublicationRules.js";
import type { CatalogPublicationDocument, CatalogPublicationDraftEvidence } from "./publicationEvidence.js";
import { publicationIntent, readPublicationDraftRecord, type PublicationDraftRecord, type PublicationIntent, type PublicationOperation } from "./publicationIntent.js";
import { sealedPresentation } from "./publicationDraft.js";
import { assertCatalogAction, catalogPublicationClaim, checkedDocument, equal, matchesAuthoredIdentifier, need } from "./publicationOperationHelpers.js";

const draftReceipt = catalogDraftSummarySchema.pick({ draftId: true, revision: true, commandKey: true, fingerprint: true }).strip();
const draftHead = catalogDraftSummarySchema.pick({ draftId: true, productId: true, revision: true, status: true }).strip();
export const documentProvenance = z.object({ draftId: draftReceipt.shape.draftId, draftRevision: draftReceipt.shape.revision,
  draftCommandKey: draftReceipt.shape.commandKey, draftFingerprint: draftReceipt.shape.fingerprint });

function bindDraftObservation(
  entry: CatalogPublicationDraftEvidence,
  source: PublicationDraftRecord,
  candidate: PublicationDraftRecord,
  claim?: CatalogDraftClaimV3,
  requireCurrent = true,
) {
  const receipt = draftReceipt.safeParse(entry.receipt);
  const head = draftHead.safeParse(entry.head);
  need(source.status === "open" && source.productId === candidate.productId
    && equal(source.payload.product.type, candidate.payload.product.type), "catalog_publication_source_mismatch");
  if (receipt.success) {
    need(equal(catalogPublicationClaim(source), receipt.data) && (!claim || equal(claim, receipt.data)), "catalog_publication_source_mismatch");
  }
  if (head.success) {
    need(head.data.draftId === source.draftId && head.data.productId === source.productId
      && (requireCurrent ? head.data.revision === source.revision : head.data.revision >= source.revision)
      && head.data.status === "open", "catalog_publication_draft_advanced");
  }
  return receipt.success && head.success;
}

export function boundDrafts(
  record: PublicationDraftRecord,
  payload: PublicationIntent,
  rows: readonly CatalogPublicationDraftEvidence[],
) {
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
      const verified = bindDraftObservation(entry, source, record, explicit ?? catalogPublicationClaim(record), candidate);
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

export function publicationAuthorship(
  record: PublicationDraftRecord,
  payload: PublicationIntent,
  retained: readonly CatalogPublicationDraftEvidence[],
  materialized: ReadonlyMap<string, CatalogPublishedSku>,
  rules: CatalogPublicationRulesModule | undefined,
  missingEvidence: boolean,
  onUnavailable: () => void,
) {
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
  const sourcesByRevision = new Map(sources.map(source => [`${source.draftId}@${source.revision}`, source]));
  function documentDraft(provenance: CatalogPublicationDocument["provenance"]) {
    const source = sourcesByRevision.get(`${provenance.draftId}@${provenance.draftRevision}`);
    if (source?.commandKey === provenance.draftCommandKey && source.fingerprint === provenance.draftFingerprint) return source;
  }
  function documentValue({ provenance, reference }: CatalogPublicationDocument) {
    const source = documentDraft(provenance);
    if (!source || source.productId !== payload.product.id) return;
    if (source !== record) {
      // The receipt binds the immutable revision even after that draft's head moves.
      const receipt = draftReceipt.safeParse(proven.get(source)?.receipt);
      if (!receipt.success || !equal(receipt.data, catalogPublicationClaim(source))) return;
    }
    const authored = intents.get(source)!.product;
    if (equal(authored.documentRevision, reference)) return authored.sharedContent.document;
  }
  function requireCurrent(source: PublicationDraftRecord) {
    const entry = proven.get(source);
    if (!entry || !bindDraftObservation(entry, source, record)) {
      onUnavailable();
      return false;
    }
    return true;
  }
  function sku(code: string, allowRetained = false, missingReason: PlatformCode = "catalog_publication_operation_source_missing") {
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
    return { source: documentDraft(provenance), provenance };
  }
  function document(operation: Extract<PublicationOperation, { op: "register_document_revision" }>) {
    const { source, provenance } = documentSource(operation);
    const intent = source && intents.get(source);
    const reference = intent?.product.documentRevision;
    if (reference && rules) checkedDocument(operation.canonicalText, { ...operation, schemaId: reference.schemaId }, slug, rules);
    if (!source && missingEvidence) return undefined;
    if (!source || !intent || source.productId !== payload.product.id) return publicationRefuse("catalog_publication_document_source_missing");
    if (!reference || reference.id !== operation.revisionId || reference.revisionNo !== operation.revisionNo
      || reference.documentRef !== operation.documentRef || reference.sourceRef !== operation.sourceRef || reference.digest !== operation.digest)
      return publicationRefuse("catalog_publication_document_source_mismatch");
    return { document: { reference, canonicalText: operation.canonicalText, provenance }, authored: intent.product.sharedContent.document };
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
  return { document, documentSource, documentValue, productOperation, skuOperation, sku };
}
