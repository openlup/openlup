// Replays the shipped managed baseline and ordered forwards on the digest-pinned
// stock PostgreSQL 17 image with the managed-compatibility test adapter, then runs
// every shipped pgTAP test with pg_prove inside that container. No Supabase CLI,
// linked project, remote database, application seed or stored credential is used.
import { createHash, randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { env as processEnvironment } from "node:process";
import { fileURLToPath } from "node:url";

import packagePins from "../config/ci-postgres-packages.json" with { type: "json" };
import { pullWithRetry, readCiImage } from "./ci-image-pull.mjs";
import { disposableLabelArgs } from "./disposable-docker.mjs";
import { CATALOG_SNAPSHOT_SQL, ENVIRONMENT_FINGERPRINT_SQL, SABOTAGE, captureRows, sabotageSql } from "./pgtap-parity.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = join(root, ".context/scratch/pgtap");
const adapterPath = join(root, "tests/postgres/managed-compat/supabase.sql");
const testsInContainer = "/work/tests";
const debsInContainer = "/work/debs";
// Disposable test-only login that dblink tests and pg_prove use; not a stored credential.
const testPassword = "postgres";
const DOWNLOAD_TIMEOUT_MS = 60_000;

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

/** Fixed server settings: preload pg_cron for the postgres database and pin the managed clock and float output. */
export const SERVER_FLAGS = Object.freeze(["-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=postgres", "-c", "timezone=UTC", "-c", "extra_float_digits=0"]);

/** Password authentication on every TCP connection (dblink's non-superuser checks apply) and the managed ICU en-US database locale. */
export const INITDB_ARGS = "--auth-local=trust --auth-host=scram-sha-256 --locale-provider=icu --icu-locale=en-US --locale=en_US.UTF-8";

/** The argv the retired Supabase CLI 2.122.0 lane used for `test db --debug`; `--verbose` keeps every assertion in the log. */
export function pgProveArgs(directory) {
  return ["pg_prove", "--ext", ".pg", "--ext", ".sql", "-r", directory, "--verbose"];
}

export function parseArguments(argv) {
  const options = { sabotage: undefined };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--sabotage" && index + 1 < argv.length) {
      options.sabotage = argv[++index];
      if (!Object.hasOwn(SABOTAGE, options.sabotage)) throw new Error(`unknown sabotage: ${options.sabotage}; expected one of ${Object.keys(SABOTAGE).join(", ")}`);
    } else throw new Error("usage: public-ci-pgtap.mjs [--sabotage <name>]");
  }
  return options;
}

/** Select the pinned files for one Docker architecture; refuse an unpinned architecture or malformed pin. */
export function selectPackageFiles(pins, architecture) {
  if (!/^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9/._-]*\/$/u.test(pins.baseUrl)) throw new Error("invalid package base URL");
  const files = pins.packages.map(pin => {
    const file = pin.files[architecture] ?? pin.files.all;
    if (!file) throw new Error(`no pinned ${pin.name} package for ${architecture}`);
    if (!/^[a-z0-9]+(?:\/[a-z0-9.+_-]+)+\.deb$/u.test(file.path) || !/^[a-f0-9]{64}$/u.test(file.sha256)) throw new Error(`malformed package pin for ${pin.name}`);
    if (!file.path.split("/").at(-1).startsWith(`${pin.name}_${pin.version}_`)) throw new Error(`package path does not match ${pin.name} ${pin.version}`);
    return { name: file.path.split("/").at(-1), url: pins.baseUrl + file.path.split("/").map(encodeURIComponent).join("/"), sha256: file.sha256 };
  });
  return files;
}

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

/** Reuse verified cached packages or download each exact file once; never install unverified bytes. */
export async function ensurePackages(files, cache, fetcher = fetch) {
  mkdirSync(cache, { recursive: true });
  for (const file of files) {
    const target = join(cache, file.name);
    if (existsSync(target) && sha256(readFileSync(target)) === file.sha256) continue;
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const response = await fetcher(file.url, { redirect: "error", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const bytes = Buffer.from(await response.arrayBuffer());
        const actual = sha256(bytes);
        if (actual !== file.sha256) throw Object.assign(new Error(`checksum mismatch for ${file.name}: expected ${file.sha256}, got ${actual}`), { fatal: true });
        // A per-process partial name keeps concurrent test workers from sharing one file.
        writeFileSync(`${target}.${process.pid}.partial`, bytes);
        renameSync(`${target}.${process.pid}.partial`, target);
        lastError = undefined;
        break;
      } catch (error) {
        if (error?.fatal) throw error;
        lastError = error;
      }
    }
    if (lastError) throw new Error(`cannot download ${file.url}: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  return files.map(file => file.name);
}

/** The transactional replay: adapter, shared prerequisites, default-ACL discipline, the chain, test extensions. */
export function replaySql({ adapter, prereqs, migrations }) {
  // A schema-only dump carries explicit ACLs. The managed defaults the adapter
  // reproduces must not hand browser roles privileges the shipped baseline does
  // not grant, so revoke them before creating objects.
  const defaults = ["postgres", "supabase_admin"].flatMap(role =>
    ["", " IN SCHEMA public"].flatMap(scope =>
      ["TABLES", "SEQUENCES", "FUNCTIONS"].map(kind =>
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC, anon, authenticated, service_role;`,
      ),
    ),
  ).join("\n");
  return [
    adapter,
    `ALTER ROLE postgres PASSWORD '${testPassword}';`,
    // Replay as the managed superuser identity supabase_admin, as on the managed host.
    "SET ROLE supabase_admin;",
    prereqs,
    defaults, "SET ROLE postgres;",
    ...migrations.map(({ contents }) => contents),
    "RESET ROLE; SET ROLE supabase_admin; CREATE EXTENSION IF NOT EXISTS pg_cron; CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;",
    // Role-taking tests still need the assertion helpers. Grant only members
    // of the test extension, never application functions or whole schemas.
    `DO $$ DECLARE fn regprocedure; BEGIN
      FOR fn IN SELECT p.oid::regprocedure FROM pg_proc p
        JOIN pg_depend d ON d.objid = p.oid AND d.classid = 'pg_proc'::regclass
        JOIN pg_extension e ON e.oid = d.refobjid
        WHERE e.extname = 'pgtap' AND d.deptype = 'e'
      LOOP EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO PUBLIC', fn); END LOOP;
    END $$;`,
    "RESET ROLE;",
  ].join("\n");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });
  // psql may exit on its first error before reading all input; report its stderr, not EPIPE.
  if (result.error && !(result.error.code === "EPIPE" && result.status !== 0)) throw result.error;
  return result;
}
function must(command, args, options) {
  const result = run(command, args, options);
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

function dockerArchitecture() {
  const machine = must("docker", ["info", "--format", "{{.Architecture}}"]).trim();
  const architecture = { x86_64: "amd64", amd64: "amd64", aarch64: "arm64", arm64: "arm64" }[machine];
  if (!architecture) throw new Error(`no pinned extension packages for Docker architecture ${machine}`);
  return architecture;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const started = performance.now();
  const elapsed = () => `${Math.round((performance.now() - started) / 1000)}s`;
  const migrations = readManagedMigrationChain(root);
  mkdirSync(scratch, { recursive: true });
  const directory = mkdtempSync(join(scratch, "run-"));
  const files = selectPackageFiles(packagePins, dockerArchitecture());
  const cache = processEnvironment.OPENLUP_PGTAP_DEB_CACHE || join(root, ".context/scratch/cache/pgtap-debs");
  const debs = await ensurePackages(files, cache);
  const image = await pullWithRetry(readCiImage(packagePins.image));
  console.log(`Pinned image ${image}; packages ${debs.join(", ")} (${elapsed()})`);
  // Tests and the replayed chain's .inc includes, mounted read-only; pg_prove discovers .sql/.pg, never .inc.
  cpSync(join(root, "supabase/tests"), join(directory, "tests"), { recursive: true });
  for (const { name, contents } of migrations) writeFileSync(join(directory, "tests", `${name}.inc`), contents);
  mkdirSync(join(directory, "debs"));
  for (const name of debs) cpSync(join(cache, name), join(directory, "debs", name));

  const container = `openlup-pgtap-${randomBytes(6).toString("hex")}`;
  const bootstrapPassword = randomBytes(18).toString("hex");
  const flags = options.sabotage === "no-pg-cron" ? SERVER_FLAGS.filter((flag, index, all) => !/pg_cron|cron\./u.test(flag) && !/pg_cron|cron\./u.test(all[index + 1] ?? "")) : SERVER_FLAGS;
  let status = 1;
  try {
    must("docker", ["run", "-d", "--name", container, ...disposableLabelArgs(),
      "--tmpfs", "/var/lib/postgresql/data", "--pull=never",
      "-v", `${join(directory, "debs")}:${debsInContainer}:ro`, "-v", `${join(directory, "tests")}:${testsInContainer}:ro`,
      "-e", "POSTGRES_USER=ci_bootstrap", "-e", `POSTGRES_PASSWORD=${bootstrapPassword}`, "-e", "POSTGRES_DB=postgres",
      "-e", `POSTGRES_INITDB_ARGS=${INITDB_ARGS}`,
      "--entrypoint", "bash", image, "-c",
      `set -euo pipefail; dpkg -i ${debs.map(name => `${debsInContainer}/${name}`).join(" ")} >/dev/null; exec docker-entrypoint.sh postgres "$@"`,
      "openlup-pgtap", ...flags]);
    // The entrypoint's temporary init server has no TCP listener, so a TCP
    // probe opens only for the real server (tests/helpers/postgresContainer.ts).
    let ready = false;
    for (let attempt = 0; attempt < 240 && !ready; attempt++) {
      ready = run("docker", ["exec", container, "pg_isready", "-q", "-h", "127.0.0.1", "-U", "ci_bootstrap", "-d", "postgres"]).status === 0;
      if (!ready) {
        if (must("docker", ["inspect", "-f", "{{.State.Running}}", container]).trim() !== "true") break;
        await new Promise(done => setTimeout(done, 500));
      }
    }
    if (!ready) throw new Error(`stock PostgreSQL did not become ready:\n${run("docker", ["logs", "--tail", "40", container]).stderr}`);
    console.log(`Stock PostgreSQL ready (${elapsed()})`);

    const sql = replaySql({
      adapter: readFileSync(adapterPath, "utf8"),
      prereqs: readFileSync(join(root, "scripts/public-reference/subscription-prereqs.sql"), "utf8"),
      migrations,
    });
    must("docker", ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "ci_bootstrap", "-d", "postgres", "-1"], { input: sql });
    console.log(`Adapter and managed baseline replayed transactionally (${elapsed()})`);
    writeFileSync(join(scratch, "snapshot.json"), JSON.stringify(captureRows(container, CATALOG_SNAPSHOT_SQL, { docker: (args, options) => run("docker", args, options) }), null, 1));
    writeFileSync(join(scratch, "fingerprint.json"), JSON.stringify(captureRows(container, ENVIRONMENT_FINGERPRINT_SQL, { docker: (args, options) => run("docker", args, options) }), null, 1));

    let provePassword = testPassword;
    if (options.sabotage) {
      console.log(`Applying local sabotage ${options.sabotage}`);
      const sabotage = sabotageSql(options.sabotage);
      if (sabotage) must("docker", ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "ci_bootstrap", "-d", "postgres"], { input: sabotage });
      if (options.sabotage === "wrong-dblink-password") {
        provePassword = randomBytes(9).toString("hex");
        must("docker", ["exec", "-i", container, "psql", "-X", "-q", "-v", "ON_ERROR_STOP=1", "-U", "ci_bootstrap", "-d", "postgres"], { input: `ALTER ROLE postgres PASSWORD '${provePassword}';` });
      }
    }
    console.log(`Running every shipped pgTAP test (${elapsed()})`);
    const result = run("docker", ["exec", "-w", testsInContainer,
      "-e", "PGHOST=127.0.0.1", "-e", "PGPORT=5432", "-e", "PGUSER=postgres", "-e", `PGPASSWORD=${provePassword}`, "-e", "PGDATABASE=postgres",
      container, ...pgProveArgs(testsInContainer)]);
    writeFileSync(join(scratch, "tap.log"), result.stdout);
    writeFileSync(join(scratch, "latest.log"), `${result.stdout}\n${result.stderr}`);
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    status = result.status ?? 1;
    console.log(`pg_prove exit ${status} (${elapsed()}); TAP in ${join(scratch, "tap.log")}`);
  } finally {
    const removed = run("docker", ["rm", "-f", "-v", container]);
    if (removed.status !== 0 && !/No such container/iu.test(removed.stderr)) {
      console.error(`Owned container cleanup failed: ${removed.stderr}`);
      status = 1;
    }
    rmSync(directory, { recursive: true, force: true });
  }
  process.exitCode = status;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : "managed baseline pgTAP failed"); process.exitCode = 1; });
}
