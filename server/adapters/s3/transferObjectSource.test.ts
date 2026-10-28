import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import { createS3TransferObjectSource } from "./transferObjectSource.js";

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
