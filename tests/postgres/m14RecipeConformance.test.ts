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
    DeleteMarkers: [{ Key: objects[1].key, VersionId: "v5", IsLatest: true }] };
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
