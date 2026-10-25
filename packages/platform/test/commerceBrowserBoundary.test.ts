import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const commerceRoot = join(packageRoot, "src/commerce");
function browserSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "server" ? [] : browserSources(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("commerce browser entry boundary", () => {
  it("bundles the published commerce entry for a browser without Node builtins or the server entry", async () => {
    const result = await build({
      absWorkingDir: packageRoot, entryPoints: ["@openlup/platform/commerce"],
      platform: "browser", bundle: true, write: false, metafile: true, format: "esm",
    });
    const inputs = Object.entries(result.metafile!.inputs);
    expect(inputs.length).toBeGreaterThan(10);
    expect(inputs.filter(([path]) => /(?:^|\/)commerce\/server\//.test(path))).toEqual([]);
    expect(inputs.flatMap(([, input]) => input.imports).filter(({ path }) => path.startsWith("node:"))).toEqual([]);
    expect(result.outputFiles[0]!.text).not.toMatch(/(?:from\s*|import\s*\(|require\s*\()\s*["']node:/);
  });

  it("has no source import of commerce/server, including erased type imports", () => {
    const files = browserSources(commerceRoot);
    expect(files.length).toBeGreaterThan(10);
    for (const path of files) {
      const source = readFileSync(path, "utf8");
      const imports = ts.preProcessFile(source, true, true).importedFiles;
      for (const { fileName } of imports) {
        const target = fileName.startsWith(".") ? relative(commerceRoot, resolve(dirname(path), fileName)).replaceAll("\\", "/") : fileName;
        expect(target, `${relative(commerceRoot, path)} imports ${fileName}`).not.toMatch(/^(?:server\/|@openlup\/platform\/commerce\/server(?:\/|$))/);
      }
    }
  });
});
