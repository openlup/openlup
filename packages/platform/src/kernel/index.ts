export {
  BLOB_CAPABILITIES,
  DEFAULT_PLATFORM_BUNDLE,
  ENV_MISSING_CODE,
  PLATFORM_BUNDLE_DESCRIPTORS,
  PLATFORM_BUNDLE_IDS,
  getBundleDescriptor,
  isPlatformBundleId,
  platformEnvSchema,
  resolveBlobCapability,
  resolveBundleId,
  type BlobCapability,
  type PlatformBundleDescriptor,
  type PlatformBundleId,
  type PlatformBundleReadiness,
  type PlatformEnv,
} from "./platformKernel.js";

/** Minimal query surface for a host-owned PostgreSQL connection. */
export interface PgQueryExecutor {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
