import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createPostgresMigrationRunner, resolvePostgresMigrationRunnerEnv } from "./migrationRunner.js";

const INVENTORY_PAYLOAD = "selected-catalog-v2:test";
const BASELINE_PATH = "db/platform/migrations/00000000000000_platform_baseline.sql";
const FORWARD_A = "db/platform/migrations/20260806000000_a.sql";
const FORWARD_B = "db/platform/migrations/20260806000001_b.sql";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

type AppliedRow = { catalog_path: string; sha256: string; position: number };
function stubPool(input: { ledger?: AppliedRow[]; bodies: readonly string[] }) {
  const ledger = [...(input.ledger ?? [])];
  let ledgerExists = input.ledger !== undefined;
  const executed: string[] = [];
  const queries: string[] = [];
  const pool = {
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          queries.push(text);
          if (text === "SELECT pg_advisory_lock(hashtextextended($1, 0))") return { rows: [{}] };
          if (text === "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked") {
            return { rows: [{ unlocked: true }] };
          }
          if (text.includes("to_regclass")) {
            return { rows: [{ ledger_exists: ledgerExists }] };
          }
          if (text.startsWith("SELECT catalog_path")) return { rows: ledger.map((row) => ({ ...row })) };
          if (text.startsWith("INSERT INTO public.platform_schema_migrations")) {
            ledgerExists = true;
            ledger.push({ catalog_path: String(values?.[0]), sha256: String(values?.[1]), position: Number(values?.[2]) });
            return { rows: [] };
          }
          if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
          if (input.bodies.includes(text)) {
            executed.push(text);
            if (text === input.bodies[0]) ledgerExists = true;
            return { rows: [] };
          }
          throw new Error(`unexpected stub query: ${text}`);
        },
        release() {},
      };
    },
  };
  return { pool: pool as never, ledger, executed, queries };
}

async function fixtureRoot() {
  const root = await mkdtemp(join(tmpdir(), "cp2a-migrations-"));
  roots.push(root);
  const directory = join(root, "db/platform/migrations");
  await mkdir(directory, { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  const bodies = [
    "-- baseline exact bytes\nCREATE TABLE public.platform_schema_migrations();\n",
    "-- forward a exact bytes\nSELECT 1;\n",
    "-- forward b is never rewritten\nCREATE EXTENSION pg_net;\n",
  ] as const;
  const entries = [BASELINE_PATH, FORWARD_A, FORWARD_B].map((file, index) => ({ file, sha256: sha256(bodies[index]!) }));
  for (let index = 0; index < entries.length; index += 1) {
    await writeFile(join(root, entries[index]!.file), bodies[index]!);
  }
  const manifest = {
    schemaVersion: 1,
    baseline: entries[0],
    forward: entries.slice(1),
    objectInventorySha256: sha256(INVENTORY_PAYLOAD),
  };
  await writeFile(join(root, "config/platform-migration-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { root, bodies, entries, manifest };
}

describe("createPostgresMigrationRunner", () => {
  it("lists the exact manifest order before creating a pool", async () => {
    const fixture = await fixtureRoot();
    const stub = stubPool({ bodies: fixture.bodies });
    const poolFactory = vi.fn(() => stub.pool);
    const runner = createPostgresMigrationRunner({ connectionString: "x" }, {
      root: fixture.root,
      poolFactory,
      catalogProjectionPayload: async () => INVENTORY_PAYLOAD,
    });
    await expect(runner.status()).resolves.toEqual({
      pending: [BASELINE_PATH, FORWARD_A, FORWARD_B],
      applied: [],
    });
    expect(poolFactory).toHaveBeenCalledOnce();
  });

  it("executes immutable validated bytes baseline-before-forward and restarts with zero work", async () => {
    const fixture = await fixtureRoot();
    const stub = stubPool({ bodies: fixture.bodies });
    const runner = createPostgresMigrationRunner({ connectionString: "x" }, {
      root: fixture.root,
      poolFactory: () => stub.pool,
      catalogProjectionPayload: async () => INVENTORY_PAYLOAD,
    });
    await expect(runner.apply()).resolves.toEqual({ applied: [BASELINE_PATH, FORWARD_A, FORWARD_B] });
    expect(stub.queries[0]).toBe("SELECT pg_advisory_lock(hashtextextended($1, 0))");
    expect(stub.queries.find((query) => query.includes("to_regclass"))).toBe(
      "SELECT to_regclass($1) IS NOT NULL AS ledger_exists",
    );
    expect(stub.executed).toEqual(fixture.bodies);
    expect(stub.ledger).toEqual(fixture.entries.map((entry, position) => ({
      catalog_path: entry.file,
      sha256: entry.sha256,
      position,
    })));
    expect(stub.queries.at(-1)).toBe("SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked");
    await expect(runner.apply()).resolves.toEqual({ applied: [] });
    expect(stub.executed).toHaveLength(3);
  });

  it("dry-run returns the pending catalog without SQL or ledger mutation", async () => {
    const fixture = await fixtureRoot();
    const stub = stubPool({ bodies: fixture.bodies });
    const runner = createPostgresMigrationRunner({ connectionString: "x" }, {
      root: fixture.root,
      poolFactory: () => stub.pool,
      catalogProjectionPayload: async () => INVENTORY_PAYLOAD,
    });
    await expect(runner.apply({ dryRun: true })).resolves.toEqual({
      applied: [BASELINE_PATH, FORWARD_A, FORWARD_B],
    });
    expect(stub.executed).toEqual([]);
    expect(stub.ledger).toEqual([]);
  });

  it("rejects malformed or digest-mismatched catalogs before pool creation", async () => {
    const fixture = await fixtureRoot();
    const manifestPath = join(fixture.root, "config/platform-migration-manifest.json");
    const poolFactory = vi.fn(() => stubPool({ bodies: fixture.bodies }).pool);
    await writeFile(manifestPath, `${JSON.stringify({ ...fixture.manifest, unexpected: true })}\n`);
    const malformed = createPostgresMigrationRunner({ connectionString: "x" }, { root: fixture.root, poolFactory });
    await expect(malformed.apply()).rejects.toThrow("expected exactly");
    expect(poolFactory).not.toHaveBeenCalled();

    await writeFile(manifestPath, `${JSON.stringify({
      ...fixture.manifest,
      baseline: { ...fixture.manifest.baseline, sha256: "f".repeat(64) },
    })}\n`);
    const mismatched = createPostgresMigrationRunner({ connectionString: "x" }, { root: fixture.root, poolFactory });
    await expect(mismatched.apply()).rejects.toThrow("SHA-256 mismatch");
    expect(poolFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["changed digest", { catalog_path: BASELINE_PATH, sha256: "f".repeat(64), position: 0 }],
    ["changed path", { catalog_path: FORWARD_A, sha256: "0".repeat(64), position: 0 }],
    ["changed position", { catalog_path: BASELINE_PATH, sha256: "0".repeat(64), position: 1 }],
  ])("rejects a non-prefix ledger: %s", async (_label, changed) => {
    const fixture = await fixtureRoot();
    const first = { catalog_path: BASELINE_PATH, sha256: fixture.entries[0]!.sha256, position: 0 };
    const stub = stubPool({ ledger: [{ ...first, ...changed }], bodies: fixture.bodies });
    const runner = createPostgresMigrationRunner({ connectionString: "x" }, {
      root: fixture.root,
      poolFactory: () => stub.pool,
      catalogProjectionPayload: async () => INVENTORY_PAYLOAD,
    });
    await expect(runner.status()).rejects.toThrow("not the exact manifest prefix");
    expect(stub.executed).toEqual([]);
  });

  it("rejects canonical object-inventory drift after apply", async () => {
    const fixture = await fixtureRoot();
    const stub = stubPool({ bodies: fixture.bodies });
    const runner = createPostgresMigrationRunner({ connectionString: "x" }, {
      root: fixture.root,
      poolFactory: () => stub.pool,
      catalogProjectionPayload: async () => "different inventory",
    });
    await expect(runner.apply()).rejects.toThrow("object inventory SHA-256 mismatch");
  });

  it("reads DATABASE_URL without fallback history configuration", () => {
    expect(resolvePostgresMigrationRunnerEnv({ DATABASE_URL: "postgres://y" })).toEqual({
      connectionString: "postgres://y",
    });
  });

  it("rejects an empty DATABASE_URL before creating a pool", async () => {
    const fixture = await fixtureRoot();
    const poolFactory = vi.fn(() => stubPool({ bodies: fixture.bodies }).pool);
    const runner = createPostgresMigrationRunner({ connectionString: "" }, {
      root: fixture.root,
      poolFactory,
      catalogProjectionPayload: async () => INVENTORY_PAYLOAD,
    });
    await expect(runner.apply()).rejects.toThrow("DATABASE_URL is required");
    expect(poolFactory).not.toHaveBeenCalled();
  });
});

// Characterization of the canonical selected-catalog-v2 serializer, pinned BEFORE the
// serializer moves out of the parked receipt family and into this adapter directory.
// `config/platform-migration-manifest.json` stores sha256 of exactly these bytes, and
