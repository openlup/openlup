/** Provider-free source metadata. Delivery URLs are supplied projections. */
export type ProductMediaRole = "primary" | "view" | "illustration";
export interface ProductMediaAsset {
  assetRef: string;
  source: string;
  contentType: "image/jpeg" | "image/png" | "image/webp";
  byteLength: number;
  sha256: string;
  artworkLocale: string | null;
}
export interface ProductMediaProduct {
  productId: string;
  variantIds: readonly string[];
  primaryVariantId: string;
}
export interface ProductMediaAssociation {
  itemId: string;
  assetRef: string;
  productId: string;
  scope: "product" | "variant";
  variantId?: string;
  locale: string | null;
  role: ProductMediaRole;
  viewKey?: string;
  order: number;
  label: string;
}
export interface ProductMediaManifest {
  schemaVersion: 1;
  assets: readonly ProductMediaAsset[];
  products: readonly ProductMediaProduct[];
  associations: readonly ProductMediaAssociation[];
}
export interface ProductMediaRequest { productId: string; variantId: string; locale: string }
export interface ResolvedProductMediaItem {
  id: string; assetRef: string; src: string; label: string; role: ProductMediaRole;
}
export interface ResolvedProductMedia {
  key: string;
  revision: string;
  items: readonly ResolvedProductMediaItem[];
  primaryItemId: string | null;
}
export interface StorefrontProductMedia {
  productId: string;
  locale: string;
  primaryVariantId: string;
  collections: Readonly<Record<string, ResolvedProductMedia>>;
}
export const PRODUCT_MEDIA_LIMITS = Object.freeze({
  assets: 512, products: 256, variants: 1024, associations: 8192,
  imageBytes: 358400, totalBytes: 128 * 1024 * 1024,
  manifestBytes: 2 * 1024 * 1024, resolvedItems: 32,
});
export type ProductMediaValidationCode = "invalid_schema" | "duplicate_identity" |
  "unsafe_path" | "undeclared_variant" | "missing_resource" | "conflicting_primary" |
  "collection_limit_exceeded" | "pack_limit_exceeded";
export class ProductMediaValidationError extends Error {
  constructor(readonly code: ProductMediaValidationCode, readonly reference: string) {
    super(`${code}: ${reference}`);
    this.name = "ProductMediaValidationError";
  }
}
function refuse(code: ProductMediaValidationCode, reference: string): never {
  throw new ProductMediaValidationError(code, reference);
}
function record(value: unknown, reference: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) refuse("invalid_schema", reference);
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, allowed: readonly string[], reference: string): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) refuse("invalid_schema", reference);
}
function text(value: unknown, reference: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) {
    refuse("invalid_schema", reference);
  }
  return value;
}
function locale(value: unknown, reference: string): void {
  if (value !== null) text(value, reference, 64);
}
function array(value: unknown, reference: string, limit: number): unknown[] {
  if (!Array.isArray(value)) refuse("invalid_schema", reference);
  if (value.length > limit) refuse("pack_limit_exceeded", reference);
  return value;
}
function unique(set: Set<string>, id: string): void {
  if (set.has(id)) refuse("duplicate_identity", id);
  set.add(id);
}
/** Checks contained relative resource bindings; the resource owner also checks symlinks. */
export function validateProductMediaSourcePath(value: unknown): string {
  const source = text(value, "source", 512);
  if (source.startsWith("/") || /[:\\%?#]/u.test(source) || source.split("/").some((part) => !part || part === "." || part === "..")) {
    refuse("unsafe_path", "source");
  }
  return source;
}
/** Structural authoring/pack validation. Signatures and digests require the source bytes. */
export function validateProductMediaManifest(value: unknown): ProductMediaManifest {
  const manifest = record(value, "manifest");
  fields(manifest, ["schemaVersion", "assets", "products", "associations"], "manifest");
  if (manifest.schemaVersion !== 1) refuse("invalid_schema", "schemaVersion");
  const assets = array(manifest.assets, "assets", PRODUCT_MEDIA_LIMITS.assets);
  const products = array(manifest.products, "products", PRODUCT_MEDIA_LIMITS.products);
  const associations = array(manifest.associations, "associations", PRODUCT_MEDIA_LIMITS.associations);
  const assetIds = new Set<string>();
  let totalBytes = 0;
  for (const entry of assets) {
    const asset = record(entry, "asset");
    fields(asset, ["assetRef", "source", "contentType", "byteLength", "sha256", "artworkLocale"], "asset");
    const id = text(asset.assetRef, "assetRef");
    unique(assetIds, id);
    validateProductMediaSourcePath(asset.source);
    if (!["image/jpeg", "image/png", "image/webp"].includes(asset.contentType as string)) refuse("invalid_schema", id);
    if (!Number.isSafeInteger(asset.byteLength) || (asset.byteLength as number) <= 0) refuse("invalid_schema", id);
    if ((asset.byteLength as number) > PRODUCT_MEDIA_LIMITS.imageBytes) refuse("pack_limit_exceeded", id);
    totalBytes += asset.byteLength as number;
    if (totalBytes > PRODUCT_MEDIA_LIMITS.totalBytes) refuse("pack_limit_exceeded", "totalBytes");
    if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(asset.sha256)) refuse("invalid_schema", id);
    locale(asset.artworkLocale, id);
  }
  const productVariants = new Map<string, Set<string>>();
  let variantCount = 0;
  for (const entry of products) {
    const product = record(entry, "product");
    fields(product, ["productId", "variantIds", "primaryVariantId"], "product");
    const id = text(product.productId, "productId");
    if (productVariants.has(id)) refuse("duplicate_identity", id);
    const variants = new Set<string>();
    for (const variant of array(product.variantIds, id, PRODUCT_MEDIA_LIMITS.variants)) unique(variants, text(variant, id));
    variantCount += variants.size;
    if (variantCount > PRODUCT_MEDIA_LIMITS.variants) refuse("pack_limit_exceeded", "variants");
    const primary = text(product.primaryVariantId, id);
    if (!variants.has(primary)) refuse("undeclared_variant", primary);
    productVariants.set(id, variants);
  }
  const referencedAssets = new Set<string>();
  const identities = new Map<string, string>();
  const localizedIds = new Set<string>();
  for (const entry of associations) {
    const item = record(entry, "association");
    fields(item, ["itemId", "assetRef", "productId", "scope", "variantId", "locale", "role", "viewKey", "order", "label"], "association");
    const id = text(item.itemId, "itemId");
    const assetRef = text(item.assetRef, id);
    if (!assetIds.has(assetRef)) refuse("missing_resource", assetRef);
    referencedAssets.add(assetRef);
    const productId = text(item.productId, id);
    const variants = productVariants.get(productId);
    if (!variants) refuse("invalid_schema", productId);
    if (item.scope !== "product" && item.scope !== "variant") refuse("invalid_schema", id);
    if (item.scope === "product" && item.variantId !== undefined) refuse("invalid_schema", id);
    if (item.scope === "variant") {
      const variantId = text(item.variantId, id);
      if (!variants.has(variantId)) refuse("undeclared_variant", variantId);
    }
    locale(item.locale, id);
    if (!["primary", "view", "illustration"].includes(item.role as string)) refuse("invalid_schema", id);
    if (item.viewKey !== undefined) text(item.viewKey, id);
    if (!Number.isSafeInteger(item.order)) refuse("invalid_schema", id);
    text(item.label, id, 1024);
    const identity = JSON.stringify([productId, item.scope, item.variantId, item.role, item.viewKey]);
    if (identities.has(id) && identities.get(id) !== identity) refuse("duplicate_identity", id);
    identities.set(id, identity);
    unique(localizedIds, JSON.stringify([id, item.locale]));
  }
  for (const id of assetIds) if (!referencedAssets.has(id)) refuse("missing_resource", id);
  return value as ProductMediaManifest;
}
