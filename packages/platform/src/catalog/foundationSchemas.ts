import { z } from "./validation.js";
import { CATALOG_FOUNDATION_CONTRACT_VERSION, isValidGtin } from "./contracts/foundation.js";
export { CATALOG_FOUNDATION_CONTRACT_VERSION, CatalogSkuAuthorityError, isValidGtin, assertPrimaryUnitGtinAuthority, requireCurrentCatalogDocumentAuthority } from "./contracts/foundation.js";
export type { CatalogDocumentRevisionRef, CatalogSkuIdentifier, CatalogSkuEnvelopeSelector, NeutralSkuEnvelopeV1, CatalogPriceContext, CatalogSkuAuthorityRefusal } from "./contracts/foundation.js";

/**
 * Portable, payload-free catalog shape. Document interpretation remains an
 * adopter concern; this module can only carry immutable document references.
 */

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

