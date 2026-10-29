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

/**
 * Fallback used when `PLATFORM_BUNDLE` is absent or unknown during bundle resolution.
 * Readiness still refuses an unknown nonempty `PLATFORM_BUNDLE` value.
 */
export const DEFAULT_PLATFORM_BUNDLE: PlatformBundleId = "vercel-supabase";

export const isPlatformBundleId = createPlatformBundleIdGuard(PLATFORM_BUNDLE_IDS);

export type PlatformBundleDescriptor = CorePlatformBundleDescriptor & { id: PlatformBundleId };
export type { PlatformBundleReadiness };

/** The readiness code a bundle reports when a selected capability lacks its configuration. */
export const ENV_MISSING_CODE = "OPENLUP_E_ENV_MISSING";

/** The blob capabilities a deployment can select with `PLATFORM_BLOB`. */
export const BLOB_CAPABILITIES = ["filesystem", "s3", "supabase", "vercel-blob"] as const;

export type BlobCapability = (typeof BLOB_CAPABILITIES)[number];

/**
 * The blob capability in effect: a valid `PLATFORM_BLOB` selection, else the bundle's own. An
 * invalid selection keeps the bundle's own here and is refused by readiness.
 */
export function resolveBlobCapability(
  descriptor: Pick<PlatformBundleDescriptor, "capabilities">,
  env: PlatformEnvInput,
): string {
  const selected = env.PLATFORM_BLOB?.trim();
  return selected && (BLOB_CAPABILITIES as readonly string[]).includes(selected) ? selected : descriptor.capabilities.blob;
}

/** The settings each blob capability needs; an alternative name may stand in for the first. */
const BLOB_SETTINGS: Readonly<Record<string, ReadonlyArray<readonly string[]>>> = {
  "vercel-blob": [["BLOB_READ_WRITE_TOKEN"]],
  supabase: [["SUPABASE_URL", "VITE_SUPABASE_URL"], ["SUPABASE_SERVICE_ROLE_KEY"], ["BLOB_SUPABASE_BUCKET"]],
  filesystem: [["BLOB_FS_ROOT"], ["BLOB_FS_BASE_URL"]],
  s3: [["BLOB_S3_BUCKET"], ["BLOB_S3_BASE_URL"]],
};

function present(env: PlatformEnvInput, name: string): boolean {
  return typeof env[name] === "string" && env[name]!.trim() !== "";
}

/**
 * Per-capability readiness, in this order: an unknown PLATFORM_BUNDLE refuses (resolution itself
 * keeps defaulting); a self-host bundle needs APP_BASE_URL; then every selected capability's
 * missing settings are reported together under OPENLUP_E_ENV_MISSING: a scheduler needs
 * CRON_SECRET, Node scheduling needs DATABASE_URL for its cluster lock (never a silent no-op lock),
 * and the selected blob capability needs its settings. An unknown PLATFORM_BLOB refuses too.
 */
function capabilityReadiness(descriptor: Pick<PlatformBundleDescriptor, "capabilities">, selfHost: boolean) {
  return (env: PlatformEnvInput): PlatformBundleReadiness => {
    const raw = env.PLATFORM_BUNDLE;
    if (raw !== undefined && raw.trim() !== "" && !isPlatformBundleId(raw)) {
      return { ok: false, error: `unknown PLATFORM_BUNDLE "${raw}"; expected one of ${PLATFORM_BUNDLE_IDS.join(", ")}` };
    }
    const selectedBlob = env.PLATFORM_BLOB;
    if (selectedBlob !== undefined && selectedBlob.trim() !== "" && !(BLOB_CAPABILITIES as readonly string[]).includes(selectedBlob.trim())) {
      return { ok: false, error: `unknown PLATFORM_BLOB "${selectedBlob}"; expected one of ${BLOB_CAPABILITIES.join(", ")}` };
    }
    if (selfHost && !present(env, "APP_BASE_URL")) {
      return { ok: false, error: "APP_BASE_URL is required for self-host bundles" };
    }
    const { scheduler } = descriptor.capabilities;
    const blob = resolveBlobCapability(descriptor, env);
    const missing: string[] = [];
    if (scheduler === "vercel-cron" || scheduler === "node-cron") {
      if (!present(env, "CRON_SECRET")) missing.push("CRON_SECRET (scheduler)");
    }
    if (scheduler === "node-cron" && !present(env, "DATABASE_URL")) missing.push("DATABASE_URL (scheduler lock)");
    for (const names of BLOB_SETTINGS[blob] ?? []) {
      if (!names.some((name) => present(env, name))) missing.push(`${names[0]} (blob: ${blob})`);
    }
    return missing.length === 0 ? { ok: true } : { ok: false, error: `${ENV_MISSING_CODE}: ${missing.join(", ")}` };
  };
}

function descriptor(
  id: PlatformBundleId,
  capabilities: PlatformBundleDescriptor["capabilities"],
  selfHost: boolean,
): PlatformBundleDescriptor {
  return { id, capabilities, readReadiness: capabilityReadiness({ capabilities }, selfHost) };
}

const DESCRIPTORS: readonly PlatformBundleDescriptor[] = [
  descriptor("vercel-supabase", {
    http: "vercel",
    scheduler: "vercel-cron",
    blob: "vercel-blob",
    data: "supabase",
    migrations: "supabase",
    analytics: "vercel",
    transactional: "application",
  }, false),
  descriptor("node-supabase", {
    http: "node",
    scheduler: "node-cron",
    blob: "supabase",
    data: "supabase",
    migrations: "supabase",
    analytics: "gtm",
    transactional: "node",
  }, true),
  descriptor("node-postgres", {
    http: "node",
    scheduler: "node-cron",
    blob: "filesystem",
    data: "postgres",
    migrations: "postgres",
    analytics: "noop",
    transactional: "node",
  }, true),
];

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
