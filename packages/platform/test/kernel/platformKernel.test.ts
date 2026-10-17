import { describe, expect, it } from "vitest";
import {
  DEFAULT_PLATFORM_BUNDLE,
  PLATFORM_BUNDLE_DESCRIPTORS,
  PLATFORM_BUNDLE_IDS,
  getBundleDescriptor,
  isPlatformBundleId,
  platformEnvSchema,
  resolveBundleId,
} from "../../src/kernel/platformKernel.js";

describe("platform bundle kernel", () => {
  it.each([{}, { PLATFORM_BUNDLE: "unknown-bundle" }, { PLATFORM_BUNDLE: "" }])("defaults an absent or unknown selector", (env) => {
    expect(DEFAULT_PLATFORM_BUNDLE).toBe("vercel-supabase");
    expect(resolveBundleId(env)).toBe("vercel-supabase");
  });

  it.each(["vercel-supabase", "node-supabase", "node-postgres"])("recognizes and resolves %s", (id) => {
    expect(isPlatformBundleId(id)).toBe(true);
    expect(resolveBundleId({ PLATFORM_BUNDLE: id })).toBe(id);
  });

  it.each([undefined, null, 4, {}, "", "node", " node-postgres "])("rejects a non-id %s", (value) => {
    expect(isPlatformBundleId(value)).toBe(false);
  });

  it("exposes three descriptors with all seven capabilities", () => {
    expect(PLATFORM_BUNDLE_IDS).toEqual(["vercel-supabase", "node-supabase", "node-postgres"]);
    expect(PLATFORM_BUNDLE_DESCRIPTORS.map(({ id }) => id)).toEqual(PLATFORM_BUNDLE_IDS);
    for (const descriptor of PLATFORM_BUNDLE_DESCRIPTORS) {
      expect(getBundleDescriptor(descriptor.id)).toBe(descriptor);
      expect(Object.keys(descriptor.capabilities).sort()).toEqual([
        "analytics", "blob", "data", "http", "migrations", "scheduler", "transactional",
      ]);
    }
    expect(getBundleDescriptor("vercel-supabase").capabilities.transactional).toBe("application");
  });

  // B3 amends the former witness (node bundles ready with APP_BASE_URL alone; the default bundle
  // always ready): every selected capability now reports its missing settings.
  const READY: Record<string, Record<string, string>> = {
    "vercel-supabase": { CRON_SECRET: "cron-secret", BLOB_READ_WRITE_TOKEN: "blob-token" },
    "node-supabase": {
      APP_BASE_URL: "https://example.test", CRON_SECRET: "cron-secret", DATABASE_URL: "postgres://localhost/lock",
      SUPABASE_URL: "https://data.example.test", SUPABASE_SERVICE_ROLE_KEY: "service-key",
    },
    "node-postgres": {
      APP_BASE_URL: "https://example.test", CRON_SECRET: "cron-secret", DATABASE_URL: "postgres://localhost/lock",
      BLOB_FS_ROOT: "/synthetic/objects", BLOB_FS_BASE_URL: "https://objects.example.test",
    },
  };

  it.each(Object.keys(READY))("%s is ready with every capability configured", (id) => {
    expect(getBundleDescriptor(id as never).readReadiness(READY[id]!)).toEqual({ ok: true });
  });

  it.each(["node-supabase", "node-postgres"] as const)("%s still refuses a missing or blank APP_BASE_URL first", (id) => {
    for (const APP_BASE_URL of [undefined, "", "   "]) {
      expect(getBundleDescriptor(id).readReadiness({ ...READY[id], APP_BASE_URL })).toEqual({
        ok: false, error: "APP_BASE_URL is required for self-host bundles",
      });
    }
  });

  it.each([
    ["vercel-supabase", "CRON_SECRET", "OPENLUP_E_ENV_MISSING: CRON_SECRET (scheduler)"],
    ["vercel-supabase", "BLOB_READ_WRITE_TOKEN", "OPENLUP_E_ENV_MISSING: BLOB_READ_WRITE_TOKEN (blob: vercel-blob)"],
    ["node-supabase", "CRON_SECRET", "OPENLUP_E_ENV_MISSING: CRON_SECRET (scheduler)"],
    ["node-supabase", "DATABASE_URL", "OPENLUP_E_ENV_MISSING: DATABASE_URL (scheduler lock)"],
    ["node-supabase", "SUPABASE_SERVICE_ROLE_KEY", "OPENLUP_E_ENV_MISSING: SUPABASE_SERVICE_ROLE_KEY (blob: supabase)"],
    ["node-supabase", "SUPABASE_URL", "OPENLUP_E_ENV_MISSING: SUPABASE_URL (blob: supabase)"],
    ["node-postgres", "DATABASE_URL", "OPENLUP_E_ENV_MISSING: DATABASE_URL (scheduler lock)"],
    ["node-postgres", "BLOB_FS_ROOT", "OPENLUP_E_ENV_MISSING: BLOB_FS_ROOT (blob: filesystem)"],
    ["node-postgres", "BLOB_FS_BASE_URL", "OPENLUP_E_ENV_MISSING: BLOB_FS_BASE_URL (blob: filesystem)"],
  ])("%s without %s refuses with OPENLUP_E_ENV_MISSING", (id, name, error) => {
    for (const value of [undefined, "", "   "]) {
      expect(getBundleDescriptor(id as never).readReadiness({ ...READY[id], [name]: value })).toEqual({ ok: false, error });
    }
  });

  it("reports every missing setting of a bundle together, in capability order", () => {
    expect(getBundleDescriptor("node-postgres").readReadiness({ APP_BASE_URL: "https://example.test" })).toEqual({
      ok: false,
      error: "OPENLUP_E_ENV_MISSING: CRON_SECRET (scheduler), DATABASE_URL (scheduler lock), "
        + "BLOB_FS_ROOT (blob: filesystem), BLOB_FS_BASE_URL (blob: filesystem)",
    });
  });

  it("accepts the browser Supabase URL as the storage URL alternative", () => {
    const { SUPABASE_URL: _url, ...withoutUrl } = READY["node-supabase"]!;
    expect(getBundleDescriptor("node-supabase").readReadiness({ ...withoutUrl, VITE_SUPABASE_URL: "https://data.example.test" }))
      .toEqual({ ok: true });
  });

  it("refuses an unknown PLATFORM_BUNDLE in readiness while resolution keeps defaulting", () => {
    expect(resolveBundleId({ PLATFORM_BUNDLE: "edge-cluster" })).toBe("vercel-supabase");
    for (const id of PLATFORM_BUNDLE_IDS) {
      expect(getBundleDescriptor(id).readReadiness({ ...READY[id], PLATFORM_BUNDLE: "edge-cluster" })).toEqual({
        ok: false,
        error: 'unknown PLATFORM_BUNDLE "edge-cluster"; expected one of vercel-supabase, node-supabase, node-postgres',
      });
    }
    for (const PLATFORM_BUNDLE of [undefined, "", "  "]) {
      expect(getBundleDescriptor("vercel-supabase").readReadiness({ ...READY["vercel-supabase"], PLATFORM_BUNDLE })).toEqual({ ok: true });
    }
  });

  it("validates optional bundle selection and URL syntax independently of readiness", () => {
    expect(platformEnvSchema.safeParse({}).success).toBe(true);
    expect(platformEnvSchema.safeParse({ APP_BASE_URL: "https://example.test" }).success).toBe(true);
    for (const PLATFORM_BUNDLE of PLATFORM_BUNDLE_IDS) {
      expect(platformEnvSchema.safeParse({ APP_BASE_URL: "https://example.test", PLATFORM_BUNDLE }).success).toBe(true);
    }
    expect(platformEnvSchema.safeParse({ APP_BASE_URL: "not-a-url" }).success).toBe(false);
    expect(platformEnvSchema.safeParse({ PLATFORM_BUNDLE: "unknown-bundle" }).success).toBe(false);
    expect(platformEnvSchema.safeParse({ PLATFORM_BUNDLE: "" }).success).toBe(false);
  });
});
