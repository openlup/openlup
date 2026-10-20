/** Local, bounded source-resource transfer. Uploading bytes never activates associations. */
import { constants, promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, resolve, sep } from "node:path";
import { resolveProductMedia } from "./contracts/resolveProductMedia.js";
import type { BlobStoragePort } from "@openlup/core/platform-runtime";
import {
  validateProductMediaManifest,
  PRODUCT_MEDIA_LIMITS,
  type ProductMediaManifest,
  type ProductMediaAsset,
} from "./contracts/productMediaContracts.js";

export const SOURCE_PACK_LIMITS = PRODUCT_MEDIA_LIMITS;
export interface CatalogMediaSourcePack {
  schemaVersion: "catalog.media-source-pack.v1";
  manifest: ProductMediaManifest;
}
export class CatalogMediaSourcePackError extends Error {
  constructor(public readonly code: string, public readonly reference?: string) {
    super(reference ? `${code}:${reference}` : code);
    this.name = "CatalogMediaSourcePackError";
  }
}
const refuse = (code: string, reference?: string): never => {
  throw new CatalogMediaSourcePackError(code, reference);
};
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const extensions: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };
const keyFor = (asset: ProductMediaAsset): string => `assets/${asset.sha256}.${extensions[asset.contentType]}`;

function normalized(manifest: ProductMediaManifest): ProductMediaManifest {
  return {
    schemaVersion: manifest.schemaVersion,
    products: manifest.products.map(({ productId, variantIds, primaryVariantId }) => ({ productId, variantIds: [...variantIds], primaryVariantId })),
    assets: manifest.assets.map(({ assetRef, source, contentType, byteLength, sha256, artworkLocale }) => ({ assetRef, source, contentType, byteLength, sha256, artworkLocale })),
    associations: manifest.associations.map(({ itemId, assetRef, productId, scope, variantId, locale, role, viewKey, order, label }) => ({
      itemId, assetRef, productId, scope, ...(variantId === undefined ? {} : { variantId }),
      locale, role, ...(viewKey === undefined ? {} : { viewKey }), order, label,
    })),
  };
}
function checkedManifest(value: unknown): ProductMediaManifest {
  const manifest = normalized(validateProductMediaManifest(value));
  const envelope = { schemaVersion: "catalog.media-source-pack.v1", manifest: {
    ...manifest, assets: manifest.assets.map((asset) => ({ ...asset, source: keyFor(asset) })),
  } };
  if (Buffer.byteLength(JSON.stringify(manifest)) > SOURCE_PACK_LIMITS.manifestBytes ||
      Buffer.byteLength(JSON.stringify(envelope, null, 2) + "\n") > SOURCE_PACK_LIMITS.manifestBytes) refuse("pack_limit_exceeded");
  const checks = manifest.products.map((product) => {
    const items = manifest.associations.filter((item) => item.productId === product.productId);
    const locales = new Set(items.flatMap((item) => item.locale === null ? [] : [item.locale]));
    let neutralIndex = 0;
    while (locales.has(`source-pack-neutral-${neutralIndex}`)) neutralIndex++;
    locales.add(`source-pack-neutral-${neutralIndex}`);
    return { product, locales };
  });
  // Bound processing before any full resolver pass, resource read or upload.
  const expandedChecks = checks.reduce((total, { product, locales }) => total + product.variantIds.length * locales.size, 0);
  if (expandedChecks > SOURCE_PACK_LIMITS.associations) refuse("pack_limit_exceeded");
  const urls = Object.fromEntries(manifest.assets.map((asset) => [asset.assetRef, asset.source]));
  for (const { product, locales } of checks) {
    for (const variantId of product.variantIds) for (const locale of locales) {
      resolveProductMedia(manifest, { productId: product.productId, variantId, locale }, urls);
    }
  }
  return manifest;
}

async function contained(root: string, key: string, reference?: string): Promise<string> {
  if (!key || isAbsolute(key) || key.includes("\\") || key.includes(":" ) || key.includes("%") ||
      key.split("/").some((part) => !part || part === "." || part === "..")) refuse("unsafe_path", reference);
  try {
    const canonicalRoot = await fs.realpath(root);
    const target = await fs.realpath(resolve(canonicalRoot, key));
    if (!target.startsWith(canonicalRoot + sep)) refuse("unsafe_path", reference);
    return target;
  } catch (error) {
    if (error instanceof CatalogMediaSourcePackError) throw error;
    return refuse("missing_resource", reference);
  }
}
/** Open only contained regular files, allocate a fixed bound and read at most limit + 1. */
async function boundedRead(path: string, limit: number, reference?: string): Promise<Buffer> {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => refuse("missing_resource", reference));
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) refuse("unsafe_path", reference);
    if (stat.size > limit) refuse("pack_limit_exceeded", reference);
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(bytes, length, bytes.length - length, null);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > limit) refuse("pack_limit_exceeded", reference);
    return bytes.subarray(0, length);
  } finally { await handle.close(); }
}
function matchesMime(bytes: Buffer, mime: string): boolean {
  if (mime === "image/png") return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg") return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP" && bytes.readUInt32LE(4) + 8 === bytes.length &&
    ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16));
}
async function loadResources(manifest: ProductMediaManifest, root: string): Promise<Map<string, Buffer>> {
  const paths = new Map<string, string>();
  // Stat every resource before reading any payload; declared and actual totals are bounded.
  for (const asset of manifest.assets) {
    const path = await contained(root, asset.source, asset.assetRef);
    const stat = await fs.stat(path);
    if (!stat.isFile()) refuse("unsafe_path", asset.assetRef);
    if (stat.size > SOURCE_PACK_LIMITS.imageBytes) refuse("pack_limit_exceeded", asset.assetRef);
    if (stat.size !== asset.byteLength) refuse("size_mismatch", asset.assetRef);
    paths.set(asset.assetRef, path);
  }
  const resources = new Map<string, Buffer>();
  for (const asset of manifest.assets) {
    const bytes = await boundedRead(paths.get(asset.assetRef)!, asset.byteLength, asset.assetRef);
    if (bytes.length !== asset.byteLength) refuse("size_mismatch", asset.assetRef);
    if (!matchesMime(bytes, asset.contentType)) refuse("mime_mismatch", asset.assetRef);
    if (digest(bytes) !== asset.sha256) refuse("digest_mismatch", asset.assetRef);
    resources.set(asset.assetRef, bytes);
  }
  return resources;
}

export async function readCatalogMediaSourceManifest(path: string): Promise<unknown> {
  const bytes = await boundedRead(path, SOURCE_PACK_LIMITS.manifestBytes);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return refuse("invalid_schema"); }
}
async function checkInventory(root: string, manifest: ProductMediaManifest) {
  const expected = new Set(manifest.assets.map((asset) => keyFor(asset).slice(7)));
  const rootEntries = await fs.opendir(root);
  let rootCount = 0;
  for await (const entry of rootEntries) {
    if (++rootCount > 2 || !["assets", "manifest.json"].includes(entry.name)) refuse("reference_mismatch");
  }
  const assetRoot = await contained(root, "assets");
  const entries = await fs.opendir(assetRoot);
  let count = 0;
  for await (const entry of entries) {
    if (++count > SOURCE_PACK_LIMITS.assets) refuse("pack_limit_exceeded");
    if (!expected.delete(entry.name)) refuse("reference_mismatch");
  }
  if (expected.size) refuse("missing_resource");
}
export async function validateCatalogMediaSourcePack(root: string) {
  const input = await readCatalogMediaSourceManifest(await contained(root, "manifest.json"));
  if (!input || typeof input !== "object" || (input as CatalogMediaSourcePack).schemaVersion !== "catalog.media-source-pack.v1") return refuse("invalid_schema");
  if (Object.keys(input).some((key) => !["schemaVersion", "manifest"].includes(key))) refuse("invalid_schema");
  const manifest = checkedManifest((input as CatalogMediaSourcePack).manifest);
  for (const asset of manifest.assets) if (asset.source !== keyFor(asset)) refuse("unsafe_path", asset.assetRef);
  await checkInventory(root, manifest);
  const resources = await loadResources(manifest, root);
  return { pack: { schemaVersion: "catalog.media-source-pack.v1", manifest } as CatalogMediaSourcePack, resources };
}
async function writeNewPack(pack: CatalogMediaSourcePack, resources: Map<string, Buffer>, targetRoot: string) {
  const encoded = JSON.stringify(pack, null, 2) + "\n";
  if (Buffer.byteLength(encoded) > SOURCE_PACK_LIMITS.manifestBytes) refuse("pack_limit_exceeded");
  // mkdir without recursive is the atomic no-overwrite boundary.
  await fs.mkdir(targetRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "EEXIST") refuse("target_exists");
    refuse("dependency_unavailable");
  });
  const root = await fs.realpath(targetRoot);
  await fs.mkdir(resolve(root, "assets"));
  const written = new Set<string>();
  for (const asset of pack.manifest.assets) {
    if (written.has(asset.source)) continue;
    await fs.writeFile(resolve(root, asset.source), resources.get(asset.assetRef)!, { flag: "wx" });
    written.add(asset.source);
  }
  await fs.writeFile(resolve(root, "manifest.json"), encoded, { flag: "wx" });
  return pack;
}
export async function exportCatalogMediaSourcePack(options: { manifest: unknown; sourceRoot: string; targetRoot: string }) {
  const manifest = checkedManifest(options.manifest);
  const resources = await loadResources(manifest, options.sourceRoot);
  const portable = { ...manifest, assets: manifest.assets.map((asset) => ({ ...asset, source: keyFor(asset) })) };
  return writeNewPack({ schemaVersion: "catalog.media-source-pack.v1", manifest: portable }, resources, options.targetRoot);
}
export async function restoreCatalogMediaSourcePack(packRoot: string, targetRoot: string) {
  const { pack, resources } = await validateCatalogMediaSourcePack(packRoot);
  return writeNewPack(pack, resources, targetRoot);
}
export type CatalogMediaImportOutcome =
  | { status: "complete"; successfulKeys: string[]; assets: Array<{ assetRef: string; key: string; url: string }> }
  | { status: "validation_refusal"; code: string; reference?: string }
  | { status: "dependency_unavailable" | "partial_upload"; successfulKeys: string[]; failedAssetRef: string; failedKey: string };
export async function importCatalogMediaSourcePack(root: string, storage: BlobStoragePort): Promise<CatalogMediaImportOutcome> {
  let validated: Awaited<ReturnType<typeof validateCatalogMediaSourcePack>>;
  try { validated = await validateCatalogMediaSourcePack(root); }
  catch (error) {
    const refusal = error as { code?: string; reference?: string };
    return { status: "validation_refusal", code: refusal.code ?? "invalid_schema", ...(refusal.reference ? { reference: refusal.reference } : {}) };
  }
  const successfulKeys: string[] = [];
  const assets: Array<{ assetRef: string; key: string; url: string }> = [];
  const urlsByKey = new Map<string, string>();
  for (const asset of validated.pack.manifest.assets) {
    const key = keyFor(asset);
    try {
      if (!urlsByKey.has(key)) {
        const result = await storage.upload(key, validated.resources.get(asset.assetRef)!, { contentType: asset.contentType });
        if (result.pathname !== key) refuse("storage_path_mismatch", asset.assetRef);
        successfulKeys.push(key);
        urlsByKey.set(key, storage.urlFor(key));
      }
      assets.push({ assetRef: asset.assetRef, key, url: urlsByKey.get(key)! });
    } catch {
      return { status: successfulKeys.length ? "partial_upload" : "dependency_unavailable", successfulKeys, failedAssetRef: asset.assetRef, failedKey: key };
    }
  }
  return { status: "complete", successfulKeys, assets };
}
