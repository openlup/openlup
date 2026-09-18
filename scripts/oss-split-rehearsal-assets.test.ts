// This measures the ASSET STAGE, not the repository. Every input is synthetic: made-up importers,
// made-up specifiers, a made-up published tree. The fixtures name no path this repository withholds.

import { describe, expect, it } from "vitest";

import { ASSET_EXTENSIONS, assetEdges, assetTarget, isAssetSpecifier } from "./oss-split-rehearsal-assets.ts";

const tree = (paths: string[]) => (path: string) => paths.includes(path);

describe("asset specifiers", () => {
  it("recognises an asset by extension and ignores a module", () => {
    expect(isAssetSpecifier("./art.png")).toBe(true);
    expect(isAssetSpecifier("./art.png?url")).toBe(true);
    expect(isAssetSpecifier("./art.PNG")).toBe(true);
    expect(isAssetSpecifier("./model.ts")).toBe(false);
    expect(isAssetSpecifier("react")).toBe(false);
  });

  it("covers every extension it claims to cover", () => {
    for (const extension of ASSET_EXTENSIONS) expect(isAssetSpecifier(`./file${extension}`)).toBe(true);
  });

  it("resolves the three address forms and refuses a bare specifier", () => {
    expect(assetTarget("alpha/one.tsx", "@/art/logo.svg")).toBe("src/art/logo.svg");
    expect(assetTarget("alpha/one.tsx", "./nested/logo.svg")).toBe("alpha/nested/logo.svg");
    expect(assetTarget("alpha/one.tsx", "/served/logo.svg")).toBe("public/served/logo.svg");
    expect(assetTarget("alpha/one.tsx", "some-package/logo.svg")).toBeNull();
  });
});

describe("asset edges over a published tree", () => {
  // The extensions are spelled at runtime, and the placeholder is not itself an extension: the
  // recogniser is case-insensitive, so a fixture that only shouted its extension would still be
  // counted by the very stage it is testing - the same trap the module stage's fixtures avoid by
  // naming no withheld route.
  const source = [
    'import logo from "./kept.ASSET_SVG";',
    'import missing from "./gone.ASSET_SVG";',
    'import "./also-gone.ASSET_WEBP";',
    'const late = await import("./gone.ASSET_SVG");',
    'const url = new URL("./third.ASSET_PNG", import.meta.url);',
    'import model from "./model.ts";',
  ].join("\n").replace(/\.ASSET_SVG/g, ".svg").replace(/\.ASSET_WEBP/g, ".webp").replace(/\.ASSET_PNG/g, ".png");

  it("counts only specifiers the published tree cannot answer, once per pair", () => {
    const { pairs, specifiers } = assetEdges(["alpha/one.tsx"], () => source, tree(["alpha/one.tsx", "alpha/kept.svg"]));
    expect(pairs).toEqual([
      "alpha/one.tsx -> alpha/also-gone.webp",
      "alpha/one.tsx -> alpha/gone.svg",
      "alpha/one.tsx -> alpha/third.png",
    ]);
    expect(specifiers).toBe(5);
  });

  it("reads only files that can carry a specifier", () => {
    const md = 'import "./x.ASSET_PNG";'.replace(".ASSET_PNG", ".png");
    const { pairs } = assetEdges(["alpha/one.tsx", "alpha/notes.md"], (path) => (path.endsWith(".md") ? md : source), tree([]));
    expect(pairs.every((pair) => pair.startsWith("alpha/one.tsx"))).toBe(true);
  });

  it("is fatal when the extraction finds nothing, rather than reporting no debt", () => {
    expect(() => assetEdges(["alpha/one.tsx"], () => "export const x = 1;", tree([]))).toThrow(/extraction is dead/);
  });
});
