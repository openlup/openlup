// Supabase Storage adapter for the platform-runtime BlobStoragePort (Platform Portability, W5).
//
// Wraps `client.storage.from(bucket)` 1:1 with the existing DHL-label / feedback-media usage:
// upsert uploads, public-URL resolution via getPublicUrl, and bucket-scoped list/remove. Keys
// are bucket-relative paths. Behavior matches the current inline storage calls so the default
// vercel-supabase bundle (which uses this for storage buckets) is byte-identical.

import type { BlobStoragePort } from "../../../src/domains/platform-runtime/ports.js";

/** Minimal structural shape of the Supabase Storage bucket API we depend on. */
export interface SupabaseStorageBucket {
  upload(
    path: string,
    bytes: Uint8Array | Buffer,
    options?: { contentType?: string; upsert?: boolean },
  ): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  remove(paths: string[]): PromiseLike<{ data: unknown; error: { message?: string } | null }>;
  list(
    prefix?: string,
  ): PromiseLike<{ data: Array<{ name: string }> | null; error: { message?: string } | null }>;
  getPublicUrl(path: string): { data: { publicUrl: string } };
}

export interface SupabaseStorageClient {
  storage: { from(bucket: string): SupabaseStorageBucket };
}

export function createSupabaseBlobStorage(
  client: SupabaseStorageClient,
  bucket: string,
  options: { defaultContentType?: string } = {},
): BlobStoragePort {
  const from = (): SupabaseStorageBucket => client.storage.from(bucket);
  const defaultContentType = options.defaultContentType ?? "application/octet-stream";

  return {
    urlFor(key: string): string {
      return from().getPublicUrl(key).data.publicUrl;
    },

    async upload(key, data, opts) {
      const bucketApi = from();
      const result = await bucketApi.upload(key, data, {
        contentType: opts?.contentType ?? defaultContentType,
        upsert: true,
      });
      if (result.error) {
        throw new Error(`supabase_storage_upload_failed:${result.error.message ?? "unknown"}`);
      }
      return { url: bucketApi.getPublicUrl(key).data.publicUrl, pathname: key };
    },

    async exists(key) {
      // Supabase has no head(); list the parent folder and match the leaf name.
      const slash = key.lastIndexOf("/");
      const folder = slash >= 0 ? key.slice(0, slash) : "";
      const leaf = slash >= 0 ? key.slice(slash + 1) : key;
      const result = await from().list(folder || undefined);
      if (result.error) return false;
      return (result.data ?? []).some((entry) => entry.name === leaf);
    },

    async delete(keyOrUrl) {
      const result = await from().remove([toBucketKey(keyOrUrl, bucket)]);
      if (result.error) {
        throw new Error(`supabase_storage_remove_failed:${result.error.message ?? "unknown"}`);
      }
    },

    async list(prefix) {
      const result = await from().list(prefix);
      if (result.error) {
        throw new Error(`supabase_storage_list_failed:${result.error.message ?? "unknown"}`);
      }
      const base = prefix ? `${prefix.replace(/\/$/, "")}/` : "";
      return { keys: (result.data ?? []).map((entry) => `${base}${entry.name}`) };
    },
  };
}

// Accept either a bucket-relative key or a full public URL; strip everything up to and
// including the bucket segment so remove() always gets a bucket-relative path.
function toBucketKey(keyOrUrl: string, bucket: string): string {
  const marker = `/storage/v1/object/public/${bucket}/`;
  const idx = keyOrUrl.indexOf(marker);
  if (idx >= 0) return keyOrUrl.slice(idx + marker.length);
  return keyOrUrl;
}
