/** Portable, payload-free catalog references and identifier authority. */
export const CATALOG_FOUNDATION_CONTRACT_VERSION = "catalog.foundation.v1";
export interface CatalogDocumentRevisionRef {
  id: string; productId: string; revisionNo: number; schemaId: string;
  documentRef: string; sourceRef: string; digest: string;
}
export interface CatalogSkuIdentifier {
  issuer: string; normalizedValue: string; kind: "gtin" | "other";
  packKind: "unit" | "collective"; packQuantity: number; isPrimary: boolean;
}
export type CatalogSkuEnvelopeSelector =
  | { kind: "sku_code"; skuCode: string }
  | { kind: "primary_product_slug"; productSlug: string };
export interface NeutralSkuEnvelopeV1 {
  contractVersion: typeof CATALOG_FOUNDATION_CONTRACT_VERSION;
  product: { id: string; slug: string; primarySkuId: string };
  sku: {
    id: string; productId: string; code: string;
    netContent: { unscaled: number; scale: number; unit: string };
    sellability: { status: "draft" | "active" | "archived"; oneTime: boolean; subscription: boolean };
    isAddon: boolean; assetRef: string | null;
  };
  documentRevision: CatalogDocumentRevisionRef; identifiers: CatalogSkuIdentifier[];
}
export interface CatalogPriceContext {
  priceListId: string; regionCode: string; currency: string; channel: string; atTime: string;
}

/** Refusal vocabulary shared by managed and portable catalog readers. */
export type CatalogSkuAuthorityRefusal =
  | "catalog_sku_authority_sku_absent"
  | "catalog_sku_authority_product_absent"
  | "catalog_sku_authority_primary_sku_invalid"
  | "catalog_sku_authority_selector_ambiguous"
  | "catalog_sku_authority_current_document_absent"
  | "catalog_sku_authority_current_document_invalid"
  | "catalog_sku_identifier_authority_absent"
  | "catalog_sku_identifier_authority_ambiguous"
  | "catalog_sku_identifier_authority_invalid";

export class CatalogSkuAuthorityError extends Error {
  constructor(readonly code: CatalogSkuAuthorityRefusal) {
    super(code);
    this.name = "CatalogSkuAuthorityError";
  }
}

/** Accepts only GS1 GTIN-8/12/13/14 values with a valid modulo-10 check digit. */
export function isValidGtin(value: string): boolean {
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/u.test(value)) return false;
  const digits = [...value].map(Number);
  const checkDigit = digits.pop();
  if (checkDigit === undefined) return false;
  const weighted = digits.reverse().reduce(
    (sum, digit, index) => sum + digit * (index % 2 === 0 ? 3 : 1),
    0,
  );
  return (weighted + checkDigit) % 10 === 0;
}

/**
 * Makes a read adapter fail closed when source rows cannot state one valid,
 * primary unit GTIN. The neutral envelope itself remains payload and DB agnostic.
 */
export function assertPrimaryUnitGtinAuthority(
  identifiers: readonly CatalogSkuIdentifier[],
): void {
  const primary = identifiers.filter((identifier) => identifier.isPrimary);
  if (primary.length === 0) {
    throw new CatalogSkuAuthorityError("catalog_sku_identifier_authority_absent");
  }
  if (primary.length !== 1) {
    throw new CatalogSkuAuthorityError("catalog_sku_identifier_authority_ambiguous");
  }
  const [identifier] = primary;
  if (
    identifier.kind !== "gtin"
    || identifier.packKind !== "unit"
    || identifier.packQuantity !== 1
    || !isValidGtin(identifier.normalizedValue)
  ) {
    throw new CatalogSkuAuthorityError("catalog_sku_identifier_authority_invalid");
  }
}

/** Returns the product-scoped revision only when the declared current authority is sound. */
export function requireCurrentCatalogDocumentAuthority<T extends { id: string; productId: string }>(
  productId: string,
  currentDocumentRevisionId: string | null,
  revision: T | null | undefined,
): T {
  if (currentDocumentRevisionId === null) {
    throw new CatalogSkuAuthorityError("catalog_sku_authority_current_document_absent");
  }
  if (
    !revision
    || revision.id !== currentDocumentRevisionId
    || revision.productId !== productId
  ) {
    throw new CatalogSkuAuthorityError("catalog_sku_authority_current_document_invalid");
  }
  return revision;
}

