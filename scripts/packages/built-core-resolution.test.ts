import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { assertPublicReferenceModuleId } from "../../vite.public-reference.config.ts";

const root = process.cwd();
const specifier = "@openlup/core/subscription";
const declaration = join(root, "packages/core/dist/subscription/index.d.ts");
const runtime = join(root, "packages/core/dist/subscription/index.js");
const source = join(root, "packages/core/src/subscription/index.ts");

const projects = [
  ["tsconfig.api.json", "api/unsubscribe.ts"],
  ["tsconfig.app.json", "src/domains/subscription/index.ts"],
  ["tsconfig.mcp.json", "mcp/index.ts"],
  ["tsconfig.node.json", "scripts/packages/packages-check.ts"],
] as const;

function options(file: string): ts.CompilerOptions {
  const config = ts.readConfigFile(join(root, file), ts.sys.readFile);
  expect(config.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, root);
  expect(parsed.errors).toEqual([]);
  return parsed.options;
}

describe("root built-core resolution", () => {
  it.each(projects)("%s uses built declarations and refuses a missing build", (config, importer) => {
    expect(existsSync(declaration), "Build @openlup/core before root tests").toBe(true);
    const compilerOptions = options(config);
    const from = join(root, importer);
    const actual = ts.resolveModuleName(specifier, from, compilerOptions, ts.sys).resolvedModule;
    expect(actual?.resolvedFileName).toBe(realpathSync(declaration));

    const hiddenDist = (file: string) => file.includes("/@openlup/core/dist") || file.includes("/packages/core/dist");
    const withoutBuild: ts.ModuleResolutionHost = {
      ...ts.sys,
      fileExists: (file) => !hiddenDist(file) && ts.sys.fileExists(file),
      readFile: (file) => hiddenDist(file) ? undefined : ts.sys.readFile(file),
      directoryExists: (file) => !hiddenDist(file) && ts.sys.directoryExists(file),
    };
    expect(ts.resolveModuleName(specifier, from, compilerOptions, withoutBuild).resolvedModule).toBeUndefined();
  });

  it("loads the built runtime through the default Node package export", () => {
    expect(existsSync(runtime), "Build @openlup/core before root tests").toBe(true);
    const resolved = execFileSync(process.execPath, ["--input-type=module", "--eval",
      `console.log(import.meta.resolve(${JSON.stringify(specifier)})); await import(${JSON.stringify(specifier)});`],
    { cwd: root, encoding: "utf8", env: { NODE_OPTIONS: "" } });
    expect(resolved.trim()).toBe(pathToFileURL(realpathSync(runtime)).href);
  });

  it("admits built core files in the subscription closure and refuses core source", () => {
    const inventory = JSON.parse(readFileSync(join(root, "config/public-reference-subscription-imports.json"), "utf8")) as { files: string[] };
    const coreFiles = inventory.files.filter((file) => file.startsWith("packages/core/"));
    expect(coreFiles.length).toBeGreaterThan(0);
    for (const file of coreFiles) {
      expect(file).toMatch(/^packages\/core\/dist\/.*\.js$/);
      expect(existsSync(join(root, file)), `${file} must come from the core build`).toBe(true);
      expect(() => assertPublicReferenceModuleId(join(root, file), root, inventory.files)).not.toThrow();
    }
    expect(() => assertPublicReferenceModuleId(source, root, inventory.files)).toThrow(/outside declared profile/);
  });
});
