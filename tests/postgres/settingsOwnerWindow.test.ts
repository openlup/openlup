import { readFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { createPostgresMigrationRunner, type PlatformMigrationManifest } from "@openlup/platform/migrations";
import { PLATFORM_BASELINE_FILE } from "../../scripts/platform-migration-manifest.js";
import { renderNativeStoreSettingsOwnerWindow, sqlSha256, sqlStatements } from "../../scripts/reviewed-platform-forward.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, runPostgresContainer,
  waitForPostgresTcpReady, type PostgresContainer } from "../helpers/postgresContainer.js";

const ownerRole = "window_fixture_owner";
const installerRole = "window_fixture_installer";
const signatures = Array.from({ length: 6 }, (_, index) => `public.window_fixture_${index + 1}()`);
const targets = signatures.map(signature => ({ signature, searchPath: "pg_catalog, pg_temp" }));
const forward = renderNativeStoreSettingsOwnerWindow(targets, ownerRole);
const [open, ...afterOpen] = sqlStatements(forward, false, false, true);
const forwardFile = "db/platform/migrations/20990101000000_fixture_owner_window.sql";
const inventory = "synthetic owner-window fixture";
const ledger = readFileSync(PLATFORM_BASELINE_FILE, "utf8").match(/CREATE TABLE public\.platform_schema_migrations \([\s\S]*?\n\);/u)?.[0];
if (!ledger) throw new Error("canonical baseline ledger definition missing");
const baseline = { file: PLATFORM_BASELINE_FILE, content: ledger };
const unit = { file: forwardFile, content: forward };
const entry = ({ file, content }: typeof unit) => ({ file, sha256: sqlSha256(content) });

let container: PostgresContainer | undefined;
let admin: Pool;
let installer: Pool;

function runner(includeForward = true) {
  const manifest: PlatformMigrationManifest = {
    schemaVersion: 1, baseline: entry(baseline), forward: includeForward ? [entry(unit)] : [],
    objectInventorySha256: sqlSha256(inventory),
  };
  return createPostgresMigrationRunner({ connectionString: "" }, {
    pool: installer, lockName: "settings-owner-window-fixture",
    catalogProjectionPayload: async () => inventory,
    source: {
      readMigrations: () => ({ migrations: includeForward ? [baseline, unit] : [baseline], errors: [] }),
      readManifest: () => manifest,
      evaluate: () => [],
    },
  });
}

const memberships = async (db: Pool | PoolClient) => (await db.query("SELECT * FROM pg_catalog.pg_auth_members ORDER BY oid")).rows;
const functionPaths = async (db: Pool | PoolClient) => (await db.query<{ proconfig: string[] }>(`
  SELECT p.proconfig FROM unnest($1::text[]) WITH ORDINALITY AS f(signature, position)
  JOIN pg_catalog.pg_proc AS p ON p.oid = f.signature::regprocedure ORDER BY f.position`, [signatures])).rows.map(row => row.proconfig);
const original = signatures.map(() => ["search_path=pg_catalog"]);
const pinned = targets.map(({ searchPath }) => [`search_path=${searchPath}`]);

async function inUnit(pool: Pool, finish: "COMMIT" | "ROLLBACK", apply: (db: PoolClient) => Promise<void>) {
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    try {
      await apply(db);
      await db.query(finish);
    } catch (error) {
      await db.query("ROLLBACK");
      throw error;
    }
  } finally { db.release(); }
}

beforeAll(async () => {
  container = await runPostgresContainer({ name: `settings-owner-window-${process.pid}`, password: "synthetic-conformance" });
  if (!await waitForPostgresTcpReady(container.connectionString)) throw new Error("settings owner window PostgreSQL unavailable");
  admin = new Pool({ connectionString: container.connectionString });
  await admin.query(`CREATE ROLE ${ownerRole} NOLOGIN;
    CREATE ROLE ${installerRole} LOGIN NOINHERIT NOSUPERUSER NOCREATEROLE PASSWORD 'synthetic-only';
    GRANT ${ownerRole} TO ${installerRole} WITH ADMIN TRUE, INHERIT FALSE, SET FALSE;
    GRANT CREATE ON SCHEMA public TO ${installerRole};
    ${signatures.map(signature => `CREATE FUNCTION ${signature} RETURNS int LANGUAGE sql SET search_path = pg_catalog AS 'SELECT 1';
      ALTER FUNCTION ${signature} OWNER TO ${ownerRole};`).join("\n")}`);
  const url = new URL(container.connectionString);
  url.username = installerRole;
  url.password = "synthetic-only";
  installer = new Pool({ connectionString: url.toString() });
  await runner(false).apply();
  await admin.query(`REVOKE CREATE ON SCHEMA public FROM ${installerRole}`);
}, postgresSetupTimeoutMs);

beforeEach(async () => {
  await admin.query(signatures.map(signature => `ALTER FUNCTION ${signature} SET search_path = pg_catalog;`).join("\n"));
  await admin.query("DELETE FROM public.platform_schema_migrations WHERE catalog_path = $1", [forwardFile]);
});

afterAll(() => closePostgres(container, [admin, installer]), postgresTeardownTimeoutMs);

it("commits all six settings through the ledger runner and retains only the original memberships", async () => {
  const before = await memberships(admin);
  expect(await functionPaths(admin)).toEqual(original);
  await expect(installer.query(`ALTER FUNCTION ${signatures[0]} SET search_path = pg_catalog, pg_temp`))
    .rejects.toMatchObject({ code: "42501", message: "must be owner of function public.window_fixture_1" });
  expect(await runner().apply()).toEqual({ applied: [forwardFile] });
  expect(await functionPaths(admin)).toEqual(pinned);
  expect(await memberships(admin)).toEqual(before);
  expect(await runner().status()).toEqual({ pending: [], applied: [PLATFORM_BASELINE_FILE, forwardFile] });
});

it("opens an inherited-only edge in the unit and rolls all settings back explicitly", async () => {
  const before = await memberships(admin);
  await inUnit(installer, "ROLLBACK", async db => {
    await db.query(open!);
    const during = await memberships(db);
    expect(during).toHaveLength(before.length + 1);
    expect(during).toEqual(expect.arrayContaining(before));
    const edge = (await db.query(`SELECT admin_option, inherit_option, set_option FROM pg_catalog.pg_auth_members
      WHERE roleid = $1::regrole AND member = current_user::regrole AND grantor = member`, [ownerRole])).rows;
    expect(edge).toEqual([{ admin_option: false, inherit_option: true, set_option: false }]);
    await db.query(afterOpen.join("\n"));
    expect(await functionPaths(db)).toEqual(pinned);
    expect(await memberships(db)).toEqual(before);
  });
  expect(await memberships(admin)).toEqual(before);
  expect(await functionPaths(admin)).toEqual(original);
});

it("rolls back the settings and the grant when the sixth ALTER fails in the ledger runner", async () => {
  const sixth = signatures.at(-1)!;
  await admin.query(`ALTER FUNCTION ${sixth} OWNER TO CURRENT_USER`);
  try {
    const before = await memberships(admin);
    await expect(runner().apply()).rejects.toThrow("must be owner of function public.window_fixture_6");
    expect(await functionPaths(admin)).toEqual(original);
    expect(await memberships(admin)).toEqual(before);
    expect(await runner().status()).toEqual({ pending: [forwardFile], applied: [PLATFORM_BASELINE_FILE] });
  } finally { await admin.query(`ALTER FUNCTION ${sixth} OWNER TO ${ownerRole}`); }
});

it("refuses and preserves a pre-existing self-granted edge", async () => {
  await installer.query(`GRANT ${ownerRole} TO CURRENT_USER WITH ADMIN FALSE, INHERIT TRUE, SET FALSE GRANTED BY CURRENT_USER`);
  try {
    const before = await memberships(admin);
    await expect(inUnit(installer, "COMMIT", async db => { await db.query(forward); })).rejects.toMatchObject({
      code: "42501", message: `installer already holds a self-granted membership in ${ownerRole}`,
      hint: `Revoke that membership with REVOKE ${ownerRole} FROM the installer GRANTED BY the installer, then rerun the migration.`,
    });
    expect(await memberships(admin)).toEqual(before);
    expect(await functionPaths(admin)).toEqual(original);
  } finally { await installer.query(`REVOKE ${ownerRole} FROM CURRENT_USER GRANTED BY CURRENT_USER`); }
});

it("skips OPEN for a superuser and commits all six settings without a membership edge", async () => {
  const before = await memberships(admin);
  await inUnit(admin, "COMMIT", async db => {
    await db.query(open!);
    expect(await memberships(db)).toEqual(before);
    await db.query(afterOpen.join("\n"));
  });
  expect(await memberships(admin)).toEqual(before);
  expect(await functionPaths(admin)).toEqual(pinned);
});
