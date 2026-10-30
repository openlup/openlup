// Disposable stock PostgreSQL 17 with the managed-compatibility test adapter,
// for the managed-rail suites that previously booted the supabase/postgres image.
//
// It reuses the stock pgTAP lane's supply and server settings
// (scripts/public-ci-pgtap-postgres.mjs): the digest-pinned install-proof
// `postgres:17` image, the checksum-pinned pg_cron/pgTAP/pg_prove packages from
// config/ci-postgres-packages.json, the pg_cron preload, the managed clock and
// float output and the ICU en-US locale. The adapter
// (tests/postgres/managed-compat/supabase.sql) then runs as the neutral
// bootstrap superuser.
//
// Login identities match the managed image the suites used: `postgres` and the
// managed superuser `supabase_admin` both log in with the container password.
// The adapter keeps supabase_admin NOLOGIN for the pgTAP lane, which never logs
// in as it; here the suites' owner session is that identity, so this helper
// grants it LOGIN and changes nothing else.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import packagePins from "../../config/ci-postgres-packages.json" with { type: "json" };
import { imageReference, readCiImage } from "../../scripts/ci-image-pull.mjs";
import { ensurePackages, INITDB_ARGS, selectPackageFiles, SERVER_FLAGS } from "../../scripts/public-ci-pgtap-postgres.mjs";
import { runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer, type PostgresContainerSpec } from "./postgresContainer.js";

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, "../..");
const adapterPath = join(root, "tests/postgres/managed-compat/supabase.sql");
const bootstrapUser = "ci_bootstrap";
const debsInContainer = "/work/debs";
// Shared with the pgTAP lane: its CI cache directory, or an ignored scratch directory.
const packageCache = () => process.env.OPENLUP_PGTAP_DEB_CACHE || join(root, ".context/scratch/cache/pgtap-postgres-debs");
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function dockerArchitecture(): Promise<string> {
  const { stdout } = await exec("docker", ["info", "--format", "{{.Architecture}}"], { timeout: 30_000 });
  const architecture = ({ x86_64: "amd64", amd64: "amd64", aarch64: "arm64", arm64: "arm64" } as Record<string, string>)[stdout.trim()];
  if (!architecture) throw new Error(`no pinned extension packages for Docker architecture ${stdout.trim()}`);
  return architecture;
}

/**
 * Copy the pinned packages into a private directory for one container and
 * verify each SHA-256 on the bytes actually staged, so a concurrent suite
 * refreshing the shared cache can never hand dpkg other bytes.
 */
async function stagePackages(): Promise<{ directory: string; names: string[] }> {
  const files = selectPackageFiles(packagePins, await dockerArchitecture());
  const cache = packageCache();
  await ensurePackages(files, cache);
  const directory = mkdtempSync(join(tmpdir(), "openlup-managed-compat-debs-"));
  try {
    for (const file of files) {
      const bytes = readFileSync(join(cache, file.name));
      if (sha256(bytes) !== file.sha256) throw new Error(`cached ${file.name} does not match its pinned SHA-256 ${file.sha256}`);
      writeFileSync(join(directory, file.name), bytes);
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  return { directory, names: files.map(file => file.name) };
}

export type ManagedCompatPostgresSpec = Pick<PostgresContainerSpec, "name" | "password" | "labels">;

/**
 * Start stock PostgreSQL 17 with the pinned extensions installed and the
 * managed-compatibility adapter applied. The result has the shape of
 * `runPostgresContainer`: its connection string logs in as `postgres`, and the
 * caller still gates on `waitForPostgresTcpReady` before use.
 */
export async function runManagedCompatPostgres(spec: ManagedCompatPostgresSpec): Promise<PostgresContainer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(spec.password)) throw new Error("managed-compat password must be a plain synthetic token");
  const packages = await stagePackages();
  const pin = readCiImage(packagePins.image);
  let container: PostgresContainer | undefined;
  try {
    container = await runPostgresContainer({
      ...spec,
      image: imageReference(pin, pin.sources.at(-1)),
      runOptions: [
        "-v", `${packages.directory}:${debsInContainer}:ro`,
        "-e", `POSTGRES_USER=${bootstrapUser}`, "-e", "POSTGRES_DB=postgres", "-e", `POSTGRES_INITDB_ARGS=${INITDB_ARGS}`,
        "--entrypoint", "bash",
      ],
      command: ["-c",
        `set -euo pipefail; dpkg -i ${packages.names.map(name => `${debsInContainer}/${name}`).join(" ")} >/dev/null; exec docker-entrypoint.sh postgres "$@"`,
        "openlup-managed-compat", ...SERVER_FLAGS],
    });
    // The bootstrap superuser shares the disposable container password.
    const bootstrap = container.connectionString.replace("postgres://postgres:", `postgres://${bootstrapUser}:`);
    if (!await waitForPostgresTcpReady(bootstrap)) throw new Error(`managed-compat PostgreSQL ${spec.name} did not become ready`);
    const client = new Client({ connectionString: bootstrap });
    await client.connect();
    try {
      await client.query(`BEGIN;
${readFileSync(adapterPath, "utf8")}
ALTER ROLE postgres PASSWORD '${spec.password}';
ALTER ROLE supabase_admin LOGIN PASSWORD '${spec.password}';
COMMIT;`);
    } finally {
      await client.end();
    }
  } catch (error) {
    try { await container?.remove(); } finally { rmSync(packages.directory, { recursive: true, force: true }); }
    throw error;
  }
  const started = container;
  return {
    ...started,
    remove: async () => {
      try { await started.remove(); } finally { rmSync(packages.directory, { recursive: true, force: true }); }
    },
  };
}
