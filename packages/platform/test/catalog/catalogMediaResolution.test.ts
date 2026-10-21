import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportCatalogMediaSourcePack, importCatalogMediaSourcePack, validateCatalogMediaSourcePack } from "../../src/catalog/mediaSourcePack.js";
import { PRODUCT_MEDIA_LIMITS, type ProductMediaManifest } from "../../src/catalog/contracts/productMediaContracts.js";
import { resolveProductMedia } from "../../src/catalog/contracts/resolveProductMedia.js";

// Fresh, distinguishable synthetic resources; only the signature is image-shaped.
const resources = ["panel", "translated", "edge"].map((assetRef, index) => {
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 83, 41, 170, 20 + index]);
  return { assetRef, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
});
const assetResources = [...resources, { ...resources[2]!, assetRef: "mirror" }];
const expectedUrls = Object.fromEntries(assetResources.map(({ assetRef, sha256 }) => [assetRef, `https://media.example.com/assets/${sha256}.png`]));
const selected = { productId: "display-unit", variantId: "standard", locale: "qab" };
function manifest(): ProductMediaManifest {
  return {
    schemaVersion: 1,
    products: [{ productId: selected.productId, variantIds: ["standard", "compact"], primaryVariantId: "standard" }],
    assets: assetResources.map(({ assetRef, bytes, sha256 }) => ({ assetRef, source: `${assetRef}.png`, contentType: "image/png", byteLength: bytes.length, sha256, artworkLocale: null })),
    associations: [
      { itemId: "cover", assetRef: "panel", productId: selected.productId, scope: "variant", variantId: "standard", locale: null, role: "primary", order: 0, label: "Cover" },
      { itemId: "cover", assetRef: "translated", productId: selected.productId, scope: "variant", variantId: "standard", locale: "qab", role: "primary", order: 0, label: "Localized cover" },
      { itemId: "edge", assetRef: "edge", productId: selected.productId, scope: "product", locale: null, role: "view", order: 2, label: "Edge" },
      { itemId: "mirror", assetRef: "mirror", productId: selected.productId, scope: "product", locale: null, role: "illustration", order: 3, label: "Detail" },
    ],
  };
}
const storage = () => ({
  upload: vi.fn(async (pathname: string) => ({ pathname, url: "https://ignored.example/unused" })),
  urlFor: (key: string) => `https://media.example.com/${key}`,
  exists: vi.fn(), delete: vi.fn(), list: vi.fn(),
});
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), "catalog-media-conformance-"));
  await Promise.all(assetResources.map(({ assetRef, bytes }) => fs.writeFile(join(root, `${assetRef}.png`), bytes)));
});
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });

describe("catalog media source-pack conformance (W8)", () => {
  it("preserves exact per-ref immutable URLs for distinct bytes and uploads a shared key once", async () => {
    const packRoot = join(root, "pack");
    const pack = await exportCatalogMediaSourcePack({ manifest: manifest(), sourceRoot: root, targetRoot: packRoot });
    const validated = await validateCatalogMediaSourcePack(packRoot);
    expect(validated.resources.size).toBe(4);
    const target = storage();
    const result = await importCatalogMediaSourcePack(packRoot, target);
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected complete");
    expect(Object.fromEntries(result.assets.map(({ assetRef, url }) => [assetRef, url]))).toEqual(expectedUrls);
    expect(new Set(result.assets.map(({ url }) => url)).size).toBe(3);
    expect(result.successfulKeys).toEqual(resources.map(({ sha256 }) => `assets/${sha256}.png`));
    expect(target.upload).toHaveBeenCalledTimes(3);
    resources.forEach(({ sha256, bytes }, index) => {
      expect(target.upload).toHaveBeenNthCalledWith(index + 1, `assets/${sha256}.png`, bytes, { contentType: "image/png" });
    });
    expect(pack.manifest.assets.map(({ source }) => source)).toEqual(assetResources.map(({ sha256 }) => `assets/${sha256}.png`));
  });

  it("keeps locale, variant, order and revision deterministic with neutral fallback", () => {
    const source = manifest();
    const resolved = resolveProductMedia(source, selected, expectedUrls);
    expect(resolved.items.map(({ id, assetRef, src }) => [id, assetRef, src])).toEqual([
      ["cover", "translated", expectedUrls.translated], ["edge", "edge", expectedUrls.edge], ["mirror", "mirror", expectedUrls.mirror],
    ]);
    expect(resolved.primaryItemId).toBe("cover");
    expect(resolveProductMedia({ ...source, assets: [...source.assets].reverse(), products: source.products.map(p => ({ ...p, variantIds: [...p.variantIds].reverse() })), associations: [...source.associations].reverse() }, selected, expectedUrls)).toEqual(resolved);
    expect(resolveProductMedia(source, { ...selected, locale: "qac" }, expectedUrls).items.map(({ assetRef }) => assetRef)).toEqual(["panel", "edge", "mirror"]);
    expect(resolveProductMedia(source, { ...selected, variantId: "compact" }, expectedUrls)).toMatchObject({ primaryItemId: null, items: [expect.objectContaining({ assetRef: "edge" }), expect.objectContaining({ assetRef: "mirror" })] });
  });

  it("permits optional absence and refuses invalid variants, refs, bounds and changed digests before upload", async () => {
    const empty = { ...manifest(), assets: [], associations: [] };
    expect(resolveProductMedia(empty, selected, {})).toMatchObject({ items: [], primaryItemId: null });
    expect(() => resolveProductMedia(empty, { ...selected, variantId: "unknown" }, {})).toThrow("undeclared_variant");
    const packRoot = join(root, "pack");
    const pack = await exportCatalogMediaSourcePack({ manifest: manifest(), sourceRoot: root, targetRoot: packRoot });
    const target = storage();
    const invalidVariants = { ...pack.manifest, associations: pack.manifest.associations.map((a, index) => index === 0 ? { ...a, variantId: "unknown" } : a) };
    const dangling = { ...pack.manifest, associations: pack.manifest.associations.map((a, index) => index === 0 ? { ...a, assetRef: "missing" } : a) };
    const oversized = { ...pack.manifest, assets: pack.manifest.assets.map((a, index) => index === 0 ? { ...a, byteLength: PRODUCT_MEDIA_LIMITS.imageBytes + 1 } : a) };
    for (const [invalid, code] of [[invalidVariants, "undeclared_variant"], [dangling, "missing_resource"], [oversized, "pack_limit_exceeded"]] as const) {
      await fs.writeFile(join(packRoot, "manifest.json"), JSON.stringify({ ...pack, manifest: invalid }));
      expect(await importCatalogMediaSourcePack(packRoot, target)).toMatchObject({ status: "validation_refusal", code });
      expect(target.upload).not.toHaveBeenCalled();
    }
    await fs.writeFile(join(packRoot, "manifest.json"), JSON.stringify(pack));
    await fs.writeFile(join(packRoot, pack.manifest.assets[0]!.source), Buffer.concat([resources[0]!.bytes.subarray(0, -1), Buffer.from([241])]));
    expect(await importCatalogMediaSourcePack(packRoot, target)).toMatchObject({ status: "validation_refusal", code: "digest_mismatch" });
    expect(target.upload).not.toHaveBeenCalled();
  });
});
