import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { assertFreshClusterCatalogue, hostedS3WorkerEnvironment, initialReceipt, loadCredentials, main } from "./runM14RecipeConformance.mjs";
import { journeyReceipt } from "./m14RecipeJourneys.mjs";
import { cleanupRdsPhase, rdsControlRoles } from "./m14RdsRecipe.mjs";
import { OIDC_IMAGE } from "./runOidcIdentityConformance.mjs";
import { createOidcIssuerFixture } from "./oidcIssuerFixture.js";

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
afterEach(() => { vi.unstubAllGlobals(); for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

it.each([false, true])("removes only created hosted realms, including partial provisioning (failure=%s)", async failSecond => {
  const realms = new Set(["unrelated"]), deleted: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path.endsWith("/token")) return Response.json({ access_token: "synthetic-admin-token" });
    if (path === "/admin/realms" && init?.method === "POST") {
      const realm = JSON.parse(String(init.body)).realm;
      if (failSecond && realm.endsWith("foreign")) return new Response(null, { status: 409 });
      realms.add(realm); return new Response(null, { status: 201 });
    }
    if (init?.method === "DELETE") {
      const realm = path.split("/").at(-1)!; deleted.push(realm); realms.delete(realm);
      return new Response(null, { status: 204 });
    }
    const realm = path.split("/")[2]!;
    return realm === "master" || realms.has(realm) ? Response.json({}) : new Response(null, { status: 404 });
  });
  const create = createOidcIssuerFixture("https://issuer.example.org", "synthetic-admin-password", "http://127.0.0.1:9000/callback", "m14-run-");
  if (failSecond) await expect(create).rejects.toThrow("Owned issuer operation refused");
  else {
    const issuer = await create;
    expect(issuer.issuer).toBe("https://issuer.example.org/realms/m14-run-reference");
    expect(issuer.issuerFor("foreign")).toBe("https://issuer.example.org/realms/m14-run-foreign");
    await issuer.close(); await issuer.close();
  }
  expect([...realms]).toEqual(["unrelated"]);
  expect(deleted).toEqual(failSecond ? ["m14-run-reference"] : ["m14-run-foreign", "m14-run-reference"]);
});

it("admits only an explicit disposable pinned hosted issuer over public HTTPS before any connection", async () => {
  const f = fixture();
  const config = { schemaVersion: 1, target: "hosted-oidc", disposable: true, region: "test-region",
    issuerOrigin: "https://issuer.example.org", issuerImage: OIDC_IMAGE, adminPassword: f.secret };
  const save = () => writeFileSync(f.path, JSON.stringify(config), { mode: 0o600 }); save();
  expect(loadCredentials(f.path, "hosted-oidc")).toEqual(config);
  for (const issuerOrigin of ["http://issuer.example.org", "https://localhost", "https://127.0.0.1", "https://[::1]",
    "https://issuer.local", "https://issuer.internal", "https://issuer.localhost", "https://localhost.",
    "https://issuer.local.", "https://issuer.internal.", "https://issuer.example.org.", "https://user:secret@issuer.example.org",
    "https://issuer.example.org/realms/shared", "https://issuer.example.org?secret=value", "https://issuer.example.org#fragment"]) {
    config.issuerOrigin = issuerOrigin; save();
    expect(() => loadCredentials(f.path, "hosted-oidc")).toThrow("public_https_issuer_required");
  }
  const receipt = join(f.root, "unsafe-hosted-receipt.json");
  await expect(main(["--target", "hosted-oidc", "--credentials", f.path, "--receipt", receipt])).rejects.toThrow("public_https_issuer_required");
  expect(() => readFileSync(receipt)).toThrow();
  config.issuerOrigin = "https://issuer.example.org";
  for (const issuerImage of ["quay.io/keycloak/keycloak:latest", `quay.io/keycloak/keycloak@sha256:${"a".repeat(64)}`]) {
    config.issuerImage = issuerImage; save();
    expect(() => loadCredentials(f.path, "hosted-oidc")).toThrow("disposable_pinned_issuer_required");
  }
  config.issuerImage = OIDC_IMAGE; config.disposable = false; save();
  expect(() => loadCredentials(f.path, "hosted-oidc")).toThrow("explicit_disposable_target_required");
  config.disposable = true; config.adminPassword = "short"; save();
  expect(() => loadCredentials(f.path, "hosted-oidc")).toThrow("disposable_pinned_issuer_required");
  config.adminPassword = f.secret; save(); chmodSync(f.path, 0o644);
  expect(() => loadCredentials(f.path, "hosted-oidc")).toThrow("credential_file_requires_owner_mode_600");
});

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
  const hosted = { schemaVersion: 1, target: "rds", disposable: true, region: "xx-test-1", layout: "serial-cluster",
    previousApplicationPath: f.config.previousApplicationPath,
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
    for (const key of ["password", "adminPassword", "localNodeImage"]) {
      writeFileSync(f.path, JSON.stringify({ ...hosted, [key]: f.secret }), { mode: 0o600 });
      expect(() => loadCredentials(f.path, "rds", environment)).toThrow("rds_declaration_fields_refused");
    }
    for (const mode of ["installer-managed", "operator-provisioned", "schema"]) {
      for (const key of ["password", "adminPassword", "systemIdentifier"]) {
        writeFileSync(f.path, JSON.stringify({ ...hosted, installations: { ...hosted.installations,
          [mode]: { ...hosted.installations[mode], [key]: f.secret } } }), { mode: 0o600 });
        expect(() => loadCredentials(f.path, "rds", environment)).toThrow("rds_declaration_fields_refused");
      }
    }
    save();
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
it("admits a password-free hosted S3 declaration and refuses wider namespaces, credentials and undeclared targets", () => {
  const f = fixture();
  const selected = { schemaVersion: 1, target: "s3", disposable: true, region: "xx-test-1", bucket: "synthetic-test-bucket",
    prefix: "m14-10o/synthetic-run/", lifecycleStatePath: join(f.root, "state.json"), sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40) };
  const save = (value: object) => writeFileSync(f.path, JSON.stringify(value), { mode: 0o600 });
  save(selected); expect(loadCredentials(f.path, "s3")).toEqual(selected);
  for (const delta of [{ region: undefined }, { region: "invalid" }, { region: "xx-test" },
    { prefix: "" }, { prefix: "other/run/" }, { prefix: "m14-10o/../" },
    { lifecycleStatePath: resolve("state.json") }, { accessKeyId: "synthetic" }, { endpoint: "https://example.invalid" }, { sourceTree: "invalid" }]) {
    save({ ...selected, ...delta }); expect(() => loadCredentials(f.path, "s3")).toThrow("region" in delta ? "region_required" : "hosted_s3_declaration_refused");
  }
});

it("refuses each hosted target's declaration fields when relabelled as the other target", () => {
  const f = fixture();
  const s3 = { schemaVersion: 1, target: "s3", disposable: true, region: "xx-test-1", bucket: "synthetic-test-bucket",
    prefix: "m14-10o/synthetic-run/", lifecycleStatePath: join(f.root, "state.json"), sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40) };
  const oidc = { schemaVersion: 1, target: "hosted-oidc", disposable: true, region: "xx-test-1",
    issuerOrigin: "https://issuer.example.org", issuerImage: OIDC_IMAGE, adminPassword: f.secret };
  const save = (value: object) => writeFileSync(f.path, JSON.stringify(value), { mode: 0o600 });
  save(s3); expect(loadCredentials(f.path, "s3")).toEqual(s3);
  save(oidc); expect(loadCredentials(f.path, "hosted-oidc")).toEqual(oidc);
  save({ ...s3, target: "hosted-oidc" });
  expect(() => loadCredentials(f.path, "hosted-oidc")).toThrow("credential_input_refused");
  save({ ...oidc, target: "s3" });
  expect(() => loadCredentials(f.path, "s3")).toThrow("hosted_s3_declaration_refused");
});

it("refuses declarations from another target family for every selectable target", () => {
  const f = fixture();
  const environment = { M14_CROSS_TARGET_PASSWORD: f.secret };
  const pg = { ...f.config, region: "xx-test-1" };
  const declarations: Record<string, object> = {
    "self-host": pg, neon: { ...pg, target: "neon" },
    rds: { schemaVersion: 1, target: "rds", disposable: true, region: "xx-test-1", layout: "serial-cluster",
      previousApplicationPath: f.config.previousApplicationPath,
      installations: Object.fromEntries(["installer-managed", "operator-provisioned", "schema"].map(mode => [mode, {
        disposable: true, connectionString: "postgresql://bootstrap@managed.example.invalid/postgres",
        passwordEnv: "M14_CROSS_TARGET_PASSWORD", incarnationSha256: "a".repeat(64), ca: f.config.installations.schema.ca,
      }])) },
    s3: { schemaVersion: 1, target: "s3", disposable: true, region: "xx-test-1", bucket: "synthetic-test-bucket",
      prefix: "m14-10o/cross-target/", lifecycleStatePath: join(f.root, "state.json"), sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40) },
    "hosted-oidc": { schemaVersion: 1, target: "hosted-oidc", disposable: true, region: "xx-test-1",
      issuerOrigin: "https://issuer.example.org", issuerImage: OIDC_IMAGE, adminPassword: f.secret },
  };
  for (const [target, declaration] of Object.entries(declarations)) {
    writeFileSync(f.path, JSON.stringify(declaration), { mode: 0o600 });
    expect(loadCredentials(f.path, target, environment)).toEqual(declaration);
    for (const [other, foreign] of Object.entries(declarations)) {
      // Self-host and Neon deliberately share the three-cluster SQL declaration.
      if (other === target || [target, other].every(name => ["self-host", "neon"].includes(name))) continue;
      writeFileSync(f.path, JSON.stringify({ ...foreign, target }), { mode: 0o600 });
      expect(() => loadCredentials(f.path, target, environment)).toThrow();
    }
  }
});

it("keeps shared AWS profiles out of the hosted S3 worker credential chain", () => {
  const f = fixture();
  const aws = join(f.root, ".aws"); mkdirSync(aws);
  const syntheticProfile = "[default]\naws_access_key_id = synthetic-access\naws_secret_access_key = synthetic-secret\n";
  writeFileSync(join(aws, "config"), syntheticProfile);
  writeFileSync(join(aws, "credentials"), syntheticProfile);
  const script = "const { S3Client } = require('@aws-sdk/client-s3'); const client = new S3Client({ region: 'xx-test-1' }); client.config.credentials().then(() => process.stdout.write('RESOLVED'), () => process.stdout.write('REFUSED')).finally(() => client.destroy());";
  const base = { HOME: f.root, AWS_EC2_METADATA_DISABLED: "true" };
  const probe = (env: Record<string, string>) => spawnSync(process.execPath, ["-e", script], { env, encoding: "utf8", timeout: 10000 });
  const exposed = probe(base);
  expect(exposed.status).toBe(0); expect(exposed.stdout).toBe("RESOLVED");
  const isolated = probe({ ...base, ...hostedS3WorkerEnvironment });
  expect(isolated.status).toBe(0); expect(isolated.stdout).toBe("REFUSED");
});

it("keeps lifecycle pending before elapsed observation and requires surviving latest identities before cleanup", () => {
  const script = String.raw`
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lifecycle, lifecycleRule } from "./tests/postgres/m14HostedStorage.mjs";
const root = await mkdtemp(join(tmpdir(), "lifecycle-proof-"));
try {
  const now = Date.now(), prefix = "m14-10o/synthetic/";
  const config = { bucket: "synthetic-bucket", prefix, lifecycleStatePath: join(root, "state.json") };
  const objects = [{ key: prefix + "lifecycle/overwritten", noncurrentVersionId: "v1", currentVersionId: "v2" },
    { key: prefix + "lifecycle/deleted", noncurrentVersionId: "v3", currentVersionId: "v4", deleteMarkerVersionId: "v5" }];
  let rows = { IsTruncated: false, Versions: [
    { Key: objects[0].key, VersionId: "v1", IsLatest: false, LastModified: new Date(now - 2000) },
    { Key: objects[0].key, VersionId: "v2", IsLatest: true, LastModified: new Date(now - 1000) },
    { Key: objects[1].key, VersionId: "v3", IsLatest: false, LastModified: new Date(now - 2000) },
    { Key: objects[1].key, VersionId: "v4", IsLatest: false, LastModified: new Date(now - 1000) }],
    DeleteMarkers: [{ Key: objects[1].key, VersionId: "v5", IsLatest: true, LastModified: new Date(now - 500) }] };
  let versionStatus = 404;
  const client = { send: async command => {
    if (command.constructor.name === "GetObjectCommand") throw Object.assign(new Error("absent"), { name: versionStatus === 404 ? "NoSuchVersion" : "AccessDenied", $metadata: { httpStatusCode: versionStatus } });
    return rows;
  } };
  const save = async (delta = {}) => writeFile(config.lifecycleStatePath, JSON.stringify({ schemaVersion: 1, prefix,
    clockStart: new Date(now).toISOString(), objects, nextChecks: [], ...delta }), { mode: 0o600 });
  await save(); assert.equal((await lifecycle(client, config)).status, "PENDING-OBSERVATION");
  rows.Versions = rows.Versions.filter(row => row.IsLatest);
  assert.equal((await lifecycle(client, config)).status, "PENDING-OBSERVATION");
  await save(); await assert.rejects(lifecycle(client, config)); // Missing original seed cannot first-admit.
  await save({ admittedAt: new Date(now - 26 * 3600000).toISOString(), clockStart: new Date(now - 26 * 3600000).toISOString() });
  await assert.rejects(lifecycle(client, config)); // A backdated resume cannot outrun provider seed time.
  rows.Versions = rows.Versions.map(row => ({ ...row, LastModified: new Date(now - 26 * 3600000 - 1000) }));
  rows.DeleteMarkers = rows.DeleteMarkers.map(row => ({ ...row, LastModified: new Date(now - 26 * 3600000 - 1000) }));
  assert.equal((await lifecycle(client, config)).status, "PASS");
  versionStatus = 403; await assert.rejects(lifecycle(client, config)); versionStatus = 404;
  rows.DeleteMarkers = []; await assert.rejects(lifecycle(client, config));
  // A fresh declaration creates the same two-key seed through the same witness.
  const fresh = { ...config, lifecycleStatePath: join(root, "fresh.json") };
  let serial = 0; const physical = [];
  const seedClient = { send: async command => {
    const { Key, VersionId } = command.input;
    if (command.constructor.name === "ListObjectVersionsCommand") return { IsTruncated: false,
      Versions: physical.filter(row => !row.marker), DeleteMarkers: physical.filter(row => row.marker) };
    for (const row of physical.filter(row => row.Key === Key)) row.IsLatest = false;
    const id = "seed-" + (++serial);
    physical.push({ Key, VersionId: id, IsLatest: true, LastModified: new Date(Date.now() - 1000), marker: command.constructor.name === "DeleteObjectCommand" });
    return { VersionId: id };
  } };
  assert.equal((await lifecycle(seedClient, fresh)).status, "PENDING-OBSERVATION");
  assert.equal(JSON.parse(await readFile(fresh.lifecycleStatePath, "utf8")).objects.length, 2);
  const rule = { Status: "Enabled", NoncurrentVersionExpiration: { NoncurrentDays: 1 }, Filter: { Prefix: "m14-10o/" } };
  assert(lifecycleRule([rule], prefix));
  for (const change of [{ Status: "Disabled" }, { Filter: { Prefix: "other/" } }, { Filter: { ObjectSizeGreaterThan: 100 } },
    { NoncurrentVersionExpiration: { NoncurrentDays: 1, NewerNoncurrentVersions: 2 } }]) assert(!lifecycleRule([{ ...rule, ...change }], prefix));
  process.stdout.write("PASS");
} finally { await rm(root, { recursive: true, force: true }); }
`;
  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 30000 });
  expect(result.stderr).toBe(""); expect(result.status).toBe(0); expect(result.stdout).toBe("PASS");
}, 35000);

function hostedFixture() {
  const f = fixture();
  const certificatePath = join(f.root, "cert.pem"), keyPath = join(f.root, "key.pem");
  for (const path of [certificatePath, keyPath]) writeFileSync(path, "synthetic-not-a-certificate", { mode: 0o600 });
  const config = { schemaVersion: 1, target: "hosted-node", disposable: true, region: "us-west-2",
    origin: "https://host-recipe.192-0-2-1.sslip.io", localNodeImage: `sha256:${"a".repeat(64)}`,
    database: { connectionString: f.config.installations.schema.connectionString, ca: f.config.installations.schema.ca },
    sourceCommit: "a".repeat(40), sourceTree: "b".repeat(40), certificatePath, keyPath };
  const save = () => writeFileSync(f.path, JSON.stringify(config), { mode: 0o600 }); save();
  return { ...f, config, save };
}

it("admits a declared hosted Node target with a neutral region and preserves PaaS pending", () => {
  const f = hostedFixture();
  expect(loadCredentials(f.path, "hosted-node")).toEqual(f.config);
  const original = f.config.origin;
  for (const origin of [`${original}:443`, `${original}/`]) {
    f.config.origin = origin; f.save();
    const admitted = loadCredentials(f.path, "hosted-node");
    expect(admitted).toEqual({ ...f.config, origin: original });
    for (const path of ["/api/state", "/api/dispatch"]) expect(new URL(`${admitted.origin}${path}`).pathname).toBe(path);
  }
  f.config.origin = original; f.save();
  expect(initialReceipt("hosted-node")).toMatchObject({ nodeHosts: { status: "PENDING" },
    hostedRecipes: { "10H": { status: "PENDING" } }, paas: { status: "PENDING", owner: "10H-paas", reason: "access not provided" } });
});

it("refuses insecure hosted origins, mutable images, remote DBs and public TLS key files before work", () => {
  const f = hostedFixture();
  const withUserinfo = new URL(f.config.origin); withUserinfo.username = "user"; withUserinfo.password = f.secret;
  for (const origin of ["http://host.192-0-2-1.sslip.io", "https://192.0.2.1", "https://[::1]",
    "https://host.example.invalid", "https://host.example.test", "https://host.example.example",
    "https://host.example.localhost", "https://host.example.local", "https://localhost",
    "https://@host.192-0-2-1.sslip.io", "https://:@host.192-0-2-1.sslip.io",
    `${f.config.origin}/path`, `${f.config.origin}/path/..`, `${f.config.origin}/?q=1`, `${f.config.origin}/#fragment`,
    `${f.config.origin}?`, `${f.config.origin}#`,
    withUserinfo.href.replace(/\/$/u, ""), "https://host.192-0-2-1.sslip.io:444"]) {
    const old = f.config.origin; f.config.origin = origin; f.save();
    expect(() => loadCredentials(f.path, "hosted-node")).toThrow("public_https_origin_required"); f.config.origin = old;
  }
  f.config.localNodeImage = "node:24"; f.save();
  expect(() => loadCredentials(f.path, "hosted-node")).toThrow("local_node_image_required");
  f.config.localNodeImage = `sha256:${"a".repeat(64)}`;
  const database = f.config.database.connectionString;
  f.config.database.connectionString = database.replace("127.0.0.1", "remote.example.invalid"); f.save();
  expect(() => loadCredentials(f.path, "hosted-node")).toThrow("local_tls_database_required");
  f.config.database.connectionString = database; f.save(); chmodSync(f.config.keyPath, 0o644);
  expect(() => loadCredentials(f.path, "hosted-node")).toThrow("external_tls_files_required");
  chmodSync(f.config.keyPath, 0o600);
  const key = f.config.keyPath; f.config.keyPath = join(f.root, "key-link"); symlinkSync(key, f.config.keyPath); f.save();
  expect(() => loadCredentials(f.path, "hosted-node")).toThrow("external_tls_files_required");
});

it("fails a mismatched hosted source without exposing endpoint, DB credential or TLS paths", () => {
  const f = hostedFixture(), receipt = join(f.root, "hosted-failed.json");
  const result = spawnSync(process.execPath, ["tests/postgres/runM14RecipeConformance.mjs", "--target", "hosted-node",
    "--credentials", f.path, "--receipt", receipt], { encoding: "utf8", timeout: 30000 });
  expect(result.status).toBe(1);
  const bytes = readFileSync(receipt, "utf8"), output = result.stdout + result.stderr + bytes;
  for (const privateValue of [f.secret, f.path, f.config.origin, f.config.keyPath, f.config.database.connectionString]) expect(output).not.toContain(privateValue);
  expect(JSON.parse(bytes)).toMatchObject({ status: "FAIL", hostedRecipes: { "10H": { status: "PENDING" } } });
});
