import { build } from "esbuild";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["marketing", "marketing/contracts"].flatMap(entry =>
  ["src", "dist"].map(tree => ({ entry, tree })),
))("bundles the complete $tree/$entry entry without server or Node imports", async ({ entry, tree }) => {
  const result = await build({
    entryPoints: [fileURLToPath(new URL(`../../${tree}/${entry}/index.${tree === "src" ? "ts" : "js"}`, import.meta.url))],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true, treeShaking: false,
  });
  const imports = Object.values(result.metafile.inputs).flatMap(input => input.imports);
  expect(imports.filter(input => input.external || input.path.startsWith("node:") || builtinModules.includes(input.path))).toEqual([]);
  expect(Object.keys(result.metafile.inputs).filter(path => /(?:^|\/)server\//.test(path))).toEqual([]);
  expect(result.outputFiles).toHaveLength(1);
  if (entry === "marketing/contracts") {
    expect(Object.keys(result.metafile.inputs).filter(path => /(?:zod|acquisitionCaseSchemas|acquisitionEvidenceSchemas|prelaunchAcquisitionSchemas)/.test(path))).toEqual([]);
  }
});
