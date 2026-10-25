import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, posix, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// The package's own source reads no environment variable and imports no provider SDK: the
// application passes the environment and every provider client in. The only external client it
// imports are its optional peers: `pg` in the PostgreSQL adapters and `@aws-sdk/client-s3` in the
// default S3 client, each listed here.

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const ENVIRONMENT_READ = new RegExp(["process", "env"].join("\\s*\\.\\s*"));
const CONTRACTS_LOADER_IDENTIFIERS = new Set([
  "require", "module", "exports", "process", "globalThis", "global", "__dirname", "__filename", "Buffer",
]);
const PG_ADAPTERS = new Set([
  "data/postgresGateway.ts",
  "data/queryBuilder.ts",
  "migrations/postgresRunner.ts",
  "scheduler/advisoryLock.ts",
]);

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

function specifiers(source: string, contracts = false): string[] {
  const found: string[] = [];
  const literal = (node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
  const add = (node: ts.Node | undefined) => {
    if (literal(node)) found.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (contracts) {
      // Reserve these names in every identifier position, including types and
      // property names, so wrappers and aliases cannot expose a loader handle.
      expect(ts.isIdentifier(node) && CONTRACTS_LOADER_IDENTIFIERS.has(node.text) || ts.isMetaProperty(node),
        "Contracts must not reference ambient loader identifiers or meta-properties").toBe(false);
    }
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier);
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require")
      || (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "require")
      || (ts.isElementAccessExpression(node.expression) && literal(node.expression.argumentExpression)
        && node.expression.argumentExpression.text === "require"))) {
      if (contracts) expect(literal(node.arguments[0]), "Contracts load targets must be string literals or templates without substitutions").toBe(true);
      add(node.arguments[0]);
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    ts.forEachChild(node, visit);
  };
  const file = ts.createSourceFile("boundary.ts", source, ts.ScriptTarget.Latest, true);
  if (contracts) {
    expect(file.typeReferenceDirectives, "Contracts must not reference external types").toEqual([]);
    expect(file.referencedFiles, "Contracts must not reference external files").toEqual([]);
  }
  visit(file);
  return found;
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
const coreEntries = Object.keys(JSON.parse(readFileSync(fileURLToPath(new URL("../../core/package.json", import.meta.url)), "utf8")).exports)
  .map((entry) => `@openlup/core${entry === "." ? "" : entry.slice(1)}`);

function contractsImportAllowed(file: string, specifier: string, graph: ModuleGraph): boolean {
  const module = file.split("/")[0]!;
  if (graph[module]?.contracts !== true) return false;
  if (coreEntries.includes(specifier)) return true;
  // Canonical relative forms only; normalize after validating, so a mid-path
  // climb, URL or alternate separator cannot disappear during resolution.
  if (!/^(?:\.\/)?(?:\.\.\/)*(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(specifier)
    || !specifier.startsWith(".") || !specifier.endsWith(".js")
    || /(?:^|\/)[^/]*\.test(?:Fixtures)?(?:\.[^/]*)?$/.test(specifier)) return false;
  return posix.normalize(posix.join(posix.dirname(file), specifier)).startsWith(`${module}/contracts/`);
}

function sourceImportAllowed(file: string, specifier: string, graph: ModuleGraph): boolean {
  if (file.split("/")[1] === "contracts") return contractsImportAllowed(file, specifier, graph);
  return specifier.startsWith(".")
    || specifier.startsWith("node:")
    || specifier.startsWith("@openlup/core/")
    || specifier === "zod"
    || (specifier === "pg" && PG_ADAPTERS.has(file))
    || (specifier === "@aws-sdk/client-s3" && file === "blob/s3Client.ts");
}

function assertModuleExports(modules: string[], graph: ModuleGraph, exports: Record<string, unknown>, hasFile: (path: string) => boolean, nestedEntries: string[] = []): void {
  expect(Object.keys(graph).sort()).toEqual([...modules].sort());
  const entries = modules.flatMap((module) => {
    expect(graph[module]!.contracts === undefined || graph[module]!.contracts === true, `${module} contracts declaration`).toBe(true);
    return [module, ...(graph[module]!.contracts === true ? [`${module}/contracts`] : [])];
  });
  for (const entry of nestedEntries) {
    expect(modules.includes(entry.split("/")[0]!), `${entry} belongs to an existing module`).toBe(true);
    expect(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/.test(entry), `${entry} is an exact nested entry`).toBe(true);
    entries.push(entry);
  }
  expect(Object.keys(exports).sort()).toEqual(entries.map((entry) => `./${entry}`).sort());
  for (const entry of entries) {
    expect(hasFile(`${entry}/index.ts`), `${entry}/index.ts`).toBe(true);
    expect(exports[`./${entry}`]).toEqual({
      types: `./dist/${entry}/index.d.ts`, import: `./dist/${entry}/index.js`, default: `./dist/${entry}/index.js`,
    });
  }
}

const platformExports = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")).exports as Record<string, unknown>;
const moduleDirectories = readdirSync(SOURCE_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

function relativeImportAllowed(path: string, specifier: string): boolean {
  const ownModule = path.split("/")[0]!;
  if (path.split("/")[1] === "contracts") return contractsImportAllowed(path, specifier, graph);
  const sameModule = /^\.\/[^/]+$/.test(specifier);
  const ownContracts = graph[ownModule]!.contracts === true && contractsImportAllowed(path, specifier, graph);
  const crossModule = /^\.\.\/([^/]+)\/(.+)$/.exec(specifier);
  if (sameModule || ownContracts || (posix.dirname(path) === ownModule && crossModule !== null && crossModule[1] !== ownModule && crossModule[2] === "index.js")) return true;
  if (!/^(?:\.\/)?(?:\.\.\/)*(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*\.js$/.test(specifier) || !specifier.startsWith(".")) return false;
  const target = posix.normalize(posix.join(posix.dirname(path), specifier));
  const targetModule = target.split("/")[0]!;
  if (!moduleDirectories.includes(targetModule)) return false;
  const declared = (entry: string) => Object.hasOwn(platformExports, `./${entry}`) && moduleDirectories.includes(entry.split("/")[0]!);
  // Nested callers may use their own module's implementation, while imports
  // into a nested public entry require that exact manifest declaration.
  const callerEntry = path.split("/").slice(0, 2).join("/");
  if (ownModule === targetModule && declared(callerEntry) && posix.dirname(target) === ownModule) return true;
  return target.endsWith("/index.js") && declared(target.slice(0, -"/index.js".length));
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
      "commerce/index.ts", "commerce/contracts/index.ts", "commerce/server/index.ts",
      "invoicing/index.ts", "invoicing/contracts/index.ts",
      "subscriptions/index.ts", "subscriptions/contracts/index.ts",
      "fulfillment/index.ts", "fulfillment/contracts/index.ts", "fulfillment/omnipack/index.ts", "fulfillment/bindings.ts", "fulfillment/contracts/bindings.ts", "composition/fulfillmentContribution.ts",
      "payments/index.ts", "payments/contracts/index.ts", "payments/stripe/index.ts", "payments/tpay/index.ts",
      "shipping/index.ts", "shipping/contracts/index.ts",
      "catalog/index.ts", "catalog/contracts/index.ts",
      "catalog/catalogSkuEnvelope.ts", "catalog/catalogSkuEnvelopeMapper.ts", "catalog/catalogDraftStore.ts", "composition/catalogContribution.ts",
      "catalog/adminBindings.ts", "catalog/bundleBindings.ts", "catalog/bundleRules.ts", "catalog/bundleRuleCodes.ts",
      "catalog/bundleAvailability.ts", "catalog/bundleAvailabilityService.ts", "catalog/bundleCatalogReadPort.ts",
      "catalog/bundleCatalogStore.ts", "catalog/bundleCatalogQueries.ts", "catalog/sql.ts",
      "catalog/adminBundleWritePort.ts", "catalog/adminBundleHandler.ts", "catalog/adminBundleReadHandler.ts", "catalog/sellableBundleHandler.ts",
      "catalog/contracts/bundleAdmin.ts", "catalog/contracts/bundleRead.ts", "catalog/contracts/bundleAvailability.ts",
      "pricing/index.ts", "pricing/browser/index.ts", "pricing/contracts/index.ts",
      "promotions/index.ts", "promotions/contracts/index.ts",
      "promotions/adminBindings.ts", "promotions/adminPromotionsHandler.ts", "promotions/adminPromotionCodesHandler.ts",
      "promotions/adminPromotionsContracts.ts", "promotions/adminPromotionCodesContracts.ts",
      "promotions/promotionClaims.ts", "promotions/promotionClaimSweepPort.ts", "promotions/sql.ts",
      "communications/index.ts", "communications/contracts/index.ts", "http/webhookSignature.ts",
      "kernel/platformKernel.ts", "bff/dispatch.ts", "composition/composeBundle.ts", "composition/nodeHost.ts",
      "inventory/index.ts", "inventory/contracts/index.ts", "inventory/schemas.ts", "inventory/ports.ts",
    ]));
    const nativeStore = files.find(({ path }) => path === "catalog/bundleCatalogStore.ts")!.source;
    expect(nativeStore).toContain('import type { PgQueryExecutor } from "../data/index.js"');
    expect(specifiers(nativeStore)).not.toContain("pg");
    for (const path of ["catalog/catalogSkuEnvelope.ts", "catalog/catalogSkuEnvelopeMapper.ts", "catalog/catalogDraftStore.ts"]) {
      const source = files.find(file => file.path === path)!.source;
      expect(source).toContain('import type { PgQueryExecutor } from "../data/index.js"');
      expect(specifiers(source)).not.toContain("pg");
    }
    expect(specifiers(files.find(file => file.path === "composition/catalogContribution.ts")!.source)).toEqual(["@openlup/core/readiness"]);
    expect(specifiers(files.find(file => file.path === "payments/bindings.ts")!.source)).toEqual(["./contracts/repair.js"]);
    expect(specifiers(files.find(file => file.path === "composition/composeBundle.ts")!.source)
      .filter((specifier) => /(?:^|\/)payments(?:\/|$)/u.test(specifier))).toEqual([]);
    // Shipping lane: audit every source, including contracts and type-only loads.
    for (const { path, source } of files.filter(({ path }) => path.startsWith("shipping/"))) {
      expect(specifiers(source).filter((specifier) => /(?:^|\/)inventory(?:\/|$)/u.test(specifier)), path).toEqual([]);
    }

  });

  it.each(files)("$path reads no environment variable", ({ source }) => {
    expect(source).not.toMatch(ENVIRONMENT_READ);
  });

  it.each(files)("$path imports only relative modules, node built-ins, core, zod and the allowed pg adapters", ({ path, source }) => {
    const contracts = path.split("/")[1] === "contracts";
    if (contracts) {
      expect(graph[path.split("/")[0]!]!.contracts, `${path} must declare contracts in the module graph`).toBe(true);
    }
    for (const specifier of specifiers(source, contracts)) {
      expect(sourceImportAllowed(path, specifier, graph), `${path} imports ${specifier}`).toBe(true);
    }
  });

  it("gives every module its public entry and exactly its declared contracts sub-entry", () => {
    const modules = readdirSync(SOURCE_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      exports: Record<string, unknown>;
    };
    assertModuleExports(modules, graph, manifest.exports, (path) => existsSync(join(SOURCE_ROOT, path)), ["commerce/server", "pricing/browser", "communications/resend", "communications/klaviyo", "payments/stripe", "payments/tpay", "fulfillment/omnipack"]);
  });

  it.each(files)("$path reaches another module only through that module's public entry", ({ path, source }) => {
    for (const specifier of specifiers(source).filter((value) => value.startsWith("."))) {
      expect(relativeImportAllowed(path, specifier), `${path} imports ${specifier}`).toBe(true);
    }
  });

  it.each(files.filter(({ path }) => path.startsWith("blob/")))("$path has no data-module imports, including types", ({ source }) => {
    expect(specifiers(source).filter((specifier) => specifier.startsWith("../data/"))).toEqual([]);
  });

  it("accepts only the single declared contracts export with the normal export shape (negative plants)", () => {
    const moduleGraph = readModuleGraph('export const PLATFORM_MODULE_GRAPH = { example: { contracts: true } };');
    const entry = (name: string) => ({ types: `./dist/${name}/index.d.ts`, import: `./dist/${name}/index.js`, default: `./dist/${name}/index.js` });
    const exports = { "./example": entry("example"), "./example/contracts": entry("example/contracts") };
    const hasFile = (path: string) => ["example/index.ts", "example/contracts/index.ts"].includes(path);
    expect(() => assertModuleExports(["example"], moduleGraph, exports, hasFile)).not.toThrow();
    expect(relativeImportAllowed("communications/index.ts", "./resend/index.js")).toBe(true);
    expect(relativeImportAllowed("communications/index.ts", "./undeclared/index.js")).toBe(false);
    expect(relativeImportAllowed("communications/resend/index.ts", "../undeclared/index.js")).toBe(false);
    expect(relativeImportAllowed("communications/index.ts", "../absent/vendor/index.js")).toBe(false);
    expect(() => assertModuleExports(["example"], moduleGraph, exports, hasFile, ["absent/adapter"])).toThrow();
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

  it("refuses server, neighbour and dependency imports from synthetic contracts (negative plants)", () => {
    const moduleGraph: ModuleGraph = { example: { contracts: true } };
    for (const file of ["example/contracts/index.ts", "example/contracts/nested/value.ts"]) {
      const up = file.includes("/nested/") ? "../../" : "../";
      for (const specifier of ["./own.js", "./nested/own.js", ...coreEntries, ...(up === "../../" ? ["../own.js"] : [])]) {
        expect(contractsImportAllowed(file, specifier, moduleGraph), `${file} imports ${specifier}`).toBe(true);
      }
      for (const specifier of [
        `${up}index.js`, `${up}server.js`, `${up}../data/index.js`, `${up}../http/index.js`,
        `${up}contracts/../server.js`, "./bridge.testFixtures.js", "./bridge.test.js", "././own.js", "./nested/../own.js",
        "./helper.mjs", "./helper.cjs", "./helper.mts", "./helper.cts", "./helper.ts", "./helper.tsx", "./helper.json", "./helper",
        "./%2e%2e/server.js", "./..\\server.js", "./own.js?server", "node:fs", "pg", "@example/provider-sdk", "zod",
        "@openlup/platform/example/contracts", "@openlup/core", "@openlup/core/src/private", "@openlup/core/platform-runtime/extra",
        "@OpenLup/core/platform-runtime", "/example/contracts/index.js", "file:///example/contracts/index.js", "#alias", "@/alias",
      ]) {
        // Exercise extraction and the same predicate used by the real source scan.
        for (const source of [
          `import type { Value } from ${JSON.stringify(specifier)};`,
          `export * from ${JSON.stringify(specifier)};`,
          `const value = import(\`${specifier.replaceAll("\\", "\\\\")}\`);`,
          `module.require(${JSON.stringify(specifier)});`,
          `import value = require(${JSON.stringify(specifier)});`,
          `type Value = import(${JSON.stringify(specifier)}).Value;`,
        ]) {
          expect(specifiers(source)).toEqual([specifier]);
          expect(() => {
            for (const imported of specifiers(source)) expect(contractsImportAllowed(file, imported, moduleGraph)).toBe(true);
          }).toThrow();
        }
      }
    }
    expect(contractsImportAllowed("example/contracts/index.ts", "./own.js", { example: {} })).toBe(false);
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

  it("refuses non-literal contracts loads (negative plants)", () => {
    for (const target of ["target", '"p" + "g"', "`./${target}.js`", "42", "null", "...targets", ""]) {
      const sources = [`require(${target});`, `module.require(${target});`, `globalThis.require(${target});`,
        `process.mainModule.require(${target});`, `module["require"](${target});`, `registry["require"](${target});`];
      if (target !== "" && target !== "...targets") sources.push(`import(${target});`);
      for (const source of sources) expect(() => specifiers(source, true)).toThrow("Contracts load targets must be string literals");
    }
    for (const source of ['import("./own.js");', "import(`./own.js`);"]) {
      expect(specifiers(source, true)).toEqual(["./own.js"]);
    }
    for (const source of ['require("./own.js");', "module.require(`./own.js`);"]) {
      expect(() => specifiers(source, true)).toThrow("Contracts must not reference ambient loader identifiers");
    }
  });

  it("refuses ambient loader identifiers in contracts values and types (negative plants)", () => {
    for (const identifier of ["require", "module", "exports", "process", "globalThis", "global", "__dirname", "__filename", "Buffer"]) {
      for (const source of [`const value = ${identifier};`, `type Value = typeof ${identifier};`, `type Value = ${identifier};`]) {
        expect(() => specifiers(source, true), source).toThrow("Contracts must not reference ambient loader identifiers");
      }
    }
    for (const source of ["import.meta;", "const value = import.meta.url;"]) {
      expect(() => specifiers(source, true), source).toThrow("Contracts must not reference ambient loader identifiers or meta-properties");
    }
  });

  it.each([
    'require!("pg");',
    '(require as any)("pg");',
    '(<any>require)("pg");',
    'module.require!("pg");',
    '(module.require as any)("pg");',
    '(0, require)("pg");',
    'process.getBuiltinModule("node:fs");',
    'process.getBuiltinModule("node:module").createRequire(import.meta.url)("pg");',
  ])("refuses a wrapped or builtin contracts loader: %s (negative plant)", (source) => {
    expect(() => specifiers(source, true)).toThrow("Contracts must not reference ambient loader identifiers");
  });

  it("permits browser-safe contracts types, validators, pure functions and allowed imports (positive plant)", () => {
    const source = `
      import type { OwnValue } from "./own.js";
      import { validate } from "./validator.js";
      export type { PlatformSettings } from "@openlup/core/platform-runtime";
      export type Contract = { value: OwnValue };
      const schema = { parse(value: unknown): string {
        if (typeof value !== "string") throw new Error("Expected a string");
        return value.trim();
      } };
      export function normalize(value: unknown): string { return validate(schema.parse(value)); }
      export const loadOwn = () => import("./own.js");
    `;
    const imported = specifiers(source, true);
    expect(imported).toEqual(["./own.js", "./validator.js", "@openlup/core/platform-runtime", "./own.js"]);
    for (const specifier of imported) {
      expect(sourceImportAllowed("example/contracts/index.ts", specifier, { example: { contracts: true } })).toBe(true);
    }
  });

  it("refuses triple-slash type and path references in contracts (negative plants)", () => {
    for (const source of ['/// <reference types="node" />\nexport {};', '/// <reference path="../server.ts" />\nexport {};']) {
      expect(() => specifiers(source, true)).toThrow("Contracts must not reference external");
    }
  });

  it("checks member-call loads in every source file (negative plants)", () => {
    const moduleGraph: ModuleGraph = { example: { contracts: true } };
    for (const source of ['globalThis.require("pg");', 'process.mainModule.require("pg");', 'module["require"]("pg");']) {
      expect(specifiers(source)).toEqual(["pg"]);
      for (const specifier of specifiers(source)) {
        expect(sourceImportAllowed("example/server.ts", specifier, moduleGraph)).toBe(false);
      }
      expect(() => specifiers(source, true)).toThrow("Contracts must not reference ambient loader identifiers");
    }
    expect(sourceImportAllowed("data/postgresGateway.ts", "pg", moduleGraph)).toBe(true);
  });

  it("recognizes the forms it refuses", () => {
    expect("const value = process . env.X;").toMatch(ENVIRONMENT_READ);
    expect(specifiers('import { a } from "provider-sdk";\nimport "side-sdk";\nawait import("other-sdk"); require("third-sdk");'))
      .toEqual(["provider-sdk", "side-sdk", "other-sdk", "third-sdk"]);
    expect(specifiers('// import("commented-sdk")\nclient.from("table_name");')).toEqual([]);
  });
});
