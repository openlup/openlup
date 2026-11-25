import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type QueryResult } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";

const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as PlatformMigrationManifest;
const catalog = [manifest.baseline, ...manifest.forward];
const position = catalog.findIndex(unit => /_tax_calculation_composition\.sql$/u.test(unit.file));
const prefix = catalog.slice(0, position + 1);
const replay = readFileSync(new URL("./fixtures/commerceQuoteV2Storage/replayed.sql", import.meta.url), "utf8");
let container: PostgresContainer | undefined;
let owner: Pool;

async function apply(db: PoolClient, position: number) {
  const { file } = prefix[position]!;
  const bytes = readFileSync(file);
  await db.query(bytes.toString("utf8"));
  await db.query("INSERT INTO applied_prefix VALUES ($1,$2,$3)", [
    position, file, createHash("sha256").update(bytes).digest("hex"),
  ]);
}

beforeAll(async () => {
  expect(position).toBeGreaterThan(0);
  container = await runManagedCompatPostgres({ name: `quote-storage-pgtap-${process.pid}`, password: "synthetic-conformance" });
  owner = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"),
    max: 1, idleTimeoutMillis: 0 });
  const db = await owner.connect();
  try {
    await db.query(`DROP SCHEMA auth CASCADE;
      DROP OWNED BY anon,authenticated,service_role CASCADE;
      DROP ROLE anon,authenticated,service_role;
      CREATE ROLE service_role;
      CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
      CREATE TEMP TABLE applied_prefix(position integer PRIMARY KEY, path text, sha256 text)`);
    for (let index = 0; index < position; index++) await apply(db, index);
  } finally { db.release(); }
}, postgresSetupTimeoutMs);
afterAll(() => closePostgres(container, owner), postgresTeardownTimeoutMs);

function tapRows(response: QueryResult<Record<string, unknown>> | QueryResult<Record<string, unknown>>[]) {
  const results = Array.isArray(response) ? response : [response];
  return results.flatMap(result => result.rows.flatMap((row: Record<string, unknown>) =>
    Object.values(row).filter((value): value is string => typeof value === "string")));
}

it.each([true, false])("replays only the selected prefix and preserves both routines (optional roles: %s)", async optionalRoles => {
  const db = await owner.connect();
  try {
    await db.query("BEGIN; SET LOCAL search_path=public,extensions");
    if (!optionalRoles) await db.query("DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role");
    await db.query(`CREATE TEMP VIEW evaluation_routine_catalog AS
      SELECT p.oid, p.proname, p.proargnames, p.proargtypes, p.proargmodes, p.pronargdefaults, p.prorettype,
        p.proretset, l.lanname, p.proowner, p.proacl, p.provolatile, p.prosecdef, p.proconfig, p.prosrc,
        ARRAY(SELECT r.rolname FROM pg_roles r
          WHERE r.rolname IN ('anon','authenticated','service_role') AND has_function_privilege(r.oid,p.oid,'EXECUTE')
          ORDER BY r.rolname) AS effective_application_grants
      FROM pg_proc p JOIN pg_language l ON l.oid=p.prolang
      WHERE p.oid IN ('public.tax_calculation_check_domain_v1(jsonb,jsonb,jsonb,boolean)'::regprocedure,
        'public.tax_calculation_terminal_v1(public.tax_calculations)'::regprocedure);
      CREATE TEMP TABLE predecessor_routines AS SELECT * FROM evaluation_routine_catalog;
      CREATE TEMP TABLE expected_prefix(LIKE applied_prefix);
      CREATE TEMP TABLE replay_fixture_roles(present boolean)`);
    await db.query("INSERT INTO replay_fixture_roles VALUES ($1)", [optionalRoles]);
    await db.query(`INSERT INTO expected_prefix
      SELECT (ordinality-1)::int, entry->>'file', entry->>'sha256'
      FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS units(entry,ordinality)`, [JSON.stringify(prefix)]);
    await apply(db, position);

    if (optionalRoles) {
      const mutations = [
        ["DELETE FROM applied_prefix WHERE position=(SELECT max(position) FROM applied_prefix)", "exact forward prefix"],
        ["ALTER FUNCTION public.tax_calculation_check_domain_v1(jsonb,jsonb,jsonb,boolean) VOLATILE", "stable invoker"],
        ["ALTER FUNCTION public.tax_calculation_terminal_v1(public.tax_calculations) SECURITY DEFINER", "stable invoker"],
        ["ALTER FUNCTION public.tax_calculation_terminal_v1(public.tax_calculations) RESET search_path", "stable invoker"],
        ["GRANT EXECUTE ON FUNCTION public.tax_calculation_check_domain_v1(jsonb,jsonb,jsonb,boolean) TO PUBLIC", "predecessor catalog"],
      ] as const;
      for (const [mutation, assertion] of mutations) {
        await db.query("SAVEPOINT catalog_mutation");
        await db.query(mutation);
        expect(tapRows(await db.query(replay)).filter(line => /^not ok /u.test(line)))
          .toContainEqual(expect.stringContaining(assertion));
        await db.query("ROLLBACK TO SAVEPOINT catalog_mutation");
      }
    }
    const lines = tapRows(await db.query(replay));
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^ok \d+/u.test(line))).toHaveLength(6);
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
}, postgresSetupTimeoutMs);
