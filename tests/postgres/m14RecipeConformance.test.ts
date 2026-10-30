import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { afterEach, expect, it } from "vitest";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { assertFreshClusterCatalogue, initialReceipt, loadCredentials, main } from "./runM14RecipeConformance.mjs";
import { journeyReceipt } from "./m14RecipeJourneys.mjs";
import { cleanupRdsPhase, rdsControlRoles } from "./m14RdsRecipe.mjs";

const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "recipe-input-")); directories.push(root);
  const secret = "private-credential-do-not-print";
  const config = { schemaVersion: 1, target: "self-host", region: "local", disposable: true,
    localNodeImage: `sha256:${"b".repeat(64)}`,
    previousApplicationPath: "/external/previous/dist/payments/index.js",
    installations: Object.fromEntries(["installer-managed", "operator-provisioned", "schema"].map((mode, index) => [mode, {
      disposable: true, systemIdentifier: String(7000000000000000000n + BigInt(index)),
      connectionString: `postgresql://postgres:${secret}@127.0.0.1:1/postgres`,
      ca: "-----BEGIN CERTIFICATE-----\nunusable-private-input\n-----END CERTIFICATE-----",
      ociDigest: `sha256:${"a".repeat(64)}`,
    }])) };
  const path = join(root, "credentials.json");
  const save = () => writeFileSync(path, JSON.stringify(config), { mode: 0o600 }); save();
  return { root, path, secret, config, save };
}
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it("refuses missing and undeclared selections before creating a receipt", async () => {
  const f = fixture();
  await expect(main([])).rejects.toThrow("usage:");
  expect(() => loadCredentials(f.path, "unknown")).toThrow("target_input_required");
  delete (f.config as { disposable?: boolean }).disposable; f.save();
  expect(() => loadCredentials(f.path, "self-host")).toThrow("explicit_disposable_target_required");
  expect(() => loadCredentials(f.path, "neon")).toThrow("explicit_disposable_target_required");
});

it("requires private mode, an external ordinary file, and three declared distinct clusters", () => {
  const f = fixture();
  chmodSync(f.path, 0o644);
  expect(() => loadCredentials(f.path, "self-host")).toThrow("credential_file_requires_owner_mode_600");
  chmodSync(f.path, 0o600);
  const link = join(f.root, "link.json"); symlinkSync(f.path, link);
  expect(() => loadCredentials(link, "self-host")).toThrow("credential_symlink_refused");
  const inside = resolve(".context/scratch/m14-recipe-input-test"); mkdirSync(inside, { recursive: true });
  const internal = join(inside, `credentials-${process.pid}.json`);
  try {
    writeFileSync(internal, JSON.stringify(f.config), { mode: 0o600 });
    expect(() => loadCredentials(internal, "self-host")).toThrow("credential_file_must_be_external");
  } finally { rmSync(internal); }
  f.config.installations.schema.systemIdentifier = f.config.installations["installer-managed"].systemIdentifier; f.save();
  expect(() => loadCredentials(f.path, "self-host")).toThrow("separate_clusters_required");
});

it("requires an exact declared image digest for each installation", () => {
  const f = fixture();
  delete (f.config.installations.schema as { ociDigest?: string }).ociDigest; f.save();
  expect(() => loadCredentials(f.path, "self-host")).toThrow("oci_digest_required");
  f.config.installations.schema.ociDigest = "sha256:invalid"; f.save();
  expect(() => loadCredentials(f.path, "self-host")).toThrow("oci_digest_required");
});

it("refuses an undeclared or mutable local Node image before any recipe connection", () => {
  const f = fixture();
  for (const image of [undefined, "node:24", "sha256:invalid"]) {
    f.config.localNodeImage = image as string; f.save();
    expect(() => loadCredentials(f.path, "self-host")).toThrow("local_node_image_required");
  }
});

it("refuses a non-local endpoint for the selected local self-host recipe before mutation", () => {
  const f = fixture();
  f.config.installations.schema.connectionString = "postgresql://postgres:synthetic@remote.example.invalid/postgres"; f.save();
  expect(() => loadCredentials(f.path, "self-host")).toThrow("local_self_host_endpoint_required");
});

it("does not promote a refused or incompletely cleaned journey into a successful receipt", () => {
  const report = { outcome: "LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION", cleanupFailures: [],
    journey: { leg: "portable-to-portable", takeover: true }, graphPublished: true, filesystemPublished: true, sourceWritesFrozen: true,
    recovery: { format: "openlup.local-older-snapshot-recovery.v1", snapshotAgeSeconds: 60.1,
      effectiveRpoSeconds: 60.1, rtoSeconds: 87, postFailureDiagnosticGraphUsedForRestore: false, noSloClaim: true, hostedQualification: false } };
  expect(journeyReceipt(report, true)).toMatchObject({ status: "PASS", hostedQualification: false,
    measurementClaim: "declared-scope fixture measurement, not an SLO or hosted claim" });
  for (const delta of [{ outcome: "INCOMPLETE" }, { cleanupFailures: ["container"] }, { journey: { leg: "portable-to-portable", takeover: false } },
    { recovery: { ...report.recovery, rtoSeconds: null } }, { recovery: { ...report.recovery, postFailureDiagnosticGraphUsedForRestore: true } }]) {
    expect(() => journeyReceipt({ ...report, ...delta }, true)).toThrow();
  }
});

it("refuses a reused cluster catalogue before the proof can create global roles", async () => {
  if (!await dockerAvailable()) throw new Error("Recipe freshness refusal requires Docker PostgreSQL 16");
  const container = await runPostgresContainer({ name: `m14-recipe-freshness-${process.pid}`, password: "synthetic-conformance" });
  let pool: Pool | undefined;
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    pool = new Pool({ connectionString: container.connectionString });
    await expect(assertFreshClusterCatalogue(pool, "postgres", "postgres")).resolves.toBeUndefined();
    for (const [occupy, clear] of [
      ["CREATE DATABASE recipe_other", "DROP DATABASE recipe_other"],
      ["CREATE SCHEMA recipe_other", "DROP SCHEMA recipe_other"],
      ["CREATE FUNCTION public.recipe_other() RETURNS integer LANGUAGE SQL AS 'SELECT 1'", "DROP FUNCTION public.recipe_other()"],
      ["CREATE ROLE recipe_other", "DROP ROLE recipe_other"],
    ]) {
      await pool.query(occupy);
      try { await expect(assertFreshClusterCatalogue(pool, "postgres", "postgres")).rejects.toThrow("fresh_cluster_required"); }
      finally { await pool.query(clear); }
    }
    const other = new Pool({ connectionString: container.connectionString });
    const held = await other.connect();
    try { await expect(assertFreshClusterCatalogue(pool, "postgres", "postgres")).rejects.toThrow("fresh_cluster_required"); }
    finally { held.release(); await other.end(); }
    await expect(assertFreshClusterCatalogue(pool, "postgres", "postgres")).resolves.toBeUndefined();
    for (const role of rdsControlRoles) await pool.query(`CREATE ROLE ${role} ${role === "rdsadmin" ? "LOGIN PASSWORD 'synthetic-monitor'" : "NOLOGIN"}`);
    await pool.query("CREATE DATABASE rdsadmin OWNER rdsadmin");
    const profile = { target: "rds", baselineDatabases: ["postgres"] };
    const monitorUrl = new URL(container.connectionString); monitorUrl.username = "rdsadmin"; monitorUrl.password = "synthetic-monitor";
    monitorUrl.pathname = "/rdsadmin";
    const monitor = new Pool({ connectionString: monitorUrl.toString() });
    const monitoring = await monitor.connect();
    try {
      await expect(assertFreshClusterCatalogue(pool, "postgres", "postgres", profile)).resolves.toBeUndefined();
      for (const [occupy, clear] of [["CREATE ROLE rds_unexpected", "DROP ROLE rds_unexpected"],
        ["CREATE DATABASE rds_unexpected", "DROP DATABASE rds_unexpected"]]) {
        await pool.query(occupy);
        try { await expect(assertFreshClusterCatalogue(pool, "postgres", "postgres", profile)).rejects.toThrow("fresh_cluster_required"); }
        finally { await pool.query(clear); }
      }
      monitorUrl.pathname = "/postgres";
      const wrongDatabase = new Pool({ connectionString: monitorUrl.toString() });
      const wrongSession = await wrongDatabase.connect();
      try { await expect(assertFreshClusterCatalogue(pool, "postgres", "postgres", profile)).rejects.toThrow("fresh_cluster_required"); }
      finally { wrongSession.release(); await wrongDatabase.end(); }
      await expect(assertFreshClusterCatalogue(pool, "postgres", "postgres")).rejects.toThrow("fresh_cluster_required");
    } finally {
      monitoring.release(); await monitor.end();
      await pool.query("DROP DATABASE rdsadmin");
      for (const role of rdsControlRoles) await pool.query(`DROP ROLE ${role}`);
    }
  } finally { await closePostgres(container, pool); }
}, postgresSetupTimeoutMs);

it("keeps credentials, paths and raw worker errors out of process output and failed receipts", () => {
  const f = fixture();
  const receipt = join(f.root, "receipt.json");
  const result = spawnSync(process.execPath, ["tests/postgres/runM14RecipeConformance.mjs", "--target", "self-host",
    "--credentials", f.path, "--receipt", receipt], { encoding: "utf8", timeout: 30000 });
  expect(result.status).toBe(1);
  const bytes = readFileSync(receipt, "utf8");
  const allOutput = result.stdout + result.stderr + bytes;
  for (const privateValue of [f.secret, f.path, f.config.installations.schema.connectionString, "unusable-private-input"])
    expect(allOutput).not.toContain(privateValue);
  expect(JSON.parse(bytes)).toMatchObject({ status: "FAIL", install: { status: "PENDING" }, transfer: { status: "PENDING", owner: "8D/10P" } });
  expect(() => loadCredentials(f.path, "self-host")).not.toThrow();
  // Receipts never overwrite an earlier result or a caller-selected link.
  const again = spawnSync(process.execPath, ["tests/postgres/runM14RecipeConformance.mjs", "--target", "self-host",
    "--credentials", f.path, "--receipt", receipt], { encoding: "utf8", timeout: 30000 });
  expect(again.status).toBe(1);
  expect(readFileSync(receipt, "utf8")).toBe(bytes);
}, 35000);

it("drops the owned phase database before application groups and their restricted grantors", async () => {
  if (!await dockerAvailable()) throw new Error("Role cleanup proof requires Docker PostgreSQL 16");
  const container = await runPostgresContainer({ name: `m14-10r-role-cleanup-${process.pid}`, password: "synthetic-conformance" });
  const root = new Pool({ connectionString: container.connectionString });
  let owner: Pool | undefined;
  const prefix = `m14_10r_cleanup_${process.pid}`, database = prefix, m = `${prefix}_m`, app = `${prefix}_previous`;
  try {
    expect(await waitForPostgresTcpReady(container.connectionString)).toBe(true);
    await root.query(`CREATE ROLE ${m} LOGIN NOINHERIT CREATEROLE NOSUPERUSER PASSWORD 'synthetic-cleanup'`);
    await root.query(`CREATE DATABASE ${database} OWNER ${m}`);
    const url = new URL(container.connectionString); url.username = m; url.password = "synthetic-cleanup"; url.pathname = `/${database}`;
    owner = new Pool({ connectionString: url.toString() });
    await owner.query(`CREATE ROLE ${app} NOLOGIN; CREATE ROLE anon NOLOGIN; GRANT anon TO ${app};
      CREATE TABLE public.cleanup_probe(id integer); GRANT SELECT ON public.cleanup_probe TO ${app}`);
    await expect(owner.query(`DROP OWNED BY ${app}`)).rejects.toMatchObject({ code: "42501" });
    await owner.end();
    await expect(cleanupRdsPhase(root, { database: "postgres", rolePrefix: prefix, bootstrapLogin: "postgres" }))
      .rejects.toThrow("test_namespace_refused");
    expect(await cleanupRdsPhase(root, { database, rolePrefix: prefix, bootstrapLogin: "postgres" }))
      .toEqual({ databaseAbsent: true, rolesAbsent: true, rolesDropped: 3 });
    expect((await root.query("SELECT current_user AS login, EXISTS(SELECT 1 FROM pg_database WHERE datname='postgres') AS baseline_preserved")).rows)
      .toEqual([{ login: "postgres", baseline_preserved: true }]);
  } finally { await closePostgres(container, [root, owner]); }
}, postgresSetupTimeoutMs);

it("starts every unfinished appendix section explicitly pending with its owner", () => {
  expect(initialReceipt("self-host")).toMatchObject({ status: "INCOMPLETE", schema: { status: "PENDING", owner: "10A" },
    transfer: { status: "PENDING", owner: "8D/10P" }, recovery: { status: "PENDING", owner: "9A/10P" },
    oidc: { status: "PENDING", owner: "10I" }, s3: { status: "PENDING", owner: "10O" },
    nodeHosts: { status: "PENDING", owner: "10H" }, effortCleanup: { status: "PENDING", owner: "10H/10S" } });
});

it("admits only one explicitly serial RDS target with an environment-only password", () => {
  const f = fixture();
  const envName = "M14_RECIPE_TEST_PASSWORD";
  const environment: Record<string, string> = {};
  const hosted = { ...f.config, target: "rds", region: "xx-test-1", layout: "serial-cluster",
    installations: Object.fromEntries(["installer-managed", "operator-provisioned", "schema"].map(mode => [mode, {
      disposable: true, connectionString: "postgresql://bootstrap@managed.example.invalid/postgres",
      passwordEnv: envName, incarnationSha256: "a".repeat(64), ca: f.config.installations.schema.ca,
    }])) };
  const save = () => writeFileSync(f.path, JSON.stringify(hosted), { mode: 0o600 });
  try {
    save();
    expect(() => loadCredentials(f.path, "rds", environment)).toThrow("rds_password_environment_required");
    environment[envName] = f.secret;
    expect(loadCredentials(f.path, "rds", environment)).toEqual(hosted);
    delete (hosted as { region?: string }).region; save();
    expect(() => loadCredentials(f.path, "rds", environment)).toThrow("region_required");
    hosted.region = "xx-test"; save();
    expect(() => loadCredentials(f.path, "rds", environment)).toThrow("rds_serial_declaration_required");
    hosted.region = "xx-test-1"; save();
    expect(readFileSync(f.path, "utf8")).not.toContain(f.secret);
    hosted.installations.schema.passwordEnv = "NODE_OPTIONS"; save();
    expect(() => loadCredentials(f.path, "rds", { ...environment, NODE_OPTIONS: "--import ./untrusted.mjs" })).toThrow("rds_password_environment_required");
    hosted.installations.schema.passwordEnv = envName;
    hosted.installations.schema.connectionString = "postgresql://bootstrap:inline@managed.example.invalid/postgres"; save();
    expect(() => loadCredentials(f.path, "rds", environment)).toThrow("rds_password_environment_required");
    hosted.installations.schema.connectionString = "postgresql://bootstrap@other.example.invalid/postgres"; save();
    expect(() => loadCredentials(f.path, "rds", environment)).toThrow("one_rds_cluster_required");
    hosted.installations.schema.connectionString = hosted.installations["installer-managed"].connectionString;
    hosted.layout = "parallel"; save();
    expect(() => loadCredentials(f.path, "rds", environment)).toThrow("rds_serial_declaration_required");
  } finally { delete environment[envName]; }
});
