/** Focused managed-host scenarios. Missing pinned CLI is a visible skip, never parity proof. */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { readManagedMigrationChain } from "../../scripts/public-ci-pgtap.mjs";
import { dockerAvailable, reservePort } from "../helpers/postgresContainer.js";

const scenarios = [
  ["lot consumption and browser-role refusal", "inventory_lot_runtime_boundary_test.sql"],
  ["reserve/released replay leaves leases and balances unchanged", "inventory_reservation_replay_characterization_test.sql"],
  ["recount dry-run/apply conservation and denied roles", "inventory_recount_reserved_balances_test.sql"],
  ["retry expiry releases holds while preserving paid/subscription/dunning state", "retry_window_release_only_sweep_test.sql"],
] as const;
const cliVersion = "2.98.2";
let directory: string | undefined, started = false, unavailable = "";
const project = `inventory-managed-${randomUUID()}`;
function run(command: string, args: string[], input?: string) {
  return spawnSync(command, args, { encoding: "utf8", input, timeout: 240_000, maxBuffer: 64 * 1024 * 1024 });
}
function must(command: string, args: string[], input?: string) {
  const result = run(command, args, input);
  // CLI output can contain local generated credentials; never echo it on failure.
  if (result.error || result.status !== 0) throw new Error(`Managed inventory ${command} stage failed (output withheld)`);
  return result.stdout;
}
beforeAll(async () => {
  const version = run("supabase", ["--version"]);
  if (version.status !== 0 || version.stdout.trim() !== cliVersion) {
    unavailable = `PENDING P5a: focused managed pgTAP requires supplied Supabase CLI ${cliVersion}; no installation or substitution`;
    return;
  }
  if (!await dockerAvailable()) { unavailable = "PENDING P5a: Docker unavailable for managed inventory"; return; }
  const migrations = readManagedMigrationChain(process.cwd());
  directory = mkdtempSync(join(tmpdir(), "inventory-managed-"));
  const ports = new Set<number>();
  while (ports.size < 7) ports.add(await reservePort());
  const [db, shadow, api, studio, mail, pooler, app] = [...ports];
  const replacements: Record<string, string | number> = { PROJECT_ID: project, DB_PORT: db, SHADOW_PORT: shadow, API_PORT: api, STUDIO_PORT: studio, MAIL_PORT: mail, POOLER_PORT: pooler, APP_PORT: app };
  mkdirSync(join(directory, "supabase/tests"), { recursive: true });
  const config = readFileSync("config/public-reference-subscription-supabase.toml", "utf8").replace(/\{\{([A-Z_]+)\}\}/gu, (_, key: string) => String(replacements[key]));
  writeFileSync(join(directory, "supabase/config.toml"), config);
  for (const [, file] of scenarios) writeFileSync(join(directory, "supabase/tests", file), readFileSync(`supabase/tests/${file}`));
  // Exactly this randomly named owned project is stopped, even if start partially fails.
  started = true;
  must("supabase", ["start", "--workdir", directory, "--exclude", "gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor"]);
  const psql = (sql: string, transactional = true) => must("docker", ["exec", "-e", "PGPASSWORD=postgres", "-i", `supabase_db_${project}`, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres", ...(transactional ? ["-1"] : [])], sql);
  // Same formatter-only workaround and ACL-default removal as the supplied managed harness.
  psql("ALTER SYSTEM SET supautils.hint_roles = '';", false);
  must("docker", ["restart", `supabase_db_${project}`]);
  // pg_isready is inside the owned container; all subsequent work uses that same psql transport.
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (run("docker", ["exec", `supabase_db_${project}`, "pg_isready", "-U", "supabase_admin"]).status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error("Managed inventory PostgreSQL unavailable");
  const defaults = ["postgres", "supabase_admin"].flatMap(role => ["", " IN SCHEMA public"].flatMap(scope => ["TABLES", "SEQUENCES", "FUNCTIONS"].map(kind => `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role;`))).join("\n");
  psql([readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"), defaults, "SET ROLE postgres;", ...migrations.map((row: { contents: string }) => row.contents),
    "RESET ROLE; CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;",
    `DO $$ DECLARE fn regprocedure; BEGIN FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_depend d ON d.objid=p.oid AND d.classid='pg_proc'::regclass JOIN pg_extension e ON e.oid=d.refobjid WHERE e.extname='pgtap' AND d.deptype='e' LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC',fn); END LOOP; END $$;`].join("\n"));
}, 240_000);
afterAll(() => {
  try { if (started && directory) must("supabase", ["stop", "--workdir", directory, "--no-backup"]); }
  finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
});
for (const [name, file] of scenarios) it(name, ctx => {
  if (unavailable) { ctx.skip(unavailable); return; }
  const result = run("supabase", ["test", "db", `supabase/tests/${file}`, "--workdir", directory!]);
  expect(result.error, "focused managed runner error").toBeUndefined();
  expect(result.status, "focused managed SQL failed; output withheld").toBe(0);
  expect(result.stdout).toContain("All tests successful");
}, 120_000);
