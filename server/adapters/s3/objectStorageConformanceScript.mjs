// Shared plain-Node proof body; imported by the ordinary test and local recipe.
export const STORAGE_SCRIPT = String.raw`
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBundleComposer } from "@openlup/platform/composition";
import { getBundleDescriptor } from "@openlup/platform/kernel";
import { copyTransferObjects, createFilesystemTransferObjects } from "@openlup/platform/portability";
import { createS3TransferObjectSource } from "./server/adapters/s3/transferObjectSource.ts";
const sdk = createRequire(import.meta.url)("@aws-sdk/client-s3");
const [endpoint, bucket, access, secret, step, otherAccess, otherSecret] = process.argv.slice(1);
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
  await client(secret).send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: "private/secret.txt" }));
} else if (step === "transfer") {
  const key = "transfer/retained.txt", value = Buffer.from("retained source bytes");
  const sourceClient = client(secret);
  const metadata = { "s3.content-type": "text/plain", "s3.user.retained": "yes" };
  const sha256 = createHash("sha256").update(value).digest("hex");
  const version = "sha256:" + createHash("sha256").update(JSON.stringify({ sha256, bytes: value.length, metadata })).digest("hex");
  const root = await mkdtemp(join(await realpath(tmpdir()), "openlup-s3-transfer-"));
  try {
    await sourceClient.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: value,
      ContentType: "text/plain", Metadata: { retained: "yes" } }));
    const source = createS3TransferObjectSource({ client: sourceClient, bucket, maximumObjectBytes: 1024,
      maximumTotalBytes: 4096, maximumFiles: 10, maximumPages: 4 });
    const reference = { bucket, snapshotId: "source-owned-record", features: { nativeVersionHistory: "none", objectTags: "none", multipartUploads: "none" },
      objects: [{ key, version, bytes: value.length, sha256, metadata }], obligations: [] };
    const census = await source.captureAgainstReferences(async () => reference);
    try { await source.read(key, "sha256:" + "0".repeat(64)); out.contentVersionRefusal = false; }
    catch (error) { out.contentVersionRefusal = error.code; }
    const bounded = createS3TransferObjectSource({ client: sourceClient, bucket, maximumObjectBytes: 1,
      maximumTotalBytes: 4096, maximumFiles: 10, maximumPages: 4 });
    try { await bounded.read(key); out.byteLimitRefusal = false; }
    catch (error) { out.byteLimitRefusal = error.code; }
    const destination = await createFilesystemTransferObjects({ root: join(root, "inactive"),
      maximumObjectBytes: 1024, access: "private-target" });
    const transfer = { inventory: { sourceId: "versity-source", snapshot: { kind: "quiesced", id: reference.snapshotId }, objects: census.objects },
      source, destination, accessMapping: { "authenticated-source-read": "private-target" },
      maximumObjectBytes: 1024, maximumTotalBytes: 4096 };
    try { await copyTransferObjects({ ...transfer, checkpoint: async () => { throw new Error("interrupted checkpoint"); } }); }
    catch (error) { if (error.message !== "interrupted checkpoint") throw error; }
    out.resume = await copyTransferObjects(transfer);
    const retained = await destination.read(key);
    out.readback = Buffer.from(await (async () => { const chunks = []; for await (const chunk of retained.body) chunks.push(chunk); return Buffer.concat(chunks); })()).toString();
    out.referenceSnapshotId = census.referenceSnapshotId;
    const anonymous = await fetch(endpoint + "/" + bucket + "/" + key);
    out.anonymousStatus = anonymous.status;
    out.anonymousLeaks = (await anonymous.text()).includes(value.toString());
  } finally {
    await sourceClient.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
    sourceClient.destroy();
    await rm(root, { recursive: true, force: true });
  }
} else if (step === "cross-user") {
  const owner = client(secret), other = new sdk.S3Client({ region: "us-east-1", endpoint, forcePathStyle: true,
    credentials: { accessKeyId: otherAccess, secretAccessKey: otherSecret } });
  try {
    await owner.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: "private/owner.txt", Body: "owner-only bytes" }));
    await other.send(new sdk.CreateBucketCommand({ Bucket: "other-account" }));
    await other.send(new sdk.PutObjectCommand({ Bucket: "other-account", Key: "own.txt", Body: "other-user own bytes" }));
    const own = await other.send(new sdk.GetObjectCommand({ Bucket: "other-account", Key: "own.txt" }));
    out.otherOwnRead = await own.Body.transformToString();
    try { const response = await other.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: "private/owner.txt" })); await response.Body.transformToByteArray(); out.crossUserStatus = 200; }
    catch (error) { out.crossUserStatus = error.$metadata?.httpStatusCode; }
    const authorized = await owner.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: "private/owner.txt" }));
    out.ownerRead = await authorized.Body.transformToString();
    await other.send(new sdk.DeleteObjectCommand({ Bucket: "other-account", Key: "own.txt" }));
    await other.send(new sdk.DeleteBucketCommand({ Bucket: "other-account" }));
    await owner.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: "private/owner.txt" }));
  } finally { owner.destroy(); other.destroy(); }
} else if (step === "privacy-restore") {
  const selected = client(secret), backup = "older-backup";
  const root = await mkdtemp(join(await realpath(tmpdir()), "openlup-s3-private-restore-"));
  const entries = ["erased.txt", "retained.txt"].map(key => {
    const value = Buffer.from("older snapshot " + key), metadata = { "s3.content-type": "text/plain" };
    const sha256 = createHash("sha256").update(value).digest("hex");
    const version = "sha256:" + createHash("sha256").update(JSON.stringify({ sha256, bytes: value.length, metadata })).digest("hex");
    return { key, value, metadata, sha256, version };
  });
  try {
    await selected.send(new sdk.CreateBucketCommand({ Bucket: backup }));
    for (const entry of entries) for (const destination of [bucket, backup]) await selected.send(new sdk.PutObjectCommand({ Bucket: destination, Key: entry.key, Body: entry.value, ContentType: "text/plain" }));
    const earlierSnapshot = { bucket: backup, snapshotId: "before-erasure", features: { nativeVersionHistory: "none", objectTags: "none", multipartUploads: "none" },
      objects: entries.map(({ key, value, metadata, sha256, version }) => ({ key, bytes: value.length, metadata, sha256, version })), obligations: [] };
    // A later host-owned privacy obligation is independent of this older backup.
    const laterErasure = { key: "erased.txt", obligation: "erasure-after-snapshot" };
    await selected.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: laterErasure.key }));
    try { const response = await selected.send(new sdk.GetObjectCommand({ Bucket: bucket, Key: laterErasure.key })); await response.Body.transformToByteArray(); out.erasedLiveStatus = 200; }
    catch (error) { out.erasedLiveStatus = error.$metadata?.httpStatusCode; }
    const stale = await selected.send(new sdk.GetObjectCommand({ Bucket: backup, Key: laterErasure.key }));
    out.olderBackupStillHasErasedBytes = (await stale.Body.transformToString()) === "older snapshot erased.txt";
    const source = createS3TransferObjectSource({ client: selected, bucket: backup, maximumObjectBytes: 1024, maximumTotalBytes: 4096, maximumFiles: 10, maximumPages: 4 });
    const census = await source.captureAgainstReferences(async () => earlierSnapshot);
    const destination = await createFilesystemTransferObjects({ root: join(root, "inactive"), maximumObjectBytes: 1024, access: "private-target" });
    // Supply only the finite retained inventory allowed by the later obligation.
    // This is fixture/host composition, not an automatic privacy policy in the copier.
    const retained = census.objects.filter(object => object.key !== laterErasure.key);
    const restored = await copyTransferObjects({ source, destination,
      inventory: { sourceId: "older-s3-snapshot", snapshot: { kind: "quiesced", id: earlierSnapshot.snapshotId }, objects: retained },
      accessMapping: { "authenticated-source-read": "private-target" }, maximumObjectBytes: 1024, maximumTotalBytes: 4096 });
    out.restoredKeys = restored.verifiedKeys;
    try { await destination.read(laterErasure.key); out.erasedRestoreRefusal = false; }
    catch (error) { out.erasedRestoreRefusal = error.code; }
    const survivor = await destination.read("retained.txt");
    const chunks = []; for await (const chunk of survivor.body) chunks.push(chunk);
    out.retainedReadback = Buffer.concat(chunks).toString();
    out.erasureBoundary = "later host obligation excludes erased key before private target publication";
  } finally {
    for (const entry of entries) for (const destination of [bucket, backup]) await selected.send(new sdk.DeleteObjectCommand({ Bucket: destination, Key: entry.key }));
    await selected.send(new sdk.DeleteBucketCommand({ Bucket: backup }));
    selected.destroy(); await rm(root, { recursive: true, force: true });
  }
} else if (step === "features") {
  const selected = client(secret), versionsBucket = "versions";
  try {
    await selected.send(new sdk.CreateBucketCommand({ Bucket: versionsBucket }));
    try {
      await selected.send(new sdk.PutBucketVersioningCommand({ Bucket: versionsBucket, VersioningConfiguration: { Status: "Enabled" } }));
      const observed = await selected.send(new sdk.GetBucketVersioningCommand({ Bucket: versionsBucket }));
      if (observed.Status !== "Enabled") throw new Error("versioning acknowledgement without enabled readback");
      const first = await selected.send(new sdk.PutObjectCommand({ Bucket: versionsBucket, Key: "retained.txt", Body: "first" }));
      const second = await selected.send(new sdk.PutObjectCommand({ Bucket: versionsBucket, Key: "retained.txt", Body: "second" }));
      if (!first.VersionId || !second.VersionId || first.VersionId === second.VersionId) throw new Error("native version identity missing");
      const previous = await selected.send(new sdk.GetObjectCommand({ Bucket: versionsBucket, Key: "retained.txt", VersionId: first.VersionId }));
      out.previousVersion = await previous.Body.transformToString();
      await selected.send(new sdk.DeleteObjectCommand({ Bucket: versionsBucket, Key: "retained.txt" }));
      try { await selected.send(new sdk.GetObjectCommand({ Bucket: versionsBucket, Key: "retained.txt" })); out.deletedLatest = false; }
      catch (error) { if (error.$metadata?.httpStatusCode !== 404) throw error; out.deletedLatest = true; }
      const listing = await selected.send(new sdk.ListObjectVersionsCommand({ Bucket: versionsBucket }));
      for (const entry of [...(listing.Versions ?? []), ...(listing.DeleteMarkers ?? [])]) await selected.send(new sdk.DeleteObjectCommand({ Bucket: versionsBucket, Key: entry.Key, VersionId: entry.VersionId }));
      const empty = await selected.send(new sdk.ListObjectVersionsCommand({ Bucket: versionsBucket }));
      if (empty.Versions?.length || empty.DeleteMarkers?.length) throw new Error("native version cleanup failed");
      out.nativeVersions = "PASS";
    } catch (error) {
      if (![405,501].includes(error.$metadata?.httpStatusCode) && !["NotImplemented", "XNotImplemented"].includes(error.name)) throw error;
      out.nativeVersions = "UNSUPPORTED";
      out.nativeVersionRefusal = { name: error.name, status: error.$metadata?.httpStatusCode };
    }
    try { await selected.send(new sdk.GetBucketLifecycleConfigurationCommand({ Bucket: bucket })); out.lifecycle = "configuration readable; no elapsed expiration proof"; }
    catch (error) {
      if (![404,405,501].includes(error.$metadata?.httpStatusCode)) throw error;
      out.lifecycle = { name: error.name, status: error.$metadata?.httpStatusCode, expirationObserved: false };
    }
    await selected.send(new sdk.DeleteBucketCommand({ Bucket: versionsBucket }));
  } finally { selected.destroy(); }
}
process.stdout.write(JSON.stringify(out));
`;
