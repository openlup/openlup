import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readPlatformMigrationManifest, sha256, type PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import { installAccountMutations } from "./customerAccountMutations.fixture.js";

const catalogue = readPlatformMigrationManifest(process.cwd()) as PlatformMigrationManifest | null;
if (catalogue?.schemaVersion !== 3) throw new Error("Expected native catalogue");
const manifest = catalogue;
const suffix = "_paid_order_money_v2_read.sql";
const position = manifest.forward.findIndex(entry => entry.file.endsWith(suffix));
const fixture = readFileSync("tests/postgres/fixtures/paidOrderMoneyV2Read/replayed.sql", "utf8");
let container: PostgresContainer | undefined;
let pool: Pool | undefined;

beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `paid-money-pgtap-${process.pid}`, password: "synthetic-conformance" });
  const url = new URL(container.connectionString);
  url.username = "supabase_admin";
  const bootstrap = new Pool({ connectionString: url.toString() });
  try {
    await bootstrap.query("DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role; CREATE ROLE service_role");
    await bootstrap.query("CREATE DATABASE paid_money_reader WITH TEMPLATE template0");
  } finally { await bootstrap.end(); }
  url.pathname = "/paid_money_reader";
  pool = new Pool({ connectionString: url.toString() });
  await pool.query("CREATE SCHEMA extensions; CREATE EXTENSION pgtap WITH SCHEMA extensions");
  for (const entry of [manifest.baseline, ...manifest.forward.slice(0, position < 0 ? undefined : position)]) {
    const body = readFileSync(entry.file, "utf8");
    expect(sha256(body)).toBe(entry.sha256);
    await pool.query(body);
  }
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, pool), postgresTeardownTimeoutMs);

it.each([["replay_roles_present", true], ["replay_roles_absent", false]] as const)("%s", async (_name, roles) => {
  const db = await pool!.connect();
  try {
    await db.query("BEGIN; SET LOCAL search_path=public,extensions");
    await db.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    END $$`);
    if (!roles) await db.query("DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role");
    await db.query(`CREATE TEMP TABLE reader_predecessor_functions AS
      SELECT oid,oid::regprocedure::text AS signature,md5(pg_get_functiondef(oid)) AS definition,proowner,proacl::text FROM pg_proc
      WHERE pronamespace='public'::regnamespace`);
    const unit = manifest.forward[position];
    if (unit) {
      const sql = readFileSync(unit.file, "utf8");
      expect(sha256(sql)).toBe(unit.sha256);
      await db.query(sql);
    }
    const result = await db.query(fixture);
    const lines = (Array.isArray(result) ? result : [result]).flatMap(part =>
      part.rows.flatMap(row => Object.values(row).filter((value): value is string => typeof value === "string")));
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^ok \d+/u.test(line))).toHaveLength(5);
  } finally { await db.query("ROLLBACK"); db.release(); }
});

it("applies its own forward first in the native suffix", async () => {
  expect(position).toBeGreaterThanOrEqual(0);
  const prefix = structuredClone(manifest);
  for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
    const end = plan.forward.findIndex(entry => entry.file.endsWith(suffix));
    expect(end).toBeGreaterThanOrEqual(0);
    plan.forward = plan.forward.slice(0, end);
  }
  const unit = manifest.forward[position]!;
  const store = await withPlatformCatalog(prefix, root => installAccountMutations("legacy", true, "paid-money-prefix", root));
  try {
    const suffixEntry = () => store.owner.query("SELECT catalog_path,sha256,position FROM public.platform_schema_migrations WHERE position=$1", [position + 1]);
    expect((await suffixEntry()).rows).toEqual([]);
    expect((await store.runner.apply()).applied.slice(0, 1)).toEqual([unit.file]);
    expect((await suffixEntry()).rows).toEqual([{ catalog_path: unit.file, sha256: unit.sha256, position: position + 1 }]);
  } finally { await store.close(); }
}, postgresSetupTimeoutMs);
