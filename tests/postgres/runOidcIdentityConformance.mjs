// Opt-in only. The recipe runner may supply an explicitly disposable hosted issuer.
import { ownedStackCleanup } from "../../scripts/owned-stack-cleanup.mjs";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { connect } from "node:tls";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { assertPortBindings } from "../identity/runAcceptance.mjs";
export const OIDC_IMAGE = "quay.io/keycloak/keycloak:26.0.7@sha256:4388e2379b7e870a447adbe7b80bd61f5fbf04e925832b19669fda4957f05a81";
export function assertOidcImage(image) {
  const digest = OIDC_IMAGE.slice(OIDC_IMAGE.indexOf("@"));
  assert(image?.RepoDigests?.includes(`quay.io/keycloak/keycloak${digest}`), "OIDC conformance requires the cached pinned issuer image digest");
  assert(/^sha256:[a-f0-9]{64}$/.test(image.Id), "OIDC image identity unavailable");
}
export function assertOidcOwned(container, runId, project, imageId) {
  assert.equal(container.Config?.Labels?.["com.openlup.oidc.run"], runId, "OIDC resource run ownership mismatch");
  assert.equal(container.Config?.Labels?.["com.docker.compose.project"], project, "OIDC resource project ownership mismatch");
  assert.equal(container.Image, imageId, "OIDC running image identity mismatch");
  assertPortBindings(container);
}
let cleanupOptions;
function must(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 240000, ...options, ...(cleanupOptions?.() ?? {}) });
  if (result.error || result.status !== 0) throw new Error(`OIDC conformance operation failed: ${command} (exit ${result.status ?? "unavailable"}); credential-bearing output suppressed`);
  return result.stdout.trim();
}
async function freePort() {
  return new Promise((done, reject) => { const server = createServer(); server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const address = server.address(); server.close(() => address && typeof address === "object" ? done(address.port) : reject(new Error("Loopback port unavailable"))); }); });
}
export async function main(args = process.argv.slice(2), hosted = null) {
  if (args.length) throw new Error("Usage: node tests/postgres/runOidcIdentityConformance.mjs");
  if (process.versions.node.split(".")[0] !== "24" || must("npm", ["--version"]) !== "11.19.0") throw new Error("OIDC conformance requires Node 24 and npm 11.19.0");
  must("docker", ["info"]); must("docker", ["compose", "version"]);
  const issuerImage = hosted ? null : JSON.parse(must("docker", ["image", "inspect", OIDC_IMAGE]))[0];
  if (issuerImage) assertOidcImage(issuerImage);
  let tls;
  if (hosted) {
    assert.equal(hosted.target, "hosted-oidc"); assert.equal(hosted.disposable, true);
    assert.equal(hosted.issuerImage, OIDC_IMAGE);
    const origin = new URL(hosted.issuerOrigin); assert.equal(origin.protocol, "https:");
    tls = await new Promise((done, reject) => {
      const socket = connect({ host: origin.hostname, port: Number(origin.port || 443), servername: origin.hostname,
        rejectUnauthorized: true }, () => {
        if (!socket.authorized) { socket.destroy(); reject(new Error("public_tls_required")); return; }
        const observation = { status: "PASS", ordinaryTrustStore: true, hostnameVerified: true,
          protocol: socket.getProtocol(), leafSha256: socket.getPeerCertificate().fingerprint256 };
        socket.end(); done(observation);
      });
      socket.setTimeout(10000, () => socket.destroy(new Error("public_tls_timeout")));
      socket.once("error", () => reject(new Error("public_tls_refused")));
    });
  }
  const databaseImage = JSON.parse(must("docker", ["image", "inspect", "postgres:16"]))[0];
  assert(databaseImage.Config?.Env?.includes("PG_MAJOR=16"), "OIDC conformance requires cached PostgreSQL 16");
  const compose = readFileSync("docker-compose.identity-oidc.yml", "utf8");
  assert(compose.includes(`image: ${OIDC_IMAGE}\n`), "OIDC compose image pin mismatch");
  // Load the complete graph before provisioning; missing dependencies refuse rather than skip.
  const { register } = await import("tsx/esm/api"); register();
  const { runOidcIdentityConformance } = await import("./oidcIdentity.conformance.ts");
  const { chromium } = await import("@playwright/test");
  const probe = await chromium.launch({ headless: true }); await probe.close();
  const runId = randomUUID(), project = `openlup-oidc-${runId}`;
  const directory = mkdtempSync(join(tmpdir(), "openlup-oidc-")); chmodSync(directory, 0o700);
  const port = await freePort(), adminPassword = randomBytes(24).toString("hex"), databasePassword = randomBytes(24).toString("hex");
  const envFile = join(directory, "compose.env");
  writeFileSync(envFile, `OIDC_PORT=${port}\nOIDC_ADMIN_PASSWORD=${adminPassword}\nOIDC_DATABASE_PASSWORD=${databasePassword}\nOIDC_RUN_ID=${runId}\n`, { mode: 0o600 });
  const composeArgs = ["compose", "--project-name", project, "--env-file", envFile, "-f", resolve("docker-compose.identity-oidc.yml")];
  const ids = () => must("docker", ["ps", "-aq", "--filter", `label=com.docker.compose.project=${project}`]).split("\n").filter(Boolean);
  const inspect = id => JSON.parse(must("docker", ["inspect", id]))[0];
  const owned = () => ids().map(id => {
    const container = inspect(id); const service = container.Config?.Labels?.["com.docker.compose.service"];
    assert((hosted ? ["database"] : ["issuer", "database"]).includes(service), "OIDC project contains an unexpected service");
    assertOidcOwned(container, runId, project, service === "issuer" ? issuerImage.Id : databaseImage.Id);
    return container;
  });
  let started = false;
  const cleanup = ownedStackCleanup(options => {
    cleanupOptions = options;
    try {
    if (started) {
      owned();
      // Compose can leave only its labelled network after partial startup; refuse foreign networks/volumes.
      const networks = must("docker", ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]).split("\n").filter(Boolean);
      for (const id of networks) {
        const network = JSON.parse(must("docker", ["network", "inspect", id]))[0];
        assert.equal(network.Labels?.["com.docker.compose.project"], project);
        assert.equal(network.Labels?.["com.openlup.oidc.run"], runId);
        assert(Object.values(network.Containers ?? {}).every(value => ids().some(id => id === value.Name || inspect(id).Name === `/${value.Name}`)), "OIDC network has an unowned endpoint");
      }
      assert.equal(must("docker", ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]), "", "OIDC recipe must not own durable volumes");
      must("docker", [...composeArgs, "down", "--volumes", "--timeout", "10"]);
    }
    rmSync(directory, { recursive: true });
    } finally { cleanupOptions = undefined; }
  });
  let result;
  try {
    assert.equal(ids().length, 0, "OIDC project must be new");
    for (const kind of ["network", "volume"]) assert.equal(must("docker", [kind, "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]), "", "OIDC project resources already exist");
    started = true;
    await cleanup.start("docker", [...composeArgs, "up", "--detach", "--pull", "never", ...(hosted ? ["database"] : [])]);
    const containers = owned(); assert.equal(containers.length, hosted ? 1 : 2, "OIDC conformance requires its owned services");
    const issuer = containers.find(container => container.Config.Labels["com.docker.compose.service"] === "issuer");
    if (!hosted) {
      const issuerBindings = issuer.NetworkSettings.Ports["8080/tcp"];
      assert.equal(issuerBindings.length, 1); assert.equal(issuerBindings[0].HostIp, "127.0.0.1"); assert.equal(issuerBindings[0].HostPort, String(port));
    }
    const database = containers.find(container => container.Config.Labels["com.docker.compose.service"] === "database");
    const bindings = database.NetworkSettings.Ports["5432/tcp"];
    assert.equal(bindings.length, 1); assert.equal(bindings[0].HostIp, "127.0.0.1");
    result = await runOidcIdentityConformance({ issuerOrigin: hosted?.issuerOrigin ?? `http://127.0.0.1:${port}`,
      adminPassword: hosted?.adminPassword ?? adminPassword, hosted: Boolean(hosted),
      directory, runId, database: `postgresql://postgres:${databasePassword}@127.0.0.1:${bindings[0].HostPort}/postgres`, assertOwned: owned });
    console.log("OIDC real-issuer conformance: passed");
  } finally {
    await cleanup.finish();
  }
  assert.equal(ids().length, 0, "OIDC containers remain after teardown");
  for (const kind of ["network", "volume"]) assert.equal(must("docker", [kind, "ls", "-q", "--filter", `label=com.docker.compose.project=${project}`]), "", "OIDC resources remain after teardown");
  return { ...result, image: OIDC_IMAGE, imageId: issuerImage?.Id ?? null, ...(tls ? { tls } : {}),
    cleanup: { status: "PASS", containersAbsent: true, networksAbsent: true, volumesAbsent: true,
      ...(hosted ? { realmsAbsent: true, operatorIssuerAndTlsTeardown: "recorded separately by operator" } : {}) } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => {
  if (error instanceof Error && /^OIDC conformance failed at stage: [a-z_]+$/.test(error.message)) console.error(error.message);
  console.error("OIDC conformance failed or a prerequisite is unavailable; credential-bearing details suppressed. Verify pinned cached images, Docker Compose, Node/npm, installed browser and package builds. Cleanup refusal retains the private run directory."); process.exitCode = 1;
});
