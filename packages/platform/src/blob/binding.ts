// Blob port binding for bundle composition.
//
// Maps a bundle's declared `blob` capability kind to a concrete BlobStoragePort built from env and,
// where a provider client is needed, from the client the application injects (vercel-blob, s3). A
// backend whose client is not injected stays unbound (null). The supabase backend needs a runtime
// supabase client, so it returns null and the consuming storage call-sites keep injecting their
// own client, the same null-is-no-op convention as other unbound ports.

import { createVercelBlobStorage, type VercelBlobSdk } from "./vercel.js";
import { createFilesystemBlobStorage } from "./filesystem.js";
import { createS3BlobStorage, type S3ObjectClient } from "./s3.js";
import type { BlobStoragePort } from "@openlup/core/platform-runtime";

type Env = Record<string, string | undefined>;

export interface BlobBindingDeps {
  /** The `@vercel/blob` module; without it the vercel-blob capability stays unbound. */
  vercelBlob?: VercelBlobSdk;
  /** Injected S3 client factory; without it the s3 capability stays unbound. */
  s3ClientFactory?: (env: Env) => S3ObjectClient;
}

/**
 * Resolve the BlobStoragePort for a bundle's declared blob capability kind.
 * Returns null when the backend requires a runtime client the env cannot supply (supabase).
 */
export function bindBlobPort(
  blobKind: string,
  env: Env,
  deps: BlobBindingDeps = {},
): BlobStoragePort | null {
  switch (blobKind) {
    case "vercel-blob":
      return deps.vercelBlob ? createVercelBlobStorage({ env, sdk: deps.vercelBlob }) : null;
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
