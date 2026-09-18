export {
  createPlatformBundleIdGuard,
} from "@openlup/core/platform-runtime";
import { createPlatformBundleIdGuard } from "@openlup/core/platform-runtime";

export const PLATFORM_BUNDLE_IDS = [
  "vercel-supabase",
  "node-supabase",
  "node-postgres",
] as const;

export type PlatformBundleId = (typeof PLATFORM_BUNDLE_IDS)[number];

export const DEFAULT_PLATFORM_BUNDLE: PlatformBundleId = "vercel-supabase";

export const isPlatformBundleId = createPlatformBundleIdGuard(PLATFORM_BUNDLE_IDS);

export type {
  PlatformCapability,
} from "@openlup/core/platform-runtime";
