import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createS3TransferObjectSource } from "./transferObjectSource.js";
import type { S3SourceReferenceSnapshot } from "./transferObjectSource.js";

type Command = { constructor: { name: string }; input: Record<string, unknown> };
// Protocol doubles expose command input only; the separate plain-Node SDK
// witness below exercises real constructors, signing and deserialization.
const commands = { GetObjectCommand: class GetObjectCommand { constructor(readonly input: Record<string, unknown>) {} },
  ListObjectsV2Command: class ListObjectsV2Command { constructor(readonly input: Record<string, unknown>) {} } };
const sourceWithCommands = (input: Parameters<typeof createS3TransferObjectSource>[0]) => createS3TransferObjectSource(input, () => commands as unknown as ReturnType<NonNullable<Parameters<typeof createS3TransferObjectSource>[1]>>);
const limits = { maximumObjectBytes: 1024, maximumTotalBytes: 4096, maximumFiles: 10, maximumPages: 4 };
const output = (value = "abc", metadata: Record<string, string> = {}, fields: Record<string, unknown> = {}) => ({
  $metadata: {}, Body: Readable.from([Buffer.from(value)]), ContentLength: Buffer.byteLength(value), Metadata: metadata, ...fields,
});
const page = (keys: string[], next?: string) => ({ $metadata: {}, IsTruncated: next !== undefined,
  KeyCount: keys.length, Contents: keys.map(Key => ({ Key, Size: 3, ETag: '"opaque-not-a-hash"' })),
  ...(next === undefined ? {} : { NextContinuationToken: next }),
});
function fixture(handler: (command: Command) => unknown = () => output()) {
  const send = vi.fn(); send.mockImplementation(async (command: Command) => handler(command));
  const source = sourceWithCommands({ client: { send }, bucket: "owned-fixture", ...limits });
  return { source, send };
}
async function bytes(read: Awaited<ReturnType<ReturnType<typeof fixture>["source"]["read"]>>): Promise<string> {
  const chunks: Uint8Array[] = []; for await (const chunk of read.body) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}

it("does no request until explicitly used, follows every terminal page and rechecks the observed namespace", async () => {
  const f = fixture(command => command.constructor.name === "GetObjectCommand" ? output()
    : command.input.ContinuationToken === undefined ? page(["z", "ą"], "next-page") : page(["a"]));
  expect(f.send).not.toHaveBeenCalled();
  const census = await f.source.capture();
  expect(census.pages).toEqual({ before: 2, after: 2 });
  expect(census.objects.map(object => object.key)).toEqual(["a", "z", "ą"]);
  expect(census.objects.every(object => object.access === "authenticated-source-read")).toBe(true);
  expect(census).not.toHaveProperty("complete");
  const lists = f.send.mock.calls.map(([command]) => command).filter(command => command.constructor.name === "ListObjectsV2Command");
  expect(lists.map(command => command.input)).toEqual([
    { Bucket: "owned-fixture", MaxKeys: 10 }, { Bucket: "owned-fixture", MaxKeys: 10, ContinuationToken: "next-page" },
    { Bucket: "owned-fixture", MaxKeys: 10 }, { Bucket: "owned-fixture", MaxKeys: 10, ContinuationToken: "next-page" },
  ]);
  expect(f.send).toHaveBeenCalledTimes(7);
});

it("reads through the actual SDK deserializer and signing with explicit synthetic credentials and an injected HTTP handler", async () => {
  const script = String.raw`
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import assert from "node:assert/strict";
import { createS3TransferObjectSource } from "./server/adapters/s3/transferObjectSource.ts";
const { S3Client } = createRequire(import.meta.url)("@aws-sdk/client-s3");
const requests = [];
const client = new S3Client({ region: "us-east-1", endpoint: "http://127.0.0.1:9", forcePathStyle: true,
  credentials: { accessKeyId: "synthetic-source", secretAccessKey: "synthetic-source-only" },
  requestHandler: { async handle(request) {
    requests.push({ method: request.method, hostname: request.hostname, path: request.path, authenticated: typeof request.headers.authorization === "string" });
    return { response: { statusCode: 200, headers: { "content-length": "3", "content-type": "text/plain", "x-amz-meta-original": "kept", etag: '"opaque"' }, body: Readable.from([Buffer.from("abc")]) } };
  } },
});
try {
  const source = createS3TransferObjectSource({ client, bucket: "owned-fixture", maximumObjectBytes:1024, maximumTotalBytes:4096, maximumFiles:10, maximumPages:4 });
  assert.deepEqual(requests, []);
  const read = await source.read("key with space");
  assert.deepEqual(read.object.metadata, { "s3.content-type": "text/plain", "s3.user.original": "kept" });
  const chunks = []; for await (const chunk of read.body) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), "abc");
  assert.deepEqual(requests, [{ method:"GET", hostname:"127.0.0.1", path:"/owned-fixture/key%20with%20space", authenticated:true }]);
  process.stdout.write(JSON.stringify({ read:true, authenticated:true, requests:requests.length }));
} finally { client.destroy(); }
`;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
    cwd: process.cwd(), env: {}, timeout: 15000, maxBuffer: 1024 * 1024,
  });
  expect(JSON.parse(stdout)).toEqual({ read: true, authenticated: true, requests: 1 });
});

it("binds exact returned metadata and content, ignores ETag as a version and owns the captured body", async () => {
  let metadata = { Case: "żółć", empty: "" }, fields: Record<string, unknown> = {
    ContentType: "", CacheControl: "max-age=7", ExpiresString: "Wed, 21 Oct 2037 07:28:00 GMT", WebsiteRedirectLocation: "/original", ETag: "first",
  };
  const f = fixture(() => output("abc", metadata, fields));
  const original = await f.source.read("key with space");
  expect(original.object.sha256).toBe(createHash("sha256").update("abc").digest("hex"));
  expect(original.object.metadata).toEqual({ "s3.content-type": "", "s3.cache-control": "max-age=7",
    "s3.expires-string": "Wed, 21 Oct 2037 07:28:00 GMT", "s3.website-redirect-location": "/original", "s3.user.Case": "żółć", "s3.user.empty": "" });
  fields = { ...fields, ETag: "different" };
  expect((await f.source.read("key with space", original.object.version)).object.version).toBe(original.object.version);
  fields = { ...fields, WebsiteRedirectLocation: "/changed" };
  await expect(f.source.read("key with space", original.object.version)).rejects.toMatchObject({ code: "version_conflict" });
  metadata = { ...metadata, Case: "changed" };
  await expect(f.source.read("key with space", original.object.version)).rejects.toMatchObject({ code: "version_conflict" });
  expect(await bytes(original)).toBe("abc");
  const absentMetadata = fixture(() => output("abc", {}));
  expect((await absentMetadata.source.read("key")).object.metadata).toEqual({});
});

it.each([
  ["NoSuchKey", 404, "absent"], ["NoSuchKey", 500, "unavailable"], ["NoSuchBucket", 404, "unavailable"], ["NotFound", 404, "unavailable"],
  ["AccessDenied", 403, "denied"], ["Unauthorized", 401, "denied"], ["SignatureDoesNotMatch", 403, "denied"], ["InternalError", 500, "unavailable"],
  ["AbortError", undefined, "unavailable"], ["PreconditionFailed", 412, "version_conflict"], ["ChecksumMismatch", undefined, "integrity_conflict"],
])("classifies %s without exposing source error details", async (name, status, code) => {
  const f = fixture(() => { throw Object.assign(new Error("untrusted provider detail"), { name, $metadata: { httpStatusCode: status } }); });
  await expect(f.source.read("key")).rejects.toMatchObject({ code, message: `object_transfer_${code}` });
  if (status === 404) await expect(f.source.capture()).rejects.toMatchObject({ code: "unavailable" });
});

it("refuses truncated/oversize bodies and closes responses on metadata or tag refusal", async () => {
  const f = fixture(() => output("abc", {}, { ContentLength: 4 }));
  await expect(f.source.read("key")).rejects.toMatchObject({ code: "integrity_conflict" });
  const excess = fixture(() => output("abc", {}, { ContentLength: 2 }));
  await expect(excess.source.read("key")).rejects.toMatchObject({ code: "integrity_conflict" });
  const tagged = output("abc", {}, { TagCount: 1 }), tooLarge = output("abc", { huge: "x".repeat(8193) });
  await expect(fixture(() => tagged).source.read("key")).rejects.toMatchObject({ code: "invalid_input" });
  await expect(fixture(() => tooLarge).source.read("key")).rejects.toMatchObject({ code: "invalid_input" });
  expect(tagged.Body.destroyed).toBe(true); expect(tooLarge.Body.destroyed).toBe(true);
  await expect(fixture(() => output("abc", {}, { MissingMeta: 1 })).source.read("key")).rejects.toMatchObject({ code: "integrity_conflict" });
});

it.each([
  { IsTruncated: true, Contents: [] },
  { ...page(["same"]), Contents: [{ Key: "same", Size: 3 }, { Key: "same", Size: 3 }], KeyCount: 2 },
  { ...page([]), CommonPrefixes: [{ Prefix: "hidden/" }] },
  { ...page([]), IsTruncated: undefined },
  { ...page([]), NextContinuationToken: "unexpected-terminal-token" },
])("refuses malformed or filtered pagination rather than claiming a complete namespace: %j", async response => {
  const f = fixture(() => response);
  await expect(f.source.capture()).rejects.toMatchObject({ name: "ObjectTransferError" });
  expect(f.send.mock.calls.every(([command]) => command.constructor.name === "ListObjectsV2Command")).toBe(true);
});

it("bounds cursor cycles, page count and total bytes before fetching objects", async () => {
  const repeated = fixture(() => page([], "same-cursor"));
  await expect(repeated.source.capture()).rejects.toMatchObject({ code: "integrity_conflict" });
  expect(repeated.send).toHaveBeenCalledTimes(2);
  let cursor = 0;
  const endless = fixture(() => page([], `cursor-${++cursor}`));
  await expect(endless.source.capture()).rejects.toMatchObject({ code: "invalid_input" });
  expect(endless.send).toHaveBeenCalledTimes(limits.maximumPages);
  const send = vi.fn().mockImplementation(async () => ({ ...page(["a", "b", "c", "d", "e"]), Contents: ["a", "b", "c", "d", "e"].map(Key => ({ Key, Size: 1024 })) }));
  await expect(sourceWithCommands({ client: { send }, bucket: "owned-fixture", ...limits }).capture()).rejects.toMatchObject({ code: "invalid_input" });
  expect(send).toHaveBeenCalledTimes(1);
});

it("refuses changed listing facts and list/GET byte disagreement", async () => {
  let lists = 0;
  const changed = fixture(command => command.constructor.name === "GetObjectCommand" ? output() : page([++lists === 1 ? "a" : "b"]));
  await expect(changed.source.capture()).rejects.toMatchObject({ code: "version_conflict" });
  const mismatch = fixture(command => command.constructor.name === "GetObjectCommand" ? output("ab") : page(["a"]));
  await expect(mismatch.source.capture()).rejects.toMatchObject({ code: "version_conflict" });
});

it("refuses a pre-aborted operation before issuing any request", async () => {
  const controller = new AbortController(); controller.abort();
  const send = vi.fn();
  const source = sourceWithCommands({ client: { send }, bucket: "owned-fixture", ...limits, signal: controller.signal });
  await expect(source.capture()).rejects.toMatchObject({ code: "unavailable" });
  await expect(source.read("key")).rejects.toMatchObject({ code: "unavailable" });
  expect(send).not.toHaveBeenCalled();
});

it("cancels an interrupted body without returning a partial descriptor", async () => {
  const controller = new AbortController();
  const body = Readable.from((async function* () { yield Buffer.from("a"); controller.abort(); yield Buffer.from("b"); })());
  const send = vi.fn().mockResolvedValue({ $metadata: {}, Body: body, ContentLength: 2 });
  const source = sourceWithCommands({ client: { send }, bucket: "owned-fixture", ...limits, signal: controller.signal });
  await expect(source.read("key")).rejects.toMatchObject({ code: "unavailable" });
  expect(body.destroyed).toBe(true);
});

it("reports only observed empty terminal pages for an accessible empty view", async () => {
  const f = fixture(() => page([]));
  expect(await f.source.capture()).toEqual({ bucket: "owned-fixture", pages: { before: 1, after: 1 }, objects: [] });
  expect(f.send).toHaveBeenCalledTimes(2);
});

it("qualifies only an independent stable reference snapshot with exact bytes and metadata", async () => {
  const f = fixture(command => command.constructor.name === "GetObjectCommand"
    ? output("abc", { owner: "retained" }) : page(["known"]));
  const observed = await f.source.read("known");
  const reference: S3SourceReferenceSnapshot = { bucket: "owned-fixture", snapshotId: "source-snapshot-1",
    features: { nativeVersionHistory: "none", objectTags: "none", multipartUploads: "none" }, objects: [observed.object], obligations: [
    { kind: "cleanup", key: "known", sourceRecordId: "media-1" },
    { kind: "pending-upload", key: "not-materialized-yet", sourceRecordId: "media-2" },
  ] };
  expect(await f.source.captureAgainstReferences(async () => reference)).toMatchObject({
    referenceSnapshotId: "source-snapshot-1", obligations: reference.obligations,
  });
  await expect(f.source.captureAgainstReferences(async () => ({ ...reference, features: undefined as never })))
    .rejects.toMatchObject({ code: "invalid_input" });
  await expect(f.source.captureAgainstReferences(async () => ({ ...reference, bucket: "another-bucket" })))
    .rejects.toMatchObject({ code: "invalid_input" });
  await expect(f.source.captureAgainstReferences(async () => ({ ...reference, objects: [
    ...reference.objects, { ...observed.object, key: "filtered" },
  ] }))).rejects.toMatchObject({ code: "integrity_conflict" });
  await expect(f.source.captureAgainstReferences(async () => ({ ...reference, objects: [] })))
    .rejects.toMatchObject({ code: "integrity_conflict" });
  await expect(f.source.captureAgainstReferences(async () => ({ ...reference, objects: [
    { ...observed.object, sha256: "0".repeat(64) },
  ] }))).rejects.toMatchObject({ code: "integrity_conflict" });
  await expect(f.source.captureAgainstReferences(async () => ({ ...reference, objects: [
    { ...observed.object, metadata: { "s3.user.owner": "other" } },
  ] }))).rejects.toMatchObject({ code: "integrity_conflict" });
});

it("refuses source-reference drift and unexplained physical objects", async () => {
  const f = fixture(command => command.constructor.name === "GetObjectCommand" ? output() : page(["known", "extra"]));
  const object = (await f.source.read("known")).object;
  let reads = 0;
  await expect(f.source.captureAgainstReferences(async () => ({ bucket: "owned-fixture", snapshotId: `snapshot-${++reads}`,
    features: { nativeVersionHistory: "none", objectTags: "none", multipartUploads: "none" }, objects: [object], obligations: [] })))
    .rejects.toMatchObject({ code: "version_conflict" });
  await expect(f.source.captureAgainstReferences(async () => ({ bucket: "owned-fixture", snapshotId: "stable",
    features: { nativeVersionHistory: "none", objectTags: "none", multipartUploads: "none" }, objects: [object], obligations: [] })))
    .rejects.toMatchObject({ code: "integrity_conflict" });
});

it("refuses a native versioned source instead of silently omitting older versions", async () => {
  const f = fixture(command => command.constructor.name === "GetObjectCommand"
    ? output("abc", {}, { VersionId: "v2" }) : page(["known"]));
  const object = (await f.source.read("known")).object;
  expect(object.metadata["s3.version-id"]).toBe("v2");
  await expect(f.source.captureAgainstReferences(async () => ({ bucket: "owned-fixture", snapshotId: "versioned",
    features: { nativeVersionHistory: "none", objectTags: "none", multipartUploads: "none" }, objects: [object], obligations: [] })))
    .rejects.toMatchObject({ code: "invalid_input" });
});

it("admits only a stable single current native version within the selected prefix and binds its GET version", async () => {
  const sdk = { ...commands, ListObjectVersionsCommand: class ListObjectVersionsCommand { constructor(readonly input: Record<string, unknown>) {} } };
  const history = { IsTruncated: false, Versions: [{ Key: "owned/a", VersionId: "native-1", IsLatest: true }] };
  const send = vi.fn(async (command: Command) => command.constructor.name === "GetObjectCommand" ? output("abc", {}, { VersionId: "native-1" })
    : command.constructor.name === "ListObjectVersionsCommand" ? history : page(["owned/a"]));
  const source = createS3TransferObjectSource({ client: { send }, bucket: "owned-fixture", prefix: "owned/",
    nativeVersionAdmission: "single-current", ...limits }, () => sdk as never);
  const descriptor = (await source.read("owned/a")).object;
  const reference: S3SourceReferenceSnapshot = { bucket: "owned-fixture", snapshotId: "independent-source-record",
    features: { nativeVersionHistory: "single-current", objectTags: "none", multipartUploads: "none" }, objects: [descriptor], obligations: [] };
  expect((await source.captureAgainstReferences(async () => reference)).objects).toEqual([descriptor]);
  expect(send.mock.calls.every(([command]) => command.constructor.name === "GetObjectCommand"
    ? command.input.Key === "owned/a" : command.input.Prefix === "owned/")).toBe(true);
  await expect(source.read("other/a")).rejects.toMatchObject({ code: "invalid_input" });
  const calls = send.mock.calls.length;
  await expect(source.captureAgainstReferences(async () => ({ ...reference,
    objects: [{ ...descriptor, key: "other/a" }] }))).rejects.toMatchObject({ code: "invalid_input" });
  for (const kind of ["pending-upload", "cleanup"] as const) {
    await expect(source.captureAgainstReferences(async () => ({ ...reference,
      obligations: [{ kind, key: "other/a", sourceRecordId: "synthetic-duty" }] })))
      .rejects.toMatchObject({ code: "invalid_input" });
  }
  expect(send).toHaveBeenCalledTimes(calls);
  history.Versions[0]!.VersionId = "other-version";
  await expect(source.captureAgainstReferences(async () => reference)).rejects.toMatchObject({ code: "version_conflict" });
});

it.each([
  { IsTruncated: false, Versions: [{ Key: "owned/a", VersionId: "old", IsLatest: false }] },
  { IsTruncated: false, Versions: [{ Key: "owned/a", VersionId: "null", IsLatest: true }] },
  { IsTruncated: false, DeleteMarkers: [{ Key: "owned/a", VersionId: "marker", IsLatest: true }] },
  { IsTruncated: false, Versions: [{ Key: "other/a", VersionId: "v", IsLatest: true }] },
  { IsTruncated: false, Versions: [{ Key: "owned/a", VersionId: "v", IsLatest: true }, { Key: "owned/a", VersionId: "v2", IsLatest: true }] },
  { IsTruncated: true, Versions: [], NextKeyMarker: "owned/a" },
])("refuses unsupported or incomplete native history before reading object bodies: %j", async history => {
  const sdk = { ...commands, ListObjectVersionsCommand: class ListObjectVersionsCommand { constructor(readonly input: Record<string, unknown>) {} } };
  const send = vi.fn(async () => history);
  const source = createS3TransferObjectSource({ client: { send }, bucket: "owned-fixture", prefix: "owned/",
    nativeVersionAdmission: "single-current", ...limits }, () => sdk as never);
  await expect(source.captureAgainstReferences(async () => ({ bucket: "owned-fixture", snapshotId: "empty",
    features: { nativeVersionHistory: "single-current", objectTags: "none", multipartUploads: "none" }, objects: [], obligations: [] })))
    .rejects.toHaveProperty("code");
  expect(send.mock.calls).toHaveLength(1);
});

it("follows native history's paired cursors and refuses repeated pages, missing GET keys and changed history", async () => {
  const sdk = { ...commands, ListObjectVersionsCommand: class ListObjectVersionsCommand { constructor(readonly input: Record<string, unknown>) {} } };
  let mode = "valid", historyCalls = 0;
  const send = vi.fn(async (command: Command) => {
    if (command.constructor.name === "GetObjectCommand") return output("abc", {}, { VersionId: "v1" });
    if (command.constructor.name === "ListObjectsV2Command") return page(["owned/a"]);
    historyCalls++;
    if (mode === "missing") return { IsTruncated: false, Versions: [] };
    if (mode === "changed" && historyCalls > 2) return { IsTruncated: false, Versions: [] };
    if (!command.input.KeyMarker || mode === "repeat") return { IsTruncated: true,
      NextKeyMarker: "owned/a", NextVersionIdMarker: "v1", Versions: [] };
    return { IsTruncated: false, Versions: [{ Key: "owned/a", VersionId: "v1", IsLatest: true }] };
  });
  const source = createS3TransferObjectSource({ client: { send }, bucket: "owned-fixture", prefix: "owned/",
    nativeVersionAdmission: "single-current", ...limits }, () => sdk as never);
  const descriptor = (await source.read("owned/a")).object;
  const refs = async (): Promise<S3SourceReferenceSnapshot> => ({ bucket: "owned-fixture", snapshotId: "record",
    features: { nativeVersionHistory: "single-current", objectTags: "none", multipartUploads: "none" }, objects: [descriptor], obligations: [] });
  await expect(source.captureAgainstReferences(refs)).resolves.toHaveProperty("referenceSnapshotId", "record");
  for (const next of ["repeat", "missing", "changed"]) {
    mode = next; historyCalls = 0;
    await expect(source.captureAgainstReferences(refs)).rejects.toHaveProperty("code");
  }
});
