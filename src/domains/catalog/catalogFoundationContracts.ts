import { z } from "../../lib/validation/zod.js";

/**
 * Portable, payload-free catalog shape. Document interpretation remains an
 * adopter concern; this module can only carry immutable document references.
 */
export const CATALOG_FOUNDATION_CONTRACT_VERSION = "catalog.foundation.v1";

const entityIdSchema = z.guid();
const opaqueReferenceSchema = z.string().trim().min(1).max(240);
const codeSchema = z.string().trim().min(1).max(160).regex(/^[A-Za-z0-9._:-]+$/);
const sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const currencyCodeSchema = z.string().regex(/^[A-Z]{3}$/u);

export const catalogFixedPointSchema = z.object({
  /** SKU net content is a physical, positive quantity; signed values need a distinct contract. */
  unscaled: z.number().int().positive().safe(),
  scale: z.number().int().min(0).max(12).safe(),
  unit: z.string().trim().min(1).max(64).regex(/^[A-Z][A-Z0-9_]*$/),
}).strict();

export const catalogDocumentRevisionRefSchema = z.object({
  id: entityIdSchema,
  productId: entityIdSchema,
  revisionNo: z.number().int().positive(),
  schemaId: opaqueReferenceSchema,
  documentRef: opaqueReferenceSchema,
  sourceRef: opaqueReferenceSchema,
  digest: sha256DigestSchema,
}).strict();

export const catalogSkuIdentifierSchema = z.object({
  issuer: opaqueReferenceSchema,
  normalizedValue: z.string().trim().min(1).max(128),
  kind: z.enum(["gtin", "other"]),
  packKind: z.enum(["unit", "collective"]),
  packQuantity: z.number().int().positive(),
  isPrimary: z.boolean(),
}).strict();

/** Stable, payload-free detail selectors shared by both catalog adapters. */
export const catalogSkuEnvelopeSelectorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("sku_code"),
    skuCode: codeSchema,
  }).strict(),
  z.object({
    kind: z.literal("primary_product_slug"),
    productSlug: codeSchema,
  }).strict(),
]);

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

export const neutralSkuEnvelopeV1Schema = z.object({
  contractVersion: z.literal(CATALOG_FOUNDATION_CONTRACT_VERSION),
  product: z.object({
    id: entityIdSchema,
    slug: codeSchema,
    primarySkuId: entityIdSchema,
  }).strict(),
  sku: z.object({
    id: entityIdSchema,
    productId: entityIdSchema,
    code: codeSchema,
    netContent: catalogFixedPointSchema,
    sellability: z.object({
      status: z.enum(["draft", "active", "archived"]),
      oneTime: z.boolean(),
      subscription: z.boolean(),
    }).strict(),
    /** Structural SKU classification shared by both bundle schemas. */
    isAddon: z.boolean(),
    assetRef: opaqueReferenceSchema.nullable(),
  }).strict(),
  documentRevision: catalogDocumentRevisionRefSchema,
  identifiers: z.array(catalogSkuIdentifierSchema).max(32),
}).strict().superRefine((envelope, context) => {
  if (envelope.product.id !== envelope.sku.productId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["sku", "productId"], message: "sku must belong to envelope product" });
  }
  if (envelope.product.id !== envelope.documentRevision.productId) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["documentRevision", "productId"], message: "document revision must belong to envelope product" });
  }

  const seen = new Set<string>();
  let primaryGtinCount = 0;
  envelope.identifiers.forEach((identifier, index) => {
    const identity = `${identifier.issuer}\u0000${identifier.normalizedValue}`;
    if (seen.has(identity)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["identifiers", index], message: "identifier issuer/value pairs must be unique" });
    }
    seen.add(identity);
    if (identifier.packKind === "unit" && identifier.packQuantity !== 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["identifiers", index, "packQuantity"], message: "unit identifiers require pack quantity 1" });
    }
    if (identifier.packKind === "collective" && identifier.packQuantity <= 1) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["identifiers", index, "packQuantity"], message: "collective identifiers require pack quantity above 1" });
    }
    if (identifier.isPrimary) {
      primaryGtinCount += 1;
      if (
        identifier.kind !== "gtin"
        || identifier.packKind !== "unit"
        || !isValidGtin(identifier.normalizedValue)
      ) {
        context.addIssue({ code: z.ZodIssueCode.custom, path: ["identifiers", index], message: "a primary identifier must be a unit GTIN" });
      }
    }
  });
  if (primaryGtinCount > 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["identifiers"], message: "a SKU may have at most one primary GTIN" });
  }
});

export const catalogPriceContextSchema = z.object({
  priceListId: entityIdSchema,
  regionCode: z.string().regex(/^[A-Z]{2,3}$/u),
  currency: currencyCodeSchema,
  channel: z.string().trim().min(1).max(64).regex(/^[A-Za-z0-9._:-]+$/),
  atTime: z.string().datetime({ offset: true }),
}).strict();

export type CatalogDocumentRevisionRef = z.infer<typeof catalogDocumentRevisionRefSchema>;
export type CatalogSkuIdentifier = z.infer<typeof catalogSkuIdentifierSchema>;
export type CatalogSkuEnvelopeSelector = z.infer<typeof catalogSkuEnvelopeSelectorSchema>;
export type NeutralSkuEnvelopeV1 = z.infer<typeof neutralSkuEnvelopeV1Schema>;
export type CatalogPriceContext = z.infer<typeof catalogPriceContextSchema>;
