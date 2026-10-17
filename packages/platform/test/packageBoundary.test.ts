import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";

// The package's own source reads no environment variable and imports no provider SDK: the
// application passes the environment and every provider client in. The only external client it
// imports are its optional peers: `pg` in the PostgreSQL adapters and `@aws-sdk/client-s3` in the
// default S3 client, each listed here.

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const ENVIRONMENT_READ = new RegExp(["process", "env"].join("\\s*\\.\\s*"));
const PG_ADAPTERS = new Set([
  "data/postgresGateway.ts",
  "data/queryBuilder.ts",
  "migrations/postgresRunner.ts",
  "scheduler/advisoryLock.ts",
]);

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

function specifiers(source: string): string[] {
  const code = withoutComments(source);
  const found = [
    ...code.matchAll(/(?:^|[\s;}])from\s+["']([^"']+)["']/g),
    ...code.matchAll(/\bimport\s+["']([^"']+)["']/g),
    ...code.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g),
    ...code.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g),
  ];
  return found.map((match) => match[1]!);
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
  });

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
  });

  it("scans the whole package source", () => {
    expect(files.map(({ path }) => path)).toEqual(expect.arrayContaining([
      "kernel/platformKernel.ts", "bff/dispatch.ts", "composition/composeBundle.ts", "composition/nodeHost.ts",
    ]));
  });

  it.each(files)("$path reads no environment variable", ({ source }) => {
    expect(source).not.toMatch(ENVIRONMENT_READ);
  });

  it.each(files)("$path imports only relative modules, node built-ins, core, zod and the allowed pg adapters", ({ path, source }) => {
    for (const specifier of specifiers(source)) {
      const allowed = specifier.startsWith(".")
        || specifier.startsWith("node:")
        || specifier.startsWith("@openlup/core/")
        || specifier === "zod"
        || (specifier === "pg" && PG_ADAPTERS.has(path))
        || (specifier === "@aws-sdk/client-s3" && path === "blob/s3Client.ts");
      expect(allowed, `${path} imports ${specifier}`).toBe(true);
    }
  });

  it("gives every module exactly one public entry, declared as its package subpath", () => {
    const modules = readdirSync(SOURCE_ROOT, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    const manifest = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as {
      exports: Record<string, { import: string; types: string }>;
    };
    expect(Object.keys(manifest.exports).sort()).toEqual(modules.map((name) => `./${name}`));
    for (const name of modules) {
      expect(existsSync(join(SOURCE_ROOT, name, "index.ts")), `${name}/index.ts`).toBe(true);
      expect(manifest.exports[`./${name}`]).toEqual({
        types: `./dist/${name}/index.d.ts`, import: `./dist/${name}/index.js`, default: `./dist/${name}/index.js`,
      });
    }
  });

  it.each(files)("$path reaches another module only through that module's public entry", ({ path, source }) => {
    const ownModule = path.split("/")[0];
    for (const specifier of specifiers(source).filter((value) => value.startsWith("."))) {
      const crossModule = /^\.\.\/([^/]+)\/(.+)$/.exec(specifier);
      const sameModule = /^\.\/[^/]+$/.test(specifier);
      const allowed = sameModule
        || (crossModule !== null && crossModule[1] !== ownModule && crossModule[2] === "index.js");
      expect(allowed, `${path} imports ${specifier}`).toBe(true);
    }
  });

  it.each(files.filter(({ path }) => path.startsWith("blob/")))("$path has no data-module imports, including types", ({ source }) => {
    expect(specifiers(source).filter((specifier) => specifier.startsWith("../data/"))).toEqual([]);
  });

  it("recognizes the forms it refuses", () => {
    expect("const value = process . env.X;").toMatch(ENVIRONMENT_READ);
    expect(specifiers('import { a } from "provider-sdk";\nimport "side-sdk";\nawait import("other-sdk"); require("third-sdk");'))
      .toEqual(["provider-sdk", "side-sdk", "other-sdk", "third-sdk"]);
    expect(specifiers('// import("commented-sdk")\nclient.from("table_name");')).toEqual([]);
  });
});
