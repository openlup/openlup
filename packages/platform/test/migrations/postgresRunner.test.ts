import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresMigrationRunner,
  resolvePostgresMigrationRunnerEnv,
  type PlatformMigrationManifest,
  type PlatformMigrationSource,
  type PostgresMigrationRunnerOptions,
} from "../../src/migrations/postgresRunner.js";

const lockName = "synthetic-schema-update";
const acquireSql = "SELECT pg_advisory_lock(hashtextextended($1, 0))";
const releaseSql = "SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS unlocked";
const existenceSql = "SELECT to_regclass($1) IS NOT NULL AS ledger_exists";
const boundAcquireSql = "SELECT pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended($1::pg_catalog.text, 0::pg_catalog.int8))";
const boundReleaseSql = "SELECT pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended($1::pg_catalog.text, 0::pg_catalog.int8)) AS unlocked";
const boundExistenceSql = "SELECT pg_catalog.to_regclass($1::pg_catalog.text) IS NOT NULL AS ledger_exists";
const ledgerSql = "SELECT catalog_path, sha256, position FROM public.platform_schema_migrations ORDER BY position";
const insertSql = "INSERT INTO public.platform_schema_migrations (catalog_path, sha256, position) VALUES ($1, $2, $3)";
const ledgerName = "public.platform_schema_migrations";
const root = "/virtual/migration-input";
const env = { connectionString: "postgres://localhost/reference" };
const inventory = "inventory-v1:objects=3";
const files = [
  "migrations/00000000000000_baseline.sql",
  "migrations/00000000000001_step.sql",
  "migrations/00000000000002_step.sql",
];
const bodies = [
  "-- synthetic baseline\nCREATE TABLE public.platform_schema_migrations (catalog_path text, sha256 text, position integer);\n",
  "-- synthetic first step\nSELECT 17;\n",
  "-- synthetic second step\nSELECT 29;\n",
];
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const entries = files.map((file, index) => ({ file, sha256: digest(bodies[index]!) }));
type LedgerRow = { catalog_path: unknown; sha256: unknown; position: unknown };
const expectedRows = (): LedgerRow[] => entries.map((entry, position) => ({
  catalog_path: entry.file, sha256: entry.sha256, position,
}));

function scenario(input: {
  rows?: LedgerRow[];
  fail?: (sql: string) => unknown;
  unlockRows?: Record<string, unknown>[];
  ignoreInserts?: boolean;
} = {}) {
  let present = input.rows !== undefined;
  const rows = (input.rows ?? []).map((row) => ({ ...row }));
  let snapshot: { present: boolean; rows: LedgerRow[] } | undefined;
  const query = vi.fn(async (sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> => {
    const failure = input.fail?.(sql);
    if (failure !== undefined) throw failure;
    if (sql === acquireSql || sql === boundAcquireSql) return { rows: [{}] };
    if (sql === releaseSql || sql === boundReleaseSql) return { rows: input.unlockRows ?? [{ unlocked: true }] };
    if (sql === existenceSql || sql === boundExistenceSql) return { rows: [{ ledger_exists: present }] };
    if (sql === ledgerSql) return { rows: rows.map((row) => ({ ...row })) };
    if (sql === "BEGIN") snapshot = { present, rows: rows.map((row) => ({ ...row })) };
    else if (sql === "COMMIT") snapshot = undefined;
    else if (sql === "ROLLBACK") {
      if (snapshot) {
        present = snapshot.present;
        rows.splice(0, rows.length, ...snapshot.rows);
        snapshot = undefined;
      }
    } else if (sql === insertSql) {
      if (!input.ignoreInserts) rows.push({ catalog_path: values?.[0], sha256: values?.[1], position: values?.[2] });
    } else if (bodies.includes(sql)) present = true;
    else throw new Error(`unexpected query: ${sql}`);
    return { rows: [] };
  });
  const release = vi.fn();
  const client = { query, release };
  const connect = vi.fn(async () => client);
  const pool = { connect } as unknown as Pool;
  const poolFactory = vi.fn(async () => pool);
  const manifest: PlatformMigrationManifest = {
    schemaVersion: 1, baseline: entries[0]!, forward: entries.slice(1), objectInventorySha256: digest(inventory),
  };
  // Catalogue enumeration differs from manifest order so execution must follow the manifest.
  const migrations = files.map((file, index) => ({ file, content: bodies[index]! })).reverse();
  const readMigrations = vi.fn((_root: string) => ({ migrations, errors: [] as string[] }));
  const readManifest = vi.fn((_root: string): unknown | null => manifest);
  const evaluate = vi.fn((_input: Parameters<PlatformMigrationSource["evaluate"]>[0]): string[] => []);
  const source: PlatformMigrationSource = { readMigrations, readManifest, evaluate };
  const catalogProjectionPayload = vi.fn(async (_client: PoolClient) => inventory);
  const makeRunner = (overrides: Partial<PostgresMigrationRunnerOptions> = {}, connectionString = env.connectionString) =>
    createPostgresMigrationRunner({ connectionString }, {
      lockName, root, source, poolFactory, catalogProjectionPayload, ...overrides,
    });
  return {
    rows, query, release, client, connect, poolFactory, manifest, migrations,
    readMigrations, readManifest, evaluate, catalogProjectionPayload, makeRunner, source,
  };
}

describe("PostgreSQL migration runner", () => {
  it("admits one isolated exact prefix under the lock before executing any pending SQL", async () => {
    const s = scenario({ rows: expectedRows().slice(0, 1) });
    const admission = vi.fn(async (client: PoolClient, applied: readonly (typeof entries[number] & { position: number })[]) => {
      expect(client).toBe(s.client);
      expect(applied).toEqual([{ ...entries[0], position: 0 }]);
      expect(s.query.mock.calls).toEqual([[boundAcquireSql, [lockName]], [boundExistenceSql, [ledgerName]], [ledgerSql]]);
    });
    await expect(s.makeRunner({ source: { ...s.source, assertSession: admission } }).apply()).resolves.toEqual({ applied: files.slice(1) });
    expect(admission).toHaveBeenCalledOnce();
    expect(admission.mock.invocationCallOrder[0]).toBeLessThan(s.query.mock.invocationCallOrder[3]!);
    expect(s.rows).toEqual(expectedRows());
    expect(s.query.mock.calls.slice(-3)).toEqual([[boundExistenceSql, [ledgerName]], [ledgerSql], [boundReleaseSql, [lockName]]]);
    expect(s.query.mock.calls.filter(([sql]) => [acquireSql, existenceSql, releaseSql].includes(sql))).toEqual([]);
  });

  it.each(["status", "apply", "dry-run"] as const)("refuses session admission before %s results or pending writes and releases the lock", async method => {
    const s = scenario({ rows: expectedRows().slice(0, 1) });
    const admission = vi.fn(async () => { throw new Error("declared runtime binding differs"); });
    const runner = s.makeRunner({ source: { ...s.source, assertSession: admission } });
    const result = method === "status" ? runner.status() : runner.apply({ dryRun: method === "dry-run" });
    await expect(result).rejects.toThrow("declared runtime binding differs");
    expect(admission).toHaveBeenCalledOnce();
    expect(s.query.mock.calls).toEqual([[boundAcquireSql, [lockName]], [boundExistenceSql, [ledgerName]], [ledgerSql], [boundReleaseSql, [lockName]]]);
    expect(s.release).toHaveBeenCalledExactlyOnceWith(false);
    expect(s.rows).toEqual(expectedRows().slice(0, 1));
    expect(s.catalogProjectionPayload).not.toHaveBeenCalled();
  });

  it.each(["status", "dry-run"] as const)("uses catalog-bound session queries around successful %s admission", async method => {
    const s = scenario({ rows: expectedRows().slice(0, 1) });
    const admission = vi.fn(async () => {});
    const runner = s.makeRunner({ source: { ...s.source, assertSession: admission } });
    if (method === "status") await expect(runner.status()).resolves.toEqual({ pending: files.slice(1), applied: files.slice(0, 1) });
    else await expect(runner.apply({ dryRun: true })).resolves.toEqual({ applied: files.slice(1) });
    expect(admission).toHaveBeenCalledOnce();
    expect(s.query.mock.calls).toEqual([[boundAcquireSql, [lockName]], [boundExistenceSql, [ledgerName]], [ledgerSql], [boundReleaseSql, [lockName]]]);
    expect(s.release).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("preserves the legacy transcript when the session hook is explicitly undefined", async () => {
    const s = scenario({ rows: expectedRows().slice(0, 1) });
    await expect(s.makeRunner({ source: { ...s.source, assertSession: undefined } }).status())
      .resolves.toEqual({ pending: files.slice(1), applied: files.slice(0, 1) });
    expect(s.query.mock.calls).toEqual([[acquireSql, [lockName]], [existenceSql, [ledgerName]], [ledgerSql], [releaseSql, [lockName]]]);
  });

  it("rejects a mismatched prefix before calling admission and releases the catalog-bound lock", async () => {
    const s = scenario({ rows: [{ ...expectedRows()[0]!, sha256: "changed" }] });
    const admission = vi.fn(async () => {});
    await expect(s.makeRunner({ source: { ...s.source, assertSession: admission } }).status())
      .rejects.toThrow("platform migration ledger is not the exact manifest prefix at position 0");
    expect(admission).not.toHaveBeenCalled();
    expect(s.query.mock.calls).toEqual([[boundAcquireSql, [lockName]], [boundExistenceSql, [ledgerName]], [ledgerSql], [boundReleaseSql, [lockName]]]);
  });

  it("validates the plan before creating a reusable pool and lists manifest order under the supplied lock", async () => {
    const s = scenario();
    const runner = s.makeRunner();
    expect(s.poolFactory).not.toHaveBeenCalled();
    await expect(runner.status()).resolves.toEqual({ pending: files, applied: [] });
    expect(s.readMigrations).toHaveBeenCalledWith(root);
    expect(s.readManifest).toHaveBeenCalledWith(root);
    expect(s.evaluate).toHaveBeenCalledExactlyOnceWith({ manifest: s.manifest, migrations: s.migrations });
    expect(s.readMigrations.mock.invocationCallOrder[0]).toBeLessThan(s.readManifest.mock.invocationCallOrder[0]!);
    expect(s.readManifest.mock.invocationCallOrder[0]).toBeLessThan(s.evaluate.mock.invocationCallOrder[0]!);
    expect(s.evaluate.mock.invocationCallOrder[0]).toBeLessThan(s.poolFactory.mock.invocationCallOrder[0]!);
    expect(s.poolFactory).toHaveBeenCalledExactlyOnceWith(env);
    expect(s.query.mock.calls).toEqual([
      [acquireSql, [lockName]], [existenceSql, [ledgerName]], [releaseSql, [lockName]],
    ]);
    expect(s.catalogProjectionPayload).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledExactlyOnceWith(false);
    await runner.status();
    expect(s.poolFactory).toHaveBeenCalledOnce();
    expect(s.connect).toHaveBeenCalledTimes(2);
    expect(s.readMigrations).toHaveBeenCalledTimes(2);
  });

  it("defaults only the source root to the current directory", async () => {
    const s = scenario();
    await s.makeRunner({ root: undefined }).status();
    expect(s.readMigrations).toHaveBeenCalledWith(process.cwd());
    expect(s.readManifest).toHaveBeenCalledWith(process.cwd());
  });

  it("applies exact SQL bytes and ledger inserts in individual ordered transactions, then performs no work on restart", async () => {
    const s = scenario();
    const runner = s.makeRunner();
    await expect(runner.apply()).resolves.toEqual({ applied: files });
    expect(s.query.mock.calls).toEqual([
      [acquireSql, [lockName]], [existenceSql, [ledgerName]],
      ...bodies.flatMap((sql, index) => [
        ["BEGIN"], [sql], [insertSql, [files[index], entries[index]!.sha256, index]], ["COMMIT"],
      ]),
      [existenceSql, [ledgerName]], [ledgerSql], [releaseSql, [lockName]],
    ]);
    expect(s.rows).toEqual(expectedRows());
    expect(s.catalogProjectionPayload).toHaveBeenCalledExactlyOnceWith(s.client);
    expect(s.evaluate.mock.calls).toEqual([
      [{ manifest: s.manifest, migrations: s.migrations }],
      [{ manifest: s.manifest, migrations: s.migrations, objectInventoryPayload: inventory }],
    ]);
    expect(s.query.mock.invocationCallOrder.at(-2)).toBeLessThan(s.catalogProjectionPayload.mock.invocationCallOrder[0]!);
    expect(s.catalogProjectionPayload.mock.invocationCallOrder[0]).toBeLessThan(s.evaluate.mock.invocationCallOrder[1]!);
    expect(s.evaluate.mock.invocationCallOrder[1]).toBeLessThan(s.query.mock.invocationCallOrder.at(-1)!);
    s.query.mockClear();
    await expect(runner.apply()).resolves.toEqual({ applied: [] });
    expect(s.query.mock.calls).toEqual([
      [acquireSql, [lockName]], [existenceSql, [ledgerName]], [ledgerSql],
      [existenceSql, [ledgerName]], [ledgerSql], [releaseSql, [lockName]],
    ]);
    expect(s.catalogProjectionPayload).toHaveBeenCalledTimes(2);
    expect(s.poolFactory).toHaveBeenCalledOnce();
  });

  it("resumes after an exact prefix without executing or inserting already applied units", async () => {
    const s = scenario({ rows: expectedRows().slice(0, 1) });
    const runner = s.makeRunner();
    await expect(runner.status()).resolves.toEqual({ applied: files.slice(0, 1), pending: files.slice(1) });
    await expect(runner.apply()).resolves.toEqual({ applied: files.slice(1) });
    expect(s.query).not.toHaveBeenCalledWith(bodies[0]);
    expect(s.query.mock.calls.filter(([sql]) => sql === insertSql)).toEqual([
      [insertSql, [files[1], entries[1]!.sha256, 1]], [insertSql, [files[2], entries[2]!.sha256, 2]],
    ]);
    expect(s.rows).toEqual(expectedRows());
  });

  it.each([0, 1, 3])("dry-run reports the pending suffix for prefix length %i without transaction or ledger writes", async (length) => {
    const s = scenario({ rows: expectedRows().slice(0, length) });
    await expect(s.makeRunner().apply({ dryRun: true })).resolves.toEqual({ applied: files.slice(length) });
    expect(s.query.mock.calls).toEqual([
      [acquireSql, [lockName]], [existenceSql, [ledgerName]], [ledgerSql], [releaseSql, [lockName]],
    ]);
    expect(s.rows).toEqual(expectedRows().slice(0, length));
    expect(s.catalogProjectionPayload).toHaveBeenCalledTimes(length === 3 ? 1 : 0);
  });

  it.each(["status", "apply"] as const)("rejects catalogue and manifest refusals before pool creation during %s", async (method) => {
    const s = scenario();
    s.readMigrations.mockReturnValue({ migrations: s.migrations, errors: ["catalogue unavailable"] });
    s.readManifest.mockReturnValue(null);
    await expect(s.makeRunner()[method]()).rejects.toThrow(
      /^platform migration catalog rejected: catalogue unavailable; platform migration manifest is missing$/,
    );
    expect(s.evaluate).not.toHaveBeenCalled();
    expect(s.poolFactory).not.toHaveBeenCalled();
    expect(s.connect).not.toHaveBeenCalled();
  });

  it.each(["manifest shape invalid", "SHA-256 mismatch"])("preserves source validation refusal: %s", async (reason) => {
    const s = scenario();
    s.readMigrations.mockReturnValue({ migrations: s.migrations, errors: ["catalogue read warning"] });
    s.evaluate.mockReturnValue([reason, "second refusal"]);
    await expect(s.makeRunner().apply()).rejects.toThrow(
      `platform migration catalog rejected: catalogue read warning; ${reason}; second refusal`,
    );
    expect(s.evaluate).toHaveBeenCalledExactlyOnceWith({ manifest: s.manifest, migrations: s.migrations });
    expect(s.poolFactory).not.toHaveBeenCalled();
  });

  it("rejects a missing manifest by itself", async () => {
    const s = scenario();
    s.readManifest.mockReturnValue(null);
    await expect(s.makeRunner().status()).rejects.toThrow(
      /^platform migration catalog rejected: platform migration manifest is missing$/,
    );
    expect(s.poolFactory).not.toHaveBeenCalled();
  });

  it.each([
    ["digest", { sha256: "f".repeat(64) }],
    ["path", { catalog_path: files[1] }],
    ["position", { position: 1 }],
    ["position type", { position: "0" }],
  ])("rejects a non-prefix ledger with changed %s", async (_label, delta) => {
    const s = scenario({ rows: [{ ...expectedRows()[0]!, ...delta }] });
    const runner = s.makeRunner();
    await expect(runner.status()).rejects.toThrow(/^platform migration ledger is not the exact manifest prefix at position 0$/);
    await expect(runner.apply()).rejects.toThrow(/^platform migration ledger is not the exact manifest prefix at position 0$/);
    expect(s.query.mock.calls).toEqual(Array.from({ length: 2 }, () => [
      [acquireSql, [lockName]], [existenceSql, [ledgerName]], [ledgerSql], [releaseSql, [lockName]],
    ]).flat());
    expect(s.catalogProjectionPayload).not.toHaveBeenCalled();
    expect(s.release.mock.calls).toEqual([[false], [false]]);
  });

  it("reports the exact position of a later prefix mismatch", async () => {
    const rows = expectedRows().slice(0, 2);
    rows[1]!.sha256 = "changed";
    const s = scenario({ rows });
    await expect(s.makeRunner().status()).rejects.toThrow(/^platform migration ledger is not the exact manifest prefix at position 1$/);
  });

  it("rejects extra ledger rows even when the known prefix is intact", async () => {
    const s = scenario({ rows: [...expectedRows(), { catalog_path: "migrations/extra.sql", sha256: "extra", position: 3 }] });
    await expect(s.makeRunner().apply()).rejects.toThrow(/^platform migration ledger contains an extra row$/);
    expect(s.query).not.toHaveBeenCalledWith("BEGIN");
    expect(s.catalogProjectionPayload).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledWith(false);
  });

  it.each(["status", "apply", "dryRun"] as const)("evaluates live inventory on a complete ledger during %s", async (method) => {
    const s = scenario({ rows: expectedRows() });
    const payload = "inventory-v2:objects=4";
    s.catalogProjectionPayload.mockResolvedValue(payload);
    s.evaluate.mockImplementation((input) => input.objectInventoryPayload === undefined
      ? [] : ["object inventory SHA-256 mismatch", "unexpected object"]);
    const runner = s.makeRunner();
    const operation = method === "status" ? runner.status() : runner.apply({ dryRun: method === "dryRun" });
    await expect(operation).rejects.toThrow(
      /^platform migration inventory rejected: object inventory SHA-256 mismatch; unexpected object$/,
    );
    expect(s.catalogProjectionPayload).toHaveBeenCalledExactlyOnceWith(s.client);
    expect(s.evaluate).toHaveBeenLastCalledWith({ manifest: s.manifest, migrations: s.migrations, objectInventoryPayload: payload });
    expect(s.query).not.toHaveBeenCalledWith("BEGIN");
    expect(s.release).toHaveBeenCalledWith(false);
  });

  it("reports inventory drift after applying the full chain", async () => {
    const s = scenario();
    s.evaluate.mockImplementation((input) => input.objectInventoryPayload === undefined ? [] : ["object inventory SHA-256 mismatch"]);
    await expect(s.makeRunner().apply()).rejects.toThrow(/^platform migration inventory rejected: object inventory SHA-256 mismatch$/);
    expect(s.rows).toEqual(expectedRows());
    expect(s.query.mock.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(3);
    expect(s.query).not.toHaveBeenCalledWith("ROLLBACK");
  });

  it("refuses an incomplete ledger after apply before evaluating inventory", async () => {
    const s = scenario({ ignoreInserts: true });
    await expect(s.makeRunner().apply()).rejects.toThrow(/^platform migration ledger is incomplete after apply$/);
    expect(s.catalogProjectionPayload).not.toHaveBeenCalled();
    expect(s.query).toHaveBeenLastCalledWith(releaseSql, [lockName]);
    expect(s.release).toHaveBeenCalledWith(false);
  });

  it.each(["body", "insert", "commit"])("rolls back a failing %s, preserves earlier commits and stops before later migrations", async (stage) => {
    let inserts = 0;
    let commits = 0;
    const s = scenario({ fail: (sql) => {
      if (stage === "body" && sql === bodies[1]) return new Error("step refused");
      if (sql === insertSql && ++inserts === 2 && stage === "insert") return new Error("step refused");
      if (sql === "COMMIT" && ++commits === 2 && stage === "commit") return new Error("step refused");
      return undefined;
    } });
    await expect(s.makeRunner().apply()).rejects.toThrow(`platform migration ${files[1]} failed: step refused`);
    expect(s.rows).toEqual(expectedRows().slice(0, 1));
    expect(s.query).toHaveBeenCalledWith("ROLLBACK");
    expect(s.query).not.toHaveBeenCalledWith(bodies[2]);
    expect(s.query.mock.calls.slice(-2)).toEqual([["ROLLBACK"], [releaseSql, [lockName]]]);
    expect(s.catalogProjectionPayload).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledWith(false);
  });

  it("retains the migration failure when rollback also fails, including non-Error failures", async () => {
    const s = scenario({ fail: (sql) => sql === bodies[0] ? "statement refused"
      : sql === "ROLLBACK" ? new Error("rollback refused") : undefined });
    await expect(s.makeRunner().apply()).rejects.toThrow(`platform migration ${files[0]} failed: statement refused`);
    expect(s.query.mock.calls.slice(-2)).toEqual([["ROLLBACK"], [releaseSql, [lockName]]]);
    expect(s.release).toHaveBeenCalledWith(false);
  });

  it("releases the lock after a transaction-start failure without attempting rollback", async () => {
    const failure = new Error("transaction unavailable");
    const s = scenario({ fail: (sql) => sql === "BEGIN" ? failure : undefined });
    await expect(s.makeRunner().apply()).rejects.toBe(failure);
    expect(s.query).not.toHaveBeenCalledWith("ROLLBACK");
    expect(s.query).toHaveBeenLastCalledWith(releaseSql, [lockName]);
    expect(s.release).toHaveBeenCalledWith(false);
  });

  it.each([[], [{ unlocked: false }], [{ unlocked: "true" }]].map((unlockRows) => ({ unlockRows })))("destroys the client when unlock has no true acknowledgement: $unlockRows", async ({ unlockRows }) => {
    const s = scenario({ unlockRows });
    await expect(s.makeRunner().status()).rejects.toThrow(
      /^platform migration advisory lock release failed: PostgreSQL did not release the advisory lock$/,
    );
    expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("reports an unlock query failure after a successful operation", async () => {
    const s = scenario({ fail: (sql) => sql === releaseSql ? new Error("unlock unavailable") : undefined });
    await expect(s.makeRunner().status()).rejects.toThrow(/^platform migration advisory lock release failed: unlock unavailable$/);
    expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("aggregates operation and lock-release failures and destroys the client", async () => {
    const s = scenario({ fail: (sql) => sql === existenceSql ? new Error("ledger unavailable")
      : sql === releaseSql ? "unlock unavailable" : undefined });
    await expect(s.makeRunner().status()).rejects.toThrow(
      /^platform migration operation failed: ledger unavailable; advisory lock release failed: unlock unavailable$/,
    );
    expect(s.query).toHaveBeenLastCalledWith(releaseSql, [lockName]);
    expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not unlock an unacquired lock and destroys the client after acquisition failure", async () => {
    const failure = new Error("lock unavailable");
    const s = scenario({ fail: (sql) => sql === acquireSql ? failure : undefined });
    await expect(s.makeRunner().status()).rejects.toBe(failure);
    expect(s.query.mock.calls).toEqual([[acquireSql, [lockName]]]);
    expect(s.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("propagates pool connection failures without querying or releasing an absent client", async () => {
    const s = scenario();
    const failure = new Error("connection unavailable");
    s.connect.mockRejectedValue(failure);
    await expect(s.makeRunner().status()).rejects.toBe(failure);
    expect(s.query).not.toHaveBeenCalled();
    expect(s.release).not.toHaveBeenCalled();
  });

  it("releases the lock after an inventory projector failure", async () => {
    const s = scenario({ rows: expectedRows() });
    const failure = new Error("projection unavailable");
    s.catalogProjectionPayload.mockRejectedValue(failure);
    await expect(s.makeRunner().status()).rejects.toBe(failure);
    expect(s.evaluate).toHaveBeenCalledOnce();
    expect(s.query).toHaveBeenLastCalledWith(releaseSql, [lockName]);
    expect(s.release).toHaveBeenCalledWith(false);
  });

  it.each(["", " \t\n"])("refuses empty connection string %j before loading a plan or creating a pool", async (connectionString) => {
    const s = scenario();
    const runner = s.makeRunner({}, connectionString);
    await expect(runner.status()).rejects.toThrow(/^DATABASE_URL is required for node-postgres migrations$/);
    await expect(runner.apply()).rejects.toThrow(/^DATABASE_URL is required for node-postgres migrations$/);
    expect(s.readMigrations).not.toHaveBeenCalled();
    expect(s.readManifest).not.toHaveBeenCalled();
    expect(s.poolFactory).not.toHaveBeenCalled();
  });

  it("resolves only DATABASE_URL and preserves its supplied value", () => {
    expect(resolvePostgresMigrationRunnerEnv({ DATABASE_URL: "postgres://localhost/reference", APP_BASE_URL: "https://example.test" }))
      .toEqual(env);
    expect(resolvePostgresMigrationRunnerEnv({ DATABASE_URL: "  postgres://localhost/reference  " }))
      .toEqual({ connectionString: "  postgres://localhost/reference  " });
    expect(resolvePostgresMigrationRunnerEnv({})).toEqual({ connectionString: "" });
    expect(resolvePostgresMigrationRunnerEnv({ DATABASE_URL: "" })).toEqual({ connectionString: "" });
  });
});
