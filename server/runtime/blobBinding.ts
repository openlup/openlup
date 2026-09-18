// Blob port binding for composeBundle (Platform Portability, W5).
//
// Maps a bundle's declared `blob` capability kind to a concrete BlobStoragePort built from env.
// Kept out of composeBundle so that file stays a thin one-line-per-slot registry (its #1
// conflict-magnet status). Env-resolvable backends (vercel-blob, filesystem, s3) are constructed
// here; the supabase backend needs a runtime supabase client (not available from env alone), so
// it returns null and the consuming storage call-sites keep injecting their own client — the
// same null-is-no-op convention W1 established for unbound ports.

import { createVercelBlobStorage } from "../adapters/vercel/blobStorage.js";
import { createFilesystemBlobStorage } from "../adapters/filesystem/blobStorage.js";
import { createS3BlobStorage, type S3ObjectClient } from "../adapters/s3/blobStorage.js";
import type { BlobStoragePort } from "../../src/domains/platform-runtime/ports.js";

type Env = Record<string, string | undefined>;

export interface BlobBindingDeps {
  /** Injected S3 client factory (avoids a hard SDK dep in this wave). */
  s3ClientFactory?: (env: Env) => S3ObjectClient;
}

/**
 * Resolve the BlobStoragePort for a bundle's declared blob capability kind.
 * Returns null when the backend requires a runtime client the env cannot supply (supabase).
 */
export function bindBlobPort(
  blobKind: string,
  env: Env = process.env,
  deps: BlobBindingDeps = {},
): BlobStoragePort | null {
  switch (blobKind) {
    case "vercel-blob":
      return createVercelBlobStorage();
    case "filesystem":
      return env.BLOB_FS_ROOT && env.BLOB_FS_BASE_URL
        ? createFilesystemBlobStorage({ root: env.BLOB_FS_ROOT, baseUrl: env.BLOB_FS_BASE_URL })
        : null;
    case "s3":
      return deps.s3ClientFactory && env.BLOB_S3_BUCKET && env.BLOB_S3_BASE_URL
        ? createS3BlobStorage(deps.s3ClientFactory(env), {
            bucket: env.BLOB_S3_BUCKET,
            baseUrl: env.BLOB_S3_BASE_URL,
          })
        : null;
    case "supabase":
      // Needs a runtime supabase client; bound at the storage call-site, not from env.
      return null;
    default:
      return null;
  }
}
