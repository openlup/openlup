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
  return new Linter({ cwd: root })
    .verify(`import value from "${specifier}";\nexport { value };\n`, config, domainFile)
    .filter(({ ruleId }) => ruleId === "no-restricted-imports")
    .map(({ message }) => message);
}

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
