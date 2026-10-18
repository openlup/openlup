import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// Source imports and module edges are enforced by the root ESLint rules and
// their syntax/path falsifiers. This package proof owns environment reads,
// declaration independence and the correspondence between modules and exports.

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const ENVIRONMENT_READ = new RegExp(["process", "env"].join("\\s*\\.\\s*"));
function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return scannedSource(relative(SOURCE_ROOT, path).split("\\").join("/")) ? [path] : [];
  });
}

function scannedSource(file: string): boolean {
  if (file.split("/")[1] === "contracts") {
    expect(file.endsWith(".ts"), `${file}: every contracts file must be a scanned .ts file`).toBe(true);
  }
  return file.endsWith(".ts");
}

function assertContractsReferences(source: string): void {
  const file = ts.createSourceFile("contracts.ts", source, ts.ScriptTarget.Latest, true);
  expect(file.typeReferenceDirectives, "Contracts must not reference external types").toEqual([]);
  expect(file.referencedFiles, "Contracts must not reference external files").toEqual([]);
  const visit = (node: ts.Node): void => {
    expect(ts.isMetaProperty(node), "Contracts must not reference meta-properties").toBe(false);
    ts.forEachChild(node, visit);
  };
  visit(file);
}

type ModuleGraph = Record<string, { contracts?: unknown }>;

// Read the declaration without importing repository tooling across the package
// boundary. Only the fixed contracts flag is relevant to this package proof.
function readModuleGraph(source: string): ModuleGraph {
  const file = ts.createSourceFile("eslint.config.js", source, ts.ScriptTarget.Latest, true);
  const declaration = file.statements.filter(ts.isVariableStatement).flatMap((statement) => [...statement.declarationList.declarations])
    .find((node) => ts.isIdentifier(node.name) && node.name.text === "PLATFORM_MODULE_GRAPH");
  if (!declaration?.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) throw new Error("Missing literal PLATFORM_MODULE_GRAPH");
  return Object.fromEntries(declaration.initializer.properties.map((module) => {
    if (!ts.isPropertyAssignment(module) || !ts.isObjectLiteralExpression(module.initializer)
      || !(ts.isIdentifier(module.name) || ts.isStringLiteral(module.name))) throw new Error("Expected a literal module declaration");
    const contracts = module.initializer.properties.filter((property) => ts.isPropertyAssignment(property)
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "contracts");
    if (contracts.length > 1) throw new Error("Duplicate contracts declaration");
    const flag = contracts[0] as ts.PropertyAssignment | undefined;
    return [module.name.text, flag ? { contracts: flag.initializer.kind === ts.SyntaxKind.TrueKeyword ? true : flag.initializer.getText(file) } : {}];
  }));
}

const graph = readModuleGraph(readFileSync(fileURLToPath(new URL("../../../eslint.config.js", import.meta.url)), "utf8"));
function assertModuleExports(modules: string[], graph: ModuleGraph, exports: Record<string, unknown>, hasFile: (path: string) => boolean): void {
  expect(Object.keys(graph).sort()).toEqual([...modules].sort());
  const entries = modules.flatMap((module) => {
    expect(graph[module]!.contracts === undefined || graph[module]!.contracts === true, `${module} contracts declaration`).toBe(true);
    return [module, ...(graph[module]!.contracts === true ? [`${module}/contracts`] : [])];
  });
  expect(Object.keys(exports).sort()).toEqual(entries.map((entry) => `./${entry}`).sort());
  for (const entry of entries) {
    expect(hasFile(`${entry}/index.ts`), `${entry}/index.ts`).toBe(true);
    expect(exports[`./${entry}`]).toEqual({
      types: `./dist/${entry}/index.d.ts`, import: `./dist/${entry}/index.js`, default: `./dist/${entry}/index.js`,
    });
  }
}

const files = sources(SOURCE_ROOT).map((path) => ({
  path: relative(SOURCE_ROOT, path).split("\\").join("/"),
  source: readFileSync(path, "utf8"),
}));

describe("package source boundary", () => {
  it("typechecks the blob declarations without the optional S3 SDK", () => {
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, noEmit: true, types: ["node"], target: ts.ScriptTarget.ES2022,
    };
    const host = ts.createCompilerHost(options);
    const fileExists = host.fileExists;
    const readFile = host.readFile;
    const blocked = (path: string) => path.replaceAll("\\", "/").includes("/node_modules/@aws-sdk/");
    host.fileExists = (path) => !blocked(path) && fileExists(path);
    host.readFile = (path) => blocked(path) ? undefined : readFile(path);
    const program = ts.createProgram([join(SOURCE_ROOT, "../dist/blob/index.d.ts")], options, host);
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
  }, 30_000);

  it("typechecks the composition declarations without pg and references no data-module declarations", () => {
    const options: ts.CompilerOptions = {
      module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true, noEmit: true, types: ["node"], target: ts.ScriptTarget.ES2022,
    };
    const host = ts.createCompilerHost(options);
    const fileExists = host.fileExists;
    const readFile = host.readFile;
    const blocked = (path: string) => /\/node_modules\/(?:pg|@types\/pg)\//.test(path.replaceAll("\\", "/"));
    host.fileExists = (path) => !blocked(path) && fileExists(path);
    host.readFile = (path) => blocked(path) ? undefined : readFile(path);
    const program = ts.createProgram([join(SOURCE_ROOT, "../dist/composition/index.d.ts")], options, host);
    expect(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
    const declarations = program.getSourceFiles().map((file) => file.fileName.replaceAll("\\", "/"));
    expect(declarations.filter((name) => name.includes("/dist/data/"))).toEqual([]);
  }, 30_000);

  it("scans the whole package source", () => {
    expect(files.map(({ path }) => path)).toEqual(expect.arrayContaining([
      "kernel/platformKernel.ts", "bff/dispatch.ts", "composition/composeBundle.ts", "composition/nodeHost.ts",
    ]));
  });

  it.each(files)("$path reads no environment variable", ({ source }) => {
    expect(source).not.toMatch(ENVIRONMENT_READ);
  });

  it("gives every module its public entry and exactly its declared contracts sub-entry", () => {
    const modules = readdirSync(SOURCE_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      exports: Record<string, unknown>;
    };
    assertModuleExports(modules, graph, manifest.exports, (path) => existsSync(join(SOURCE_ROOT, path)));
  });

  it("accepts only the single declared contracts export with the normal export shape (negative plants)", () => {
    const moduleGraph = readModuleGraph('export const PLATFORM_MODULE_GRAPH = { example: { contracts: true } };');
    const entry = (name: string) => ({ types: `./dist/${name}/index.d.ts`, import: `./dist/${name}/index.js`, default: `./dist/${name}/index.js` });
    const exports = { "./example": entry("example"), "./example/contracts": entry("example/contracts") };
    const hasFile = (path: string) => ["example/index.ts", "example/contracts/index.ts"].includes(path);
    expect(() => assertModuleExports(["example"], moduleGraph, exports, hasFile)).not.toThrow();
    const undeclared: ModuleGraph = { example: {} };
    expect(() => assertModuleExports(["example"], undeclared, { "./example": entry("example") }, hasFile)).not.toThrow();
    for (const invalid of [
      { "./example": entry("example") },
      { ...exports, "./example/contracts/extra": entry("example/contracts/extra") },
      { ...exports, "./example/client": entry("example/client") },
      { ...exports, "./example/contracts": entry("example") },
      { ...exports, "./example/contracts": { types: "./dist/example/contracts/index.d.ts", import: "./dist/example/contracts/index.js" } },
    ]) expect(() => assertModuleExports(["example"], moduleGraph, invalid, hasFile)).toThrow();
    expect(() => assertModuleExports(["example"], undeclared, exports, hasFile)).toThrow();
    expect(() => assertModuleExports(["example"], moduleGraph, exports, (path) => path === "example/index.ts")).toThrow();
    for (const contracts of [false, "contracts", ["contracts", "client"]]) {
      const invalidGraph = readModuleGraph(`export const PLATFORM_MODULE_GRAPH = { example: { contracts: ${JSON.stringify(contracts)} } };`);
      expect(() => assertModuleExports(["example"], invalidGraph, exports, hasFile)).toThrow();
    }
  });

  it("refuses every contracts file the source scan cannot check (negative plants)", () => {
    for (const directory of ["example/contracts", "example/contracts/nested"]) {
      expect(scannedSource(`${directory}/helper.ts`)).toBe(true);
      for (const name of ["helper.mts", "helper.cts", "helper.js", "helper.mjs", "helper.cjs", "helper.tsx", "helper.json", "helper.txt", "helper"]) {
        expect(() => scannedSource(`${directory}/${name}`)).toThrow("every contracts file must be a scanned .ts file");
      }
    }
    expect(scannedSource("example/server.js")).toBe(false);
  });

  it.each(files.filter(({ path }) => path.split("/")[1] === "contracts"))(
    "$path has no external references or meta-properties", ({ source }) => assertContractsReferences(source),
  );

  it("refuses external references and new.target in contracts", () => {
    for (const source of ['/// <reference types="node" />\nexport {};', '/// <reference path="../server.ts" />\nexport {};', 'function value() { return new.target; }']) {
      expect(() => assertContractsReferences(source)).toThrow();
    }
    expect(() => assertContractsReferences('export type Value = { id: string };')).not.toThrow();
  });

});
