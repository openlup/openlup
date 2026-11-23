import { readFileSync, readdirSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { showCoverageSetting } from "./fixtures/taxCoverage/settings.js";
import { bindTaxCoverageReader } from "@openlup/platform/tax";
import { runManagedCompatPostgres } from "../helpers/managedCompatPostgres.js";
import { closePostgres, postgresSetupTimeoutMs, postgresTeardownTimeoutMs, type PostgresContainer } from "../helpers/postgresContainer.js";

let container: PostgresContainer | undefined, pool: Pool, db: PoolClient;
beforeAll(async () => {
  container = await runManagedCompatPostgres({ name: `installed-coverage-pgtap-${process.pid}`, password: "synthetic-conformance" });
  pool = new Pool({ connectionString: container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") });
  db = await pool.connect();
  await db.query("DROP SCHEMA auth CASCADE; DROP OWNED BY anon,authenticated,service_role CASCADE; DROP ROLE anon,authenticated,service_role; CREATE ROLE service_role");
  const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
  for (const unit of [manifest.baseline, ...manifest.forward]) await db.query(readFileSync(unit.file, "utf8"));
  await db.query("CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions; SET search_path=public,extensions");
  await db.query("GRANT USAGE ON SCHEMA extensions TO service_role, anon, authenticated");
}, postgresSetupTimeoutMs);
afterAll(async () => { db?.release(); await closePostgres(container, pool); }, postgresTeardownTimeoutMs);

it("checks the append transcript and effective service role grants on the native chain", async () => {
  try {
    const response = await db.query(readFileSync("tests/postgres/fixtures/taxCoverage/revisions.sql", "utf8"));
    const results = Array.isArray(response) ? response : [response];
    const lines = results.flatMap(result => result.rows.flatMap((row: Record<string, unknown>) =>
      Object.values(row).filter((value): value is string => typeof value === "string")));
    expect(lines.filter(line => /^(?:not ok|# Looks like)/u.test(line))).toEqual([]);
    expect(lines.filter(line => /^ok \d+/u.test(line))).toHaveLength(20);
  } finally { await db.query("ROLLBACK"); }
});

it("refuses connected coverage on the managed chain and names the native remedy", async () => {
  const managed = await runManagedCompatPostgres({ name: `coverage-managed-${process.pid}`, password: "synthetic-managed-coverage" });
  const owner = new Pool({ connectionString: managed.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:") });
  const runtime = new Pool({ connectionString: managed.connectionString, options: "-c role=service_role" });
  try {
    const installer = await owner.connect();
    try {
      await installer.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
      await installer.query("SET ROLE postgres");
      for (const name of readdirSync("supabase/migrations").filter(name => name.endsWith(".sql")).sort()) {
        await installer.query(readFileSync(`supabase/migrations/${name}`, "utf8").replace(/^\\(?:un)?restrict .*$/gmu, ""));
      }
    } finally { installer.release(); }
    expect((await owner.query(`SELECT to_regclass('public.tax_coverage_revisions') AS history,
      to_regprocedure('public.tax_coverage_append_v1(jsonb)') AS append,
      to_regprocedure('public.tax_coverage_read_v1(text,text)') AS read,
      to_regprocedure('public.tax_coverage_validate(jsonb)') AS validate,
      to_regprocedure('public.tax_coverage_revision_immutable()') AS guard`)).rows)
      .toEqual([{ history: null, append: null, read: null, validate: null, guard: null }]);
    expect((await runtime.query("SELECT current_user")).rows).toEqual([{ current_user: "service_role" }]);
    expect(await showCoverageSetting()).toMatchObject({ status: 0, body: {
      setting: { runtime: { level: "read-only", reason: expect.stringContaining("Managed installations do not supply this capability.") } },
      observation: { state: "offline" },
    } });
    expect(await showCoverageSetting(managed.connectionString, async () => ({ refusal: "tax_coverage_reader_unbound" }))).toMatchObject({
      status: 74, body: { refusal: { code: "commerce_setting_read_unavailable", remediation: {
        action: "Use a qualified native PostgreSQL installation; managed installations do not supply tax coverage history (documented limitation).",
      } } },
    });
    const read = bindTaxCoverageReader(runtime, { installationRef: "store-a", accountRef: "account-a" });
    expect(await showCoverageSetting(managed.connectionString, read)).toMatchObject({
      status: 74, body: { refusal: { code: "commerce_setting_read_unavailable", remediation: {
        action: "The coverage reader is not installed in this database. Apply this release's platform migrations, then run the same command again.",
      } } },
    });
  } finally { await closePostgres(managed, [owner, runtime]); }
}, postgresSetupTimeoutMs);
