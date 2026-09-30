import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Linter } from "eslint";
import { afterEach, describe, expect, it, vi } from "vitest";

// eslint.config.js reads the root package.json `imports` map to find the aliases
// that resolve into infra code, which domain code may not import. Node also
// allows a condition object as a target; these tests load the real config with
// such a map in place of the committed one.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = join(root, "package.json");
const domainFile = join(root, "src/domains/example/usesAlias.ts");

type ReadFileSync = typeof import("node:fs").readFileSync;

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

function restrictedImports(config: Linter.Config[], specifier: string): string[] {
  return boundaryMessages(config, `import value from ${JSON.stringify(specifier)};\nexport { value };\n`, domainFile);
}

function boundaryMessages(config: Linter.Config[], source: string, filename: string): string[] {
  const messages = new Linter({ cwd: root }).verify(source, config, resolve(root, filename));
  // A parse failure or unmatched config is not proof that a boundary refused.
  expect(messages.filter(({ fatal, ruleId }) => fatal || ruleId === null)).toEqual([]);
  return messages
    .filter(({ ruleId }) => ruleId === "no-restricted-imports" || ruleId === "no-restricted-syntax")
    .map(({ message }) => message);
}

function loadSources(specifier: string, extension: string): string[] {
  const quoted = JSON.stringify(specifier);
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

describe("eslint import-map boundary", () => {
  it("keeps string targets: an alias into infra code is refused in domain code", async () => {
    const config = await loadConfig({
      "#plain-infra": "./server/adapters/example.ts",
      "#plain-neutral": "./src/lib/example.ts",
    });
    expect(restrictedImports(config, "#plain-infra")).toEqual([expect.stringContaining("Domain code must not import")]);
    expect(restrictedImports(config, "#plain-neutral")).toEqual([]);
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
      expect(restrictedImports(config, alias)).toEqual([expect.stringContaining("Domain code must not import")]);
    }
    expect(restrictedImports(config, "#overlay-neutral")).toEqual([]);
    expect(restrictedImports(config, "#array-neutral")).toEqual([]);
  });

  it("still applies the committed import map", async () => {
    const config = await loadConfig();
    expect(restrictedImports(config, "#acquisition-case-routes")).toEqual([expect.stringContaining("Domain code must not import")]);
    expect(restrictedImports(config, "#deployment-analytics")).toEqual([]);
  });
});

describe("eslint portable package boundaries", () => {
  it("rejects every existing provider family in both portable source trees", async () => {
    const config = await loadConfig();
    for (const pkg of portablePackages) for (const specifier of [
      cardProvider, `${cardProvider}/subpath`, "pg", "openai", `@${cardProvider}/${cardProvider}-js`,
      managedProvider, "@vercel/blob", "@modelcontextprotocol/sdk",
    ]) {
      expect(boundaryMessages(config, `import value from ${JSON.stringify(specifier)};`, `packages/${pkg}/src/usesProvider.ts`))
        .toEqual([expect.stringContaining("Portable package source must not import provider SDKs")]);
    }
  });

  it.each(sourceExtensions)("refuses ordinary provider imports and loads in %s source", async (extension) => {
    const config = await loadConfig();
    for (const pkg of portablePackages) for (const specifier of [managedProvider, "@vercel/blob"]) {
      for (const source of loadSources(specifier, extension)) {
        expect(boundaryMessages(config, source, `packages/${pkg}/src/nested/usesProvider.${extension}`))
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
        expect(boundaryMessages(config, source, filename)).toEqual([]);
      }
    }
  });

  it("keeps literal CommonJS under the existing domain and public package export boundaries", async () => {
    const config = await loadConfig();
    for (const source of [
      'const value = require("@vercel/blob");',
      'const value = module.require(`@vercel/blob`);',
    ]) expect(boundaryMessages(config, source, "server/domains/example/usesProvider.cjs"))
      .toEqual([expect.stringContaining("Domain code must not import")]);
    for (const source of [
      'const value = require("@openlup/core/src/payment/index.ts");',
      'const value = module.require(`../../packages/core/src/payment/index.ts`);',
    ]) expect(boundaryMessages(config, source, "server/adapters/example.cjs"))
      .toEqual([expect.stringContaining("Import a workspace package only through a subpath")]);
    expect(boundaryMessages(config, 'const value = require("@openlup/core/payment");', "server/adapters/example.cjs"))
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
      ]) expect(boundaryMessages(config, source, filename))
        .toEqual([expect.stringContaining(`A file under packages/${pkg} imports nothing outside that directory`)]);

      expect(boundaryMessages(config, 'import value from "./internal";', filename)).toEqual([]);
      const parent = `${"../".repeat(Math.max(depth, 1))}internal`;
      expect(boundaryMessages(config, `import value from "${parent}";`, filename))
        .toEqual(depth === 0 || depth > 12
          ? [expect.stringContaining(`A file under packages/${pkg} imports nothing outside that directory`)]
          : []);
      if (depth > 0) {
        expect(boundaryMessages(config, 'import value from "@vercel/blob";', filename))
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
          expect(boundaryMessages(config, source, filename))
            .toEqual([expect.stringContaining(`A file under packages/${pkg} imports nothing outside that directory`)]);
        }
      }
    }
  });

  it("permits neutral dependencies, internal code and ordinary provider-valued data", async () => {
    const config = await loadConfig();
    for (const pkg of portablePackages) for (const extension of sourceExtensions) {
      const filename = `packages/${pkg}/src/nested/usesPort.${extension}`;
      for (const specifier of ["zod", "./internal", "../ports", `${cardProvider}-helper`, "@vercel-like/sdk"]) {
        for (const source of loadSources(specifier, extension)) expect(boundaryMessages(config, source, filename)).toEqual([]);
      }
      expect(boundaryMessages(config, 'const providerLabel = "@vercel/blob";', filename)).toEqual([]);
      expect(boundaryMessages(config, 'const value = registry.require("@vercel/blob");', filename)).toEqual([]);
    }
  });
});
