import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Pool } from "pg";
import { afterEach, expect, it, vi } from "vitest";
import { closePostgres, dockerAvailable, postgresSetupTimeoutMs, runPostgresContainer, waitForPostgresTcpReady } from "../helpers/postgresContainer.js";
import { assertFreshClusterCatalogue, initialReceipt, loadCredentials, main } from "./runM14RecipeConformance.mjs";
import { journeyReceipt } from "./m14RecipeJourneys.mjs";
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
