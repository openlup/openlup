import { describe, expect, it } from "vitest";
import { isUtcMigrationSlot, migrationIdentity, nextFreeMigrationSlot, planMigrationSlots } from "./migration-slots.mjs";

const portable = "db/platform/migrations/";
const managed = "supabase/migrations/";

describe("migration slots", () => {
  it.each([
    ["00000000000000", "19700101000000"],
    ["00000101000000", "00010101000000"],
    ["20261125310000", "20261126000000"],
    ["20261100000000", "20261101000000"],
    ["20240228235959", "20240229000000"],
    ["20230228235959", "20230301000000"],
    ["20261231235959", "20270101000000"],
    ["99991231235958", "99991231235959"],
  ])("allocates the first UTC second after %s", (bound, expected) => {
    expect(nextFreeMigrationSlot(bound)).toBe(expected);
    expect(isUtcMigrationSlot(expected)).toBe(true);
    expect(expected > bound).toBe(true);
  });

  it("rejects malformed, normalized and exhausted values", () => {
    expect(nextFreeMigrationSlot.bind(null, "2026")).toThrow("invalid 14-digit bound");
    expect(nextFreeMigrationSlot.bind(null, "99991231235959")).toThrow("UTC range exhausted");
    expect(nextFreeMigrationSlot.bind(null, "99999999999999")).toThrow("UTC range exhausted");
    for (const slot of ["00000000000000", "20260230000000", "20260430240000", "20261231235960", "20261100000000"])
      expect(isUtcMigrationSlot(slot)).toBe(false);
  });

  it("gives both rails one order and retains a feasible successor", () => {
    const create = portable + "20270101000000_create.sql";
    const insert = managed + "20270101010001_insert.sql";
    const keep = portable + "20270101010100_keep.sql";
    const main = portable + "qa_20270101010000_main.sql";
    const { moves } = planMigrationSlots([keep, insert, create], [main]);
    expect(moves.map(move => [move.sourcePath, move.targetPath])).toEqual([
      [create, portable + "20270101010002_create.sql"],
      [insert, managed + "20270101010003_insert.sql"],
      [keep, keep],
    ]);
    expect(migrationIdentity(main)).toMatchObject({ qualifier: "qa", version: "20270101010000" });
    expect(() => planMigrationSlots([create, managed + "20270101000000_insert.sql"], [main])).toThrow("ambiguous draft version");
  });
});

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applyMigrationFinalization, parseMigrationGrant, readFinalizationPlan, requiresMigrationGrant } from "./migration-finalize.mjs";

const registryPath = "config/reviewed-platform-forwards.json";

async function withRepository(run: (fixture: {
  root: string; main: string; git: (...args: string[]) => string; write: (path: string, content: unknown) => void;
  commit: () => string;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "openlup-finalize-plan-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", root, "-c", "core.hooksPath=/dev/null",
    "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgSign=false", ...args],
  { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (path: string, content: unknown) => {
    const file = join(root, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  };
  const commit = () => { git("add", "-A"); git("commit", "-qm", "Witness", "--allow-empty"); return git("rev-parse", "HEAD"); };
  try {
    git("init", "-qb", "task");
    const manifest = { baseline: { file: portable + "00000000000000_platform_baseline.sql" }, forward: [] };
    write("config/platform-migration-manifest.json", { ...manifest, qualified: manifest, qualifiedAdmin: manifest });
    write(registryPath, {});
    write("packages/platform/sql/manifest.json", { migrations: [] });
    write(portable + "00000000000000_platform_baseline.sql", "SELECT 1;\n");
    write(managed + "00000000000000_platform_schema_baseline.sql", "SELECT 1;\n");
    const main = commit();
    git("update-ref", "refs/remotes/origin/main", main);
    await run({ root, main, git, write, commit });
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("committed migration finalization plans", () => {
  it("plans the exact stack twice without changing HEAD, index, or files", async () => {
    await withRepository(async ({ root, main, git, write, commit }) => {
      const source = portable + "20990101000000_claim.sql";
      write(source, "SELECT 2;\n");
      const head = commit();
      const index = readFileSync(join(root, ".git/index"));
      const first = await readFinalizationPlan(root, main, head);
      expect(first.moves).toMatchObject([{ sourcePath: source, targetPath: source, mode: "100644" }]);
      const second = await readFinalizationPlan(root, main, head);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(first.next()).toBe("20990101000001");
      expect(requiresMigrationGrant(root, main, head)).toBe(true);
      git("checkout", "-q", "--detach", main);
      write(source, "SELECT 2;\n");
      write("README", "Disjoint commit metadata");
      const stacked = commit();
      expect((await readFinalizationPlan(root, stacked, head)).moves).toEqual([]);
      expect(requiresMigrationGrant(root, stacked, head)).toBe(false);
      git("checkout", "-q", "task");
      expect(git("rev-parse", "HEAD")).toBe(head);
      expect(git("status", "--porcelain=v1")).toBe("");
      expect(readFileSync(join(root, ".git/index")).byteLength).toBe(index.byteLength);
    });
  });

  it("keeps same-path rows with different bytes in the plan and refuses nonregular files", async () => {
    await withRepository(async ({ root, main, git, write, commit }) => {
      const source = portable + "20990101000000_claim.sql";
      write(source, "SELECT 2;\n");
      const head = commit();
      git("checkout", "-q", "--detach", main);
      write(source, "SELECT 3;\n");
      const newMain = commit();
      expect((await readFinalizationPlan(root, newMain, head)).moves[0]).toMatchObject({
        sourcePath: source, targetPath: portable + "20990101000001_claim.sql",
      });
      chmodSync(join(root, source), 0o755);
      await expect(readFinalizationPlan(root, commit(), head)).rejects.toThrow(`requires regular mode 100644 at ${source}`);
    });
  });

  it("refuses reservations, extended fixed identities and case-folded collisions", async () => {
    await withRepository(async ({ root, main, git, write, commit }) => {
      const source = portable + "20990101000000_Claim.sql";
      write(source, "SELECT 2;\n");
      const head = commit();
      git("checkout", "-q", "--detach", main);
      write(registryPath, { nativeStoreForwardClass: { slots: [{ path: source }] } });
      await expect(readFinalizationPlan(root, commit(), head)).rejects.toThrow(`issued approval or reservation owns ${source}`);
      git("checkout", "-q", "--detach", main);
      write(portable + "20990101000000_claim.sql", "SELECT 3;\n");
      await expect(readFinalizationPlan(root, commit(), head)).rejects.toThrow("case-folded migration path collision");
      git("checkout", "-q", "task");
      const fixed = portable + "q2_20990101000001_fixed.sql";
      write(fixed, "SELECT 3;\n");
      await expect(readFinalizationPlan(root, main, commit())).rejects.toThrow(`requires reviewed preparation at ${fixed}`);
    });
  });

  it("refuses surrounding authored references with their exact line numbers", async () => {
    await withRepository(async ({ root, main, git, write, commit }) => {
      const source = portable + "20990101000000_claim.sql";
      write(source, "-- file binding: 20990101000000_claim.sql\nSELECT 2;\n");
      write("docs/fixture.md", "Other content\nReference 20990101000000.\n");
      const head = commit();
      git("checkout", "-q", "--detach", main);
      write(managed + "20990101000000_upstream.sql", "SELECT 3;\n");
      await expect(readFinalizationPlan(root, commit(), head)).rejects.toThrow(`${source}:1 (20990101000000), docs/fixture.md:2 (20990101000000)`);
    });
  });

  it("validates complete grant bytes, timing and PR identity before any writes", async () => {
    await withRepository(async ({ root, main, git, write, commit }) => {
      write(portable + "20990101000000_claim.sql", "SELECT 2;\n");
      const head = commit();
      const { moves, orderingDigest } = await readFinalizationPlan(root, main, head);
      const grant = { schemaVersion: 1, repositoryId: 12, baseRef: "refs/heads/main", prNodeId: "PR_fixture", prNumber: 3,
        grantId: "12345678-1234-4123-8123-123456789abc", draftHead: head, observedMain: main, orderingDigest,
        issuedAt: "2099-11-24T10:00:00.000Z", expiresAt: "2099-11-24T11:00:00.000Z", moves };
      expect(parseMigrationGrant(JSON.stringify(grant))).toEqual(grant);
      expect(() => parseMigrationGrant(JSON.stringify({ ...grant, extra: true }))).toThrow("unexpected grant fields");
      expect(() => parseMigrationGrant(JSON.stringify(grant).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'))).toThrow(/duplicate/iu);
      expect(() => parseMigrationGrant(JSON.stringify({ ...grant, moves: [...moves, ...moves] }))).toThrow("duplicate grant move");
      const grantFile = join(root, ".git/witness-grant.json");
      write(".git/witness-grant.json", grant);
      const options = { base: main, head, pr: 3, grantFile, repositoryId: 12, prNodeId: "PR_fixture", now: () => Date.parse("2099-11-24T10:30:00.000Z") };
      await expect(applyMigrationFinalization(root, { ...options, pr: 4 })).rejects.toThrow("grant PR");
      await expect(applyMigrationFinalization(root, { ...options, repositoryId: 13 })).rejects.toThrow("grant PR");
      await expect(applyMigrationFinalization(root, { ...options, prNodeId: "PR_substitution" })).rejects.toThrow("grant PR");
      await expect(applyMigrationFinalization(root, { ...options, repositoryId: undefined })).rejects.toThrow("fixture repository ID");
      await expect(applyMigrationFinalization(root, { ...options, prNodeId: undefined })).rejects.toThrow("immutable PR node ID");
      await expect(applyMigrationFinalization(root, { ...options, now: () => Date.parse(grant.issuedAt) - 1 })).rejects.toThrow("issue time is in the future");
      await expect(applyMigrationFinalization(root, { ...options, now: () => Date.parse(grant.expiresAt) })).rejects.toThrow("grant expired");
      write(".git/witness-grant.json", { ...grant, moves: moves.map(move => ({ ...move, blobOid: "f".repeat(40) })) });
      await expect(applyMigrationFinalization(root, options)).rejects.toThrow("complete move vector");
      expect(git("rev-parse", "HEAD")).toBe(head);
      expect(git("status", "--porcelain=v1")).toBe("");
    });
  });
});
