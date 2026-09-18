// S3-compatible adapter for the platform-runtime BlobStoragePort (Platform Portability, W5).
//
// Targets any S3-compatible object store (AWS S3, MinIO, R2, Spaces) used by a self-hosted
// node-postgres bundle. To stay credential-free in CI and avoid pulling a new SDK dependency
// into this wave, it depends on a minimal STRUCTURAL client interface (PutObject/HeadObject/
// DeleteObject/ListObjectsV2). A thin factory over `@aws-sdk/client-s3` satisfies this shape;
// tests inject a fake. URLs are derived from a configurable public base (CDN or path-style).

import type { BlobStoragePort } from "../../../src/domains/platform-runtime/ports.js";

export interface S3ObjectClient {
  putObject(input: {
    Bucket: string;
    Key: string;
    Body: Uint8Array | Buffer;
    ContentType?: string;
  }): Promise<unknown>;
  headObject(input: { Bucket: string; Key: string }): Promise<unknown>;
  deleteObject(input: { Bucket: string; Key: string }): Promise<unknown>;
  listObjectsV2(input: {
    Bucket: string;
    Prefix?: string;
  }): Promise<{ Contents?: Array<{ Key?: string }> }>;
}

export interface S3BlobOptions {
  bucket: string;
  /** Public base URL for objects, e.g. https://cdn.example.com or https://s3.region.amazonaws.com/bucket. */
  baseUrl: string;
  defaultContentType?: string;
}

export function createS3BlobStorage(client: S3ObjectClient, options: S3BlobOptions): BlobStoragePort {
  const bucket = options.bucket;
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const defaultContentType = options.defaultContentType ?? "application/octet-stream";

  return {
    urlFor(key: string): string {
      return `${baseUrl}/${normalizeKey(key)}`;
    },

    async upload(key, data, opts) {
      const objectKey = normalizeKey(key);
      await client.putObject({
        Bucket: bucket,
        Key: objectKey,
        Body: data,
        ContentType: opts?.contentType ?? defaultContentType,
      });
      return { url: this.urlFor(objectKey), pathname: objectKey };
    },

    async exists(key) {
      try {
        await client.headObject({ Bucket: bucket, Key: normalizeKey(key) });
        return true;
      } catch {
        return false;
      }
    },

    async delete(keyOrUrl) {
      await client.deleteObject({ Bucket: bucket, Key: stripBaseUrl(keyOrUrl, baseUrl) });
    },

    async list(prefix) {
      const result = await client.listObjectsV2({
        Bucket: bucket,
        Prefix: prefix ? normalizeKey(prefix) : undefined,
      });
      const keys = (result.Contents ?? [])
        .map((entry) => entry.Key)
        .filter((key): key is string => typeof key === "string")
        .sort();
      return { keys };
    },
  };
}

function normalizeKey(key: string): string {
  return key.replace(/^\/+/, "");
}

function stripBaseUrl(keyOrUrl: string, baseUrl: string): string {
  return keyOrUrl.startsWith(`${baseUrl}/`) ? normalizeKey(keyOrUrl.slice(baseUrl.length + 1)) : normalizeKey(keyOrUrl);
}
