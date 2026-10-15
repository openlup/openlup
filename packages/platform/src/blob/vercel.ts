// Vercel Blob adapter for the platform-runtime BlobStoragePort.
//
// Wraps the CURRENT `@vercel/blob` behavior 1:1 so the default vercel-supabase bundle is
// byte-identical: public access, image content-type pass-through, no random suffix, the same
// 30-day cache-control, O(1) head() existence checks, and the deterministic public CDN URL
// derived from the store id encoded in BLOB_READ_WRITE_TOKEN. Operates on FULL keys
// (pathnames); any key prefix or suffix stays in the consuming facade.

import type { BlobStoragePort } from "@openlup/core/platform-runtime";

/**
 * The `@vercel/blob` functions this adapter calls, supplied by the application (pass the module
 * itself). The SDK reads its own credentials from the environment, as before.
 */
export interface VercelBlobSdk {
  put(
    pathname: string,
    body: Buffer,
    options: { access: "public"; contentType: string; addRandomSuffix: boolean; cacheControlMaxAge: number },
  ): Promise<{ url: string; pathname: string }>;
  head(url: string): Promise<{ url?: string } | null | undefined>;
  del(url: string): Promise<unknown>;
  list(options: { prefix?: string }): Promise<{ blobs: Array<{ pathname: string; url: string; uploadedAt: Date }> }>;
}

const DEFAULT_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days

export interface VercelBlobAdapterOptions {
  /** The `@vercel/blob` module. */
  sdk: VercelBlobSdk;
  /** Environment whose BLOB_READ_WRITE_TOKEN is read at each call when `token` is absent. */
  env: Record<string, string | undefined>;
  /**
   * Explicit token for deriving the public store URL (`urlFor`, `exists`); takes precedence over
   * `env`. Upload, list and delete use the credentials the injected SDK reads itself, so `env` and
   * `token` must name the same store as the SDK's own configuration.
   */
  token?: string;
  /** Default content-type when an upload omits one (image/png when absent). */
  defaultContentType?: string;
  cacheControlMaxAge?: number;
}

/** A listed blob plus the Vercel-specific metadata (uploadedAt) used by TTL cleanup. */
export interface VercelBlobEntry {
  pathname: string;
  url: string;
  uploadedAt: Date;
}

/**
 * Vercel-specific extension over the neutral BlobStoragePort.list(): also surfaces uploadedAt
 * so the TTL cron can prune by age. Not part of the port contract (other backends carry no
 * equivalent metadata); consumers needing it depend on this adapter shape explicitly.
 */
export interface VercelBlobStorage extends BlobStoragePort {
  listDetailed(prefix?: string): Promise<{ blobs: VercelBlobEntry[] }>;
}

/** Parse the public store id from a `vercel_blob_rw_{storeId}_{secret}` token. */
export function parseVercelStoreId(token: string | undefined): string {
  if (!token) throw new Error("BLOB_READ_WRITE_TOKEN missing");
  const m = token.match(/^vercel_blob_rw_([a-zA-Z0-9]+)_/);
  if (!m) throw new Error("invalid BLOB_READ_WRITE_TOKEN format");
  return m[1]!.toLowerCase();
}

export function createVercelBlobStorage(
  options: VercelBlobAdapterOptions,
): VercelBlobStorage {
  const resolveToken = (): string | undefined => options.token ?? options.env.BLOB_READ_WRITE_TOKEN;
  const cacheControlMaxAge = options.cacheControlMaxAge ?? DEFAULT_CACHE_MAX_AGE_SECONDS;
  const defaultContentType = options.defaultContentType ?? "image/png";

  return {
    urlFor(key: string): string {
      const storeId = parseVercelStoreId(resolveToken());
      return `https://${storeId}.public.blob.vercel-storage.com/${key}`;
    },

    async upload(key, data, opts) {
      const result = await options.sdk.put(key, toUploadBody(data), {
        access: "public",
        contentType: opts?.contentType ?? defaultContentType,
        addRandomSuffix: false,
        cacheControlMaxAge,
      });
      return { url: result.url, pathname: result.pathname };
    },

    async exists(key) {
      try {
        const result = await options.sdk.head(this.urlFor(key));
        return Boolean(result?.url);
      } catch {
        return false;
      }
    },

    async delete(keyOrUrl) {
      // del() accepts a full blob URL or pathname; pass through unchanged.
      await options.sdk.del(keyOrUrl);
    },

    async list(prefix) {
      const result = await options.sdk.list(prefix ? { prefix } : {});
      return { keys: result.blobs.map((blob) => blob.pathname) };
    },

    async listDetailed(prefix) {
      const result = await options.sdk.list(prefix ? { prefix } : {});
      return {
        blobs: result.blobs.map((blob) => ({
          pathname: blob.pathname,
          url: blob.url,
          uploadedAt: blob.uploadedAt,
        })),
      };
    },
  };
}

// @vercel/blob's put() accepts string | Buffer | Blob | ReadableStream etc. Buffer is a
// Uint8Array subclass, so both port input shapes pass straight through.
function toUploadBody(data: Uint8Array | Buffer): Buffer {
  return Buffer.isBuffer(data) ? data : Buffer.from(data);
}
