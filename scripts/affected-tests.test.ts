import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MAX_DEPTH,
  classifyTestRunner,
  executeAffectedRootVitest,
  extractStaticImports,
  findAffectedTests,
  formatAffectedTestsText,
  parseAffectedArgs,
  resolveImportPath,
} from "./affected-tests.mjs";

const tempDirs: string[] = [];

function createTempRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "affected-tests-fixture-"));
  tempDirs.push(dir);
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(dir, relPath);
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("affected-tests", () => {
  it("parses CLI arguments and rejects malformed options", () => {
    expect(parseAffectedArgs([])).toEqual({
      base: null,
      files: null,
      json: false,
      run: false,
      dryRun: false,
      hosted: false,
      noPostgres: false,
      maxDepth: DEFAULT_MAX_DEPTH,
      vitestArgs: [],
    });
    expect(parseAffectedArgs(["--base", "origin/main", "--json"])).toEqual({
      base: "origin/main",
      files: null,
      json: true,
      run: false,
      dryRun: false,
      hosted: false,
      noPostgres: false,
      maxDepth: DEFAULT_MAX_DEPTH,
      vitestArgs: [],
    });
    expect(parseAffectedArgs(["--base=main", "--run", "--dry-run", "--hosted", "--no-postgres", "--max-depth=5", "--", "-t", "focus"])).toEqual({
      base: "main",
      files: null,
      json: false,
      run: true,
      dryRun: true,
      hosted: true,
      noPostgres: true,
      maxDepth: 5,
      vitestArgs: ["-t", "focus"],
    });
    expect(parseAffectedArgs(["--files", "a.ts,b.ts", "--json", "--max-depth", "0"])).toEqual({
      base: null,
      files: ["a.ts", "b.ts"],
      json: true,
      run: false,
      dryRun: false,
      hosted: false,
      noPostgres: false,
      maxDepth: 0,
      vitestArgs: [],
    });
    expect(parseAffectedArgs(["--files=a.ts", "--files=b.ts,c.ts"])).toEqual({
      base: null,
      files: ["a.ts", "b.ts", "c.ts"],
      json: false,
      run: false,
      dryRun: false,
      hosted: false,
      noPostgres: false,
      maxDepth: DEFAULT_MAX_DEPTH,
      vitestArgs: [],
    });

    expect(() => parseAffectedArgs(["--base"])).toThrow(/--base requires/);
    expect(() => parseAffectedArgs(["--files="])).toThrow(/--files requires/);
    expect(() => parseAffectedArgs(["--max-depth", "-1"])).toThrow(/--max-depth requires/);
    expect(() => parseAffectedArgs(["--max-depth=abc"])).toThrow(/--max-depth requires/);
    expect(() => parseAffectedArgs(["--unknown"])).toThrow(/Unknown option/);
  });

  it("extracts static, dynamic, and vi.mock imports via AST even after regex literals with odd quotes and long imports", () => {
    const longNamedImports = Array.from({ length: 80 }, (_, idx) => `symbolNumber${idx}`).join(",\n        ");
    const source = `
      // import { ignoredLine } from "./ignored-line.js";
      /*
        import { ignoredBlock } from "./ignored-block.js";
      */
      const oddQuoteRegex = /lower\\(btrim\\(client\\.email(?:, E'[^']*')?\\)\\)/u;
      import "./side-effect.mjs";
      import defaultExport, {
        ${longNamedImports}
      } from "./moduleA.js";
      import type { Contract } from "@openlup/core/bundle";
      export { helper } from "../shared/helper.js";
      export * from "@openlup/outbox";
      export const message = "hello";
      const text = "not from './fake.js'";
      async function load(dynamicName: string) {
        await import("./dynamic-target.js");
        await import(\`./template-target.js\`);
        await import(dynamicName);
      }
      vi.mock("#deployment-route-policy", () => ({}));
      vi.doMock("./do-mock-target.js", () => ({}));
      const actual = await vi.importActual("./actual-target.js");
    `;
    expect(extractStaticImports(source, "sample.ts")).toEqual([
      "#deployment-route-policy",
      "../shared/helper.js",
      "./actual-target.js",
      "./do-mock-target.js",
      "./dynamic-target.js",
      "./moduleA.js",
      "./side-effect.mjs",
      "./template-target.js",
      "@openlup/core/bundle",
      "@openlup/outbox",
    ]);
  });

  it("resolves relative, workspace package, @/, and package.json #subpath imports", () => {
    const dir = createTempRepo({
      "package.json": JSON.stringify({
        imports: {
          "#deployment-route-policy": "./server/_lib/publicDeploymentPolicies.ts",
          "#wild/*": "./src/wild/*.ts",
        },
      }),
      "packages/core/package.json": JSON.stringify({
        name: "@openlup/core",
        exports: {
          "./bundle": {
            "core-source": "./src/bundle/contracts.ts",
            import: "./dist/bundle/contracts.js",
          },
        },
      }),
      "packages/core/src/bundle/contracts.ts": "export const x = 1;\n",
      "packages/platform/package.json": JSON.stringify({
        name: "@openlup/platform",
        exports: {
          "./http": {
            import: "./dist/http/index.js",
          },
        },
        imports: {
          "#catalog/schema": "./dist/catalog/catalogSchemaDescription.js",
        },
      }),
      "packages/platform/src/http/index.ts": "export const y = 2;\n",
      "packages/platform/src/catalog/catalogSchemaDescription.ts": "export const schema = 1;\n",
      "packages/outbox/package.json": JSON.stringify({
        name: "@openlup/outbox",
        exports: {
          ".": {
            import: "./dist/index.js",
          },
        },
      }),
      "packages/outbox/src/index.ts": "export const z = 3;\n",
      "server/_lib/publicDeploymentPolicies.ts": "export const policy = true;\n",
      "src/wild/alpha.ts": "export const alpha = 1;\n",
      "src/utils/math.ts": "export const add = (a: number, b: number) => a + b;\n",
      "src/utils/math.test.ts": "import { add } from '@/utils/math';\n",
      "scripts/lib/util.ts": "export const u = 1;\n",
      "scripts/run.mjs": "import { u } from './lib/util.js';\n",
    });

    expect(resolveImportPath("./lib/util.js", "scripts/run.mjs", dir)).toBe("scripts/lib/util.ts");
    expect(resolveImportPath("@openlup/core/bundle", "scripts/run.mjs", dir)).toBe("packages/core/src/bundle/contracts.ts");
    expect(resolveImportPath("@openlup/platform/http", "scripts/run.mjs", dir)).toBe("packages/platform/src/http/index.ts");
    expect(resolveImportPath("@openlup/outbox", "scripts/run.mjs", dir)).toBe("packages/outbox/src/index.ts");
    expect(resolveImportPath("@/utils/math", "src/utils/math.test.ts", dir)).toBe("src/utils/math.ts");
    expect(resolveImportPath("#deployment-route-policy", "server/routes.ts", dir)).toBe("server/_lib/publicDeploymentPolicies.ts");
    expect(resolveImportPath("#wild/alpha", "src/index.ts", dir)).toBe("src/wild/alpha.ts");
    expect(resolveImportPath("#catalog/schema", "packages/platform/test/catalog.test.ts", dir)).toBe("packages/platform/src/catalog/catalogSchemaDescription.ts");
    expect(resolveImportPath("node:fs", "scripts/run.mjs", dir)).toBeNull();
    expect(resolveImportPath("vitest", "scripts/run.mjs", dir)).toBeNull();
  });

  it("maps direct matches, deep transitive reverse imports up to DEFAULT_MAX_DEPTH=8, sibling CLI tests, and deduplicated reasons", () => {
    const chainFiles: Record<string, string> = {
      "packages/platform/package.json": JSON.stringify({
        name: "@openlup/platform",
        exports: {
          "./http": { import: "./dist/http/index.js" },
        },
      }),
      "packages/platform/src/http/index.ts": "export { level2 } from './level2.js';\n",
      "packages/platform/test/http/http.test.ts": "import { level2 } from '@openlup/platform/http';\nexport { level2 };\n",
      "scripts/direct.test.ts": "export const ok = true;\n",
      "scripts/cli-only.mjs": "console.log('cli');\n",
      "scripts/cli-only.test.ts": "// invokes scripts/cli-only.mjs via spawnSync without importing it\n",
    };
    for (let level = 2; level <= 8; level += 1) {
      chainFiles[`packages/platform/src/http/level${level}.ts`] = `export { level${level + 1} } from './level${level + 1}.js';\n`;
    }
    chainFiles["packages/platform/src/http/level9.ts"] = "export const level9 = 9;\n";
    const dir = createTempRepo(chainFiles);

    // Depth 1: test -> http/index.ts
    expect(findAffectedTests({ changedFiles: ["packages/platform/src/http/index.ts"], rootDir: dir }).affectedTests).toEqual([
      { path: "packages/platform/test/http/http.test.ts", reasons: ["import-graph"] },
    ]);

    // Depth 8: within DEFAULT_MAX_DEPTH=8 -> included
    expect(findAffectedTests({ changedFiles: ["packages/platform/src/http/level8.ts"], rootDir: dir }).affectedTests).toEqual([
      { path: "packages/platform/test/http/http.test.ts", reasons: ["import-graph"] },
    ]);

    // Depth 9: beyond DEFAULT_MAX_DEPTH=8 -> excluded unless maxDepth is raised
    expect(findAffectedTests({ changedFiles: ["packages/platform/src/http/level9.ts"], rootDir: dir }).affectedTests).toEqual([]);
    expect(findAffectedTests({ changedFiles: ["packages/platform/src/http/level9.ts"], rootDir: dir, maxDepth: 9 }).affectedTests).toEqual([
      { path: "packages/platform/test/http/http.test.ts", reasons: ["import-graph"] },
    ]);

    // Explicit maxDepth=3 caps at depth 3
    expect(findAffectedTests({ changedFiles: ["packages/platform/src/http/level4.ts"], rootDir: dir, maxDepth: 3 }).affectedTests).toEqual([]);

    // Sibling CLI test without static import
    expect(findAffectedTests({ changedFiles: ["scripts/cli-only.mjs"], rootDir: dir }).affectedTests).toEqual([
      { path: "scripts/cli-only.test.ts", reasons: ["sibling-test"] },
    ]);

    // Direct test match + import-graph combined and deduplicated
    const combined = findAffectedTests({
      changedFiles: [
        "scripts/direct.test.ts",
        "packages/platform/test/http/http.test.ts",
        "packages/platform/src/http/index.ts",
      ],
      rootDir: dir,
    });
    expect(combined.affectedTests).toEqual([
      { path: "packages/platform/test/http/http.test.ts", reasons: ["direct", "import-graph"] },
      { path: "scripts/direct.test.ts", reasons: ["direct"] },
    ]);
  });

  it("classifies tests by runner and supports --no-postgres filtering", () => {
    expect(classifyTestRunner("scripts/affected-tests.test.ts")).toBe("root-vitest");
    expect(classifyTestRunner("packages/platform/test/http/http.test.ts")).toBe("root-vitest");
    expect(classifyTestRunner("tests/postgres/sample.test.ts")).toBe("root-vitest");
    expect(classifyTestRunner("tests/preview/checkout/helpers/util.test.ts")).toBe("root-vitest");
    expect(classifyTestRunner("tests/dom-gate/checkout.test.tsx")).toBe("root-vitest");
    expect(classifyTestRunner("packages/core/test/bundle.test.ts")).toBe("core-vitest");
    expect(classifyTestRunner("tests/preview/checkout/flow.spec.ts")).toBe("separate");
    expect(classifyTestRunner("scripts/legacy.test.mjs")).toBe("separate");

    const dir = createTempRepo({
      "packages/core/test/bundle.test.ts": "// core\n",
      "tests/preview/checkout/flow.spec.ts": "// playwright\n",
      "tests/postgres/sample.test.ts": "// pg\n",
      "src/app.test.ts": "// root\n",
    });

    const full = findAffectedTests({
      changedFiles: [
        "packages/core/test/bundle.test.ts",
        "tests/preview/checkout/flow.spec.ts",
        "tests/postgres/sample.test.ts",
        "src/app.test.ts",
      ],
      rootDir: dir,
    });
    expect(full.runners).toEqual({
      rootVitest: ["src/app.test.ts", "tests/postgres/sample.test.ts"],
      coreVitest: ["packages/core/test/bundle.test.ts"],
      separate: ["tests/preview/checkout/flow.spec.ts"],
    });

    const noPg = findAffectedTests({
      changedFiles: [
        "packages/core/test/bundle.test.ts",
        "tests/preview/checkout/flow.spec.ts",
        "tests/postgres/sample.test.ts",
        "src/app.test.ts",
      ],
      rootDir: dir,
      includePostgres: false,
    });
    expect(noPg.runners).toEqual({
      rootVitest: ["src/app.test.ts"],
      coreVitest: ["packages/core/test/bundle.test.ts"],
      separate: ["tests/preview/checkout/flow.spec.ts"],
    });
  });

  it("applies contract-pin rules and filters out non-existent test files", () => {
    const dir = createTempRepo({
      "packages/platform/src/billing/settings-data.json": "{}\n",
      "examples/neutral-store/owned/settings.json": "{}\n",
      "examples/neutral-store/client/App.tsx": "export default function App() { return null; }\n",
      "packages/core/release-gates.json": "{}\n",
      "packages/core/docs/guide/how-to/run.md": "# guide\n",
      "config/openlup-publication-catalog.json": "{}\n",
      "config/vitest-shard-weights.json": "{}\n",
      "config/ci-postgres-suite-closures.json": "{}\n",
      "config/ci-quarantine.json": "{}\n",
      "config/doc-routing.json": "{}\n",
      "supabase/migrations/20261123000000_init.sql": "-- sql\n",
      // Create only a subset of candidate pinned tests on disk to verify existence filtering
      "scripts/settings-catalogue.test.ts": "// exists\n",
      "packages/platform/test/operations/settingsCommand.test.ts": "// exists\n",
      "scripts/packages/distribution-cli-settings.test.ts": "// exists\n",
      "scripts/packages/package-size-policy.test.ts": "// exists\n",
      "scripts/oss-published-tree-check.test.ts": "// exists\n",
      "scripts/platform-migration-manifest.test.ts": "// exists\n",
      "scripts/ci-vitest-shard.test.ts": "// exists\n",
      "scripts/ci-test-scope.test.ts": "// exists\n",
      "scripts/ci-quarantine.test.ts": "// exists\n",
      "scripts/documentation-cli.test.ts": "// exists\n",
      "scripts/starter-browser-ci.test.ts": "// exists\n",
    });

    expect(
      findAffectedTests({ changedFiles: ["packages/platform/src/billing/settings-data.json"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "packages/platform/test/operations/settingsCommand.test.ts", reasons: ["contract-pin"] },
      { path: "scripts/settings-catalogue.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["examples/neutral-store/owned/settings.json"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "packages/platform/test/operations/settingsCommand.test.ts", reasons: ["contract-pin"] },
      { path: "scripts/packages/distribution-cli-settings.test.ts", reasons: ["contract-pin"] },
      { path: "scripts/starter-browser-ci.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["examples/neutral-store/client/App.tsx"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "scripts/starter-browser-ci.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["config/vitest-shard-weights.json"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "scripts/ci-vitest-shard.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["config/ci-postgres-suite-closures.json"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "scripts/ci-test-scope.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["config/ci-quarantine.json"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "scripts/ci-quarantine.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["config/doc-routing.json"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "scripts/documentation-cli.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["packages/core/release-gates.json"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "scripts/documentation-cli.test.ts", reasons: ["contract-pin"] },
      { path: "scripts/packages/package-size-policy.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["packages/core/docs/guide/how-to/run.md"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "scripts/documentation-cli.test.ts", reasons: ["contract-pin"] },
      { path: "scripts/packages/package-size-policy.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["config/openlup-publication-catalog.json"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "scripts/oss-published-tree-check.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["supabase/migrations/20261123000000_init.sql"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "scripts/platform-migration-manifest.test.ts", reasons: ["contract-pin"] },
    ]);
  });

  it("pins canonical SQL and migration documentation to their contract tests", () => {
    const dir = createTempRepo(Object.fromEntries([
      "scripts/platform-migration-manifest.test.ts",
      "scripts/packages/platform-migration-projection.test.ts",
      "scripts/pgtap-parity.test.ts",
      "scripts/sql-admit.test.ts",
      "scripts/documentation-links.test.ts",
      "scripts/reviewed-native-store-forward.test.ts",
    ].map((path) => [path, "// exists\n"])));
    const sql = [
      "scripts/packages/platform-migration-projection.test.ts",
      "scripts/pgtap-parity.test.ts",
      "scripts/platform-migration-manifest.test.ts",
      "scripts/sql-admit.test.ts",
    ].sort();
    for (const path of ["db/platform/migrations/20261123000000_change.sql", "packages/platform/sql/20261123000000_change.sql"]) {
      expect(findAffectedTests({ changedFiles: [path], rootDir: dir }).affectedTests)
        .toEqual(sql.map((test) => ({ path: test, reasons: ["contract-pin"] })));
    }
    const docs = ["scripts/documentation-links.test.ts", "scripts/reviewed-native-store-forward.test.ts"];
    for (const path of ["docs/platform/DATA_AND_MIGRATIONS.md", "docs/platform/migrations/compatible-data-transfer.md"]) {
      expect(findAffectedTests({ changedFiles: [path], rootDir: dir }).affectedTests)
        .toEqual(docs.map((test) => ({ path: test, reasons: ["contract-pin"] })));
    }
  });

  it("formats text output with runner-safe vitest commands and separate runner notes", () => {
    const text = formatAffectedTestsText({
      base: "origin/main",
      changedFiles: ["scripts/ci-vitest-shard.mjs"],
      affectedTests: [
        { path: "packages/core/test/bundle.test.ts", reasons: ["direct"] },
        { path: "scripts/ci-vitest-shard.test.ts", reasons: ["import-graph"] },
        { path: "tests/preview/checkout/flow.spec.ts", reasons: ["direct"] },
      ],
    });
    expect(text).toContain("Base ref: origin/main");
    expect(text).toContain("scripts/ci-vitest-shard.test.ts [import-graph]");
    expect(text).toContain("npx --no -- vitest run scripts/ci-vitest-shard.test.ts");
    expect(text).not.toContain("npx --no -- vitest run packages/core/test/bundle.test.ts");
    expect(text).toContain("npm --workspace @openlup/core run ci");
    expect(text).toContain("Separate-runner tests (1, not passed to root Vitest):");

    const hostedText = formatAffectedTestsText({
      base: "origin/main",
      changedFiles: ["scripts/ci-vitest-shard.mjs"],
      affectedTests: [{ path: "scripts/ci-vitest-shard.test.ts", reasons: ["import-graph"] }],
      hosted: true,
      vitestArgs: ["-t", "shard"],
    });
    expect(hostedText).toContain("npm run test:hosted -- scripts/ci-vitest-shard.test.ts -t shard");
  });

  it("executes root Vitest directly via process.execPath for local and hosted modes", () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnOk = vi.fn((command: string, args: string[]) => {
      calls.push({ command, args });
      return { status: 0 };
    });

    expect(executeAffectedRootVitest({ rootVitest: [], rootDir: "/repo", spawnImpl: spawnOk })).toBe(0);
    expect(calls).toEqual([]);

    expect(executeAffectedRootVitest({
      rootVitest: ["scripts/a.test.ts"],
      vitestArgs: ["-t", "ok"],
      rootDir: "/repo",
      spawnImpl: spawnOk,
    })).toBe(0);
    expect(calls).toEqual([
      { command: process.execPath, args: [resolve("/repo", "scripts/build-packages-incremental.mjs")] },
      { command: process.execPath, args: [resolve("/repo", "scripts/run-vitest.mjs"), "run", "scripts/a.test.ts", "-t", "ok"] },
    ]);

    calls.length = 0;
    expect(executeAffectedRootVitest({
      rootVitest: ["scripts/a.test.ts"],
      hosted: true,
      vitestArgs: ["--bail=1"],
      rootDir: "/repo",
      spawnImpl: spawnOk,
    })).toBe(0);
    expect(calls).toEqual([
      { command: process.execPath, args: [resolve("/repo", "scripts/test-hosted.mjs"), "scripts/a.test.ts", "--bail=1"] },
    ]);

    const spawnBuildFail = vi.fn(() => ({ status: 2 }));
    expect(executeAffectedRootVitest({
      rootVitest: ["scripts/a.test.ts"],
      rootDir: "/repo",
      spawnImpl: spawnBuildFail,
    })).toBe(2);
    expect(spawnBuildFail).toHaveBeenCalledTimes(1);
  });

  it("resolves real repository reverse imports, #subpath imports, and contract pins", () => {
    const shardResult = findAffectedTests({
      changedFiles: ["scripts/ci-vitest-shard.mjs"],
    });
    expect(shardResult.affectedTests).toContainEqual({
      path: "scripts/ci-vitest-shard.test.ts",
      reasons: ["import-graph", "sibling-test"],
    });

    const subpathResult = findAffectedTests({
      changedFiles: ["server/_lib/publicDeploymentPolicies.ts"],
    });
    expect(subpathResult.runners.rootVitest.length).toBeGreaterThan(0);

    const catalogResult = findAffectedTests({
      changedFiles: ["config/openlup-publication-catalog.json"],
    });
    expect(catalogResult.affectedTests).toContainEqual({
      path: "scripts/oss-published-tree-check.test.ts",
      reasons: ["contract-pin"],
    });

    const closuresResult = findAffectedTests({
      changedFiles: ["config/ci-postgres-suite-closures.json"],
    });
    expect(closuresResult.affectedTests).toContainEqual({
      path: "scripts/ci-test-scope.test.ts",
      reasons: ["contract-pin"],
    });
  });
});
