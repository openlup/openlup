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

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONTAINER = `object-storage-conformance-${process.pid}`;
const ACCESS_KEY = "conformanceaccess";
const SECRET_KEY = "conformancesecret0000";
const BUCKET = "objects";

let endpoint = "";
let ready = false;
let infrastructureAvailable = false;

/** The object-storage image the reference compose pins, so this proof follows the compose file. */
function composeStorageImage(): string {
  const compose = readFileSync(new URL("docker-compose.yml", `file://${ROOT}`), "utf8");
  const service = compose.slice(compose.indexOf("\n  object-storage:\n"));
  const image = /\n {4}image: (\S+)\n/.exec(service)?.[1];
  if (!image) throw new Error("docker-compose.yml declares no object-storage image");
  return image;
}

const SCRIPT = String.raw`
import { createRequire } from "node:module";
import { createBundleComposer } from "@openlup/platform/composition";
import { getBundleDescriptor } from "@openlup/platform/kernel";
const sdk = createRequire(import.meta.url)("@aws-sdk/client-s3");
const [endpoint, bucket, access, secret, step] = process.argv.slice(1);
const client = (key) => new sdk.S3Client({ region: "us-east-1", endpoint, forcePathStyle: true, credentials: { accessKeyId: access, secretAccessKey: key } });
const env = {
  PLATFORM_BUNDLE: "node-postgres", PLATFORM_BLOB: "s3", BLOB_S3_BUCKET: bucket, BLOB_S3_BASE_URL: endpoint + "/" + bucket,
  BLOB_S3_ENDPOINT: endpoint, BLOB_S3_FORCE_PATH_STYLE: "true", BLOB_S3_ACCESS_KEY_ID: access, BLOB_S3_SECRET_ACCESS_KEY: secret,
};
const blob = createBundleComposer()(env).ports.blob;
const out = {};
if (step === "bucket") {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { await client(secret).send(new sdk.CreateBucketCommand({ Bucket: bucket })); out.created = true; break; }
    catch (error) { if (error.name === "BucketAlreadyOwnedByYou") { out.created = true; break; } await new Promise((r) => setTimeout(r, 500)); }
  }
} else if (step === "roundtrip") {
  out.readiness = getBundleDescriptor("node-postgres").readReadiness({ ...env, APP_BASE_URL: "https://example.test", CRON_SECRET: "cron-secret", DATABASE_URL: "postgres://localhost/lock" });
  out.upload = await blob.upload("docs/report.txt", Buffer.from("conformance object bytes"), { contentType: "text/plain" });
  const stored = await client(secret).send(new sdk.GetObjectCommand({ Bucket: bucket, Key: "docs/report.txt" }));
  out.read = Buffer.from(await stored.Body.transformToByteArray()).toString("utf8");
  out.contentType = stored.ContentType;
  out.existsAfterUpload = await blob.exists("docs/report.txt");
  out.listAfterUpload = (await blob.list("docs/")).keys;
  await blob.delete(blob.urlFor("docs/report.txt"));
  out.existsAfterDelete = await blob.exists("docs/report.txt");
  out.listAfterDelete = (await blob.list("docs/")).keys;
} else if (step === "refusal") {
  await blob.upload("private/secret.txt", Buffer.from("not public"));
  const anonymous = await fetch(blob.urlFor("private/secret.txt"));
  out.anonymousOk = anonymous.ok;
  out.anonymousLeaks = (await anonymous.text()).includes("not public");
  try { await client("wrongsecret00000000").send(new sdk.PutObjectCommand({ Bucket: bucket, Key: "intruder.txt", Body: Buffer.from("x") })); out.wrongSecretStatus = 200; }
  catch (error) { out.wrongSecretStatus = error.$metadata?.httpStatusCode; }
  out.intruderExists = await blob.exists("intruder.txt");
}
process.stdout.write(JSON.stringify(out));
`;

async function runStep(step: string): Promise<Record<string, unknown>> {
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", SCRIPT, endpoint, BUCKET, ACCESS_KEY, SECRET_KEY, step], {
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
  await exec("docker", [
    "run", "--pull=never", "-d", "--rm", "--name", CONTAINER, "-p", `127.0.0.1:${port}:7070`,
    "--read-only", "--tmpfs", "/data", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    composeStorageImage(), "--access", ACCESS_KEY, "--secret", SECRET_KEY, "posix", "/data",
  ]);
  ready = (await runStep("bucket")).created === true;
}, 180_000);

afterAll(async () => {
  await exec("docker", ["rm", "-f", CONTAINER]).catch(() => {});
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
});
