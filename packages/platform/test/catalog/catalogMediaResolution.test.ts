import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportCatalogMediaSourcePack, importCatalogMediaSourcePack, validateCatalogMediaSourcePack } from "../../src/catalog/mediaSourcePack.js";
import { PRODUCT_MEDIA_LIMITS, validateProductMediaManifest, validateProductMediaSourcePath, type ProductMediaManifest } from "../../src/catalog/contracts/productMediaContracts.js";
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

// Overlapping media census sites share this complete source/resolve matrix.
it.each(["W42_V5-0031_predicate_precedence_boundary", "W42_V5-0032_predicate_precedence_boundary", "W42_V5-0033_predicate_precedence_boundary", "W42_V5-0034_predicate_precedence_boundary", "W42_V5-0035_predicate_precedence_boundary", "W42_V5-0036_predicate_precedence_boundary", "W42_V5-0037_predicate_precedence_boundary", "W42_V5-0038_predicate_precedence_boundary", "W42_V5-0039_predicate_precedence_boundary", "W42_V5-0040_predicate_precedence_boundary", "W42_V5-0041_predicate_precedence_boundary", "W42_V5-0042_predicate_precedence_boundary", "W42_V5-0043_predicate_precedence_boundary", "W42_V5-0044_predicate_precedence_boundary", "W42_V5-0045_predicate_precedence_boundary", "W42_V5-0046_predicate_precedence_boundary", "W42_V5-0047_predicate_precedence_boundary", "W42_V5-0048_predicate_precedence_boundary", "W42_V5-0049_predicate_precedence_boundary", "W42_V5-0050_predicate_precedence_boundary", "W42_V5-0051_predicate_precedence_boundary", "W42_V5-0052_predicate_precedence_boundary", "W42_V5-0053_predicate_precedence_boundary", "W42_V5-0054_predicate_precedence_boundary", "W42_V5-0055_predicate_precedence_boundary", "W42_V5-0056_predicate_precedence_boundary", "W42_V5-0057_predicate_precedence_boundary", "W42_V5-0058_predicate_precedence_boundary", "W42_V5-0059_predicate_precedence_boundary", "W42_V5-0060_predicate_precedence_boundary", "W42_V5-0061_predicate_precedence_boundary", "W42_V5-0065_predicate_precedence_boundary", "W42_V5-0066_predicate_precedence_boundary", "W42_V5-0067_predicate_precedence_boundary", "W42_V5-0068_predicate_precedence_boundary", "W42_V5-0069_predicate_precedence_boundary", "W42_V5-0070_predicate_precedence_boundary", "W42_V5-0071_predicate_precedence_boundary", "W42_V5-0072_predicate_precedence_boundary", "W42_V5-0073_predicate_precedence_boundary", "W42_V5-0074_predicate_precedence_boundary", "W42_V5-0075_predicate_precedence_boundary", "W42_V5-0076_predicate_precedence_boundary", "W42_V5-0077_predicate_precedence_boundary", "W42_V5-0078_predicate_precedence_boundary", "W42_V5-0079_predicate_precedence_boundary", "W42_V5-0080_predicate_precedence_boundary", "W42_V5-0081_predicate_precedence_boundary", "W42_V5-0082_predicate_precedence_boundary", "W42_V5-0083_predicate_precedence_boundary", "W42_V5-0121_predicate_precedence_boundary", "W42_V5-0122_predicate_precedence_boundary", "W42_V5-0123_predicate_precedence_boundary", "W42_V5-0124_predicate_precedence_boundary", "W42_V5-0125_predicate_precedence_boundary", "W42_V5-0126_predicate_precedence_boundary", "W42_V5-0127_predicate_precedence_boundary", "W42_V5-0128_predicate_precedence_boundary", "W42_V5-0129_predicate_precedence_boundary", "W42_V5-0130_predicate_precedence_boundary", "W42_V5-0131_predicate_precedence_boundary", "W42_V5-0132_predicate_precedence_boundary", "W42_V5-0133_predicate_precedence_boundary", "W42_V5-0134_predicate_precedence_boundary", "W42_V5-0135_predicate_precedence_boundary", "W42_V5-0136_predicate_precedence_boundary", "W42_V5-0137_predicate_precedence_boundary", "W42_V5-0138_predicate_precedence_boundary", "W42_V5-0139_predicate_precedence_boundary", "W42_V5-0140_predicate_precedence_boundary", "W42_V5-0141_predicate_precedence_boundary", "W42_V5-0142_predicate_precedence_boundary", "W42_V5-0143_predicate_precedence_boundary", "W42_V5-0144_predicate_precedence_boundary", "W42_V5-0145_predicate_precedence_boundary", "W42_V5-0146_predicate_precedence_boundary", "W42_V5-0147_predicate_precedence_boundary", "W42_V5-0148_predicate_precedence_boundary", "W42_V5-0149_predicate_precedence_boundary", "W42_V5-0150_predicate_precedence_boundary", "W42_V5-0151_predicate_precedence_boundary", "W42_V5-0152_predicate_precedence_boundary", "W42_V5-0153_predicate_precedence_boundary", "W42_V5-0154_predicate_precedence_boundary", "W42_V5-0155_predicate_precedence_boundary", "W42_V5-0156_predicate_precedence_boundary", "W42_V5-0157_predicate_precedence_boundary", "W42_V5-0158_predicate_precedence_boundary", "W42_V5-0159_predicate_precedence_boundary", "W42_V5-0160_predicate_precedence_boundary"])("%s", async () => {
  const valid = manifest(), altered = (path: string, value: unknown) => {
    const copy = structuredClone(valid) as unknown as Record<string, unknown>, parts = path.split("."); let parent = copy;
    for (const key of parts.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
    parent[parts.at(-1)!] = value; return copy;
  };
  for (const [path, values] of [
    ["schemaVersion", [2]], ["assets", [null, {}, Array(PRODUCT_MEDIA_LIMITS.assets + 1).fill(valid.assets[0])]],
    ["products", [null, Array(PRODUCT_MEDIA_LIMITS.products + 1).fill(valid.products[0])]],
    ["associations", [null, Array(PRODUCT_MEDIA_LIMITS.associations + 1).fill(valid.associations[0])]],
    ["assets.0.assetRef", ["", "a\n", "a".repeat(257), null]], ["assets.0.contentType", ["image/svg+xml"]],
    ["assets.0.sha256", ["A".repeat(64), "bad"]], ["assets.0.byteLength", [0, -1, 1.5, PRODUCT_MEDIA_LIMITS.imageBytes + 1]],
    ["assets.0.artworkLocale", ["", "a".repeat(65)]], ["products.0.primaryVariantId", ["missing"]],
    ["products.0.variantIds", [["standard", "standard"], ["standard", ""]]],
    ["associations.0.assetRef", ["missing"]], ["associations.0.productId", ["missing"]],
    ["associations.0.scope", ["unknown"]], ["associations.0.variantId", ["missing"]],
    ["associations.0.role", ["unknown"]], ["associations.0.locale", ["", "a".repeat(65)]],
    ["associations.0.order", [0.5]], ["associations.0.label", ["", "a".repeat(1025)]],
    ["associations.0.viewKey", [""]],
  ] as [string, unknown[]][]) for (const value of values) expect(() => validateProductMediaManifest(altered(path, value))).toThrow();
  for (const extra of [{ ...valid, unexpected: true }, { ...valid, assets: [...valid.assets, valid.assets[0]] },
    { ...valid, products: [...valid.products, valid.products[0]] }, { ...valid, associations: [...valid.associations, valid.associations[0]] },
    { ...valid, associations: valid.associations.slice(1) },
    altered("associations.2.variantId", "standard"), altered("assets.0.extra", true), altered("products.0.extra", true), altered("associations.0.extra", true)])
    expect(() => validateProductMediaManifest(extra)).toThrow();
  for (const source of ["/absolute.png", "../escape.png", "a/../b.png", "a//b", "a/./b", "a\\b", "a%20b", "https://example.invalid/a", "a?b", "a#b"])
    expect(() => validateProductMediaSourcePath(source)).toThrow("unsafe_path");
  expect(validateProductMediaSourcePath("nested/image.png")).toBe("nested/image.png");
  expect(() => resolveProductMedia(valid, { ...selected, locale: "" }, expectedUrls)).toThrow("invalid_schema");
  expect(() => resolveProductMedia(valid, { ...selected, variantId: "absent" }, expectedUrls)).toThrow("undeclared_variant");
  for (const url of ["javascript:alert(1)", "data:image/png,a", " https://example.invalid/a", "https://example.invalid/a\n"])
    expect(() => resolveProductMedia(valid, selected, { ...expectedUrls, translated: url })).toThrow("unsafe_path");
  expect(() => resolveProductMedia(valid, selected, {})).toThrow("missing_resource");
  const competing = { ...valid, associations: [...valid.associations, { ...valid.associations[2], itemId: "second-cover", role: "primary" as const }] };
  expect(() => resolveProductMedia(competing, selected, expectedUrls)).toThrow("conflicting_primary");
  const wide = { ...valid, assets: Array.from({ length: 33 }, (_, i) => ({ ...valid.assets[0], assetRef: `asset-${i}` })),
    associations: Array.from({ length: 33 }, (_, i) => ({ ...valid.associations[2], itemId: `item-${i}`, assetRef: `asset-${i}` })) };
  expect(() => resolveProductMedia(wide, selected, Object.fromEntries(wide.assets.map(a => [a.assetRef, "/image.png"])))).toThrow("collection_limit_exceeded");
  const resolved = resolveProductMedia(valid, selected, expectedUrls);
  expect(resolveProductMedia({ ...valid, associations: [...valid.associations].reverse(), assets: [...valid.assets].reverse() }, selected, expectedUrls)).toEqual(resolved);
  expect(resolveProductMedia(valid, selected, { ...expectedUrls, translated: "/changed.png" }).revision).not.toBe(resolved.revision);
  const packRoot = join(root, "complete"), pack = await exportCatalogMediaSourcePack({ manifest: valid, sourceRoot: root, targetRoot: packRoot });
  await expect(exportCatalogMediaSourcePack({ manifest: valid, sourceRoot: root, targetRoot: packRoot })).rejects.toMatchObject({ code: "target_exists" });
  expect((await validateCatalogMediaSourcePack(packRoot)).resources.size).toBe(4);
  const target = storage(), manifestPath = join(packRoot, "manifest.json"), resourcePath = join(packRoot, pack.manifest.assets[0].source);
  for (const body of [Buffer.from([255]), Buffer.from("{"), Buffer.from(JSON.stringify({ ...pack, schemaVersion: "unknown" })), Buffer.from(JSON.stringify({ ...pack, extra: true }))]) {
    await fs.writeFile(manifestPath, body); expect(await importCatalogMediaSourcePack(packRoot, target)).toMatchObject({ status: "validation_refusal", code: "invalid_schema" });
  }
  await fs.writeFile(manifestPath, JSON.stringify(pack));
  await fs.writeFile(join(packRoot, "unexpected"), "extra");
  expect(await importCatalogMediaSourcePack(packRoot, target)).toMatchObject({ status: "validation_refusal", code: "reference_mismatch" });
  await fs.rm(join(packRoot, "unexpected"));
  for (const [bytes, code] of [[Buffer.from([1]), "size_mismatch"], [Buffer.alloc(resources[0].bytes.length), "mime_mismatch"],
    [Buffer.concat([resources[0].bytes.subarray(0, -1), Buffer.from([241])]), "digest_mismatch"]] as const) {
    await fs.writeFile(resourcePath, bytes); expect(await importCatalogMediaSourcePack(packRoot, target)).toMatchObject({ status: "validation_refusal", code });
  }
  await fs.rm(resourcePath); await fs.symlink(join(root, "panel.png"), resourcePath);
  expect(await importCatalogMediaSourcePack(packRoot, target)).toMatchObject({ status: "validation_refusal", code: "unsafe_path" });
  await fs.rm(resourcePath); await fs.mkdir(resourcePath);
  expect(await importCatalogMediaSourcePack(packRoot, target)).toMatchObject({ status: "validation_refusal", code: "unsafe_path" });
  await fs.rm(resourcePath, { recursive: true });
  expect(await importCatalogMediaSourcePack(packRoot, target)).toMatchObject({ status: "validation_refusal", code: "missing_resource" });
  expect(target.upload).not.toHaveBeenCalled();
});
