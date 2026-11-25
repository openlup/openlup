import { build } from "esbuild";
import { builtinModules } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it.each(["src", "dist"])("bundles the complete %s/storefront entry for browsers with only its own files", async (tree) => {
  const directory = fileURLToPath(new URL(`../../${tree}/storefront/`, import.meta.url));
  const result = await build({
    entryPoints: [resolve(directory, `index.${tree === "src" ? "ts" : "js"}`)],
    bundle: true, platform: "browser", format: "esm", write: false, metafile: true, treeShaking: false,
  });
  const imports = Object.values(result.metafile.inputs).flatMap(input => input.imports);
  expect(imports.filter(input => input.external || input.path.startsWith("node:") || builtinModules.includes(input.path))).toEqual([]);
  // Every bundled input is a file directly in the entry's directory: no subdirectory, no other module.
  const outside = Object.keys(result.metafile.inputs)
    .map(path => resolve(path))
    .filter(path => dirname(path) !== resolve(directory))
    .map(path => relative(directory, path));
  expect(outside).toEqual([]);
  expect(result.outputFiles).toHaveLength(1);
});
