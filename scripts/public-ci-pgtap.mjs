// Replays only the shipped managed baseline in a fresh, owned CLI project.
// No linked project, remote database, application seed or stored credential is used.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  // Only the local database is needed. CLI still owns its initialization and test transport.
  const excluded = "gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor";
  let cleanupFailed = false;
  let testStatus = 1;
  try {
    console.log(`Starting owned managed baseline ${projectId} with Supabase CLI ${cliVersion}`);
    must("supabase", ["start", "--workdir", directory, "--exclude", excluded]);
    const sql = ["scripts/public-reference/subscription-prereqs.sql", "supabase/migrations/00000000000000_platform_schema_baseline.sql"].map((path) => readFileSync(join(root, path), "utf8")).join("\n");
    // This is the CLI's fixed disposable-development password, not a stored credential.
    must("docker", ["exec", "-e", "PGPASSWORD=postgres", "-i", `supabase_db_${projectId}`, "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "supabase_admin", "-d", "postgres", "-1"], { input: sql });
    console.log("Managed baseline replayed transactionally; running every shipped pgTAP test");
    const result = run("supabase", ["test", "db", "--workdir", directory]);
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
