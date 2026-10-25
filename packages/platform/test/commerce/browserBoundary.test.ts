import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import * as server from "../../src/commerce/server/index.js";
import * as commerce from "@openlup/platform/commerce";

it.each(["commerce", "commerce/contracts", "pricing/browser"].flatMap(entry =>
  ["src", "dist"].map(tree => ({ entry, tree })),
))("bundles the complete $tree/$entry entry for browsers without Node imports", async ({ entry, tree }) => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../../${tree}/${entry}/index.${tree === "src" ? "ts" : "js"}`, import.meta.url))],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true, treeShaking: false,
  });
  const imports = Object.values(result.metafile.inputs).flatMap(input => input.imports);
  expect(imports.filter(input => input.external || input.path.startsWith("node:") || builtinModules.includes(input.path))).toEqual([]);
  expect(Object.keys(result.metafile.inputs).some(path => /commerce\/server\//.test(path))).toBe(false);
  expect(Object.keys(result.metafile.inputs).some(path => /pricing\/index\.(?:ts|js)$/.test(path))).toBe(false);
  expect(result.outputFiles).toHaveLength(1);
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const closure = Object.keys(result.metafile.inputs).map(path => relative(root, resolve(path)).replaceAll("\\", "/"))
    .filter(path => path.startsWith("packages/platform/"))
    .map(path => path.replace("/src/", "/dist/").replace(/\.ts$/, ".js"));
  for (const profile of ["identity", "subscription"]) {
    const { files } = JSON.parse(readFileSync(new URL(`../../../../config/public-reference-${profile}-imports.json`, import.meta.url), "utf8")) as { files: string[] };
    expect(files).toEqual(expect.arrayContaining(closure));
  }
});

it("exposes OMS handlers only through the server entry", () => {
  expect(server.createAdminCommerceOrdersListHandler).toBeTypeOf("function");
  expect(commerce).not.toHaveProperty("createAdminCommerceOrdersListHandler");
});

it("exposes checkout compensation only through the server entry", () => {
  expect(server.tryCompensate).toBeTypeOf("function");
  expect(commerce).not.toHaveProperty("tryCompensate");
});

it("exposes the checkout engine only through the server entry", () => {
  for (const name of ["createCommerceCheckoutHandler", "createCommerceRuntimeService", "createPaidOrderOrchestration"]) {
    expect(server).toHaveProperty(name, expect.any(Function));
    expect(commerce).not.toHaveProperty(name);
  }
});

it("exposes exactly the five existing pricing browser symbols with their original identity", async () => {
  const browser = await import("../../src/pricing/browser/index.js");
  const primitives = await import("../../src/pricing/quotePrimitives.js");
  const acquisition = await import("../../src/pricing/acquisitionTermsSchemas.js");
  const shipping = await import("../../src/shipping/thresholdPolicy.js");
  expect(Object.keys(browser).sort()).toEqual([
    "acquisitionCapabilitySchema", "acquisitionTermsExpectationSchema", "createCommerceQuotePrimitives",
    "resolvedAcquisitionTermsSchema", "shippingTermsSchema",
  ]);
  expect(browser.createCommerceQuotePrimitives).toBe(primitives.createCommerceQuotePrimitives);
  expect(browser.acquisitionCapabilitySchema).toBe(acquisition.acquisitionCapabilitySchema);
  expect(browser.acquisitionTermsExpectationSchema).toBe(acquisition.acquisitionTermsExpectationSchema);
  expect(browser.resolvedAcquisitionTermsSchema).toBe(acquisition.resolvedAcquisitionTermsSchema);
  expect(browser.shippingTermsSchema).toBe(shipping.shippingTermsSchema);
});

it("admits exactly the built pricing browser closure without its server root", async () => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../../dist/pricing/browser/index.js", import.meta.url))],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true, treeShaking: false,
  });
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const closure = Object.keys(result.metafile.inputs).map(path => relative(root, resolve(path)).replaceAll("\\", "/"))
    .filter(path => path.startsWith("packages/platform/")).sort();
  expect(closure).toEqual([
    "packages/platform/dist/pricing/acquisitionTermsSchemas.js",
    "packages/platform/dist/pricing/browser/index.js",
    "packages/platform/dist/pricing/contracts/acquisitionTerms.js",
    "packages/platform/dist/pricing/quotePrimitives.js",
    "packages/platform/dist/shipping/thresholdPolicy.js",
  ]);
  for (const profile of ["identity", "subscription"]) {
    const { files } = JSON.parse(readFileSync(new URL(`../../../../config/public-reference-${profile}-imports.json`, import.meta.url), "utf8")) as { files: string[] };
    expect(files).toEqual(expect.arrayContaining(closure));
    expect(files).not.toContain("packages/platform/dist/pricing/index.js");
    expect(files).not.toContain("packages/platform/dist/commerce/server/index.js");
  }
});

it("bundles the built commerce entry and its complete module graph for browsers", async () => {
  const result = await build({ entryPoints: [fileURLToPath(new URL("../../dist/commerce/index.js", import.meta.url))], bundle: true, platform: "browser", format: "esm", treeShaking: false, write: false, metafile: true, logLevel: "silent" });
  expect(result.outputFiles[0]!.text).not.toMatch(/(?:from|import\s*\(|require\s*\()\s*["']node:/);
  expect(Object.keys(result.metafile!.inputs).filter(path => /commerce\/(?:server|adapters)\/|platform\/dist\/(?:pricing|shipping)\/index\.js$/.test(path))).toEqual([]);
});

it("keeps locale label helpers and tables out of the commerce runtime export list", () => {
  const names = Object.keys(commerce);
  expect(names).not.toContain("timelineLabelForStep");
  expect(names).not.toContain("FULFILLMENT_STATUS_MAP");
});
