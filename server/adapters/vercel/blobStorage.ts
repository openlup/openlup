// Vercel Blob adapter for the platform-runtime BlobStoragePort (Platform Portability, W5).
//
// Wraps the CURRENT `@vercel/blob` behavior 1:1 so the default vercel-supabase bundle is
// byte-identical: public access, image content-type pass-through, no random suffix, the same
// 30-day cache-control, O(1) head() existence checks, and the deterministic public CDN URL
// derived from the store id encoded in BLOB_READ_WRITE_TOKEN. Operates on FULL keys
// (pathnames); the pet-personalizer prefix/suffix stays in the consuming facade.

import { put, list, del, head } from "@vercel/blob";
import type { BlobStoragePort } from "../../../src/domains/platform-runtime/ports.js";

const DEFAULT_CACHE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days — matches blob.facade

export interface VercelBlobAdapterOptions {
  /** Override token resolution (tests). Defaults to process.env.BLOB_READ_WRITE_TOKEN. */
  token?: string;
  /** Default content-type when an upload omits one. Matches the can-share PNG default. */
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
  options: VercelBlobAdapterOptions = {},
): VercelBlobStorage {
  const resolveToken = (): string | undefined => options.token ?? process.env.BLOB_READ_WRITE_TOKEN;
  const cacheControlMaxAge = options.cacheControlMaxAge ?? DEFAULT_CACHE_MAX_AGE_SECONDS;
  const defaultContentType = options.defaultContentType ?? "image/png";

  return {
    urlFor(key: string): string {
      const storeId = parseVercelStoreId(resolveToken());
      return `https://${storeId}.public.blob.vercel-storage.com/${key}`;
    },

    async upload(key, data, opts) {
      const result = await put(key, toUploadBody(data), {
        access: "public",
        contentType: opts?.contentType ?? defaultContentType,
        addRandomSuffix: false,
        cacheControlMaxAge,
      });
      return { url: result.url, pathname: result.pathname };
    },

    async exists(key) {
      try {
        const result = await head(this.urlFor(key));
        return Boolean(result?.url);
      } catch {
        return false;
      }
    },

    async delete(keyOrUrl) {
      // del() accepts a full blob URL or pathname; pass through unchanged.
      await del(keyOrUrl);
    },

    async list(prefix) {
      const result = await list(prefix ? { prefix } : {});
      return { keys: result.blobs.map((blob) => blob.pathname) };
    },

    async listDetailed(prefix) {
      const result = await list(prefix ? { prefix } : {});
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
