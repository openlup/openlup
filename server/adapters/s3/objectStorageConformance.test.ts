// The s3 blob capability against the reference compose's local S3-compatible service, on real
// Docker: the package's default client uploads, reads back, lists and deletes through the composed
// blob port, and the service refuses an anonymous read and a wrong secret. Hosted S3 provider
// certification is not claimed here.
//
// The storage steps run in a plain Node process with Node's default export conditions, the way an
// installed application loads the optional AWS SDK; the test runner's own resolution conditions
// would select the SDK's bundler build instead.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { dockerAvailable, reservePort } from "../../../tests/helpers/postgresContainer.js";

import { STORAGE_SCRIPT as SCRIPT } from "./objectStorageConformanceScript.mjs";

import { disposableLabelArgs } from "../../../scripts/disposable-docker.mjs";

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONTAINER = `object-storage-conformance-${process.pid}`;
const ACCESS_KEY = "conformanceaccess";
const SECRET_KEY = "conformancesecret0000";
const BUCKET = "objects";

let endpoint = "";
let ready = false;
let infrastructureAvailable = false;
let attempted = false;

/** The object-storage image the reference compose pins, so this proof follows the compose file. */
function composeStorageImage(): string {
  const compose = readFileSync(new URL("docker-compose.yml", `file://${ROOT}`), "utf8");
  const service = compose.slice(compose.indexOf("\n  object-storage:\n"));
  const image = /\n {4}image: (\S+)\n/.exec(service)?.[1];
  if (!image) throw new Error("docker-compose.yml declares no object-storage image");
  return image;
}


async function runStep(step: string): Promise<Record<string, unknown>> {
  const { stdout } = await exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SCRIPT, endpoint, BUCKET, ACCESS_KEY, SECRET_KEY, step], {
    // An empty environment: no ambient credentials or loader options reach the storage steps.
    cwd: ROOT, env: {}, timeout: 60_000,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

beforeAll(async () => {
  infrastructureAvailable = await dockerAvailable();
  if (!infrastructureAvailable) return;
  const port = await reservePort();
  endpoint = `http://127.0.0.1:${port}`;
  attempted = true;
  await exec("docker", [
    "run", ...disposableLabelArgs(), "-d", "--rm", "--name", CONTAINER, "-p", `127.0.0.1:${port}:7070`,
    "--read-only", "--tmpfs", "/data", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    composeStorageImage(), "--access", ACCESS_KEY, "--secret", SECRET_KEY, "posix", "/data",
  ], { timeout: 30_000, killSignal: "SIGKILL" });
  ready = (await runStep("bucket")).created === true;
}, 180_000);

afterAll(async () => {
  if (!attempted) return;
  await exec("docker", ["rm", "-f", CONTAINER], { timeout: 30_000, killSignal: "SIGKILL" }).catch(() => {});
});

function requireStorage(ctx: { skip: (note?: string) => void }, available: boolean, initialized: boolean): void {
  if (!available) return ctx.skip("Docker unavailable on this machine");
  if (!initialized) throw new Error("Object-storage bucket initialization exhausted its retries");
}

describe("object storage setup outcome", () => {
  it("skips only when infrastructure is unavailable", () => {
    const skip = vi.fn();
    requireStorage({ skip }, false, false);
    expect(skip).toHaveBeenCalledExactlyOnceWith("Docker unavailable on this machine");
  });

  it("fails after initialization retries are exhausted with infrastructure available", () => {
    const skip = vi.fn();
    expect(() => requireStorage({ skip }, true, false)).toThrow("Object-storage bucket initialization exhausted its retries");
    expect(skip).not.toHaveBeenCalled();
  });

  it("continues after successful initialization", () => {
    const skip = vi.fn();
    requireStorage({ skip }, true, true);
    expect(skip).not.toHaveBeenCalled();
  });
});

describe("s3 blob capability on the reference object storage", () => {
  it("is ready, then uploads, reads back, lists and deletes through the composed blob port", async (ctx) => {
    requireStorage(ctx, infrastructureAvailable, ready);
    expect(await runStep("roundtrip")).toEqual({
      readiness: { ok: true },
      upload: { url: `${endpoint}/${BUCKET}/docs/report.txt`, pathname: "docs/report.txt" },
      read: "conformance object bytes",
      contentType: "text/plain",
      existsAfterUpload: true,
      listAfterUpload: ["docs/report.txt"],
      existsAfterDelete: false,
      listAfterDelete: [],
    });
  }, 120_000);

  it("refuses an anonymous read and a wrong secret", async (ctx) => {
    requireStorage(ctx, infrastructureAvailable, ready);
    expect(await runStep("refusal")).toEqual({
      anonymousOk: false, anonymousLeaks: false, wrongSecretStatus: 403, intruderExists: false,
    });
  }, 120_000);

  it("reconciles a source-owned record and resumes S3 to an inactive private filesystem generation", async (ctx) => {
    requireStorage(ctx, infrastructureAvailable, ready);
    const result = await runStep("transfer");
    expect(result).toMatchObject({
      resume: { copied: 0, replayed: 1, verifiedKeys: ["transfer/retained.txt"] },
      readback: "retained source bytes", referenceSnapshotId: "source-owned-record", anonymousLeaks: false,
      contentVersionRefusal: "version_conflict", byteLimitRefusal: "invalid_input",
    });
    expect([400, 401, 403, 404]).toContain(result.anonymousStatus);
  }, 120_000);
});
