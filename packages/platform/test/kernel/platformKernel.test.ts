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

  it.each(["node-supabase", "node-postgres"] as const)("%s needs only APP_BASE_URL for readiness", (id) => {
    const descriptor = getBundleDescriptor(id);
    expect(descriptor.readReadiness({ APP_BASE_URL: "https://example.test" })).toEqual({ ok: true });
    expect(descriptor.readReadiness({
      APP_BASE_URL: "https://example.test", CRON_SECRET: "", DATABASE_URL: "",
      BLOB_READ_WRITE_TOKEN: "", BLOB_FS_ROOT: "", BLOB_FS_BASE_URL: "",
      BLOB_S3_BUCKET: "", BLOB_S3_BASE_URL: "",
    })).toEqual({ ok: true });
    for (const APP_BASE_URL of [undefined, "", "   "]) {
      expect(descriptor.readReadiness({ APP_BASE_URL })).toEqual({
        ok: false, error: "APP_BASE_URL is required for self-host bundles",
      });
    }
  });

  it("keeps the default bundle ready regardless of environment readiness inputs", () => {
    const descriptor = getBundleDescriptor("vercel-supabase");
    for (const env of [{}, { CRON_SECRET: "" }, { APP_BASE_URL: "   ", DATABASE_URL: "" }]) {
      expect(descriptor.readReadiness(env)).toEqual({ ok: true });
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
