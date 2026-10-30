import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { afterEach, expect, it } from "vitest";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { assertFreshClusterCatalogue, initialReceipt, loadCredentials, main } from "./runM14RecipeConformance.mjs";
import { journeyReceipt } from "./m14RecipeJourneys.mjs";

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

it("starts every unfinished appendix section explicitly pending with its owner", () => {
  expect(initialReceipt("self-host")).toMatchObject({ status: "INCOMPLETE", schema: { status: "PENDING", owner: "10A" },
    transfer: { status: "PENDING", owner: "8D/10P" }, recovery: { status: "PENDING", owner: "9A/10P" },
    oidc: { status: "PENDING", owner: "10I" }, s3: { status: "PENDING", owner: "10O" },
    nodeHosts: { status: "PENDING", owner: "10H" }, effortCleanup: { status: "PENDING", owner: "10H/10S" } });
});

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
