// Replays the shipped managed baseline and ordered forwards in an owned CLI project.
// No linked project, remote database, application seed or stored credential is used.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, ".context/scratch/pgtap");
mkdirSync(scratch, { recursive: true });
const directory = mkdtempSync(join(scratch, "run-"));
const projectId = `openlup-ci-${randomBytes(8).toString("hex")}`;
const cliVersion = "2.98.2";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) throw result.error;
  return result;
}
function must(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}
async function available(port) {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}
async function selectPorts() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 55000 + Number.parseInt(randomBytes(2).toString("hex"), 16) % 8000;
    if ((await Promise.all([0, 1, 2, 3, 4, 9, 10].map((offset) => available(base + offset)))).every(Boolean)) return base;
  }
  throw new Error("no free port block for the owned managed baseline");
}

async function main() {
  if (must("supabase", ["--version"]).trim() !== cliVersion) throw new Error(`pgTAP requires Supabase CLI ${cliVersion}`);
  const base = await selectPorts();
  const replacements = { PROJECT_ID: projectId, SHADOW_PORT: base, API_PORT: base + 1, DB_PORT: base + 2, STUDIO_PORT: base + 3, MAIL_PORT: base + 4, POOLER_PORT: base + 9, APP_PORT: base + 10 };
  const config = readFileSync(join(root, "config/public-reference-subscription-supabase.toml"), "utf8").replace(/\{\{([A-Z_]+)\}\}/gu, (_, key) => {
    if (!(key in replacements)) throw new Error(`unknown local config placeholder: ${key}`);
    return String(replacements[key]);
  });
  mkdirSync(join(directory, "supabase"));
  writeFileSync(join(directory, "supabase/config.toml"), config);
  cpSync(join(root, "supabase/tests"), join(directory, "supabase/tests"), { recursive: true });
  // Resolve the public settlement defaults with the same pure reader as the
  // application, without ambient environment. Fixture parameters are validated
  // before becoming psql literals and apply only inside each test transaction.
  const profile = JSON.parse(must(process.execPath, ["--import", "tsx", "--input-type=module", "-e",
    "import { readSettlementProfile } from './src/lib/currency/settlementProfile.ts'; console.log(JSON.stringify(readSettlementProfile({})))",
  ]));
  if (!/^[A-Z]{3}$/.test(profile.defaultCurrency) || !/^[A-Z]{2}$/.test(profile.regionCode) || !Number.isSafeInteger(profile.minimumProductPayableMinor) || profile.minimumProductPayableMinor < 1) throw new Error("invalid test settlement profile");
  const baseline = readFileSync(join(root, "supabase/migrations/00000000000000_platform_schema_baseline.sql"), "utf8");
  const migrations = readdirSync(join(root, "supabase/migrations"))
    .filter((file) => file.endsWith(".sql")).sort();
  if (migrations[0] !== "00000000000000_platform_schema_baseline.sql"
    || migrations.some((file) => !/^\d{14}_[a-z0-9_]+\.sql$/.test(file))) {
    throw new Error("invalid published managed migration order");
  }
  // The stock-authority function declares its provider/location dependency.
  // Read that dependency from the shipped body instead of adding deployment seeds.
  const stockBody = baseline.slice(baseline.indexOf("CREATE FUNCTION public.fulfillment_provider_upsert_stock_current("));
  const provider = stockBody.match(/IF btrim\(p_provider_kind\) = '([a-z][a-z0-9_-]*)'/)?.[1];
  const location = stockBody.match(/WHERE code = '([a-z][a-z0-9_-]*)'/)?.[1];
  if (!provider || !location) throw new Error("stock authority fixture dependencies absent from baseline");
  const parameters = `\\set fixture_payable_floor '${profile.minimumProductPayableMinor}'\n\\set fixture_currency '${profile.defaultCurrency}'\n\\set fixture_region '${profile.regionCode}'\n\\set fixture_provider '${provider}'\n\\set fixture_stock_location '${location}'\n`;
  for (const file of readdirSync(join(directory, "supabase/tests"))) {
    if (!file.endsWith(".sql")) continue;
    const target = join(directory, "supabase/tests", file);
    writeFileSync(target, parameters + readFileSync(target, "utf8"));
  }
  // Only the local database is needed. CLI still owns its initialization and test transport.
  const excluded = "gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";
  let cleanupFailed = false;
  let testStatus = 1;
  try {
    console.log(`Starting owned managed baseline ${projectId} with Supabase CLI ${cliVersion}`);
    must("supabase", ["start", "--workdir", directory, "--exclude", excluded]);
    // supabase/supautils#214: enhanced denial hints crash this pinned image.
    // Disable only hint formatting in this disposable database. Role identities,
    // grants, RLS and the actual 42501 refusal remain unchanged and are tested.
    must("docker", ["exec", "-e", "PGPASSWORD=postgres", "-i", `supabase_db_${projectId}`, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres"], {
      input: "ALTER SYSTEM SET supautils.hint_roles = '';",
    });
    // This formatter setting is postmaster-scoped in the pinned image.
    must("docker", ["restart", `supabase_db_${projectId}`]);
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const probe = run("docker", ["exec", "-e", "PGPASSWORD=postgres", `supabase_db_${projectId}`, "psql", "-X", "-U", "supabase_admin", "-d", "postgres", "-Atqc", "SELECT current_setting('supautils.hint_roles') = ''"]);
      if (probe.status === 0) {
        if (probe.stdout.trim() !== "t") throw new Error("denial-hint formatter workaround did not take effect");
        ready = true;
        break;
      }
      await new Promise((done) => setTimeout(done, 500));
    }
    if (!ready) throw new Error("owned database did not return after formatter configuration");
    // A schema-only dump carries explicit ACLs, not the CLI installation's
    // unrelated default grants. Remove those defaults before creating objects;
    // otherwise new tables/functions silently earn browser privileges absent
    // from the shipped baseline. Keep the ordinary postgres owner so fixture
    // transactions can replace their own functions and triggers.
    const defaults = ["postgres", "supabase_admin"].flatMap((role) =>
      ["", " IN SCHEMA public"].flatMap((scope) =>
        ["TABLES", "SEQUENCES", "FUNCTIONS"].map((kind) =>
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role;`,
        ),
      ),
    ).join("\n");
    const sql = [
      readFileSync(join(root, "scripts/public-reference/subscription-prereqs.sql"), "utf8"),
      defaults, "SET ROLE postgres;",
      ...migrations.map((file) => readFileSync(join(root, "supabase/migrations", file), "utf8")),
      "RESET ROLE; CREATE EXTENSION IF NOT EXISTS pg_cron; CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;",
      // Role-taking tests still need the assertion helpers. Grant only members
      // of the test extension, never application functions or whole schemas.
      `DO $$ DECLARE fn regprocedure; BEGIN
        FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p
          JOIN pg_depend d ON d.objid = p.oid AND d.classid = 'pg_proc'::regclass
          JOIN pg_extension e ON e.oid = d.refobjid
          WHERE e.extname = 'pgtap' AND d.deptype = 'e'
        LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', fn); END LOOP;
      END $$;`,
    ].join("\n");
    // This is the CLI's fixed disposable-development password, not a stored credential.
    must("docker", ["exec", "-e", "PGPASSWORD=postgres", "-i", `supabase_db_${projectId}`, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres", "-1"], { input: sql });
    console.log("Managed baseline replayed transactionally; running every shipped pgTAP test");
    // Explicit SET ROLE assertions still test the baseline's browser/runtime ACLs.
    const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${base + 2}/postgres`;
    const result = run("supabase", ["test", "db", "--workdir", directory, "--db-url", databaseUrl]);
    writeFileSync(join(scratch, "latest.log"), `${result.stdout}\n${result.stderr}`);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    testStatus = result.status ?? 1;
  } finally {
    const cleanup = run("supabase", ["stop", "--workdir", directory, "--no-backup"]);
    if (cleanup.status !== 0) { cleanupFailed = true; console.error(`Owned stack cleanup failed: ${cleanup.stderr}`); }
  }
  process.exitCode = cleanupFailed ? 1 : testStatus;
}

main().catch((error) => { console.error(error instanceof Error ? error.message : "managed baseline pgTAP failed"); process.exitCode = 1; });
