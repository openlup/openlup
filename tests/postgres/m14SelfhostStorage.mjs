// Compose the existing plain-Node S3 witness against the compose-pinned local gateway.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tsImport } from "tsx/esm/api";
import { STORAGE_SCRIPT } from "../../server/adapters/s3/objectStorageConformanceScript.mjs";

export async function runSelfhostStorage(root) {
  const started = performance.now();
  const { reservePort } = await tsImport("../helpers/postgresContainer.ts", import.meta.url);
  const docker = args => execFileSync("docker", args, { cwd: root, encoding: "utf8", timeout: 30000,
    stdio: ["ignore", "pipe", "pipe"] }).trim();
  const service = readFileSync(`${root}/docker-compose.yml`, "utf8").split("\n  object-storage:\n")[1];
  const image = /(?:^|\n) {4}image: (\S+)\n/u.exec(service)?.[1]; assert(image);
  const imageInfo = JSON.parse(docker(["image", "inspect", image]))[0];
  assert(imageInfo.RepoDigests.includes(`versity/versitygw@${image.split("@")[1]}`));
  const owner = randomUUID(), name = `recipe-s3-${owner}`, label = "openlup.recipe-storage.owner";
  const port = await reservePort(), endpoint = `http://127.0.0.1:${port}`;
  const access = randomBytes(12).toString("hex"), secret = randomBytes(24).toString("hex");
  const otherAccess = randomBytes(12).toString("hex"), otherSecret = randomBytes(24).toString("hex");
  let id;
  const owned = () => {
    const value = JSON.parse(docker(["inspect", name]))[0];
    if (id) assert.equal(value.Id, id);
    assert.equal(value.Config.Labels[label], owner); assert.equal(value.Image, imageInfo.Id);
    return value;
  };
  const run = step => {
    try { return JSON.parse(execFileSync(process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", STORAGE_SCRIPT, endpoint, "objects", access, secret, step, otherAccess, otherSecret],
      { cwd: root, env: {}, encoding: "utf8", timeout: 60000, stdio: ["ignore", "pipe", "pipe"] }));
    } catch (error) {
      const directory = `${root}/.context/scratch/selfhost-receipt`; mkdirSync(directory, { recursive: true, mode: 0o700 });
      let diagnostic = String(error.stderr ?? "");
      for (const value of [access, secret, otherAccess, otherSecret]) diagnostic = diagnostic.replaceAll(value, "[redacted]");
      writeFileSync(`${directory}/storage-step-refusal.log`, diagnostic, { mode: 0o600 });
      throw new Error(`local_storage_step_failed:${step}`);
    }
  };
  let facts;
  let attempted = false;
  try {
    assert.equal(docker(["ps", "--all", "--quiet", "--filter", `name=^/${name}$`]), "");
    attempted = true;
    id = docker(["run", "--detach", "--pull=never", "--name", name, "--label", `${label}=${owner}`,
      "--publish", `127.0.0.1:${port}:7070`, "--read-only", "--tmpfs", "/data", "--tmpfs", "/iam", "--tmpfs", "/versions", "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges:true", image, "--access", access, "--secret", secret, "--iam-dir", "/iam", "posix", "--versioning-dir", "/versions", "/data"]);
    assert.deepEqual(owned().NetworkSettings.Ports["7070/tcp"], [{ HostIp: "127.0.0.1", HostPort: String(port) }]);
    assert.equal(run("bucket").created, true);
    owned();
    docker(["exec", name, "/app/versitygw", "admin", "--access", access, "--secret", secret,
      "--endpoint-url", "http://127.0.0.1:7070", "create-user", "--access", otherAccess, "--secret", otherSecret, "--role", "userplus"]);
    const roundtrip = run("roundtrip");
    assert.deepEqual(roundtrip.readiness, { ok: true }); assert.equal(roundtrip.read, "conformance object bytes");
    assert.equal(roundtrip.contentType, "text/plain"); assert.equal(roundtrip.existsAfterUpload, true);
    assert.deepEqual(roundtrip.listAfterUpload, ["docs/report.txt"]); assert.equal(roundtrip.existsAfterDelete, false);
    assert.deepEqual(roundtrip.listAfterDelete, []);
    const refusal = run("refusal");
    assert.deepEqual(refusal, { anonymousOk: false, anonymousLeaks: false, wrongSecretStatus: 403, intruderExists: false });
    const transfer = run("transfer");
    assert.deepEqual(transfer.resume, { copied: 0, replayed: 1, verifiedKeys: ["transfer/retained.txt"] });
    assert.equal(transfer.readback, "retained source bytes"); assert.equal(transfer.anonymousLeaks, false);
    assert.equal(transfer.contentVersionRefusal, "version_conflict"); assert.equal(transfer.byteLimitRefusal, "invalid_input");
    const crossUser = run("cross-user");
    assert.deepEqual(crossUser, { otherOwnRead: "other-user own bytes", crossUserStatus: 403, ownerRead: "owner-only bytes" });
    const privacy = run("privacy-restore");
    assert.equal(privacy.erasedLiveStatus, 404); assert.equal(privacy.olderBackupStillHasErasedBytes, true);
    assert.deepEqual(privacy.restoredKeys, ["retained.txt"]); assert.equal(privacy.erasedRestoreRefusal, "absent");
    assert.equal(privacy.retainedReadback, "older snapshot retained.txt");
    const features = run("features");
    assert.equal(features.nativeVersions, "PASS");
    assert.equal(features.previousVersion, "first"); assert.equal(features.deletedLatest, true);
    facts = { status: "PASS", claim: "local self-host recipe receipt", image, imageId: imageInfo.Id,
      authenticatedReadback: true, anonymousDenied: true, wrongCredentialDenied: true, deletionAbsent: true,
      contentVersionRefused: true, byteLimitRefused: true, privateTargetCopyResume: transfer.resume,
      crossUser, privacyRestore: privacy, nativeVersions: features,
      limits: ["two real gateway accounts; no claim that gateway IAM is customer-principal RLS",
        "local gateway observations do not prove hosted bucket policy or elapsed lifecycle expiration",
        "host supplies the later erasure obligation and allowed inventory before private filesystem publication; copier adds no automatic privacy policy"], hostedQualification: false };
  } finally {
    if (attempted) {
      const found = docker(["ps", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${name}$`]);
      if (found) { owned(); docker(["rm", "--force", "--volumes", found]); }
      assert.equal(docker(["ps", "--all", "--quiet", "--filter", `name=^/${name}$`]), "");
    }
  }
  return { ...facts, wallSeconds: (performance.now() - started) / 1000, actions: { witnessSteps: 7, validGatewayAccounts: 2 },
    cleanup: { status: "PASS", containerAbsent: true, storage: "container tmpfs removed" } };
}
