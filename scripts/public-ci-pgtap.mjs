// Replays the shipped managed baseline and ordered forwards in an owned CLI project.
// No linked project, remote database, application seed or stored credential is used.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, ".context/scratch/pgtap");
const projectId = `openlup-ci-${randomBytes(8).toString("hex")}`;
const cliVersion = "2.98.2";

// Bind replay to committed bytes before starting any disposable service.
export function readManagedMigrationChain(checkout) {
  const folder = join(checkout, "supabase/migrations");
  if (!lstatSync(folder).isDirectory() || lstatSync(folder).isSymbolicLink()) throw new Error("invalid managed migration directory");
  const result = spawnSync("git", ["--no-replace-objects", "-C", checkout, "ls-tree", "-r", "-z", "HEAD", "--", "supabase/migrations"], { encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error("cannot read committed managed migration inventory");
  const entries = result.stdout.split("\0").filter(Boolean).map((entry) => {
    const match = /^(100644) blob ([a-f0-9]{40})\tsupabase\/migrations\/(\d{14}_[a-z0-9_]+\.sql)$/u.exec(entry);
    if (!match) throw new Error("invalid committed managed migration identity");
    return { name: match[3], digest: match[2] };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const names = entries.map((entry) => entry.name);
  if (names[0] !== "00000000000000_platform_schema_baseline.sql"
    || entries.some((entry, index) => index > 0 && entry.name.slice(0, 14) <= entries[index - 1].name.slice(0, 14))) throw new Error("invalid or duplicate managed migration version");
  if (JSON.stringify(readdirSync(folder).sort()) !== JSON.stringify(names)) throw new Error("managed migration paths differ from committed inventory");
  return entries.map(({ name, digest }) => {
    const path = join(folder, name);
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || (lstatSync(path).mode & 0o111) !== 0) throw new Error("managed migration is not a regular committed file");
    const bytes = readFileSync(path);
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== digest) throw new Error("managed migration bytes differ from committed candidate");
    return { name, contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  });
}

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
  const migrations = readManagedMigrationChain(root);
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "run-"));
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
      ...migrations.map(({ contents }) => contents),
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
    // Tests replay the same committed forwards with relative psql includes.
    // Materialize only after initialization so the CLI cannot auto-apply them.
    const replayFolder = join(directory, "supabase/migrations");
    mkdirSync(replayFolder);
    for (const { name, contents } of migrations) writeFileSync(join(replayFolder, name), contents);
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "managed baseline pgTAP failed"); process.exitCode = 1; });
}
