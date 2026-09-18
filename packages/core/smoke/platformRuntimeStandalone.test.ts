import { describe, expect, it } from "vitest";
import {
  createPlatformBundleIdGuard,
  createPlatformBundleRegistry,
  platformEnvSchema,
  type BlobStoragePort,
  type DataGatewayPort,
  type HttpRuntimePort,
  type SchedulerPort,
} from "@openlup/core/platform-runtime";

describe("platform-runtime standalone", () => {
  it("exports generic bundle id guards without concrete host presets", () => {
    const isBundleId = createPlatformBundleIdGuard(["example-managed", "example-self-host"] as const);

    expect(isBundleId("example-managed")).toBe(true);
    expect(isBundleId("vercel-supabase")).toBe(false);
  });

  it("lets downstream apps register their own descriptor matrix", () => {
    const registry = createPlatformBundleRegistry({
      defaultBundleId: "example-managed",
      descriptors: [
        {
          id: "example-managed",
          capabilities: {
            http: "managed-http",
            scheduler: "managed-scheduler",
            blob: "managed-blob",
            data: "managed-data",
            migrations: "managed-migrations",
            analytics: "managed-analytics",
            transactional: "managed-transactional",
          },
          readReadiness: () => ({ ok: true }),
        },
        {
          id: "example-self-host",
          capabilities: {
            http: "self-host-http",
            scheduler: "self-host-scheduler",
            blob: "self-host-blob",
            data: "self-host-data",
            migrations: "self-host-migrations",
            analytics: "self-host-analytics",
            transactional: "self-host-transactional",
          },
          readReadiness: (env) => ({ ok: Boolean(env.APP_BASE_URL) }),
        },
      ] as const,
    });

    expect(registry.bundleIds).toEqual(["example-managed", "example-self-host"]);
    expect(registry.resolveBundleId({})).toBe("example-managed");
    expect(registry.resolveBundleId({ PLATFORM_BUNDLE: "example-self-host" })).toBe("example-self-host");
    expect(registry.resolveBundleId({ PLATFORM_BUNDLE: "unknown" })).toBe("example-managed");
    for (const descriptor of registry.descriptors) {
      expect(Object.keys(descriptor.capabilities).sort()).toEqual([
        "analytics",
        "blob",
        "data",
        "http",
        "migrations",
        "scheduler",
        "transactional",
      ]);
    }
    expect(registry.getBundleDescriptor("example-self-host").capabilities).toMatchObject({
      http: "self-host-http",
      data: "self-host-data",
      blob: "self-host-blob",
    });
  });

  it("validates platform env without reading process env", () => {
    expect(platformEnvSchema.safeParse({
      PLATFORM_BUNDLE: "example-self-host",
      APP_BASE_URL: "https://example.test",
    }).success).toBe(true);
    expect(platformEnvSchema.safeParse({ APP_BASE_URL: "not-a-url" }).success).toBe(false);
  });

  it("keeps port contracts structural", async () => {
    const http: HttpRuntimePort = {
      handle: (_req, res) => res.status(204).json({ ok: true }),
    };
    const scheduler: SchedulerPort = {
      register: () => undefined,
      verifyInvocation: () => true,
    };
    const blob: BlobStoragePort = {
      upload: async () => ({ url: "https://example.test/object", pathname: "object" }),
      exists: async () => true,
      delete: async () => undefined,
      list: async () => ({ keys: ["object"] }),
      urlFor: (key) => `https://example.test/${key}`,
    };
    const data: DataGatewayPort = {
      asActor: async (_claims, work) => work({ source: "actor" }),
      asService: async (work) => work({ source: "service" }),
    };
    const invocationRequest = {
      headers: {},
      query: {},
    } as Parameters<SchedulerPort["verifyInvocation"]>[0];

    expect(scheduler.verifyInvocation(invocationRequest)).toBe(true);
    expect(await blob.upload("object", new Uint8Array([1]))).toMatchObject({ pathname: "object" });
    await expect(data.asService(async (gateway) => gateway)).resolves.toEqual({ source: "service" });
    expect(typeof http.handle).toBe("function");
  });
});
