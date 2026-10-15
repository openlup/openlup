// Reference-application binding: this path keeps its importers while the implementation lives in
// @openlup/platform.
export {
  DEFAULT_PLATFORM_BUNDLE,
  PLATFORM_BUNDLE_DESCRIPTORS,
  PLATFORM_BUNDLE_IDS,
  getBundleDescriptor,
  isPlatformBundleId,
  platformEnvSchema,
  resolveBundleId,
  type PlatformBundleDescriptor,
  type PlatformBundleReadiness,
  type PlatformEnv,
} from "@openlup/platform/kernel";
