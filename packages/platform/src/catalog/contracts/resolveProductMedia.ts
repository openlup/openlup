import {
  PRODUCT_MEDIA_LIMITS, ProductMediaValidationError, validateProductMediaManifest,
  type ProductMediaAssociation, type ProductMediaManifest, type ProductMediaRequest,
  type ResolvedProductMedia,
} from "./productMediaContracts.js";

const hasControls = (value: string): boolean => Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const ordered = (a: ProductMediaAssociation, b: ProductMediaAssociation): number =>
  a.order - b.order || compareText(a.itemId, b.itemId);

/** A deterministic browser-safe fingerprint, not a cryptographic integrity receipt. */
function fingerprint(value: string): string {
  return [0x811c9dc5, 0x9e3779b9, 0x85ebca6b, 0xc2b2ae35].map((seed) => {
    let hash = seed;
    for (let index = 0; index < value.length; index++) hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
    return (hash >>> 0).toString(16).padStart(8, "0");
  }).join("");
}
function revision(source: ProductMediaManifest, urls: Readonly<Record<string, string>>): string {
  const assets = [...source.assets].sort((a, b) => compareText(a.assetRef, b.assetRef)).map((a) =>
    [a.assetRef, a.source, a.contentType, a.byteLength, a.sha256, a.artworkLocale, Object.prototype.hasOwnProperty.call(urls, a.assetRef) ? urls[a.assetRef] : null]);
  const products = [...source.products].sort((a, b) => compareText(a.productId, b.productId)).map((p) =>
    [p.productId, [...p.variantIds].sort(compareText), p.primaryVariantId]);
  const associations = source.associations.map((a) =>
    [a.itemId, a.assetRef, a.productId, a.scope, a.variantId ?? null, a.locale, a.role, a.viewKey ?? null, a.order, a.label]
  ).sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));
  return fingerprint(JSON.stringify([source.schemaVersion, assets, products, associations]));
}
function survives(a: ProductMediaAssociation, b: ProductMediaAssociation, locale: string): boolean {
  const ranks = (item: ProductMediaAssociation) => [item.role === "primary" ? 1 : 0,
    item.scope === "variant" ? 1 : 0, item.locale === locale ? 1 : 0];
  const ar = ranks(a), br = ranks(b);
  for (let index = 0; index < ar.length; index++) if (ar[index] !== br[index]) return ar[index]! > br[index]!;
  return ordered(a, b) < 0;
}
/** Resolve only declared variant/product material; no filename, SKU or provider inference. */
export function resolveProductMedia(
  value: ProductMediaManifest,
  request: ProductMediaRequest,
  assetUrls: Readonly<Record<string, string>>,
): ResolvedProductMedia {
  const source = validateProductMediaManifest(value);
  const product = source.products.find((p) => p.productId === request.productId);
  if (!product || !product.variantIds.includes(request.variantId)) {
    throw new ProductMediaValidationError("undeclared_variant", request.variantId);
  }
  if (typeof request.locale !== "string" || !request.locale.trim() || request.locale.length > 64 || hasControls(request.locale)) {
    throw new ProductMediaValidationError("invalid_schema", "locale");
  }
  const logicalItems = new Map<string, ProductMediaAssociation>();
  for (const item of source.associations) {
    if (item.productId !== request.productId || (item.scope === "variant" && item.variantId !== request.variantId)) continue;
    if (item.locale !== null && item.locale !== request.locale) continue;
    const current = logicalItems.get(item.itemId);
    if (!current || item.locale === request.locale) logicalItems.set(item.itemId, item);
  }
  const applicable = [...logicalItems.values()];
  if (applicable.filter((item) => item.role === "primary").length > 1) {
    throw new ProductMediaValidationError("conflicting_primary", request.productId);
  }
  const uniqueAssets = new Map<string, ProductMediaAssociation>();
  for (const item of applicable) {
    const current = uniqueAssets.get(item.assetRef);
    if (!current || survives(item, current, request.locale)) uniqueAssets.set(item.assetRef, item);
  }
  if (uniqueAssets.size > PRODUCT_MEDIA_LIMITS.resolvedItems) {
    throw new ProductMediaValidationError("collection_limit_exceeded", request.productId);
  }
  const items = [...uniqueAssets.values()].sort(ordered).map((item) => {
    const src = Object.prototype.hasOwnProperty.call(assetUrls, item.assetRef) ? assetUrls[item.assetRef] : undefined;
    if (typeof src !== "string" || !src.trim()) throw new ProductMediaValidationError("missing_resource", item.assetRef);
    // The projection may contain opaque relative delivery paths or HTTP(S) URLs only.
    if (/^[a-z][a-z\d+.-]*:/iu.test(src) && !/^https?:\/\//iu.test(src) || /^\s/u.test(src) || hasControls(src)) {
      throw new ProductMediaValidationError("unsafe_path", item.assetRef);
    }
    return { id: item.itemId, assetRef: item.assetRef, src, label: item.label, role: item.role };
  });
  const mediaRevision = revision(source, assetUrls);
  return {
    key: JSON.stringify([request.productId, request.variantId, request.locale, mediaRevision]),
    revision: mediaRevision, items,
    primaryItemId: items.find((item) => item.role === "primary")?.id ?? null,
  };
}
