// Reference-application binding: this path keeps its importers while the implementation lives in
// @openlup/platform. It binds the `@vercel/blob` module; token resolution defaults to
// process.env.BLOB_READ_WRITE_TOKEN, read per call.

import * as vercelBlob from "@vercel/blob";
import {
  createVercelBlobStorage as createPlatformVercelBlobStorage,
  type VercelBlobAdapterOptions as PlatformVercelBlobAdapterOptions,
  type VercelBlobStorage,
} from "@openlup/platform/blob";

export { parseVercelStoreId, type VercelBlobEntry, type VercelBlobStorage } from "@openlup/platform/blob";

export type VercelBlobAdapterOptions = Omit<PlatformVercelBlobAdapterOptions, "env" | "sdk">;

export function createVercelBlobStorage(options: VercelBlobAdapterOptions = {}): VercelBlobStorage {
  return createPlatformVercelBlobStorage({ env: process.env, sdk: vercelBlob, ...options });
}
