import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import type { GetObjectCommandOutput, S3Client } from "@aws-sdk/client-s3";
import { ObjectTransferError, type TransferObject, type TransferObjectReader } from "@openlup/platform/portability";

const access = "authenticated-source-read";
type Commands = Pick<typeof import("@aws-sdk/client-s3"), "GetObjectCommand" | "ListObjectsV2Command">;
type Listing = { key: string; bytes: number; etag?: string; modified?: string };
export interface S3TransferObjectCensus {
  bucket: string;
  pages: { before: number; after: number };
  objects: TransferObject[];
}

/**
 * Explicitly selected server source, never an SDK/client/credential factory.
 * Imports/construction perform no requests or default credential discovery.
 * The host must supply its selected authenticated client, full-namespace read
 * authority and held writer exclusion. Terminal pagination observes only what
 * that principal can see; it does not certify namespace completeness or access.
 *
 * Logical versions bind captured bytes and returned metadata, not ETag, native
 * version history or If-Match. The fixed access label means authenticated GET
 * succeeded, not private/public policy, ACL, RLS or domain authorization.
 * Tags, ACLs, native versions and provider-private metadata are not exported;
 * missing independent policy facts cannot qualify them through omission.
 */
export function createS3TransferObjectSource(input: {
  client: Pick<S3Client, "send">;
  bucket: string;
  maximumObjectBytes: number;
  maximumTotalBytes: number;
  maximumFiles: number;
  maximumPages: number;
  signal?: AbortSignal;
}, loadCommands: () => Commands = () => createRequire(import.meta.url)("@aws-sdk/client-s3")): TransferObjectReader & { capture(): Promise<S3TransferObjectCensus> } {
  const { client, bucket, maximumObjectBytes, maximumTotalBytes, maximumFiles, maximumPages, signal } = input;
  if (!client || typeof client.send !== "function" || !text(bucket, 256)
    || !ceiling(maximumObjectBytes, 20 * 1024 * 1024) || !ceiling(maximumTotalBytes, 64 * 1024 * 1024)
    || !ceiling(maximumFiles, 10000) || !ceiling(maximumPages, 100)) throw new ObjectTransferError("invalid_input");
  // Loading the optional SDK also waits for an explicitly selected operation.
  const sdk = loadCommands;
  const reader: TransferObjectReader = {
    async read(key, expectedVersion) {
      if (!keyText(key) || expectedVersion !== undefined && !/^sha256:[a-f0-9]{64}$/.test(expectedVersion)) throw new ObjectTransferError("invalid_input");
      try {
        signal?.throwIfAborted();
        const response = await client.send(new (sdk().GetObjectCommand)({ Bucket: bucket, Key: key }), { abortSignal: signal });
        const body = response.Body;
        try {
          if (!Number.isSafeInteger(response.ContentLength) || response.ContentLength! < 0
            || response.ContentLength! > maximumObjectBytes) throw new ObjectTransferError("invalid_input");
          if (response.ContentRange !== undefined || response.DeleteMarker === true) throw new ObjectTransferError("integrity_conflict");
          // An observed tag dependency is unsupported, never silently discarded.
          if (response.TagCount !== undefined && response.TagCount !== 0) throw new ObjectTransferError("invalid_input");
          if (response.MissingMeta !== undefined && response.MissingMeta !== 0) throw new ObjectTransferError("integrity_conflict");
          const metadata = capturedMetadata(response);
          if (!body || !(Symbol.asyncIterator in body)) throw new ObjectTransferError("integrity_conflict");
          const hash = createHash("sha256"), chunks: Buffer[] = [];
          let bytes = 0;
          for await (const value of body) {
            signal?.throwIfAborted();
            if (!(value instanceof Uint8Array)) throw new ObjectTransferError("integrity_conflict");
            bytes += value.byteLength;
            if (bytes > maximumObjectBytes || bytes > response.ContentLength!) throw new ObjectTransferError("integrity_conflict");
            const chunk = Buffer.from(value); hash.update(chunk); chunks.push(chunk);
          }
          signal?.throwIfAborted();
          if (bytes !== response.ContentLength) throw new ObjectTransferError("integrity_conflict");
          const sha256 = hash.digest("hex");
          const version = `sha256:${digest(JSON.stringify({ sha256, bytes, metadata }))}`;
          if (expectedVersion !== undefined && expectedVersion !== version) throw new ObjectTransferError("version_conflict");
          return { object: { key, version, bytes, sha256, metadata, access },
            body: (async function* () { for (const chunk of chunks) yield Buffer.from(chunk); })() };
        } finally {
          // Close an unconsumed Node response too, including metadata refusals.
          if (body && "destroy" in body && typeof body.destroy === "function") body.destroy();
        }
      } catch (error) { throw failure(error, "object"); }
    },
  };
  async function list(): Promise<{ entries: Listing[]; pages: number }> {
    const entries = new Map<string, Listing>(), cursors = new Set<string>();
    let cursor: string | undefined, pages = 0, bytes = 0;
    try {
      for (;;) {
        if (++pages > maximumPages) throw new ObjectTransferError("invalid_input");
        signal?.throwIfAborted();
        const response = await client.send(new (sdk().ListObjectsV2Command)({
          Bucket: bucket, MaxKeys: Math.min(1000, maximumFiles), ...(cursor === undefined ? {} : { ContinuationToken: cursor }),
        }), { abortSignal: signal });
        if (typeof response.IsTruncated !== "boolean" || response.CommonPrefixes?.length
          || response.Contents !== undefined && !Array.isArray(response.Contents)) throw new ObjectTransferError("integrity_conflict");
        const contents = response.Contents ?? [];
        if (contents.length > Math.min(1000, maximumFiles)
          || response.KeyCount !== undefined && response.KeyCount !== contents.length) throw new ObjectTransferError("integrity_conflict");
        for (const entry of contents) {
          if (!keyText(entry.Key) || !Number.isSafeInteger(entry.Size) || entry.Size! < 0
            || entry.Size! > maximumObjectBytes || entries.has(entry.Key)) throw new ObjectTransferError("invalid_input");
          bytes += entry.Size!;
          if (entries.size >= maximumFiles || !Number.isSafeInteger(bytes) || bytes > maximumTotalBytes) throw new ObjectTransferError("invalid_input");
          if (entry.ETag !== undefined && !text(entry.ETag, 1024)) throw new ObjectTransferError("integrity_conflict");
          entries.set(entry.Key, { key: entry.Key, bytes: entry.Size!,
            ...(entry.ETag === undefined ? {} : { etag: entry.ETag }),
            ...(entry.LastModified === undefined ? {} : { modified: date(entry.LastModified) }),
          });
        }
        if (!response.IsTruncated) {
          if (response.NextContinuationToken !== undefined) throw new ObjectTransferError("integrity_conflict");
          signal?.throwIfAborted();
          return { entries: [...entries.values()].sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0), pages };
        }
        if (!text(response.NextContinuationToken, 8192) || cursors.has(response.NextContinuationToken)) throw new ObjectTransferError("integrity_conflict");
        cursor = response.NextContinuationToken; cursors.add(cursor);
      }
    } catch (error) { throw failure(error, "bucket"); }
  }
  return { ...reader,
    async capture() {
      const before = await list(), objects: TransferObject[] = [];
      for (const entry of before.entries) {
        const read = await reader.read(entry.key);
        if (read.object.bytes !== entry.bytes) throw new ObjectTransferError("version_conflict");
        objects.push(read.object);
      }
      const after = await list();
      if (JSON.stringify(before.entries) !== JSON.stringify(after.entries)) throw new ObjectTransferError("version_conflict");
      return { bucket, pages: { before: before.pages, after: after.pages }, objects };
    },
  };
}

function capturedMetadata(response: GetObjectCommandOutput): Record<string, string> {
  const result: Record<string, string> = {};
  const fields = [
    ["ContentType", "s3.content-type"], ["ContentEncoding", "s3.content-encoding"],
    ["ContentDisposition", "s3.content-disposition"], ["ContentLanguage", "s3.content-language"],
    ["CacheControl", "s3.cache-control"], ["ExpiresString", "s3.expires-string"],
    ["WebsiteRedirectLocation", "s3.website-redirect-location"],
  ] as const;
  for (const [field, key] of fields) if (response[field] !== undefined) {
    if (typeof response[field] !== "string") throw new ObjectTransferError("integrity_conflict");
    result[key] = response[field]!;
  }
  if (response.Expires !== undefined) result["s3.expires-date"] = date(response.Expires);
  if (response.Metadata !== undefined) {
    if (!response.Metadata || typeof response.Metadata !== "object" || Array.isArray(response.Metadata)) throw new ObjectTransferError("integrity_conflict");
    for (const [key, value] of Object.entries(response.Metadata)) {
      if (!text(key, 1000) || typeof value !== "string") throw new ObjectTransferError("integrity_conflict");
      result[`s3.user.${key}`] = value;
    }
  }
  if (Object.values(result).some(value => Buffer.byteLength(value) > 8192)
    || Buffer.byteLength(JSON.stringify(result)) > 65536) throw new ObjectTransferError("invalid_input");
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
}
function failure(error: unknown, scope: "object" | "bucket"): ObjectTransferError {
  if (error instanceof ObjectTransferError) return error;
  const value = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } } | undefined;
  const status = value?.$metadata?.httpStatusCode;
  if (status === 401 || status === 403 || value?.name === "AccessDenied" || value?.name === "InvalidAccessKeyId"
    || value?.name === "SignatureDoesNotMatch") return new ObjectTransferError("denied");
  if (status === 412 || value?.name === "PreconditionFailed") return new ObjectTransferError("version_conflict");
  if (value?.name === "NoSuchBucket") return new ObjectTransferError("unavailable");
  // An ambiguous 404/NotFound can also mean a missing/invisible bucket. Only
  // the source's explicit key-absence response establishes this classification.
  if (scope === "object" && value?.name === "NoSuchKey" && status === 404) return new ObjectTransferError("absent");
  if (value?.name === "ChecksumMismatch" || value?.name === "InvalidDigest") return new ObjectTransferError("integrity_conflict");
  return new ObjectTransferError("unavailable");
}
function date(value: Date): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new ObjectTransferError("integrity_conflict");
  return value.toISOString();
}
function text(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.from(value, "utf8").toString("utf8") === value && Buffer.byteLength(value) <= maximum
    && !Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function keyText(value: unknown): value is string { return text(value, 1024); }
function ceiling(value: number, maximum: number): boolean { return Number.isSafeInteger(value) && value >= 1 && value <= maximum; }
function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
