import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { INVENTORY_PATH, inventoryEnvelope } from "../../scripts/agent-review-derived.mjs";
import { carrierLocale, isolatedInventoryFile } from "../../scripts/agent-review-landing.mjs";
import { fixtureNpmCli, linkFixtureInstallation, localFixtureEnvironment } from "../../scripts/fixtures/landing-test-environment.ts";
import { applyMigrationFinalization, parseMigrationGrant, readFinalizationPlan, verifyFinalizedMigrationHead } from "../../scripts/migration-finalize.mjs";
import { checkPlatformMigrationProjection } from "../../scripts/packages/platform-migration-projection.ts";

import { createPostgresMigrationRunner } from "../../server/adapters/postgres/migrationRunner.ts";
import { readSelectedCatalogProjection, selectedCatalogProjectionPayload } from "../../server/adapters/postgres/selectedCatalogProjection.ts";
import { closePostgres, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.ts";

const root = process.cwd();
const npm = fixtureNpmCli();
const env = { ...localFixtureEnvironment(), ...carrierLocale, npm_execpath: npm };
const portable = "db/platform/migrations/";
const managed = "supabase/migrations/";
const packageSql = "packages/platform/sql/";
const manifest = "config/platform-migration-manifest.json";

async function witnessReplay(checkout: string, createPath: string, insertPath: string) {
  const container = await runPostgresContainer({ name: `migration-finalization-replay-${process.pid}`, password: randomUUID() });
  const pool = new Pool({ connectionString: container.connectionString });
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // The first statement of the reversed pair must fail in PostgreSQL.
      await expect(client.query(readFileSync(join(checkout, insertPath), "utf8")))
        .rejects.toMatchObject({ code: "42P01", message: expect.stringContaining("platform_finalization_witness") });
    } finally {
      try { await client.query("ROLLBACK"); }
      finally { client.release(); }
    }
    const runner = createPostgresMigrationRunner({ connectionString: container.connectionString }, {
      root: checkout,
      poolFactory: () => pool,
      catalogProjectionPayload: async connection => selectedCatalogProjectionPayload(await readSelectedCatalogProjection(connection)),
    });
    expect((await runner.apply()).applied.slice(-2)).toEqual([createPath, insertPath]);
    const ledgerSql = "SELECT position, catalog_path, sha256 FROM public.platform_schema_migrations ORDER BY position";
    const before = (await pool.query(ledgerSql)).rows;
    expect(before.slice(-2).map(row => row.catalog_path)).toEqual([createPath, insertPath]);
    expect(await runner.apply()).toEqual({ applied: [] });
    expect((await pool.query(ledgerSql)).rows).toEqual(before);
    expect((await pool.query("SELECT id FROM public.platform_finalization_witness")).rows).toEqual([{ id: 73 }]);
  } finally {
    await closePostgres(container, pool);
  }
}

it("finalizes dependent portable forwards, measures five PostgreSQL ledgers and verifies replay", async () => {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "openlup-finalize-postgres-")));
  const checkout = join(scratch, "repo");
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["--no-replace-objects", "-C", cwd, "-c", "core.hooksPath=/dev/null", ...args],
    { env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30_000 }).trim();
  const read = (path: string) => readFileSync(join(checkout, path), "utf8");
  const write = (path: string, value: string) => writeFileSync(join(checkout, path), value);
  const commit = (message: string, options: string[] = []) => {
    git(checkout, "add", "-A");
    git(checkout, "-c", "commit.gpgSign=false", "commit", ...options, "-sqm", message);
    return git(checkout, "rev-parse", "HEAD");
  };
  try {
    vi.stubEnv("npm_execpath", npm);
    git(root, "clone", "--shared", "--no-hardlinks", "-q", root, checkout);
    const paths = new Set([
      ...git(root, "diff", "--name-only", "--no-renames", "HEAD").split("\n"),
      ...git(root, "ls-files", "--others", "--exclude-standard").split("\n"),
    ].filter(Boolean));
    for (const path of paths) {
      const target = join(checkout, path);
      if (!existsSync(join(root, path))) rmSync(target, { force: true });
      else {
        mkdirSync(dirname(target), { recursive: true });
        cpSync(join(root, path), target);
      }
    }
    linkFixtureInstallation(root, checkout);
    git(checkout, "config", "user.name", "OpenLup Witness");
    git(checkout, "config", "user.email", "witness@example.invalid");
    const fork = commit("Commit fixture source", ["--allow-empty"]);
    const before = portable + "20990101000000_finalization_create.sql";
    const after = portable + "20990101010001_finalization_insert.sql";
    write(before, "CREATE TABLE public.platform_finalization_witness (id integer PRIMARY KEY);\n");
    write(after, "INSERT INTO public.platform_finalization_witness (id) VALUES (73);\n");
    git(checkout, "checkout", "-qb", "candidate");
    const draft = commit("Draft dependent migrations");
    git(checkout, "checkout", "--detach", "-q", fork);
    write(managed + "20990101010000_finalization_main.sql", "SELECT 1;\n");
    const main = commit("Advance the global migration floor");
    git(checkout, "update-ref", "refs/remotes/origin/main", main);
    git(checkout, "checkout", "-q", "candidate");
    const originalInventory = inventoryEnvelope(read(INVENTORY_PATH));
    const forkManifest = JSON.parse(read(manifest));
    const { moves, orderingDigest } = await readFinalizationPlan(checkout, main, draft);
    const expected = ["20990101010002_finalization_create.sql", "20990101010003_finalization_insert.sql"];
    expect(moves.map(move => move.targetPath)).toEqual(expected.map(path => portable + path));
    const now = new Date("2099-11-24T12:00:00.000Z").valueOf();
    const grantFile = join(checkout, ".git/openlup-migration-grant.json");
    writeFileSync(grantFile, JSON.stringify({ schemaVersion: 1, repositoryId: 123, baseRef: "refs/heads/main",
      prNodeId: "PR_fixture", prNumber: 17, grantId: "12345678-1234-4123-8123-123456789abc",
      draftHead: draft, observedMain: main, orderingDigest, issuedAt: "2099-11-24T11:00:00.000Z",
      expiresAt: "2099-11-24T13:00:00.000Z", moves,
    }));
    const options = { base: main, head: draft, pr: 17, now: () => now, repositoryId: 123, prNodeId: "PR_fixture" };
    const run = (command: string, args: string[], runOptions: { env?: NodeJS.ProcessEnv } = {}) => {
      execFileSync(command, args, { cwd: checkout, env: { ...runOptions.env, ...env }, stdio: "inherit", timeout: 540_000 });
    };
    const bystander = "concurrent-witness.txt";
    for (const failAtInventory of [true, false]) {
      const injectedFailure = new Error("Injected inventory failure after registry writes");
      await expect(applyMigrationFinalization(checkout, {
        ...options,
        runCommand: (command: string, args: string[], runOptions?: { env?: NodeJS.ProcessEnv }) => {
          if (args.some(arg => arg.endsWith("scripts/installation-inventory-refresh.ts"))) {
            write(bystander, "Preserve this concurrent staging.\n");
            git(checkout, "add", "--", bystander);
            if (failAtInventory) throw injectedFailure;
            expect(args.at(-1)).toBe("--isolated");
            writeFileSync(isolatedInventoryFile(checkout), read(INVENTORY_PATH), { flag: "wx" });
            return;
          }
          run(command, args, runOptions);
        },
      })).rejects.toThrow(failAtInventory ? injectedFailure.message : `unapproved finalization change at ${bystander}`);
      expect(git(checkout, "rev-parse", "HEAD")).toBe(draft);
      expect(existsSync(join(checkout, ".git/MERGE_HEAD"))).toBe(false);
      expect(git(checkout, "status", "--porcelain=v1")).toBe(`A  ${bystander}`);
      expect(read(bystander)).toBe("Preserve this concurrent staging.\n");
      git(checkout, "rm", "--cached", "--", bystander);
      rmSync(join(checkout, bystander));
    }
    const forwardPins = "config/reviewed-platform-forwards.json";
    const concurrentEdits = [[forwardPins, false], [forwardPins, true], [INVENTORY_PATH, false]] as const;
    for (const [edited, stageEdit] of concurrentEdits) {
      const edit = "Concurrent carrier edit.\n";
      await expect(applyMigrationFinalization(checkout, {
        ...options,
        runCommand: (command: string, args: string[], runOptions?: { env?: NodeJS.ProcessEnv }) => {
          if (args.some(arg => arg.endsWith("scripts/installation-inventory-refresh.ts"))) {
            expect(args.at(-1)).toBe("--isolated");
            writeFileSync(isolatedInventoryFile(checkout), read(INVENTORY_PATH), { flag: "wx" });
            write(edited, edit);
            if (stageEdit) git(checkout, "add", "--", edited);
            return;
          }
          run(command, args, runOptions);
        },
      })).rejects.toThrow(`concurrent edit to owned migration path: ${edited}`);
      expect(git(checkout, "rev-parse", "HEAD")).toBe(draft);
      expect(existsSync(join(checkout, ".git/MERGE_HEAD"))).toBe(false);
      expect(git(checkout, "diff", "--name-only", "--cached")).toBe(stageEdit ? edited : "");
      expect(git(checkout, "diff", "--name-only")).toBe(stageEdit ? "" : edited);
      expect(read(edited)).toBe(edit);
      git(checkout, "restore", "--source=HEAD", "--staged", "--worktree", "--", edited);
    }
    const finalized = await applyMigrationFinalization(checkout, { ...options, runCommand: run });
    const grant = parseMigrationGrant(readFileSync(grantFile, "utf8"));
    const { measuredInventorySha256 } = finalized;
    expect(measuredInventorySha256).toBe(createHash("sha256").update(read(INVENTORY_PATH)).digest("hex"));
    const proof = { grant, base: main, head: finalized.head, now: () => now };
    await expect(verifyFinalizedMigrationHead(checkout, { ...proof, measuredInventorySha256: undefined }))
      .rejects.toThrow("requires an independently measured inventory SHA-256");
    await expect(verifyFinalizedMigrationHead(checkout, { ...proof, measuredInventorySha256 }))
      .resolves.toMatchObject({ head: finalized.head, moves, measuredInventorySha256 });
    expect(git(checkout, "rev-list", "--parents", "-n1", finalized.head)).toBe(`${finalized.head} ${draft} ${main}`);
    expect(git(checkout, "show", "-s", "--format=%B", finalized.head)).toContain("Signed-off-by:");
    expect(git(checkout, "status", "--porcelain=v1")).toBe("");
    expect(checkPlatformMigrationProjection(checkout)).toEqual([]);
    for (const filename of expected) expect(read(portable + filename)).toEqual(read(packageSql + filename));
    const actual = JSON.parse(read(manifest));
    for (const [beforePlan, afterPlan] of [[forkManifest, actual], [forkManifest.qualified, actual.qualified],
      [forkManifest.qualifiedAdmin, actual.qualifiedAdmin]]) {
      expect(afterPlan.forward.slice(0, -2)).toEqual(beforePlan.forward);
      expect(afterPlan.forward.slice(-2).map(({ file }: { file: string }) => file)).toEqual(expected.map(path => portable + path));
    }
    const inventory = inventoryEnvelope(read(INVENTORY_PATH));
    expect(inventory.before).toEqual(originalInventory.before);
    expect(inventory.after).toEqual(originalInventory.after);
    const profiles = JSON.parse(read(INVENTORY_PATH)).current.profiles;
    const original = (originalInventory.value.current.profiles as Record<string, { count: number }>);
    expect(Object.keys(profiles)).toEqual(["legacy", "bootstrap", "separate", "admin-managed", "admin-operator"]);
    for (const [name, profile] of Object.entries(profiles) as [string, { count: number; tail: { file: string }[]; objectInventorySha256: string }][]) {
      expect(profile.count).toBe(original[name].count + 2);
      expect(profile.tail.slice(0, 2).map(row => row.file)).toEqual([...expected].reverse().map(path => portable + path));
      expect(profile.objectInventorySha256).toMatch(/^[0-9a-f]{64}$/u);
    }
    await witnessReplay(checkout, portable + expected[0], portable + expected[1]);
    const originalHash = profiles.legacy.objectInventorySha256;
    const otherHash = originalHash === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
    const inventoryBytes = read(INVENTORY_PATH);
    const currentBytes = inventoryBytes.slice(inventory.before.length, inventoryBytes.length - inventory.after.length);
    const editedCurrent = currentBytes.replace(`"objectInventorySha256": "${originalHash}"`, `"objectInventorySha256": "${otherHash}"`);
    expect(editedCurrent).not.toBe(currentBytes);
    const editedInventory = inventory.before + editedCurrent + inventory.after;
    write(INVENTORY_PATH, editedInventory);
    git(checkout, "add", "--", INVENTORY_PATH);
    git(checkout, "-c", "commit.gpgSign=false", "commit", "--amend", "--no-edit", "-q");
    const unmeasured = git(checkout, "rev-parse", "HEAD");
    await expect(verifyFinalizedMigrationHead(checkout, { ...proof, head: unmeasured, measuredInventorySha256 }))
      .rejects.toThrow("inventory differs from the independently measured bytes");
    git(checkout, "reset", "--hard", "-q", finalized.head);
    const generated = "packages/platform/src/migrations/catalog.ts";
    write(generated, read(generated) + "\n// Altered generated carrier.\n");
    git(checkout, "add", "--", generated);
    git(checkout, "-c", "commit.gpgSign=false", "commit", "--amend", "--no-edit", "-q");
    const changed = git(checkout, "rev-parse", "HEAD");
    await expect(verifyFinalizedMigrationHead(checkout, { ...proof, head: changed, measuredInventorySha256 }))
      .rejects.toThrow(`trusted generator differs at ${generated}`);
  } finally {
    vi.unstubAllEnvs();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 600_000);
