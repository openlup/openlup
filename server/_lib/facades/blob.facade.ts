// Pet-personalizer blob facade. Its prefix/suffix + slug<->key mapping live
// here; the actual object-storage I/O is delegated to the platform-runtime BlobStoragePort.
// Default (vercel-supabase) bundle binds the Vercel Blob adapter, so behavior is byte-identical
// to the prior direct `@vercel/blob` calls: public PNG, no random suffix, 30-day cache, O(1)
// head() existence checks, and the deterministic public CDN URL from the store id.

import {
  createVercelBlobStorage,
  type VercelBlobEntry,
  type VercelBlobStorage,
} from "../../adapters/vercel/blobStorage.js";

const PREFIX = "pet-personalizer/";

// Lazily-constructed default port so token resolution stays deferred (matches prior behavior
// where parseStoreId() only ran when a method was called, not at import). The facade keeps the
// Vercel adapter shape (VercelBlobStorage) so the TTL cron can read uploadedAt via listDetailed.
let defaultPort: VercelBlobStorage | null = null;
function port(): VercelBlobStorage {
  if (!defaultPort) defaultPort = createVercelBlobStorage({ defaultContentType: "image/png" });
  return defaultPort;
}

/** Override the backing port (composeBundle binding / tests). */
export function setBlobFacadePort(next: VercelBlobStorage | null): void {
  defaultPort = next;
}

export const blobFacade = {
  pathFor(slug: string): string {
    return `${PREFIX}${slug}.png`;
  },

  /** Construct a public CDN URL without an API call. O(1), no Vercel Blob quota usage. */
  urlFor(slug: string): string {
    return port().urlFor(this.pathFor(slug));
  },

  /** Confirm a blob exists by its pathname. O(1) — direct head() lookup, not list(). */
  async exists(slug: string): Promise<boolean> {
    return port().exists(this.pathFor(slug));
  },

  async upload(slug: string, pngBuffer: Buffer): Promise<{ url: string; pathname: string }> {
    return port().upload(this.pathFor(slug), pngBuffer, { contentType: "image/png" });
  },

  async list(): Promise<{ keys: string[] }> {
    return port().list(PREFIX);
  },

  /** Vercel-specific listing with uploadedAt, used by the TTL cleanup cron. */
  async listDetailed(): Promise<{ blobs: VercelBlobEntry[] }> {
    return port().listDetailed(PREFIX);
  },

  async delete(url: string): Promise<void> {
    await port().delete(url);
  },
};
