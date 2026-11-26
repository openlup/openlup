import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { allocateNextMigrationSlot, parseMigrationSyncArgs, runMigrationSync } from "./migration-sync.ts";
import { sqlSha256 } from "./reviewed-platform-forward.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const tempRoots: string[] = [];

afterEach(() => {
  for (const dir of tempRoots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function snapshotTree(root: string, rel = ""): Record<string, string> {
  const result: Record<string, string> = {};
  const dir = rel ? join(root, rel) : root;
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name === ".git") continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      Object.assign(result, snapshotTree(root, childRel));
    } else {
      result[childRel] = readFileSync(join(root, childRel), "utf8");
    }
  }
  return result;
}

function createFixtureRepo() {
  const root = mkdtempSync(join(tmpdir(), "openlup-migration-sync-"));
  tempRoots.push(root);
  const write = (rel: string, content: string | Buffer) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  const read = (rel: string) => readFileSync(join(root, rel), "utf8");
  const git = (...args: string[]) => execFileSync("git", [
    "-C", root, "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args,
  ], { encoding: "utf8", timeout: 10_000 }).trim();

  git("init", "-qb", "main");
  const baselinePath = "db/platform/migrations/00000000000000_platform_baseline.sql";
  const baselineSql = "CREATE FUNCTION public.demo_fn() RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;\n";
  const q2BaselinePath = "db/platform/migrations/q2_00000000000000_platform_baseline.sql";
  const qaBaselinePath = "db/platform/migrations/qa_00000000000000_platform_baseline.sql";
  const q2InterleavedPath = "db/platform/migrations/q2_20261124120000_qualified_helper.sql";
  const qbInterleavedPath = "db/platform/migrations/qb_20261124120000_qualified_helper.sql";
  const qualifiedSql = "SELECT 1;\n";
  const priorPath = "db/platform/migrations/20261124235959_prior_fixture.sql";
  const priorSql = "CREATE TABLE public.prior_fixture (id integer primary key);\n";
  const zeroHash = "0".repeat(64);
  const manifest = {
    schemaVersion: 3,
    baseline: { file: baselinePath, sha256: sha(baselineSql) },
    forward: [{ file: priorPath, sha256: sha(priorSql) }],
    objectInventorySha256: zeroHash,
    qualified: {
      baseline: { file: q2BaselinePath, sha256: sha(baselineSql) },
      forward: [
        { file: q2InterleavedPath, sha256: sha(qualifiedSql) },
        { file: priorPath, sha256: sha(priorSql) },
      ],
      objectInventorySha256: {
        bootstrapMigrator: { withRestore: zeroHash },
        separateMigrator: { withRestore: zeroHash },
      },
    },
    qualifiedAdmin: {
      baseline: { file: qaBaselinePath, sha256: sha(baselineSql) },
      forward: [
        { file: qbInterleavedPath, sha256: sha(qualifiedSql) },
        { file: priorPath, sha256: sha(priorSql) },
      ],
      objectInventorySha256: {
        installerManaged: zeroHash,
        operatorProvisioned: zeroHash,
      },
    },
  };

  write("scripts/platform-migration-manifest.ts", readFileSync(join(REPO_ROOT, "scripts/platform-migration-manifest.ts")));
  write("packages/platform/src/migrations/catalog.ts", "// stale\n");
  mkdirSync(join(root, "packages/platform/sql"), { recursive: true });
  write(baselinePath, baselineSql);
  write(q2BaselinePath, baselineSql);
  write(qaBaselinePath, baselineSql);
  write(q2InterleavedPath, qualifiedSql);
  write(qbInterleavedPath, qualifiedSql);
  write(priorPath, priorSql);
  write("config/platform-migration-manifest.json", `${JSON.stringify(manifest, null, 2)}\n`);
  const realForwards = JSON.parse(readFileSync(join(REPO_ROOT, "config/reviewed-platform-forwards.json"), "utf8"));
  realForwards.nativeStoreForwards = [];
  realForwards.nativeStoreForwardClass = { sealed: true, slots: [] };
  write("config/reviewed-platform-forwards.json", `${JSON.stringify(realForwards, null, 2)}\n`);

  const realInventory = JSON.parse(readFileSync(join(REPO_ROOT, "tests/postgres/current-installation-inventory.json"), "utf8"));
  realInventory.current.profiles.legacy.objectInventorySha256 = "1".repeat(64);
  realInventory.current.profiles.bootstrap.objectInventorySha256 = "2".repeat(64);
  realInventory.current.profiles.separate.objectInventorySha256 = "3".repeat(64);
  realInventory.current.profiles["admin-managed"].objectInventorySha256 = "4".repeat(64);
  realInventory.current.profiles["admin-operator"].objectInventorySha256 = "5".repeat(64);
  write("tests/postgres/current-installation-inventory.json", `${JSON.stringify(realInventory, null, 2)}\n`);

  git("add", ".");
  git("commit", "-qm", "Base fixture", "-s");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  return { root, write, read, git, baselineSql, priorPath, q2InterleavedPath, qbInterleavedPath };
}

describe("parseMigrationSyncArgs", () => {
  it("parses valid options and refuses unknown or conflicting combinations", () => {
    expect(parseMigrationSyncArgs(["--next-slot"])).toEqual({
      baseRef: undefined,
      files: [],
      nextSlot: true,
      noInventory: false,
      check: false,
    });
    expect(parseMigrationSyncArgs(["--file", "db/platform/migrations/20261125000000_a.sql", "--no-inventory", "--check", "--base", "HEAD"])).toEqual({
      baseRef: "HEAD",
      files: ["db/platform/migrations/20261125000000_a.sql"],
      nextSlot: false,
      noInventory: true,
      check: true,
    });
    expect(() => parseMigrationSyncArgs(["--bogus"])).toThrow("unknown option");
    expect(() => parseMigrationSyncArgs(["--file"])).toThrow("missing path value");
    expect(() => parseMigrationSyncArgs(["--next-slot", "--check"])).toThrow("cannot be combined");
  });
});

describe("migration:sync", () => {
  it("allocates monotonically increasing UTC second slots across base history and local working-tree files", () => {
    const f = createFixtureRepo();
    expect(allocateNextMigrationSlot(f.root)).toBe("20261125000000");
    f.write("supabase/migrations/20261125000000_local_managed.sql", "SELECT 1;\n");
    expect(allocateNextMigrationSlot(f.root)).toBe("20261125000001");
  });

  it("syncs a new migration into all 3 manifest plans without reordering qualified prefixes, projects, and passes --check", () => {
    const f = createFixtureRepo();
    const nextPath = "db/platform/migrations/20261125000000_new_table.sql";
    const sqlV1 = "CREATE TABLE public.new_table (id integer primary key);\n";
    f.write(nextPath, sqlV1);

    const driftBefore = runMigrationSync({ root: f.root, check: true, noInventory: true });
    expect(driftBefore.drift.length).toBeGreaterThan(0);

    const synced = runMigrationSync({ root: f.root, noInventory: true });
    expect(synced).toMatchObject({
      mode: "sync",
      files: [nextPath],
      manifestUpdated: true,
      inventoryRefreshed: false,
      drift: [],
    });

    const manifest = JSON.parse(f.read("config/platform-migration-manifest.json"));
    expect(manifest.forward.map((unit: { file: string }) => unit.file)).toEqual([f.priorPath, nextPath]);
    expect(manifest.qualified.forward.map((unit: { file: string }) => unit.file)).toEqual([
      f.q2InterleavedPath,
      f.priorPath,
      nextPath,
    ]);
    expect(manifest.qualifiedAdmin.forward.map((unit: { file: string }) => unit.file)).toEqual([
      f.qbInterleavedPath,
      f.priorPath,
      nextPath,
    ]);
    for (const plan of [manifest, manifest.qualified, manifest.qualifiedAdmin]) {
      expect(plan.forward.at(-1)).toEqual({ file: nextPath, sha256: sha(sqlV1) });
    }
    expect(existsSync(join(f.root, "packages/platform/sql/20261125000000_new_table.sql"))).toBe(true);
    expect(f.read("packages/platform/sql/20261125000000_new_table.sql")).toBe(sqlV1);

    const afterCheck = runMigrationSync({ root: f.root, check: true, noInventory: true });
    expect(afterCheck.drift).toEqual([]);

    const sqlV2 = "CREATE TABLE public.new_table (id integer primary key, note text);\n";
    f.write(nextPath, sqlV2);
    expect(runMigrationSync({ root: f.root, check: true, noInventory: true }).drift.length).toBeGreaterThan(0);
    runMigrationSync({ root: f.root, noInventory: true });
    const updatedManifest = JSON.parse(f.read("config/platform-migration-manifest.json"));
    expect(updatedManifest.forward.at(-1)).toEqual({ file: nextPath, sha256: sha(sqlV2) });
    expect(runMigrationSync({ root: f.root, check: true, noInventory: true }).drift).toEqual([]);
  });

  it("synchronizes declared nativeStoreForwardClass slot function digests and nativeStoreForwards", () => {
    const f = createFixtureRepo();
    const nextPath = "db/platform/migrations/20261125000000_replace_demo.sql";
    const replacementSql = "CREATE OR REPLACE FUNCTION public.demo_fn() RETURNS integer LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 2; $$;\n";
    const createdSql = "CREATE FUNCTION public.demo_helper() RETURNS integer LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 3; $$;\n";
    const fullSql = `${replacementSql}\n${createdSql}`;
    f.write(nextPath, fullSql);

    const forwards = JSON.parse(f.read("config/reviewed-platform-forwards.json"));
    forwards.nativeStoreForwardClass.slots.push({
      row: "R1",
      path: nextPath,
      replacedFunctions: [{ signature: "public.demo_fn()", beforeSha256: "f".repeat(64), searchPath: "pg_catalog, pg_temp" }],
      createdFunctions: [{ signature: "public.demo_helper()", searchPath: "pg_catalog, pg_temp" }],
      grantOnlyFunctions: [],
      dataStatements: [],
    });
    f.write("config/reviewed-platform-forwards.json", `${JSON.stringify(forwards, null, 2)}\n`);

    const result = runMigrationSync({ root: f.root, noInventory: true });
    expect(result.forwardsUpdated).toBe(true);

    const updated = JSON.parse(f.read("config/reviewed-platform-forwards.json"));
    const expectedBefore = sqlSha256(f.baselineSql.trim());
    const expectedAfterReplace = sqlSha256(replacementSql.trim());
    const expectedAfterCreate = sqlSha256(createdSql.trim());
    expect(updated.nativeStoreForwardClass.slots[0].replacedFunctions[0].beforeSha256).toBe(expectedBefore);
    expect(updated.nativeStoreForwards).toEqual([{
      path: nextPath,
      sha256: sha(fullSql),
      functions: [
        { signature: "public.demo_fn()", beforeSha256: expectedBefore, afterSha256: expectedAfterReplace },
        { signature: "public.demo_helper()", beforeSha256: null, afterSha256: expectedAfterCreate },
      ],
    }]);
    expect(runMigrationSync({ root: f.root, check: true, noInventory: true }).drift).toEqual([]);
  });

  it("builds packages, refreshes inventory, copies measured hashes into the manifest, and re-projects", () => {
    const f = createFixtureRepo();
    const nextPath = "db/platform/migrations/20261125000000_with_inventory.sql";
    f.write(nextPath, "CREATE TABLE public.with_inventory (id integer primary key);\n");
    const runIncrementalBuild = vi.fn();
    const runInventoryRefresh = vi.fn();

    const result = runMigrationSync({
      root: f.root,
      runIncrementalBuild,
      runInventoryRefresh,
    });

    expect(result.inventoryRefreshed).toBe(true);
    expect(runIncrementalBuild).toHaveBeenCalledExactlyOnceWith(f.root);
    expect(runInventoryRefresh).toHaveBeenCalledExactlyOnceWith(f.root);
    const manifest = JSON.parse(f.read("config/platform-migration-manifest.json"));
    expect(manifest.objectInventorySha256).toBe("1".repeat(64));
    expect(manifest.qualified.objectInventorySha256).toEqual({
      bootstrapMigrator: { withRestore: "2".repeat(64) },
      separateMigrator: { withRestore: "3".repeat(64) },
    });
    expect(manifest.qualifiedAdmin.objectInventorySha256).toEqual({
      installerManaged: "4".repeat(64),
      operatorProvisioned: "5".repeat(64),
    });
    const projected = JSON.parse(f.read("packages/platform/sql/manifest.json"));
    expect(projected.catalog.objectInventorySha256).toBe("1".repeat(64));
  });

  it("refuses non-UTC slots, inverted slots, executable migrations, and edits to base history before writing", () => {
    const f = createFixtureRepo();
    const beforeManifest = f.read("config/platform-migration-manifest.json");

    const badUtcPath = "db/platform/migrations/20269999000000_invalid_utc.sql";
    f.write(badUtcPath, "SELECT 1;\n");
    expect(() => runMigrationSync({ root: f.root, noInventory: true })).toThrow("valid 14-digit UTC timestamp");
    expect(f.read("config/platform-migration-manifest.json")).toBe(beforeManifest);
    rmSync(join(f.root, badUtcPath));

    f.write("db/platform/migrations/20261124000000_inverted.sql", "SELECT 1;\n");
    expect(() => runMigrationSync({ root: f.root, noInventory: true })).toThrow("strictly later");
    expect(f.read("config/platform-migration-manifest.json")).toBe(beforeManifest);
    rmSync(join(f.root, "db/platform/migrations/20261124000000_inverted.sql"));

    const execPath = "db/platform/migrations/20261125000000_exec.sql";
    f.write(execPath, "SELECT 1;\n");
    chmodSync(join(f.root, execPath), 0o755);
    expect(() => runMigrationSync({ root: f.root, noInventory: true })).toThrow("non-executable");
    rmSync(join(f.root, execPath));

    f.write(f.priorPath, "CREATE TABLE public.tampered (id int);\n");
    expect(() => runMigrationSync({ root: f.root, noInventory: true })).toThrow("immutable");
  });

  it("reports drift across all four surfaces in --check mode without calling build/inventory hooks or writing files", () => {
    const f = createFixtureRepo();
    const nextPath = "db/platform/migrations/20261125000000_replace_demo.sql";
    const replacementSql =
      "CREATE OR REPLACE FUNCTION public.demo_fn() RETURNS integer LANGUAGE sql SET search_path = pg_catalog, pg_temp AS $$ SELECT 2; $$;\n";
    f.write(nextPath, replacementSql);

    const forwards = JSON.parse(f.read("config/reviewed-platform-forwards.json"));
    forwards.nativeStoreForwardClass.slots.push({
      row: "R1",
      path: nextPath,
      replacedFunctions: [{ signature: "public.demo_fn()", beforeSha256: "f".repeat(64), searchPath: "pg_catalog, pg_temp" }],
      createdFunctions: [],
      grantOnlyFunctions: [],
      dataStatements: [],
    });
    f.write("config/reviewed-platform-forwards.json", `${JSON.stringify(forwards, null, 2)}\n`);

    f.write("packages/core/package.json", '{"version":"1.0.0"}\n');
    f.write(
      "packages/core/docs/guide/reference/sql.md",
      "# SQL Reference\n\n<!-- generated:sql:platform -->\n| stale |\n<!-- /generated:sql:platform -->\n",
    );

    const beforeTree = snapshotTree(f.root);
    const beforeSqlDir = readdirSync(join(f.root, "packages/platform/sql")).sort();
    const runIncrementalBuild = vi.fn();
    const runInventoryRefresh = vi.fn();

    const result = runMigrationSync({
      root: f.root,
      check: true,
      runIncrementalBuild,
      runInventoryRefresh,
    });

    expect(result.mode).toBe("check");
    expect(result.inventoryRefreshed).toBe(false);
    expect(result.manifestUpdated).toBe(true);
    expect(result.forwardsUpdated).toBe(true);
    expect(result.drift.length).toBeGreaterThanOrEqual(4);
    expect(result.drift).toContain("config/platform-migration-manifest.json: checksum or forward entries out of sync");
    expect(result.drift).toContain("config/reviewed-platform-forwards.json: reviewed forward digests out of sync");
    expect(result.drift).toContain("packages/core/docs/guide/reference/sql.md: generated SQL reference out of sync");
    expect(runIncrementalBuild).not.toHaveBeenCalled();
    expect(runInventoryRefresh).not.toHaveBeenCalled();
    expect(snapshotTree(f.root)).toEqual(beforeTree);
    expect(readdirSync(join(f.root, "packages/platform/sql")).sort()).toEqual(beforeSqlDir);
  });

  it("refuses deleted base migration files in both sync and --check modes without modifying the manifest", () => {
    const f = createFixtureRepo();
    const beforeManifest = f.read("config/platform-migration-manifest.json");
    rmSync(join(f.root, f.priorPath));

    expect(() => runMigrationSync({ root: f.root, noInventory: true })).toThrow(
      "existing base migration file was deleted from the working tree",
    );
    expect(() => runMigrationSync({ root: f.root, check: true, noInventory: true })).toThrow(
      "existing base migration file was deleted from the working tree",
    );
    expect(f.read("config/platform-migration-manifest.json")).toBe(beforeManifest);
  });

  it("detects SQL reference drift in --check without mutating it and recovers cleanly on sync", () => {
    const f = createFixtureRepo();
    const sqlRefPath = "packages/core/docs/guide/reference/sql.md";
    f.write("packages/core/package.json", '{"version":"1.0.0"}\n');
    f.write(
      sqlRefPath,
      "# SQL Reference\n\n<!-- generated:sql:platform -->\n| initial |\n<!-- /generated:sql:platform -->\n",
    );

    runMigrationSync({ root: f.root, noInventory: true });
    expect(runMigrationSync({ root: f.root, check: true, noInventory: true }).drift).toEqual([]);
    const cleanSqlRef = f.read(sqlRefPath);

    const corruptedSqlRef = "# SQL Reference\n\n<!-- generated:sql:platform -->\n| corrupted |\n<!-- /generated:sql:platform -->\n";
    f.write(sqlRefPath, corruptedSqlRef);

    const checkResult = runMigrationSync({ root: f.root, check: true, noInventory: true });
    expect(checkResult.drift).toEqual([`${sqlRefPath}: generated SQL reference out of sync`]);
    expect(f.read(sqlRefPath)).toBe(corruptedSqlRef);

    runMigrationSync({ root: f.root, noInventory: true });
    expect(f.read(sqlRefPath)).toBe(cleanSqlRef);
    expect(runMigrationSync({ root: f.root, check: true, noInventory: true }).drift).toEqual([]);
  });
});
