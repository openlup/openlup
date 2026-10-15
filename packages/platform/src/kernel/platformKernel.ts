import { z } from "zod";

import {
  createPlatformBundleRegistry,
  platformEnvSchema as corePlatformEnvSchema,
  type PlatformBundleDescriptor as CorePlatformBundleDescriptor,
  type PlatformBundleReadiness,
  type PlatformEnvInput,
  createPlatformBundleIdGuard,
} from "@openlup/core/platform-runtime";

/** The bundles a deployment can select with `PLATFORM_BUNDLE`. */
export const PLATFORM_BUNDLE_IDS = [
  "vercel-supabase",
  "node-supabase",
  "node-postgres",
] as const;

export type PlatformBundleId = (typeof PLATFORM_BUNDLE_IDS)[number];

/** The bundle selected when `PLATFORM_BUNDLE` is absent or unknown. */
export const DEFAULT_PLATFORM_BUNDLE: PlatformBundleId = "vercel-supabase";

export const isPlatformBundleId = createPlatformBundleIdGuard(PLATFORM_BUNDLE_IDS);

export type PlatformBundleDescriptor = CorePlatformBundleDescriptor & { id: PlatformBundleId };
export type { PlatformBundleReadiness };

function requiresAppBaseUrl(env: PlatformEnvInput): PlatformBundleReadiness {
  if (!env.APP_BASE_URL || env.APP_BASE_URL.trim() === "") {
    return { ok: false, error: "APP_BASE_URL is required for self-host bundles" };
  }
  return { ok: true };
}

const DESCRIPTORS: readonly PlatformBundleDescriptor[] = [
  {
    id: "vercel-supabase",
    capabilities: {
      http: "vercel",
      scheduler: "vercel-cron",
      blob: "vercel-blob",
      data: "supabase",
      migrations: "supabase",
      analytics: "vercel",
      transactional: "application",
    },
    readReadiness: () => ({ ok: true }),
  },
  {
    id: "node-supabase",
    capabilities: {
      http: "node",
      scheduler: "node-cron",
      blob: "supabase",
      data: "supabase",
      migrations: "supabase",
      analytics: "gtm",
      transactional: "node",
    },
    readReadiness: requiresAppBaseUrl,
  },
  {
    id: "node-postgres",
    capabilities: {
      http: "node",
      scheduler: "node-cron",
      blob: "filesystem",
      data: "postgres",
      migrations: "postgres",
      analytics: "noop",
      transactional: "node",
    },
    readReadiness: requiresAppBaseUrl,
  },
] as const;

const registry = createPlatformBundleRegistry({
  descriptors: DESCRIPTORS,
  defaultBundleId: DEFAULT_PLATFORM_BUNDLE,
});

export const PLATFORM_BUNDLE_DESCRIPTORS: readonly PlatformBundleDescriptor[] =
  registry.descriptors as readonly PlatformBundleDescriptor[];

export function getBundleDescriptor(id: PlatformBundleId): PlatformBundleDescriptor {
  return registry.getBundleDescriptor(id) as PlatformBundleDescriptor;
}

export function resolveBundleId(env: PlatformEnvInput): PlatformBundleId {
  return registry.resolveBundleId(env) as PlatformBundleId;
}

export const platformEnvSchema = corePlatformEnvSchema.extend({
  PLATFORM_BUNDLE: z.enum(PLATFORM_BUNDLE_IDS).optional(),
});

export type PlatformEnv = z.infer<typeof platformEnvSchema>;
