// Opt-in real managed-source proof; required root shards run the adapter suite.
import { execFile, execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { arch, env, platform } from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Pool } from "pg";
import { ownedStackCleanup } from "../../scripts/owned-stack-cleanup.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const execute = promisify(execFile);
const version = "2.122.0";
// Same reviewed release asset IDs and archive checksums as the retired installer.
const cliPins = {
  "darwin-arm64": { assetId: 668849778, sha256: "fe87a5f9781d5423dbd5ebba2d5a6e1a541d01754d14941c574952e5695eaab0" },
  "linux-x64": { assetId: 668850237, sha256: "59ed066847b98d7461c60e9109d40cab6b9756177ce06ebb05b51338519f5136" },
};
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function command(file, args, options = {}) {
  try {
    return (await execute(file, args, { cwd: root, timeout: 600_000, maxBuffer: 32 * 1024 * 1024, ...options })).stdout;
  } catch (error) {
    // CLI output can include ephemeral service credentials. Keep it private to
    // the child; errors name the failed stage without copying that output.
    throw new Error(`Managed witness command failed: ${file.split("/").at(-1)} ${args[0] ?? ""} (${error.code ?? "unavailable"})`);
  }
}
const free = port => new Promise((accept, reject) => {
  const server = createServer();
  server.once("error", error => error.code === "EADDRINUSE" ? accept(false) : reject(error));
  server.listen(port, "127.0.0.1", () => server.close(() => accept(true)));
});
async function portBlock() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const base = 55000 + Number.parseInt(randomBytes(2).toString("hex"), 16) % 8000;
    if ((await Promise.all([0, 1, 2, 3, 4, 9, 10].map(offset => free(base + offset)))).every(Boolean)) return base;
  }
  throw new Error("Real managed witness has no free loopback port block");
}
async function provisionCli(directory) {
  const pin = cliPins[`${platform}-${arch}`];
  if (!pin) throw new Error(`Missing reviewed Supabase CLI ${version} pin for ${platform}/${arch}`);
  const binaryDirectory = join(directory, "cli");
  await mkdir(binaryDirectory, { mode: 0o700 });
  const archive = join(binaryDirectory, "cli.tar.gz");
  await command("curl", ["--proto", "=https", "--proto-redir", "=https", "--tlsv1.2", "--fail", "--location",
    "--silent", "--show-error", "--retry", "2", "--retry-all-errors", "--connect-timeout", "15", "--max-time", "120",
    "--header", "Accept: application/octet-stream",
    `https://api.github.com/repos/supabase/cli/releases/assets/${pin.assetId}`, "--output", archive]);
  if (hash(await readFile(archive)) !== pin.sha256) throw new Error("Supabase CLI archive checksum mismatch");
  await command("tar", ["-xzf", archive, "-C", binaryDirectory, "supabase"]);
  const binary = join(binaryDirectory, "supabase");
  await chmod(binary, 0o755);
  if ((await command(binary, ["--version"])).trim() !== version) throw new Error("Pinned Supabase CLI executable missing or version mismatch");
  await rm(archive);
  return { binary, pin: { version, ...pin, binarySha256: hash(await readFile(binary)) } };
}
async function sourceSchema(port) {
  const pool = new Pool({ connectionString: `postgresql://supabase_admin:postgres@127.0.0.1:${port}/postgres`, max: 1 });
  try {
    return (await pool.query(`SELECT n.nspname||'.'||c.relname AS relation,a.attnum,a.attname,
      pg_catalog.format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull AS not_null,
      pg_catalog.pg_get_expr(d.adbin,d.adrelid) AS default_expression
      FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid
      JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
      WHERE n.nspname||'.'||c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY relation,a.attnum`, [["auth.users", "storage.buckets", "storage.objects"]])).rows;
  } finally { await pool.end(); }
}
// The test captures with this role's rights, so it must be the provider login a hosted source offers.
async function captureRole(port) {
  const pool = new Pool({ connectionString: `postgresql://supabase_admin:postgres@127.0.0.1:${port}/postgres`, max: 1 });
  try {
    const role = (await pool.query("SELECT rolname,rolsuper,rolbypassrls FROM pg_catalog.pg_roles WHERE rolname='postgres'")).rows[0];
    if (!role || role.rolsuper !== false) throw new Error("Real managed witness requires a non-superuser capture role");
    return role;
  } finally { await pool.end(); }
}

async function main() {
  const journeyImage = process.argv[2];
  if (process.argv.length !== 3 || !/^sha256:[a-f0-9]{64}$/u.test(journeyImage ?? ""))
    throw new Error("Usage: node tests/postgres/runM14ManagedSourceWitness.mjs sha256:<already-local-Node24.21.0-image>");
  if (process.versions.node !== "24.21.0") throw new Error("Real managed witness requires Node 24.21.0");
  if ((await command("npm", ["--version"])).trim() !== "11.19.0") throw new Error("Real managed witness requires npm 11.19.0");
  if ((await command("docker", ["image", "inspect", journeyImage, "--format", "{{.Id}}"])).trim() !== journeyImage)
    throw new Error("Managed journey requires the exact already-local Node image");
  if ((await command("docker", ["run", "--rm", "--network", "none", "--entrypoint", "node", journeyImage, "--version"])).trim() !== "v24.21.0")
    throw new Error("Managed journey image requires Node 24.21.0");
  const scratch = join(root, ".context/scratch");
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(join(scratch, "m14-real-managed-source-"));
  const report = { status: "FAIL", startedAt: new Date().toISOString(), jobs: [], journeyImage };
  let cli;
  async function withSource(label, work) {
    const jobDirectory = join(directory, label);
    await mkdir(jobDirectory, { mode: 0o700 });
    const job = { label, status: "FAIL" }; report.jobs.push(job);
    let stack;
    try {
      const base = await portBlock(), project = `m14source${process.pid}${randomBytes(3).toString("hex")}`;
      const replacements = { PROJECT_ID: project, SHADOW_PORT: base, API_PORT: base + 1, DB_PORT: base + 2,
        STUDIO_PORT: base + 3, MAIL_PORT: base + 4, POOLER_PORT: base + 9, APP_PORT: base + 10 };
      const config = (await readFile(join(root, "config/public-reference-subscription-supabase.toml"), "utf8"))
        .replace(/\{\{([A-Z_]+)\}\}/gu, (_, key) => {
          if (!Object.hasOwn(replacements, key)) throw new Error("Unknown managed witness config placeholder");
          return String(replacements[key]);
        });
      await mkdir(join(jobDirectory, "supabase"), { mode: 0o700 });
      await writeFile(join(jobDirectory, "supabase/config.toml"), config, { mode: 0o600 });
      const cliEnv = { ...env, SUPABASE_INTERNAL_IMAGE_REGISTRY: "ghcr.io" };
      stack = ownedStackCleanup(options => {
        try {
          execFileSync(cli.binary, ["stop", "--workdir", jobDirectory, "--no-backup"],
            { cwd: root, env: cliEnv, stdio: "ignore", ...options() });
        } catch { throw new Error("Real managed witness owned-stack cleanup failed"); }
      });
      // 8E extension point: this owned stack's config/start boundary is where its
      // GoTrue + Storage API + authenticated S3 GET proof will enable services and
      // compose its assertions. 8A exercises SQL metadata and typed transfer only.
      await stack.start(cli.binary, ["start", "--workdir", jobDirectory, "--exclude",
        "gotrue,realtime,storage-api,imgproxy,kong,mailpit,postgrest,postgres-meta,studio,edge-runtime,logflare,vector,supavisor"], { env: cliEnv });
      job.sourceImage = (await command("docker", ["inspect", `supabase_db_${project}`, "--format", "{{.Image}}"])).trim();
      job.sourceRepoDigests = JSON.parse(await command("docker", ["image", "inspect", job.sourceImage, "--format", "{{json .RepoDigests}}"]));
      if (label === "typed-source") report.captureRole = await captureRole(base + 2);
      const schema = JSON.stringify(await sourceSchema(base + 2), null, 2);
      await writeFile(join(jobDirectory, "source-schema.json"), schema, { mode: 0o600 });
      job.sourceSchemaSha256 = hash(schema);
      // Each job owns a fresh source: no baseline or Auth seed is reused from
      // another suite. Storage API/object qualification remains 8E's boundary.
      const testEnv = { ...env, OPENLUP_M14_MANAGED_SOURCE_PORT: String(base + 2) };
      delete testEnv.OPENLUP_VITEST_EXCLUDE_FILE;
      await work(stack, testEnv, jobDirectory, job);
      job.status = "PASS";
    } finally {
      if (stack) try { await stack.finish(); }
      catch (error) { job.status = "FAIL"; job.cleanupError = error.message; throw error; }
    }
  }
  async function suite(file, expectedCount, label) {
    await withSource(label, async (stack, testEnv, jobDirectory, job) => {
      const resultPath = join(jobDirectory, "vitest.json");
      if (label === "managed-first-leg") testEnv.OPENLUP_M14_JOURNEY_REPORT = join(jobDirectory, "journey.json");
      const test = await stack.command("npm", ["test", "--", file, "--reporter=json", `--outputFile=${resultPath}`],
        { cwd: root, env: testEnv, timeout: 600_000 });
      await writeFile(join(jobDirectory, "test.log"), test.stdout, { mode: 0o600 });
      if (test.error || test.status !== 0) throw new Error(`Real managed ${label} assertions failed; inspect the private Vitest JSON report`);
      const result = JSON.parse(await readFile(resultPath, "utf8"));
      job.tests = result.testResults.flatMap(file => file.assertionResults.map(test => [test.fullName, test.status]));
      if (job.tests.length !== expectedCount || job.tests.some(([, status]) => status !== "passed"))
        throw new Error(`Real managed ${label} requires all ${expectedCount} assertions to pass; no skips`);
      if (label === "managed-first-leg") job.journey = JSON.parse(await readFile(testEnv.OPENLUP_M14_JOURNEY_REPORT, "utf8"));
    });
  }
  try {
    cli = await provisionCli(directory); report.cli = cli.pin;
    report.baselineSha256 = hash(await readFile(join(root, "supabase/migrations/00000000000000_platform_schema_baseline.sql")));
    report.journeyImageRepoDigests = JSON.parse(await command("docker", ["image", "inspect", journeyImage, "--format", "{{json .RepoDigests}}"]));
    await suite("tests/postgres/connectedManagedRetained.test.ts", 16, "typed-source");
    report.tests = report.jobs[0].tests;
    report.sourceImage = report.jobs[0].sourceImage; report.sourceRepoDigests = report.jobs[0].sourceRepoDigests;
    await suite("tests/postgres/m14ManagedCatchup.test.ts", 1, "managed-first-leg");
    await withSource("managed-journey", async (stack, testEnv, jobDirectory, job) => {
      const journey = await stack.command(process.execPath, ["--import", "tsx", "tests/postgres/runM14EffectHandover.ts",
        journeyImage, "--managed-catch-up"], { cwd: root, env: testEnv, timeout: 600_000 });
      await writeFile(join(jobDirectory, "journey.log"), journey.stdout, { mode: 0o600 });
      await writeFile(join(jobDirectory, "journey.stderr.log"), journey.stderr, { mode: 0o600 });
      if (journey.error || journey.status !== 0) throw new Error("Real managed three-installation journey failed; inspect its private log");
      const completed = journey.stdout.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line))
        .findLast(row => row.outcome);
      if (completed?.outcome !== "LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION")
        throw new Error("Real managed journey did not reach its declared readiness");
      job.evidenceDirectory = completed.evidenceDirectory;
      const bytes = await readFile(join(completed.evidenceDirectory, "report.json"));
      job.reportSha256 = hash(bytes); job.journey = JSON.parse(bytes);
      if (job.journey.journey?.sourceGeneration !== "pinned-local-managed") throw new Error("Real journey must use the owned managed source");
    });
    report.status = "PASS";
  } catch (error) { report.error = error.message; }
  finally {
    await rm(join(directory, "cli"), { recursive: true, force: true });
    report.endedAt = new Date().toISOString();
    await writeFile(join(directory, "report.json"), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify({ status: report.status, evidenceDirectory: directory, error: report.error }));
  return report.status === "PASS" ? 0 : 1;
}
main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
