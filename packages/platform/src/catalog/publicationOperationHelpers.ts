import { isValidGtin } from "./foundationSchemas.js";
import type { CatalogDraftClaimV3, CatalogDraftPayloadV3, CatalogPublicationFacts } from "./contracts/draftV3.js";
import type { CatalogPublishedProduct, CatalogPublishedSku } from "./publicationContracts.js";
import { publicationRefuse, type PlatformCode } from "./publicationError.js";
import { comparePublicationText, publicationJson } from "./publicationCodec.js";
import { ruleSku } from "./publicationRules.js";
import type { CatalogPublicationRulesModule } from "./catalogPublicationRules.js";
import type { CatalogPublicationDocument } from "./publicationEvidence.js";
import type { PublicationDraftRecord, PublicationIntent, PublicationOperation } from "./publicationIntent.js";

export function catalogPublicationClaim(record: PublicationDraftRecord): CatalogDraftClaimV3 {
  return { draftId: record.draftId, revision: record.revision, commandKey: record.commandKey, fingerprint: record.fingerprint };
}

export const equal = (a: unknown, b: unknown): boolean => publicationJson(a) === publicationJson(b);

export const need = (condition: unknown, reason: PlatformCode): void => {
  if (!condition) publicationRefuse(reason);
};

export function assertCatalogAction(payload: PublicationIntent, action: "create" | "revise"): void {
  need(payload.product.sharedContent.catalogAction === action, "catalog_action_conflict");
}

export function normalizeIdentifierValue(scheme: string, value: string): string {
  return scheme === "gs1:gtin" ? value.padStart(14, "0") : value;
}

export function matchesAuthoredIdentifier(
  authored: NonNullable<CatalogDraftPayloadV3["skus"][number]["identifiers"]>[number],
  published: Pick<CatalogPublishedSku["identifiers"][number], "scheme" | "issuer" | "value" | "packagingLevel" | "quantity">,
): boolean {
  return authored.scheme === published.scheme && authored.issuer === published.issuer
    && (authored.scheme !== "gs1:gtin" || isValidGtin(authored.value))
    && normalizeIdentifierValue(authored.scheme, authored.value) === normalizeIdentifierValue(published.scheme, published.value)
    && authored.packagingLevel === published.packagingLevel && (authored.quantity ?? 1) === published.quantity;
}

export function checkedDocument(
  canonicalText: string,
  reference: Pick<CatalogPublicationDocument["reference"], "digest" | "documentRef" | "revisionNo" | "schemaId">,
  slug: string,
  rules: CatalogPublicationRulesModule,
) {
  const documentInfo = rules.inspectDocument(canonicalText);
  if (!documentInfo) return publicationRefuse("catalog_publication_v3_document_invalid");
  need(documentInfo.productSlug === slug && documentInfo.documentRef === reference.documentRef
    && documentInfo.revisionNo === reference.revisionNo && documentInfo.schemaId === reference.schemaId,
  "catalog_publication_document_source_mismatch");
  need(documentInfo.canonicallyEncoded === true, "catalog_publication_v3_document_not_canonical");
  return documentInfo;
}

export function matchesAuthoredDocument(authoredValue: unknown, canonicalText: string, rules: CatalogPublicationRulesModule): boolean {
  return rules.matchesDocument(authoredValue, canonicalText) === true;
}

export function documentSkuFacts(
  document: Pick<CatalogPublicationDocument, "canonicalText">,
  sku: CatalogPublishedSku,
  rules: CatalogPublicationRulesModule,
): CatalogPublicationFacts {
  return rules.deriveSkuFacts(document.canonicalText, ruleSku(sku));
}

export function assertSkuCreationDocument(
  operation: Extract<PublicationOperation, { op: "create_sku" }>,
  authored: CatalogDraftPayloadV3["product"]["documentRevision"],
  current: CatalogPublishedProduct["document"] | undefined = authored,
): void {
  need(operation.documentRevisionNo === current?.revisionNo && equal(authored, current), "catalog_publication_v3_compile_document_stale");
}

export function assertMaterializedSkuSource(sku: CatalogPublishedSku | undefined, source: CatalogDraftPayloadV3["skus"][number]): void {
  need(sku && sku.id === source.id && sku.productId === source.productId
    && source.netContent && equal(source.netContent, sku.netContent) && equal(source.options, sku.options), "catalog_publication_operation_source_mismatch");
  for (const identifier of source.identifiers ?? []) {
    need(sku!.identifiers.some(stored => identifier.scheme === "gs1:gtin" && stored.scheme === "gs1:gtin"
      ? isValidGtin(identifier.value) && normalizeIdentifierValue(identifier.scheme, identifier.value) === normalizeIdentifierValue(stored.scheme, stored.value)
      : matchesAuthoredIdentifier(identifier, stored)), "catalog_publication_identifier_source_mismatch");
  }
}

export function skuCreationFacts(
  operation: Extract<PublicationOperation, { op: "create_sku" }>,
  source: { sku: CatalogDraftPayloadV3["skus"][number]; source: PublicationDraftRecord },
  productId: string,
): CatalogPublishedSku {
  const { sku } = source;
  need(sku.netContent?.dimension === "mass", "catalog_publication_mass_required_until_mc5");
  return { id: operation.skuId, productId, code: operation.skuCode, title: operation.title,
    status: "draft", minQuantity: operation.minQuantity, isAddon: operation.isAddon, sellableStandalone: false, sellableInSubscription: false,
    netContent: sku.netContent!, grossMass: sku.grossMass ?? null, options: sku.options, attributes: sku.attributes ?? {},
    facts: operation.facts, identifiers: [], assetRefs: sku.assetRefs ?? [], logisticsRef: null, memberships: [], source: catalogPublicationClaim(source.source) };
}

function applyMembershipChange(
  rules: CatalogPublicationRulesModule | undefined,
  sku: CatalogPublishedSku,
  { offerVersion, admitted }: Extract<PublicationOperation, { op: "set_offer_membership" }>,
): void {
  const row = { offerVersion, admitted };
  if (rules?.validateMembershipChange)
    need(rules.validateMembershipChange(ruleSku(sku), row) === true, "catalog_publication_membership_change_not_allowed");
  const index = sku.memberships.findIndex(value => value.offerVersion === offerVersion);
  if (index < 0) sku.memberships.push(row); else sku.memberships[index] = row;
  sku.memberships.sort((a, b) => comparePublicationText(a.offerVersion, b.offerVersion));
}

export function prefixSku(skus: ReadonlyMap<string, CatalogPublishedSku>, code: string): CatalogPublishedSku {
  return skus.get(code) ?? publicationRefuse("catalog_publication_v3_compile_sku_absent");
}

export function applySkuPrefix(
  sku: CatalogPublishedSku,
  operation: PublicationOperation,
  rules: CatalogPublicationRulesModule | undefined,
): void {
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

export function assertDerivedSource(
  operation: Extract<PublicationOperation, { op: "set_derived_sku_facts" }>,
  original: Pick<CatalogPublishedSku, "netContent"> | undefined,
  authoredRevision: number | undefined,
): void {
  need(original && equal(original.netContent, operation.netContent) && operation.documentRevisionNo === authoredRevision,
    "catalog_publication_derived_source_mismatch");
}
