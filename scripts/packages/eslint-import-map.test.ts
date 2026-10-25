import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint, type Linter } from "eslint";
import { afterEach, describe, expect, it, vi } from "vitest";

// eslint.config.js reads the root package.json `imports` map to find the aliases
// that resolve into infra code, which domain code may not import. Node also
// allows a condition object as a target; these tests load the real config with
// such a map in place of the committed one.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = join(root, "package.json");
const domainFile = join(root, "src/domains/example/usesAlias.ts");

type ReadFileSync = typeof import("node:fs").readFileSync;

const linters = new WeakMap<Linter.Config[], ESLint>();

function linterFor(config: Linter.Config[]): ESLint {
  let linter = linters.get(config);
  if (!linter) {
    linter = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config });
    linters.set(config, linter);
  }
  return linter;
}

async function loadConfig(imports?: Record<string, unknown>): Promise<Linter.Config[]> {
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    const readFileSync = ((file: Parameters<ReadFileSync>[0], ...rest: unknown[]) => {
      if (imports !== undefined && typeof file === "string" && resolve(file) === manifestPath) {
        return JSON.stringify({ ...JSON.parse(actual.readFileSync(manifestPath, "utf8")), imports });
      }
      return (actual.readFileSync as (...args: unknown[]) => unknown)(file, ...rest);
    }) as ReadFileSync;
    return { ...actual, default: { ...actual, readFileSync }, readFileSync };
  });
  return (await import("../../eslint.config.js")).default as Linter.Config[];
}

async function restrictedImports(config: Linter.Config[], specifier: string): Promise<string[]> {
  return await boundaryMessages(config, `import value from ${JSON.stringify(specifier)};\nexport { value };\n`, domainFile);
}

async function boundaryMessages(config: Linter.Config[], source: string, filename: string): Promise<string[]> {
  const messages = (await linterFor(config).lintText(source, { filePath: resolve(root, filename), warnIgnored: true }))[0]!.messages;
  // A parse failure or unmatched config is not proof that a boundary refused.
  expect(messages.filter(({ fatal, ruleId }) => fatal || ruleId === null)).toEqual([]);
  return messages
    .filter(({ ruleId }) => ruleId === "no-restricted-imports" || ruleId === "no-restricted-syntax")
    .map(({ message }) => message);
}

function loadSources(specifier: string, extension: string, allSyntax = true): string[] {
  const quoted = JSON.stringify(specifier);
  // Path/depth tables test rule selection; the syntax tables below exercise
  // every loader form once per rule family, instead of multiplying both axes.
  if (!allSyntax) return [extension === "cjs"
    ? `const value = require(${quoted});`
    : `import value from ${quoted};`];
  const sources = [
    `const value = import(${quoted});`,
    `const value = import(\`${specifier}\`);`,
    `const value = require(${quoted});`,
    `const value = require(\`${specifier}\`);`,
    `const value = module.require(${quoted});`,
    `const value = module.require(\`${specifier}\`);`,
    `const value = require(${quoted}).createClient();`,
  ];
  if (extension !== "cjs") sources.push(
    `import value from ${quoted};`,
    `import { value } from ${quoted};`,
    `import * as value from ${quoted};`,
    `import ${quoted};`,
    `export { value } from ${quoted};`,
    `export * from ${quoted};`,
    `export * as value from ${quoted};`,
  );
  if (extension === "ts" || extension === "tsx") sources.push(
    `import type { Value } from ${quoted};`,
    `import { type Value } from ${quoted};`,
    `export type { Value } from ${quoted};`,
    `type Value = import(${quoted}).Value;`,
    `import value = require(${quoted});`,
  );
  return sources;
}

const managedProvider = `${String.fromCharCode(64)}supabase/supabase-js`;
const cardProvider = ["str", "ipe"].join("");
const portablePackages = ["core", "ui"];
const sourceExtensions = ["ts", "tsx", "js", "mjs", "cjs"];

afterEach(() => {
  vi.doUnmock("node:fs");
  vi.resetModules();
});

describe("eslint import-map boundary", { timeout: 60_000 }, () => {
  it("keeps string targets: an alias into infra code is refused in domain code", async () => {
    const config = await loadConfig({
      "#plain-infra": "./server/adapters/example.ts",
      "#plain-neutral": "./src/lib/example.ts",
    });
    expect(await restrictedImports(config, "#plain-infra")).toEqual([expect.stringContaining("Domain code must not import")]);
    expect(await restrictedImports(config, "#plain-neutral")).toEqual([]);
  });

  it("loads conditional and fallback-array targets and refuses an alias any of whose targets reaches infra", async () => {
    const config = await loadConfig({
      "#overlay-infra": { "deployment-overlay": "./server/runtime/overlay.ts", default: "./src/lib/example.ts" },
      "#nested-infra": { node: { "deployment-overlay": "./server/bff/nested.ts", default: "./src/lib/nested.ts" }, default: "./src/lib/nested.ts" },
      "#overlay-neutral": { "deployment-overlay": "./src/lib/overlay.ts", default: "./src/lib/example.ts" },
      "#plain-infra": "./server/adapters/example.ts",
      "#array-infra": ["./src/lib/fallback.ts", "./server/adapters/fallback.ts"],
      "#condition-array-infra": { "deployment-overlay": ["./src/lib/overlay.ts", "./server/infra/overlay.ts"], default: "./src/lib/example.ts" },
      "#array-neutral": ["./src/lib/first.ts", "./src/lib/second.ts"],
    });
    for (const alias of ["#overlay-infra", "#nested-infra", "#plain-infra", "#array-infra", "#condition-array-infra"]) {
      expect(await restrictedImports(config, alias)).toEqual([expect.stringContaining("Domain code must not import")]);
    }
    expect(await restrictedImports(config, "#overlay-neutral")).toEqual([]);
    expect(await restrictedImports(config, "#array-neutral")).toEqual([]);
  });

  it("still applies the committed import map", async () => {
    const config = await loadConfig();
    expect(await restrictedImports(config, "#tester-program-email-binding")).toEqual([expect.stringContaining("Domain code must not import")]);
    expect(await restrictedImports(config, "#deployment-analytics")).toEqual([]);
  });
});

describe("eslint portable package boundaries", { timeout: 60_000 }, () => {
  it.each(sourceExtensions)("checks every load syntax against each owning package rule in %s", async extension => {
    const config = await loadConfig();
    for (const pkg of ["outbox", "platform"]) {
      const filename = `packages/${pkg}/src/usesKernel.${extension}`;
      for (const source of loadSources("@openlup/core/readiness", extension))
        expect(await boundaryMessages(config, source, filename)).toEqual([]);
      for (const source of loadSources("@openlup/core/not-exported", extension))
        expect(await boundaryMessages(config, source, filename))
          .toContainEqual(expect.stringContaining("Import a workspace package only through a subpath"));
      for (const source of loadSources("../../../outside", extension))
        expect(await boundaryMessages(config, source, filename))
          .toContainEqual(expect.stringContaining(`A file under packages/${pkg} stays package-local`));
    }
    for (const source of loadSources("pg", extension))
      expect(await boundaryMessages(config, source, `packages/outbox/src/usesProvider.${extension}`))
        .toContainEqual(expect.stringContaining("Portable package source must not import provider SDKs"));
  });
  it("rejects every existing provider family in both portable source trees", async () => {
    const config = await loadConfig();
    for (const pkg of portablePackages) for (const specifier of [
      cardProvider, `${cardProvider}/subpath`, "pg", "openai", `@${cardProvider}/${cardProvider}-js`,
      managedProvider, "@vercel/blob", "@modelcontextprotocol/sdk",
    ]) {
      expect(await boundaryMessages(config, `import value from ${JSON.stringify(specifier)};`, `packages/${pkg}/src/usesProvider.ts`))
        .toEqual([expect.stringContaining("Portable package source must not import provider SDKs")]);
    }
  });

  it.each(sourceExtensions)("refuses ordinary provider imports and loads in %s source", async (extension) => {
    const config = await loadConfig();
    for (const pkg of portablePackages) for (const specifier of [managedProvider, "@vercel/blob"]) {
      for (const source of loadSources(specifier, extension)) {
        expect(await boundaryMessages(config, source, `packages/${pkg}/src/nested/usesProvider.${extension}`))
          .toEqual([expect.stringContaining("Portable package source must not import provider SDKs")]);
      }
    }
  });

  it("keeps provider composition in adapters, package tools, tests and existing fixture names", async () => {
    const config = await loadConfig();
    const files = [
      "server/adapters/example.ts",
      "src/checkout/adapters/example.tsx",
      "server/runtime/example.ts",
      "src/domains/example/example.test.ts",
      "server/domains/example/example.testFixtures.ts",
      ...portablePackages.flatMap((pkg) => [
        `packages/${pkg}/test/compose.ts`,
        `packages/${pkg}/smoke/compose.ts`,
        `packages/${pkg}/scripts/compose.mjs`,
        `packages/${pkg}/src/nested/example.testFixtures.ts`,
        ...sourceExtensions.map((extension) => `packages/${pkg}/src/nested/example.test.${extension}`),
      ]),
    ];
    for (const filename of files) for (const specifier of [managedProvider, "@vercel/blob"]) {
      const extension = filename.split(".").at(-1)!;
      for (const source of loadSources(specifier, extension)) {
        expect(await boundaryMessages(config, source, filename)).toEqual([]);
      }
    }
  });

  it("keeps literal CommonJS under the existing domain and public package export boundaries", async () => {
    const config = await loadConfig();
    for (const source of [
      'const value = require("@vercel/blob");',
      'const value = module.require(`@vercel/blob`);',
    ]) expect(await boundaryMessages(config, source, "server/domains/example/usesProvider.cjs"))
      .toEqual([expect.stringContaining("Domain code must not import")]);
    for (const source of [
      'const value = require("@openlup/core/src/payment/index.ts");',
      'const value = module.require(`../../packages/core/src/payment/index.ts`);',
    ]) expect(await boundaryMessages(config, source, "server/adapters/example.cjs"))
      .toEqual([expect.stringContaining("Import a workspace package only through a subpath")]);
    expect(await boundaryMessages(config, 'const value = require("@openlup/core/payment");', "server/adapters/example.cjs"))
      .toEqual([]);
  });

  it.each(portablePackages)("retains %s package isolation through depth-specific and fallback configs", async (pkg) => {
    const config = await loadConfig();
    for (const depth of [0, 1, 2, 12, 13]) {
      const directory = depth === 0 ? "" : `src/${"nested/".repeat(depth - 1)}`;
      const filename = `packages/${pkg}/${directory}usesPort.ts`;
      const outside = `${"../".repeat(depth + 1)}outside`;
      for (const source of [
        `import value from "${outside}";`,
        `const value = import(\`${outside}\`);`,
        `const value = module.require("${outside}");`,
      ]) expect(await boundaryMessages(config, source, filename))
        .toEqual([expect.stringContaining(`A file under packages/${pkg} imports nothing outside that directory`)]);

      expect(await boundaryMessages(config, 'import value from "./internal";', filename)).toEqual([]);
      const parent = `${"../".repeat(Math.max(depth, 1))}internal`;
      expect(await boundaryMessages(config, `import value from "${parent}";`, filename))
        .toEqual(depth === 0 || depth > 12
          ? [expect.stringContaining(`A file under packages/${pkg} imports nothing outside that directory`)]
          : []);
      if (depth > 0) {
        expect(await boundaryMessages(config, 'import value from "@vercel/blob";', filename))
          .toEqual([expect.stringContaining("Portable package source must not import provider SDKs")]);
      }
    }
  });

  it("keeps package path restrictions in production, fixture and outside-src composition", async () => {
    const config = await loadConfig();
    for (const pkg of portablePackages) for (const file of ["src/usesPort.ts", "src/example.test.ts", "src/example.testFixtures.ts", "test/compose.ts", "scripts/compose.mjs"]) {
      const filename = `packages/${pkg}/${file}`;
      const otherPackage = pkg === "core" ? "ui" : "core";
      for (const specifier of ["../../outside", "/outside", "@/outside", "#outside", `@openlup/${otherPackage}`]) {
        for (const source of [`import value from "${specifier}";`, `const value = require(\`${specifier}\`);`]) {
          expect(await boundaryMessages(config, source, filename))
            .toContainEqual(expect.stringContaining(`A file under packages/${pkg} imports nothing outside that directory`));
        }
      }
    }
  });

  it("permits neutral dependencies, internal code and ordinary provider-valued data", async () => {
    const config = await loadConfig();
    for (const pkg of portablePackages) for (const extension of sourceExtensions) {
      const filename = `packages/${pkg}/src/nested/usesPort.${extension}`;
      for (const specifier of ["zod", "./internal", "../ports", `${cardProvider}-helper`, "@vercel-like/sdk"]) {
        for (const source of loadSources(specifier, extension)) expect(await boundaryMessages(config, source, filename)).toEqual([]);
      }
      expect(await boundaryMessages(config, 'const providerLabel = "@vercel/blob";', filename)).toEqual([]);
      expect(await boundaryMessages(config, 'const value = registry.require("@vercel/blob");', filename)).toEqual([]);
    }
  });
  it.each(sourceExtensions.flatMap((extension) => [0, 1, 4, 12, 13].map((depth) => ({ extension, depth }))))(
    "permits only exact public core exports from outbox in $extension at depth $depth",
    async ({ extension, depth }) => {
      const config=await loadConfig();
      const filename=`packages/outbox/src/${"nested/".repeat(depth)}usesKernel.${extension}`;
      for(const specifier of ["@openlup/core/outbox","@openlup/core/readiness","@openlup/core/platform-runtime","@openlup/core/standard-schema"]){
        for(const source of loadSources(specifier,extension,false))expect(await boundaryMessages(config,source,filename)).toEqual([]);
      }
      for(const specifier of ["@openlup/core/src/readiness","@openlup/core/dist/readiness/index.js","@openlup/core/not-exported","@openlup/core"]){
        for(const source of loadSources(specifier,extension,false))expect(await boundaryMessages(config,source,filename))
          .toContainEqual(expect.stringContaining("Import a workspace package only through a subpath"));
      }
      for(const specifier of ["@openlup/ui","@openlup/unknown","/outside","@/outside","#outside",`${"../".repeat(depth+3)}outside`]){
        for(const source of loadSources(specifier,extension,false))expect(await boundaryMessages(config,source,filename))
          .toContainEqual(expect.stringContaining("A file under packages/outbox stays package-local"));
      }
      for(const specifier of [managedProvider,cardProvider,"pg","openai","@vercel/blob"]){
        for(const source of loadSources(specifier,extension,false))expect(await boundaryMessages(config,source,filename))
          .toContainEqual(expect.stringContaining("Portable package source must not import provider SDKs"));
      }
      if (depth === 0) for(const pkg of portablePackages)for(const source of loadSources("@openlup/outbox","ts"))
        expect(await boundaryMessages(config,source,`packages/${pkg}/src/usesOutbox.ts`))
          .toContainEqual(expect.stringContaining(`A file under packages/${pkg} imports nothing outside that directory`));
    });

  it.each(sourceExtensions.flatMap((extension) => [0, 1, 4, 12, 13].map((depth) => ({ extension, depth }))))(
    "permits only exact public core exports from platform in $extension at depth $depth",
    async ({ extension, depth }) => {
      const config=await loadConfig();
      const filename=`packages/platform/src/${"nested/".repeat(depth)}usesKernel.${extension}`;
      for(const specifier of ["@openlup/core/outbox","@openlup/core/readiness","@openlup/core/platform-runtime","@openlup/core/standard-schema"]){
        for(const source of loadSources(specifier,extension,false))expect(await boundaryMessages(config,source,filename)).toEqual([]);
      }
      for(const specifier of ["@openlup/core/src/readiness","@openlup/core/dist/readiness/index.js","@openlup/core/not-exported","@openlup/core"]){
        for(const source of loadSources(specifier,extension,false))expect(await boundaryMessages(config,source,filename))
          .toContainEqual(expect.stringContaining("Import a workspace package only through a subpath"));
      }
      for(const specifier of ["@openlup/ui","@openlup/outbox","@openlup/unknown","/outside","@/outside","#outside",`${"../".repeat(depth+3)}outside`]){
        for(const source of loadSources(specifier,extension,false))expect(await boundaryMessages(config,source,filename))
          .toContainEqual(expect.stringContaining("A file under packages/platform stays package-local"));
      }
      // The platform adapters own their provider clients, so the portable-source SDK rule does not apply.
      for(const specifier of ["pg","@vercel/blob"]){
        for(const source of loadSources(specifier,extension,false))expect(await boundaryMessages(config,source,filename)).toEqual([]);
      }
      if (depth === 0) for(const pkg of portablePackages)for(const source of loadSources("@openlup/platform/http","ts"))
        expect(await boundaryMessages(config,source,`packages/${pkg}/src/usesPlatform.ts`))
          .toContainEqual(expect.stringContaining(`A file under packages/${pkg} imports nothing outside that directory`));
    });

  it("validates declared workspace exports inside package-local imports too",async()=>{
    const config=await loadConfig();
    for(const pkg of ["core","ui","outbox","platform"]){
      const filename=`packages/${pkg}/src/usesPrivate.ts`;
      for(const source of loadSources(`@openlup/${pkg}/src/private`,"ts"))
        expect(await boundaryMessages(config,source,filename))
          .toContainEqual(expect.stringContaining("Import a workspace package only through a subpath"));
    }
  });

});

describe("eslint platform module boundaries", { timeout: 60_000 }, () => {
  const platformSource = join(root, "packages/platform/src");
  const typeOnlyForm = /^(?:import type |import \{ type |export type |type Value = import\()/;

  async function moduleMessages(config: Linter.Config[], source: string, filename: string): Promise<string[]> {
    const messages = (await linterFor(config).lintText(source, { filePath: resolve(root, filename), warnIgnored: true }))[0]!.messages;
    expect(messages.filter(({ fatal, ruleId }) => fatal || ruleId === null)).toEqual([]);
    return messages
      .filter(({ ruleId }) => ["no-restricted-imports", "no-restricted-syntax", "@typescript-eslint/no-restricted-imports"].includes(ruleId!))
      .map(({ message }) => message);
  }

  it.each(sourceExtensions)("checks contracts loader syntax independently of path spelling in %s", async extension => {
    const config = await loadConfig();
    const { PLATFORM_MODULE_GRAPH: graph, platformModuleRules } = await import("../../eslint.config.js");
    const contractsConfig = [...config, ...platformModuleRules({ name: "@openlup/platform", directory: "platform" }, "composition", {
      ...graph, composition: { ...graph.composition, contracts: true },
    })] as Linter.Config[];
    const filename = `packages/platform/src/composition/contracts/usesContracts.${extension}`;
    const refusal = expect.stringContaining('packages/platform module "composition" contracts import only');
    for (const specifier of ["./own.js", "@openlup/core/platform-runtime", "../server.js", "pg"]) {
      for (const source of loadSources(specifier, extension)) {
        const messages = await moduleMessages(contractsConfig, source, filename);
        const requireHandle = source.startsWith("const value = require(") || source.startsWith("const value = module.require(");
        if ((specifier === "./own.js" || specifier === "@openlup/core/platform-runtime") && !requireHandle)
          expect(messages).toEqual([]);
        else expect(messages).toContainEqual(refusal);
      }
    }
  });

  it.each(sourceExtensions)("checks module value and type edges for every load syntax in %s", async extension => {
    const config = await loadConfig();
    for (const [module, specifier, permission] of [
      ["composition", "../data/index.js", "value"],
      ["kernel", "../data/index.js", "refused"],
      ["http", "../bff/index.js", "type"],
      ["kernel", "@openlup/platform/composition", "refused"],
    ]) {
      for (const source of loadSources(specifier!, extension)) {
        const messages = await moduleMessages(config, source, `packages/platform/src/${module}/usesModule.${extension}`);
        if (permission === "value" || permission === "type" && typeOnlyForm.test(source)) expect(messages).toEqual([]);
        else expect(messages).toContainEqual(expect.stringContaining(`packages/platform module "${module}"`));
      }
    }
  });

  it.each(sourceExtensions)("isolates a declared contracts sub-entry in %s (negative plants)", async (extension) => {
    const config = await loadConfig();
    const { PLATFORM_MODULE_GRAPH: graph, platformModuleRules } = await import("../../eslint.config.js");
    const syntheticGraph = { ...graph, composition: { ...graph.composition, contracts: true } };
    const contractsConfig = [...config, ...platformModuleRules({ name: "@openlup/platform", directory: "platform" }, "composition", syntheticGraph)] as Linter.Config[];
    const refusal = expect.stringContaining('packages/platform module "composition" contracts import only');
    for (const depth of [0, 2, 11]) {
      const filename = `packages/platform/src/composition/contracts/${"nested/".repeat(depth)}usesContracts.${extension}`;
      const up = "../".repeat(depth + 1);
      for (const specifier of ["./own.js", "./nested/own.js", "@openlup/core/platform-runtime", ...(depth === 2 ? ["../own.js", "../../own.js"] : [])]) {
        for (const source of loadSources(specifier, extension, false)) {
          const messages = await moduleMessages(contractsConfig, source, filename);
          if (source.startsWith("const value = require(") || source.startsWith("const value = module.require(")) expect(messages).toContainEqual(refusal);
          else expect(messages).toEqual([]);
        }
      }
      for (const specifier of [
        `${up}index.js`, `${up}server.js`, `${up}../data/index.js`, `${up}../http/index.js`,
        `${up}contracts/../server.js`, "./bridge.testFixtures.js", "./bridge.test.js", "././own.js", "./nested/../own.js",
        "./helper.mjs", "./helper.cjs", "./helper.mts", "./helper.cts", "./helper.ts", "./helper.tsx", "./helper.json", "./helper",
        "./%2e%2e/server.js", "./..\\server.js", "./own.js?server", "node:fs", "pg", managedProvider, "zod", "some-new-sdk",
        "@openlup/platform/composition/contracts", "@openlup/core", "@openlup/core/src/private", "@openlup/core/platform-runtime/extra",
        "@OpenLup/core/platform-runtime", "/composition/contracts/index.js", "file:///composition/contracts/index.js", "#alias", "@/alias",
        ...(depth === 11 ? ["../own.js"] : []),
      ]) {
        for (const source of loadSources(specifier, extension, false)) expect(await moduleMessages(contractsConfig, source, filename)).toContainEqual(refusal);
      }
      for (const target of ["target", '"p" + "g"', "`./${target}.js`", "42", "null"]) {
        for (const source of [
          `import(${target});`, `require(${target});`, `module.require(${target});`,
          `globalThis.require(${target});`, `process.mainModule.require(${target});`, `module["require"](${target});`, `registry["require"](${target});`,
        ]) expect(await moduleMessages(contractsConfig, source, filename)).toContainEqual(refusal);
      }
      for (const source of ["require();", "module.require();", "require(...targets);"]) {
        expect(await moduleMessages(contractsConfig, source, filename)).toContainEqual(refusal);
      }
      // No graph declaration admits even an otherwise safe contracts import.
      for (const source of loadSources("./own.js", extension)) {
        expect(await moduleMessages(config, source, filename)).toContainEqual(expect.stringContaining("has no declared contracts entry"));
      }
    }
    for (const contracts of [false, "contracts", ["contracts", "client"]]) {
      expect(() => platformModuleRules({ name: "@openlup/platform", directory: "platform" }, "composition", {
        ...graph, composition: { ...graph.composition, contracts },
      })).toThrow("contracts must be true or omitted");
    }
  });

  it("refuses ambient loader identifiers in contracts values and types (negative plants)", async () => {
    const config = await loadConfig();
    const { PLATFORM_MODULE_GRAPH: graph, platformModuleRules } = await import("../../eslint.config.js");
    const syntheticGraph = { ...graph, composition: { ...graph.composition, contracts: true } };
    const contractsConfig = [...config, ...platformModuleRules({ name: "@openlup/platform", directory: "platform" }, "composition", syntheticGraph)] as Linter.Config[];
    for (const depth of [0, 2, 11]) {
      const filename = `packages/platform/src/composition/contracts/${"nested/".repeat(depth)}usesHandle.ts`;
      for (const identifier of ["require", "module", "exports", "process", "globalThis", "global", "__dirname", "__filename", "Buffer"]) {
        for (const source of [`const value = ${identifier};`, `type Value = typeof ${identifier};`, `type Value = ${identifier};`]) {
          expect(await moduleMessages(contractsConfig, source, filename), source)
            .toContainEqual(expect.stringContaining("Contracts must not reference ambient loader identifiers"));
        }
      }
      for (const source of ["import.meta;", "const value = import.meta.url;"]) {
        expect(await moduleMessages(contractsConfig, source, filename), source)
          .toContainEqual(expect.stringContaining("Contracts must not reference ambient loader identifiers"));
      }
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
  ])("refuses a wrapped or builtin contracts loader: %s (negative plant)", async (source) => {
    const config = await loadConfig();
    const { PLATFORM_MODULE_GRAPH: graph, platformModuleRules } = await import("../../eslint.config.js");
    const syntheticGraph = { ...graph, composition: { ...graph.composition, contracts: true } };
    const contractsConfig = [...config, ...platformModuleRules({ name: "@openlup/platform", directory: "platform" }, "composition", syntheticGraph)] as Linter.Config[];
    expect(await moduleMessages(contractsConfig, source, "packages/platform/src/composition/contracts/usesLoader.ts"))
      .toContainEqual(expect.stringContaining("Contracts must not reference ambient loader identifiers"));
  });

  it("permits browser-safe contracts types, validators, pure functions and allowed imports (positive plant)", async () => {
    const config = await loadConfig();
    const { PLATFORM_MODULE_GRAPH: graph, platformModuleRules } = await import("../../eslint.config.js");
    const syntheticGraph = { ...graph, composition: { ...graph.composition, contracts: true } };
    const contractsConfig = [...config, ...platformModuleRules({ name: "@openlup/platform", directory: "platform" }, "composition", syntheticGraph)] as Linter.Config[];
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
    expect(await moduleMessages(contractsConfig, source, "packages/platform/src/composition/contracts/index.ts")).toEqual([]);
  });

  it("declares exactly the package's module directories, each edge to another declared module", async () => {
    const { PLATFORM_MODULE_GRAPH: graph } = await import("../../eslint.config.js") as unknown as {
      PLATFORM_MODULE_GRAPH: Record<string, { values: string[]; types: string[] }>;
    };
    const entries = readdirSync(platformSource, { withFileTypes: true });
    expect(entries.filter((entry) => !entry.isDirectory()).map(({ name }) => name)).toEqual([]);
    expect(Object.keys(graph).sort()).toEqual([...entries.map(({ name }) => name), "commerce/server"].sort());
    for (const [module, { values, types }] of Object.entries(graph)) {
      for (const target of [...values, ...types]) {
        const [owner, ...entry] = target.split("/");
        expect(Object.keys(graph)).toContain(owner);
        expect(owner).not.toBe(module);
        if (entry.length) {
          expect(entry).toHaveLength(1);
          expect(["contracts", "server"]).toContain(entry[0]);
          expect(Reflect.get(graph[owner!]!, entry[0]!)).toBe(true);
        }
      }
      expect([...values, ...types]).not.toContain(module);
      expect(values.filter((target) => types.includes(target))).toEqual([]);
    }
  });

  it.each(sourceExtensions)(
    "admits own files and declared entries and refuses every other module path in %s at every supported depth",
    async (extension) => {
      const config = await loadConfig();
      // These depth cases read the same immutable config; keep every input and assertion.
      for (const depth of [0, 1, 10]) {
        const file = (module: string) => `packages/platform/src/${module}/${"nested/".repeat(depth)}usesModule.${extension}`;
        const up = "../".repeat(depth + 1);
        const refusal = (module: string) => expect.stringContaining(`packages/platform module "${module}"`);
        const admitted = async (module: string, specifier: string, onlyTypes = false) => {
          for (const source of loadSources(specifier, extension, onlyTypes)) {
            const messages = await moduleMessages(config, source, file(module));
            if (!onlyTypes || typeOnlyForm.test(source)) expect(messages).toEqual([]);
            else expect(messages).toContainEqual(refusal(module));
          }
        };
        const refused = async (module: string, specifier: string) => {
          for (const source of loadSources(specifier, extension, false)) expect(await moduleMessages(config, source, file(module))).toContainEqual(refusal(module));
        };

        // Own internals, from the module's files and through the source root.
        for (const specifier of ["./own.js", `${up}composition/own.js`, ...(depth > 0 ? ["../own.js"] : [])]) await admitted("composition", specifier);
        // Declared value edges through the target's entry.
        await admitted("composition", `${up}data/index.js`);
        await admitted("communications", `${up}data/index.js`);
        await admitted("communications", `${up}identity/index.js`);
        await admitted("communications", `${up}http/index.js`, true);
        await refused("communications", `${up}data/postgresGateway.js`);
        await refused("communications", `${up}bff/index.js`);
        await admitted("identity", `${up}bff/index.js`);
        await admitted("identity", `${up}data/index.js`);
        await admitted("identity", `${up}kernel/index.js`);
        await admitted("identity", `${up}http/index.js`, true);
        await refused("identity", `${up}data/postgresGateway.js`);
        await refused("identity", `${up}composition/index.js`);
        await refused("identity", `${up}scheduler/index.js`);
        await admitted("bff", `${up}kernel/index.js`);
        // A types edge admits type-only imports; any load that brings in a value is refused.
        await admitted("http", `${up}bff/index.js`, true);
        await admitted("job-ledger", `${up}data/index.js`, true);
        // Deep imports into a neighbour, even along a declared edge.
        for (const specifier of [`${up}data/postgresGateway.js`, `${up}data/index.ts`, `${up}data/index`, `${up}data`, `${up}data/`]) await refused("composition", specifier);
        await refused("http", `${up}bff/dispatch.js`);
        // Undeclared directions, even through the target's public entry.
        await refused("kernel", `${up}composition/index.js`);
        await refused("data", `${up}blob/index.js`);
        await refused("scheduler", `${up}bff/index.js`);
        await refused("migrations", `${up}kernel/index.js`);
        await refused("blob", `${up}data/index.js`);
        // Escapes around the relative entry: package self-reference, URL, unnormalized or out-of-source paths.
        for (const specifier of [
          "@openlup/platform/composition", "@openlup/platform", "file:///packages/platform/src/composition/index.js",
          `${up}kernel/../composition/index.js`, `./x/../${up}composition/index.js`, `${up}./composition/index.js`,
          `${up}../src/composition/index.js`, `././${up}composition/index.js`, `./.x/../${up}composition/index.js`,
          `${up}kernel/.x/../../composition/index.js`, `./..\\composition\\index.js`, `./%2e%2e/composition/index.js`,
          `${up}kernel//../composition/index.js`, `.//${up}composition/index.js`,
          ...["\t", "\n", "\r"].flatMap((control) => [`${up}kernel/${control}../composition/index.js`, `./${control}${up}composition/index.js`]),
          "\tfile:///packages/platform/src/composition/index.js", " file:///packages/platform/src/composition/index.js",
          // A dependency without an exports map resolves a climb in its subpath back into this tree.
          "accepts/../../packages/platform/src/composition/index.js", "zod/../../packages/platform/src/data/postgresGateway.js",
          "accepts/./index.js", "accepts//index.js", "accepts/", "accepts/%2e%2e/index.js", "node:fs/../index.js",
          // A case-insensitive file system resolves another spelling of the scope to the workspace links.
          "@OpenLup/platform/composition", "@OPENLUP/platform", "@openLup/core/platform-runtime",
          // Test and fixture files are outside these rules, so a production file may not relay through one.
          "./bridge.testFixtures.js", "./bridge.test.js", `${up}kernel/bridge.testFixtures.ts`,
        ]) await refused("kernel", specifier);
        // Ordinary package and built-in specifiers stay admitted.
        for (const specifier of ["pg", "zod", "node:fs/promises", "@openlup/core/platform-runtime", "./testing.js", "./latest.js"]) await admitted("kernel", specifier);
      }
    },
    // Each extension checks all three depths; retain the existing bounded deadline.
    60_000);

  it.each(sourceExtensions)("keeps refusing self-reference and URL escapes beyond the deepest module depth in %s", async (extension) => {
    const config = await loadConfig();
    const filename = `packages/platform/src/kernel/${"nested/".repeat(11)}usesModule.${extension}`;
    for (const source of loadSources("./own.js", extension)) expect(await moduleMessages(config, source, filename)).toEqual([]);
    for (const specifier of ["@openlup/platform/composition", "@OpenLup/platform/composition", "file:///packages/platform/src/composition/index.js", "././own.js", "./bridge.testFixtures.js"]) {
      for (const source of loadSources(specifier, extension)) {
        expect(await moduleMessages(config, source, filename)).toContainEqual(expect.stringContaining('packages/platform module "kernel"'));
      }
    }
    for (const source of loadSources("../composition/index.js", extension)) {
      expect(await moduleMessages(config, source, filename)).toContainEqual(expect.stringContaining("A file under packages/platform stays package-local"));
    }
  });

  it("admits only declared Node-entry edges and refuses reverse commerce imports", async () => {
    const config = await loadConfig();
    const { PLATFORM_MODULE_GRAPH: graph } = await import("../../eslint.config.js");
    expect(graph["commerce/server"]).toEqual({ values: ["commerce", "fulfillment", "pricing", "shipping", "promotions"], types: ["http", "bff", "commerce/contracts"] });
    expect(graph.commerce.values).not.toContain("commerce/server");
    expect(graph.commerce.values).toEqual(["pricing/contracts", "shipping"]);
    for (const depth of [0, 1]) {
      const up = "../".repeat(depth);
      const file = `packages/platform/src/commerce/server/${"nested/".repeat(depth)}probe.ts`;
      const source = (specifier: string) => `import * as value from ${JSON.stringify(specifier)}; export { value };`;
      for (const specifier of ["./own.js", `${up}../index.js`, "node:crypto",
        ...["commerceReturnsPort", "orderReviewContracts", "orderReviewPorts", "orderFeedbackContracts"].map((file) => `${up}../${file}.js`),
        `${up}../../commerce/index.js`]) {
        expect(await moduleMessages(config, source(specifier), file), specifier).toEqual([]);
      }
      for (const entry of ["http", "bff"]) {
        for (const source of loadSources(`${up}../../${entry}/index.js`, "ts", true)) {
          const messages = await moduleMessages(config, source, file);
          if (typeOnlyForm.test(source)) expect(messages).toEqual([]);
          else expect(messages).toContainEqual(expect.stringContaining('packages/platform module "commerce/server"'));
        }
      }
      for (const specifier of [`${up}../../data/index.js`, `${up}../../blob/index.js`, `${up}../../data/private.js`, `${up}../../identity/index.js`]) {
        expect(await moduleMessages(config, source(specifier), file), specifier).toContainEqual(expect.stringContaining('packages/platform module "commerce/server"'));
      }
      const browserFile = `packages/platform/src/commerce/${"nested/".repeat(depth)}probe.ts`;
      for (const specifier of [depth ? "../server/index.js" : "./server/index.js", `${up}../commerce/server/index.js`]) {
        expect(await moduleMessages(config, source(specifier), browserFile), specifier).toContainEqual(expect.stringContaining('packages/platform module "commerce"'));
      }
    }
  });

  it.each(sourceExtensions)("limits the commerce fulfillment edge to its server entry in %s", async (extension) => {
    const config = await loadConfig();
    for (const depth of [0, 2]) {
      const directory = "nested/".repeat(depth);
      const up = "../".repeat(depth + 1);
      const browser = `packages/platform/src/commerce/${directory}usesModule.${extension}`;
      const server = `packages/platform/src/commerce/server/${directory}usesModule.${extension}`;
      for (const source of loadSources(`${up}fulfillment/index.js`, extension)) {
        expect(await moduleMessages(config, source, browser)).toContainEqual(expect.stringContaining('module "commerce"'));
      }
      for (const source of loadSources(`../${up}fulfillment/index.js`, extension)) {
        expect(await moduleMessages(config, source, server)).toEqual([]);
      }
      for (const specifier of [`../${up}fulfillment/paidHandoff.js`, `../${up}data/index.js`]) {
        for (const source of loadSources(specifier, extension)) {
          expect(await moduleMessages(config, source, server)).toContainEqual(expect.stringContaining('module "commerce/server"'));
        }
      }
    }
  });

  it.each(sourceExtensions)("keeps checkout server edges separate from browser and contracts in %s", async extension => {
    const config = await loadConfig();
    for (const [file, target, permission, module] of [
      ["commerce/usesModule", "../pricing/index.js", "refused", "commerce"],
      ["commerce/contracts/usesModule", "../../pricing/index.js", "refused", "commerce"],
      ["commerce/server/usesModule", "../../pricing/index.js", "value", "commerce/server"],
      ["commerce/server/usesModule", "../../promotions/index.js", "value", "commerce/server"],
      ["commerce/server/usesModule", "../../http/index.js", "type", "commerce/server"],
      ["commerce/server/usesModule", "../../pricing/quotePorts.js", "refused", "commerce/server"],
      ["commerce/server/nested/usesModule", "../../../shipping/index.js", "value", "commerce/server"],
      ["commerce/server/nested/usesModule", "../../../data/index.js", "refused", "commerce/server"],
    ]) {
      for (const source of loadSources(target!, extension)) {
        const messages = await moduleMessages(config, source, `packages/platform/src/${file}.${extension}`);
        if (permission === "value" || permission === "type" && typeOnlyForm.test(source)) expect(messages).toEqual([]);
        else expect(messages).toContainEqual(expect.stringContaining(`packages/platform module "${module}"`));
      }
    }
  });

  it("declares exactly the inventoried edges; only the composer may declare more", async () => {
    const { PLATFORM_MODULE_GRAPH: graph } = await import("../../eslint.config.js") as unknown as {
      PLATFORM_MODULE_GRAPH: Record<string, { values: string[]; types: string[] }>;
    };
    const ts = (await import("typescript")).default;
    const actual = new Map(Object.keys(graph).map((module) => [module, { values: new Set<string>(), types: new Set<string>() }]));
    const moduleNames = Object.keys(graph).sort((a, b) => b.length - a.length);
    const owner = (file: string) => {
      const path = relative(platformSource, file).split(sep).join("/");
      return moduleNames.find((module) => path.startsWith(`${module}/`))!;
    };
    const files = (directory: string): string[] => readdirSync(directory, { withFileTypes: true })
      .flatMap((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : /\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [join(directory, entry.name)] : []);
    for (const path of files(platformSource)) {
      const module = owner(path);
      const source = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
      const edge = (specifier: string, typeOnly: boolean) => {
        if (!specifier.startsWith(".")) return;
        const resolved = resolve(dirname(path), specifier);
        const targetOwner = owner(resolved);
        const targetPath = relative(platformSource, resolved).split(sep).join("/");
        const target = targetPath === `${targetOwner}/contracts/index.js` ? `${targetOwner}/contracts` : targetOwner;
        if (targetOwner !== module) actual.get(module)![typeOnly ? "types" : "values"].add(target);
      };
      const visit = (node: import("typescript").Node): void => {
        if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          const clause = ts.isImportDeclaration(node) ? node.importClause : undefined;
          const named = ts.isImportDeclaration(node) ? (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings) ? clause.namedBindings.elements : undefined)
            : (node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : undefined);
          const typeOnly = (ts.isImportDeclaration(node) ? clause?.isTypeOnly === true : node.isTypeOnly) || (named !== undefined && named.length > 0 && named.every((element) => element.isTypeOnly));
          edge(node.moduleSpecifier.text, typeOnly);
        }
        if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteral(node.arguments[0]) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
          || (ts.isIdentifier(node.expression) && node.expression.text === "require")
          || (ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "module" && node.expression.name.text === "require"))) edge(node.arguments[0].text, false);
        if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression)) edge(node.moduleReference.expression.text, node.isTypeOnly);
        if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) edge(node.argument.literal.text, true);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    for (const [module, { values, types }] of actual) {
      const typesOnly = [...types].filter((target) => !values.has(target)).sort();
      if (module === "composition") {
        for (const target of [...values, ...typesOnly]) expect(graph[module]!.values).toContain(target);
        continue;
      }
      expect({ module, values: [...values].sort(), types: typesOnly }).toEqual({ module, values: [...graph[module]!.values].sort(), types: [...graph[module]!.types].sort() });
    }
  });
});
