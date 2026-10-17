// Blob port binding for bundle composition.
//
// Maps the selected blob capability to a concrete BlobStoragePort built from env: filesystem
// (the local development default), S3-compatible storage (the default client unless one is
// injected), Vercel Blob (with the injected `@vercel/blob` module) and Supabase Storage (a
// service-role client built from the data-gateway settings with the injected `createClient`).
// A capability whose settings or client are missing stays unbound (null); readiness reports it.

import type { BlobStoragePort } from "@openlup/core/platform-runtime";

import { createServiceClient, readSupabaseDataGatewayEnv, type SupabaseCreateClient } from "../data/index.js";
import { createFilesystemBlobStorage } from "./filesystem.js";
import { createS3BlobStorage, type S3ObjectClient } from "./s3.js";
import { createS3ClientFromEnv } from "./s3Client.js";
import { createSupabaseBlobStorage, type SupabaseStorageClient } from "./supabase.js";
import { createVercelBlobStorage, type VercelBlobSdk } from "./vercel.js";

type Env = Record<string, string | undefined>;

export interface BlobBindingDeps {
  /** The `@vercel/blob` module; without it the vercel-blob capability stays unbound. */
  vercelBlob?: VercelBlobSdk;
  /** S3 client factory; defaults to `createS3ClientFromEnv`. */
  s3ClientFactory?: (env: Env) => S3ObjectClient;
  /** The supabase-js `createClient`; without it the supabase capability stays unbound. */
  createSupabaseClient?: SupabaseCreateClient;
}

/** Resolve the BlobStoragePort for a blob capability, or null when it cannot be bound. */
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
      return env.BLOB_S3_BUCKET && env.BLOB_S3_BASE_URL
        ? createS3BlobStorage((deps.s3ClientFactory ?? createS3ClientFromEnv)(env), {
            bucket: env.BLOB_S3_BUCKET,
            baseUrl: env.BLOB_S3_BASE_URL,
          })
        : null;
    case "supabase": {
      const settings = readSupabaseDataGatewayEnv(env);
      if (!deps.createSupabaseClient || !settings || !env.BLOB_SUPABASE_BUCKET) return null;
      const client = createServiceClient(settings, deps.createSupabaseClient) as SupabaseStorageClient;
      return createSupabaseBlobStorage(client, env.BLOB_SUPABASE_BUCKET);
    }
    default:
      return null;
  }
}
