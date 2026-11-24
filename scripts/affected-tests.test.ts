import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
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
    expect(parseAffectedArgs([])).toEqual({ base: "HEAD", files: null, json: false });
    expect(parseAffectedArgs(["--base", "origin/main", "--json"])).toEqual({
      base: "origin/main",
      files: null,
      json: true,
    });
    expect(parseAffectedArgs(["--base=main"])).toEqual({
      base: "main",
      files: null,
      json: false,
    });
    expect(parseAffectedArgs(["--files", "a.ts,b.ts", "--json"])).toEqual({
      base: null,
      files: ["a.ts", "b.ts"],
      json: true,
    });
    expect(parseAffectedArgs(["--files=a.ts", "--files=b.ts,c.ts"])).toEqual({
      base: null,
      files: ["a.ts", "b.ts", "c.ts"],
      json: false,
    });

    expect(() => parseAffectedArgs(["--base"])).toThrow(/--base requires/);
    expect(() => parseAffectedArgs(["--files="])).toThrow(/--files requires/);
    expect(() => parseAffectedArgs(["--unknown"])).toThrow(/Unknown option/);
  });

  it("extracts static imports and re-exports while ignoring comments and non-import statements", () => {
    const source = `
      // import { ignoredLine } from "./ignored-line.js";
      /*
        import { ignoredBlock } from "./ignored-block.js";
      */
      import "./side-effect.mjs";
      import defaultExport, {
        alpha,
        beta,
      } from "./moduleA.js";
      import type { Contract } from "@openlup/core/bundle";
      export { helper } from "../shared/helper.js";
      export * from "@openlup/outbox";
      export const message = "hello";
      const text = "not from './fake.js'";
    `;
    expect(extractStaticImports(source)).toEqual([
      "../shared/helper.js",
      "./moduleA.js",
      "./side-effect.mjs",
      "@openlup/core/bundle",
      "@openlup/outbox",
    ]);
  });

  it("resolves relative, workspace package, and @/ imports", () => {
    const dir = createTempRepo({
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
      }),
      "packages/platform/src/http/index.ts": "export const y = 2;\n",
      "packages/outbox/package.json": JSON.stringify({
        name: "@openlup/outbox",
        exports: {
          ".": {
            import: "./dist/index.js",
          },
        },
      }),
      "packages/outbox/src/index.ts": "export const z = 3;\n",
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
    expect(resolveImportPath("node:fs", "scripts/run.mjs", dir)).toBeNull();
    expect(resolveImportPath("vitest", "scripts/run.mjs", dir)).toBeNull();
  });

  it("maps direct matches, transitive reverse imports up to depth 3, and deduplicated reasons", () => {
    const dir = createTempRepo({
      "packages/platform/package.json": JSON.stringify({
        name: "@openlup/platform",
        exports: {
          "./http": { import: "./dist/http/index.js" },
        },
      }),
      "packages/platform/src/http/index.ts": "export { level2 } from './level2.js';\n",
      "packages/platform/src/http/level2.ts": "export { level3 } from './level3.js';\n",
      "packages/platform/src/http/level3.ts": "export { level4 } from './level4.js';\n",
      "packages/platform/src/http/level4.ts": "export const level4 = 4;\n",
      "packages/platform/test/http/http.test.ts": "import { level2 } from '@openlup/platform/http';\nexport { level2 };\n",
      "scripts/direct.test.ts": "export const ok = true;\n",
    });

    // Depth 1: test -> http/index.ts
    expect(findAffectedTests({ changedFiles: ["packages/platform/src/http/index.ts"], rootDir: dir }).affectedTests).toEqual([
      { path: "packages/platform/test/http/http.test.ts", reasons: ["import-graph"] },
    ]);

    // Depth 2: test -> http/index.ts -> level2.ts
    expect(findAffectedTests({ changedFiles: ["packages/platform/src/http/level2.ts"], rootDir: dir }).affectedTests).toEqual([
      { path: "packages/platform/test/http/http.test.ts", reasons: ["import-graph"] },
    ]);

    // Depth 3: test -> http/index.ts -> level2.ts -> level3.ts
    expect(findAffectedTests({ changedFiles: ["packages/platform/src/http/level3.ts"], rootDir: dir }).affectedTests).toEqual([
      { path: "packages/platform/test/http/http.test.ts", reasons: ["import-graph"] },
    ]);

    // Depth 4: beyond default maxDepth=3 -> not included
    expect(findAffectedTests({ changedFiles: ["packages/platform/src/http/level4.ts"], rootDir: dir }).affectedTests).toEqual([]);

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

  it("applies contract-pin rules and filters out non-existent test files", () => {
    const dir = createTempRepo({
      "packages/platform/src/billing/settings-data.json": "{}\n",
      "examples/neutral-store/owned/settings.json": "{}\n",
      "packages/core/release-gates.json": "{}\n",
      "packages/core/docs/guide/how-to/run.md": "# guide\n",
      "config/openlup-publication-catalog.json": "{}\n",
      "supabase/migrations/20261123000000_init.sql": "-- sql\n",
      // Create only a subset of candidate pinned tests on disk to verify existence filtering
      "scripts/settings-catalogue.test.ts": "// exists\n",
      "packages/platform/test/operations/settingsCommand.test.ts": "// exists\n",
      "scripts/packages/distribution-cli-settings.test.ts": "// exists\n",
      "scripts/packages/package-size-policy.test.ts": "// exists\n",
      "scripts/oss-published-tree-check.test.ts": "// exists\n",
      "scripts/platform-migration-manifest.test.ts": "// exists\n",
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
    ]);

    expect(
      findAffectedTests({ changedFiles: ["packages/core/release-gates.json"], rootDir: dir }).affectedTests,
    ).toEqual([
      { path: "scripts/packages/package-size-policy.test.ts", reasons: ["contract-pin"] },
    ]);

    expect(
      findAffectedTests({ changedFiles: ["packages/core/docs/guide/how-to/run.md"], rootDir: dir }).affectedTests,
    ).toEqual([
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
    ].map(path => [path, "// exists\n"])));
    const sql = [
      "scripts/packages/platform-migration-projection.test.ts",
      "scripts/pgtap-parity.test.ts",
      "scripts/platform-migration-manifest.test.ts",
      "scripts/sql-admit.test.ts",
    ].sort();
    for (const path of ["db/platform/migrations/20261123000000_change.sql", "packages/platform/sql/20261123000000_change.sql"]) {
      expect(findAffectedTests({ changedFiles: [path], rootDir: dir }).affectedTests)
        .toEqual(sql.map(test => ({ path: test, reasons: ["contract-pin"] })));
    }
    const docs = ["scripts/documentation-links.test.ts", "scripts/reviewed-native-store-forward.test.ts"];
    for (const path of ["docs/platform/DATA_AND_MIGRATIONS.md", "docs/platform/migrations/compatible-data-transfer.md"]) {
      expect(findAffectedTests({ changedFiles: [path], rootDir: dir }).affectedTests)
        .toEqual(docs.map(test => ({ path: test, reasons: ["contract-pin"] })));
    }
  });

  it("formats text output with a ready-to-run vitest command", () => {
    const text = formatAffectedTestsText({
      base: "origin/main",
      changedFiles: ["scripts/ci-vitest-shard.mjs"],
      affectedTests: [
        { path: "scripts/ci-vitest-shard.test.ts", reasons: ["import-graph"] },
      ],
    });
    expect(text).toContain("Base ref: origin/main");
    expect(text).toContain("scripts/ci-vitest-shard.test.ts [import-graph]");
    expect(text).toContain("npx --no -- vitest run scripts/ci-vitest-shard.test.ts");
  });

  it("resolves real repository reverse imports and contract pins", () => {
    const shardResult = findAffectedTests({
      changedFiles: ["scripts/ci-vitest-shard.mjs"],
    });
    expect(shardResult.affectedTests).toEqual([
      { path: "scripts/ci-vitest-shard.test.ts", reasons: ["import-graph"] },
    ]);

    const catalogResult = findAffectedTests({
      changedFiles: ["config/openlup-publication-catalog.json"],
    });
    expect(catalogResult.affectedTests).toContainEqual({
      path: "scripts/oss-published-tree-check.test.ts",
      reasons: ["contract-pin"],
    });
  });
});
