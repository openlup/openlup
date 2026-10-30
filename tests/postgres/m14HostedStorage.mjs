// Hosted composition of the existing blob/source/copy and serving boundaries.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, open, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { tsImport } from "tsx/esm/api";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand, ListObjectVersionsCommand,
  GetBucketLifecycleConfigurationCommand, GetBucketVersioningCommand } from "@aws-sdk/client-s3";
import { createS3BlobStorage, createS3ClientFromEnv } from "@openlup/platform/blob";
import { copyTransferObjects, createFilesystemTransferObjects } from "@openlup/platform/portability";

const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const limits = { maximumObjectBytes: 1024, maximumTotalBytes: 4096, maximumFiles: 10, maximumPages: 4 };
export function lifecycleRule(rules, prefix) {
  return rules.some(rule => rule.Status === "Enabled" && rule.NoncurrentVersionExpiration?.NoncurrentDays === 1
    && rule.NoncurrentVersionExpiration.NewerNoncurrentVersions === undefined
    && (!rule.Filter || Object.keys(rule.Filter).every(key => key === "Prefix")) && prefix.startsWith(rule.Filter?.Prefix ?? rule.Prefix ?? ""));
}
export async function versions(client, bucket, prefix) {
  const entries = [], cursors = new Set();
  let KeyMarker, VersionIdMarker;
  for (let page = 0; page < 10; page++) {
    const value = await client.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: prefix,
      MaxKeys: 100, KeyMarker, VersionIdMarker }));
    assert.equal(typeof value.IsTruncated, "boolean");
    for (const [kind, rows] of [["version", value.Versions ?? []], ["marker", value.DeleteMarkers ?? []]]) {
      for (const item of rows) {
        assert(item.Key.startsWith(prefix) && item.VersionId);
        entries.push({ kind, key: item.Key, id: item.VersionId, latest: item.IsLatest, modified: item.LastModified });
        assert(entries.length <= 1000);
      }
    }
    if (!value.IsTruncated) return entries;
    assert(value.NextKeyMarker && value.NextVersionIdMarker);
    const cursor = JSON.stringify([value.NextKeyMarker, value.NextVersionIdMarker]);
    assert(!cursors.has(cursor)); cursors.add(cursor);
    KeyMarker = value.NextKeyMarker; VersionIdMarker = value.NextVersionIdMarker;
  }
  throw new Error("hosted_version_page_limit");
}
async function cleanup(client, bucket, prefix) {
  for (const entry of await versions(client, bucket, prefix)) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: entry.key, VersionId: entry.id }));
  }
  const after = await versions(client, bucket, prefix);
  assert.deepEqual(after, []);
  return { status: "PASS", versions: 0, deleteMarkers: 0 };
}
export async function lifecycle(client, config) {
  const { bucket, prefix, lifecycleStatePath } = config;
  // These are private continuity inputs, not an admitted prior PASS receipt.
  let file;
  try { file = await open(lifecycleStatePath, constants.O_RDWR | constants.O_NOFOLLOW); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    file = await open(lifecycleStatePath, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      assert.deepEqual(await versions(client, bucket, prefix), []);
      const objects = [];
      for (const suffix of ["overwritten", "deleted"]) {
        const key = prefix + "lifecycle/" + suffix;
        const first = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "old" }));
        const second = await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: "current" }));
        assert(first.VersionId && second.VersionId && first.VersionId !== second.VersionId);
        const entry = { key, noncurrentVersionId: first.VersionId, currentVersionId: second.VersionId };
        if (suffix === "deleted") {
          const marker = await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
          assert(marker.VersionId); entry.deleteMarkerVersionId = marker.VersionId;
        }
        objects.push(entry);
      }
      const start = new Date();
      await file.write(JSON.stringify({ schemaVersion: 1, prefix, objects, clockStart: start.toISOString(),
        nextChecks: [26, 50].map(hours => new Date(start.getTime() + hours * 3600000).toISOString()) }), 0, "utf8");
    } catch (error) { await file.close(); throw error; }
  }
  try {
  const stat = await file.stat();
  assert(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= 128 * 1024);
  const input = Buffer.alloc(stat.size);
  assert.equal((await file.read(input, 0, stat.size, 0)).bytesRead, stat.size);
  const state = JSON.parse(input.toString("utf8"));
  assert.equal(state.schemaVersion, 1); assert.equal(state.prefix, prefix);
  assert.equal(state.objects.length, 2);
  const rows = await versions(client, bucket, prefix + "lifecycle/");
  const expected = [], latestSeedTimes = [];
  for (const entry of state.objects) {
    assert(entry.key.startsWith(prefix + "lifecycle/") && !expected.includes(entry.noncurrentVersionId));
    expected.push(entry.noncurrentVersionId);
    if (entry.deleteMarkerVersionId) expected.push(entry.currentVersionId);
    const surviving = rows.find(row => row.id === (entry.deleteMarkerVersionId ?? entry.currentVersionId) && row.key === entry.key);
    assert(surviving?.latest);
    latestSeedTimes.push(new Date(surviving.modified).getTime());
  }
  assert.equal(new Set(expected).size, 3);
  // Surviving provider timestamps bound the elapsed clock on every resume,
  // including after the old versions have expired.
  const latestSeed = Math.max(...latestSeedTimes);
  assert(Number.isFinite(latestSeed) && Date.parse(state.clockStart) >= latestSeed);
  const now = new Date();
  if (!state.admittedAt) {
    for (const id of expected) assert(rows.some(row => row.id === id && !row.latest));
    state.admittedAt = now.toISOString();
  }
  assert(Date.parse(state.clockStart) <= Date.parse(state.admittedAt));
  const ageHours = (now.getTime() - Date.parse(state.clockStart)) / 3600000;
  assert(Number.isFinite(ageHours) && ageHours >= 0);
  const remaining = rows.filter(row => row.kind === "version" && !row.latest);
  const observed = ageHours >= 24 && remaining.length === 0;
  if (observed) {
    for (const entry of state.objects) for (const id of [entry.noncurrentVersionId,
      ...(entry.deleteMarkerVersionId ? [entry.currentVersionId] : [])]) {
      await assert.rejects(async () => {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: entry.key, VersionId: id }));
        response.Body?.destroy();
      }, error => error.name === "NoSuchVersion" && error.$metadata?.httpStatusCode === 404);
    }
  }
  state.observations ??= [];
  state.observations.push({ at: now.toISOString(), ageHours, noncurrentVersions: remaining.length });
  state.status = observed ? "PASS" : "PENDING-OBSERVATION";
  await file.truncate(0);
  await file.write(JSON.stringify(state, null, 2) + "\n", 0, "utf8");
  await file.sync();
  return { status: state.status, ruleReadback: "PASS", clockStart: state.clockStart,
    seededNoncurrentVersions: 3, observedNoncurrentVersions: remaining.length, ageHours,
    nextCheckUtc: state.nextChecks.find(time => Date.parse(time) > now.getTime()) ?? null,
    observations: state.observations };
  } finally { await file.close(); }
}

// Exercise the actual customer serving handler; fixture grants are independent
// host facts, not an IAM-user/account claim or an installed database binding.
async function serving(read, bytes) {
  const { createOrderReviewMediaBffHandler } = await tsImport("../../server/bff/order-review/media.ts", import.meta.url);
  const mediaRef = "order-review-media:123e4567-e89b-12d3-a456-426614174000";
  const owner = "review-grant:123e4567-e89b-12d3-a456-426614174001";
  const other = "review-grant:123e4567-e89b-12d3-a456-426614174002";
  const handler = createOrderReviewMediaBffHandler(async () => ({ authorizeCustomerMedia: async (grant, ref) =>
    grant === owner && ref === mediaRef ? { media: { state: "confirmed", observedContentType: "text/plain",
      observedByteLength: bytes.length, observedDigest: sha(bytes) }, open: async () => (await read()).body } : null }),
  { PLATFORM_BUNDLE: "node-postgres" });
  const statuses = [];
  for (const token of [owner, undefined, other]) {
    const chunks = [], headers = new Map(); let status = 0;
    const res = Object.assign(new EventEmitter(), { status(code) { status = code; return res; },
      setHeader(k, v) { headers.set(k.toLowerCase(), v); return res; },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      json(value) { chunks.push(Buffer.from(JSON.stringify(value))); return res; }, end() {}, destroy(error) { throw error; } });
    await handler({ method: "GET", headers: token ? { authorization: `Bearer ${token}` } : {}, query: { mediaRef } }, res);
    if (token === owner) { assert.equal(status, 200); assert.deepEqual(Buffer.concat(chunks), bytes);
      assert.equal(headers.get("content-type"), "text/plain"); assert.equal(headers.get("cache-control"), "private, no-store"); }
    else { assert.equal(status, 404); assert(!Buffer.concat(chunks).includes(bytes)); }
    statuses.push(status);
  }
  return { authorized: statuses[0], anonymous: statuses[1], crossUser: statuses[2], boundary: "real customer BFF handler; synthetic host grant resolver" };
}

export async function runHostedStorage(config, workDirectory) {
  const start = performance.now(); let actions = 0, blobActions = 0;
  const client = new S3Client({ region: config.region, maxAttempts: 1 });
  const send = client.send.bind(client); client.send = (...args) => { actions++; return send(...args); };
  const { bucket, prefix } = config, functional = prefix + "functional/";
  const { createS3TransferObjectSource } = await tsImport("../../server/adapters/s3/transferObjectSource.ts", import.meta.url);
  const source = (sub, extra = {}) => createS3TransferObjectSource({ client, bucket, prefix: functional + sub,
    nativeVersionAdmission: "single-current", ...limits, ...extra });
  const blobSdk = createS3ClientFromEnv({ BLOB_S3_REGION: config.region });
  const countedBlob = Object.fromEntries(Object.entries(blobSdk).map(([name, operation]) => [name, (...args) => {
    blobActions++; return operation(...args);
  }]));
  const blob = createS3BlobStorage(countedBlob,
    { bucket, baseUrl: `https://${bucket}.s3.${config.region}.amazonaws.com` });
  const bytes = Buffer.from("hosted conformance object bytes");
  let result, cleaned, directory, functionalAdmitted = false;
  try {
    const rule = await client.send(new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
    assert(lifecycleRule(rule.Rules ?? [], prefix));
    const ruleReadAt = new Date().toISOString();
    assert.equal((await client.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status, "Enabled");
    const clock = await lifecycle(client, config);
    clock.rule = { status: "PASS", noncurrentExpirationDays: 1, applicableToOwnedPrefix: true, readAt: ruleReadAt };
    assert.deepEqual(await versions(client, bucket, functional), []);
    functionalAdmitted = true;
    await mkdir(workDirectory, { recursive: true, mode: 0o700 });
    directory = await mkdtemp(join(workDirectory, "m14-10o-private-"));
    const key = functional + "serving/retained.txt";
    await blob.upload(key, bytes, { contentType: "text/plain" });
    assert.equal(await blob.exists(key), true);
    assert.deepEqual((await blob.list(functional + "serving/")).keys, [key]);
    const read = () => source("serving/").read(key);
    const served = await serving(read, bytes);
    const anonymous = await fetch(blob.urlFor(key), { signal: AbortSignal.timeout(15000) });
    assert.equal(anonymous.status, 403); assert(!(await anonymous.text()).includes(bytes.toString()));
    await assert.rejects(source("serving/", { maximumObjectBytes: 1 }).read(key), { code: "invalid_input" });
    const actual = (await read()).object;
    const reference = objects => ({ bucket, snapshotId: "independent-synthetic-source-records",
      features: { nativeVersionHistory: "single-current", objectTags: "none", multipartUploads: "none" }, objects, obligations: [] });
    const expected = { ...actual, metadata: { ...actual.metadata, "s3.content-type": "image/png" } };
    await assert.rejects(source("serving/").captureAgainstReferences(async () => reference([expected])), { code: "integrity_conflict" });
    await source("serving/").captureAgainstReferences(async () => reference([actual]));
    await blob.upload(key, Buffer.from("second"), { contentType: "text/plain" });
    const historical = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: actual.metadata["s3.version-id"] }));
    assert.equal(await historical.Body.transformToString(), bytes.toString());
    await assert.rejects(source("serving/").captureAgainstReferences(async () => reference([actual])), { code: "invalid_input" });
    await blob.delete(blob.urlFor(key)); assert.equal(await blob.exists(key), false);
    await assert.rejects(read(), { code: "absent" });
    const afterDelete = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: actual.metadata["s3.version-id"] }));
    assert.equal(await afterDelete.Body.transformToString(), bytes.toString());
    await assert.rejects(source("serving/").captureAgainstReferences(async () => reference([])), { code: "invalid_input" });
    // Independent retained source records bind the bytes and each returned version.
    const snapshot = [];
    for (const name of ["retained.txt", "erased.txt"]) {
      const objectKey = functional + "backup/" + name, value = Buffer.from("older snapshot " + name);
      const put = await client.send(new PutObjectCommand({ Bucket: bucket, Key: objectKey, Body: value, ContentType: "text/plain" }));
      const metadata = { "s3.content-type": "text/plain", "s3.version-id": put.VersionId };
      const sha256 = sha(value), version = "sha256:" + sha(JSON.stringify({ sha256, bytes: value.length, metadata }));
      snapshot.push({ key: objectKey, metadata, sha256, version, bytes: value.length });
      await blob.upload(functional + "live/" + name, value, { contentType: "text/plain" });
    }
    const erased = functional + "live/erased.txt";
    await blob.delete(erased); await assert.rejects(source("live/").read(erased), { code: "absent" });
    const backup = source("backup/");
    const census = await backup.captureAgainstReferences(async () => reference(snapshot));
    const kept = census.objects.filter(object => object.key.endsWith("/retained.txt"));
    const destination = await createFilesystemTransferObjects({ root: join(directory, "inactive"), maximumObjectBytes: 1024, access: "private-target" });
    const transfer = { source: backup, destination, inventory: { sourceId: "hosted-s3-snapshot",
      snapshot: { kind: "quiesced", id: "before-erasure" }, objects: kept },
      accessMapping: { "authenticated-source-read": "private-target" }, maximumObjectBytes: 1024, maximumTotalBytes: 4096 };
    await assert.rejects(copyTransferObjects({ ...transfer, checkpoint: async () => { throw new Error("checkpoint_interruption"); } }), /checkpoint_interruption/u);
    const resumed = await copyTransferObjects(transfer); assert.equal(resumed.replayed, 1);
    await assert.rejects(destination.read(functional + "backup/erased.txt"), { code: "absent" });
    const retained = await serving(() => destination.read(kept[0].key), Buffer.from("older snapshot retained.txt"));
    result = { status: clock.status, claim: "hosted S3 recipe receipt (single synthetic bucket, one region)",
      target: "hosted S3", region: config.region, functional: { status: "PASS" }, lifecycle: clock, serving: served, anonymousBucketStatus: anonymous.status,
      byteLimitRefusal: "invalid_input", contentTypeConflictRefusal: "integrity_conflict",
      versions: { previousVersionRead: true, currentAbsentAfterAdapterDelete: true,
        priorVersionStillReadableAfterDelete: true, noncurrentAndDeleteMarkerAdmissionRefused: true },
      restore: { olderBackupContainsErasedBytes: true, erasedDestinationAbsent: true,
        retainedReadback: retained, copied: resumed.copied, replayed: resumed.replayed,
        boundary: "later host erasure excludes erased key before private filesystem publication; 8B copy and 9A erasure-before-serving semantics" },
      limits: ["one synthetic bucket and region; no production qualification or SLO", "instance-role authority, no IAM cross-account qualification",
        "customer BFF with synthetic host grants; no hosted database/RLS or issuer qualification",
        "blob port has no GET or presigner; authorized GET uses the existing transfer source",
        "blob upload delegates size/type admission to host; bounded source read and source-record content-type conflict refuse",
        "native delete marker hides current data; noncurrent data remains role-readable until lifecycle or explicit cleanup",
        "host owns writer exclusion and independent tag/multipart absence; no whole-store hosted RPO/RTO claim"] };
  } finally {
    try { if (functionalAdmitted) cleaned = await cleanup(client, bucket, result?.lifecycle.status === "PASS" ? prefix : functional); }
    finally { if (directory) await rm(directory, { recursive: true, force: true }); client.destroy(); }
  }
  return { ...result, effort: { wallSeconds: (performance.now() - start) / 1000, sdkActions: actions,
    blobActions, interventions: [], automaticWitnessRetries: 0, sdkRetryPolicy: "direct client maxAttempts=1; blob client uses SDK default", exclusions: ["provisioning, dependency installation, lifecycle wait"] },
    cleanup: { functional: cleaned, wholePrefix: result.lifecycle.status === "PASS" ? cleaned : { status: "PENDING-OBSERVATION", retainedKeys: 2 } } };
}
