import { describe, expect, expectTypeOf, it } from "vitest";
import {
  createPlatformBundleIdGuard,
  createPlatformBundleRegistry,
  platformEnvSchema,
  type BlobStoragePort,
  type DataGatewayPort,
  type HttpRuntimePort,
  type JobRunLeasePort,
  type PlatformJobClaim,
  type PlatformJobFinishSummary,
  type PlatformJobInvocation,
  type SchedulerPort,
  type SqlExecutor,
} from "@openlup/core/platform-runtime";

describe("platform-runtime standalone", () => {
  it("exports generic bundle id guards without concrete host presets", () => {
    const isBundleId = createPlatformBundleIdGuard([
      "example-managed",
      "Adopter.Custom_Bundle/1",
    ] as const);

    expect(isBundleId("example-managed")).toBe(true);
    expect(isBundleId("Adopter.Custom_Bundle/1")).toBe(true);
    expect(isBundleId("adopter.custom_bundle/1")).toBe(false);
    expect(isBundleId("vercel-supabase")).toBe(false);
  });

  it("rejects blank or non-trimmed configured bundle ids", () => {
    const invalidIds = ["", "   ", " example-managed", "example-managed "] as const;

    for (const id of invalidIds) {
      expect(() => createPlatformBundleIdGuard([id])).toThrow(
        "Platform bundle ids must be non-empty and trimmed",
      );
    }
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

  it("keeps the job lease port to claim and finish, carrying persisted values as data", async () => {
    const calls: unknown[][] = [];
    const lease: JobRunLeasePort = {
      claimJobRun: async (...args) => {
        calls.push(["claim", ...args]);
        return args[0] === "example-disabled"
          ? { acquired: false, runId: null, reason: "job_disabled" }
          : { acquired: true, runId: "run-1", reason: "acquired" };
      },
      finishJobRun: async (...args) => {
        calls.push(["finish", ...args]);
        return true;
      },
    };
    const invocation: PlatformJobInvocation = { triggerKind: "scheduler", invocationSource: "example-cron" };
    const summary: PlatformJobFinishSummary = { checked: 2, updated: 1, failures: 1, skipped: false };

    await expect(lease.claimJobRun("example-dispatch", invocation, 120)).resolves.toEqual({
      acquired: true,
      runId: "run-1",
      reason: "acquired",
    });
    await expect(lease.claimJobRun("example-disabled", invocation)).resolves.toMatchObject({ reason: "job_disabled" });
    await expect(lease.finishJobRun("example-dispatch", "run-1", invocation, "success", summary, { "example.key": 1 }))
      .resolves.toBe(true);
    expect(calls).toEqual([
      ["claim", "example-dispatch", invocation, 120],
      ["claim", "example-disabled", invocation],
      ["finish", "example-dispatch", "run-1", invocation, "success", summary, { "example.key": 1 }],
    ]);
    // The ledger's field names, pinned: they are persisted by the lease adapters.
    expectTypeOf<keyof PlatformJobInvocation>().toEqualTypeOf<"triggerKind" | "invocationSource">();
    expectTypeOf<keyof PlatformJobClaim>().toEqualTypeOf<"acquired" | "runId" | "reason">();
    expectTypeOf<keyof PlatformJobFinishSummary>().toEqualTypeOf<"checked" | "updated" | "failures" | "skipped" | "reason">();
    expectTypeOf<PlatformJobInvocation["triggerKind"]>().toEqualTypeOf<"worker" | "scheduler" | "operator">();
    expectTypeOf<keyof JobRunLeasePort>().toEqualTypeOf<"claimJobRun" | "finishJobRun">();
  });

  it("accepts a driver-shaped client as a structural SQL executor", async () => {
    // The shape a PostgreSQL pool exposes: overloads and mutable arrays.
    interface DriverClient {
      query(config: { text: string; values?: unknown[] }): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
      query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }>;
    }
    const client: DriverClient = {
      query: async (textOrConfig: string | { text: string }, values?: unknown[]) => ({
        rows: [{ text: typeof textOrConfig === "string" ? textOrConfig : textOrConfig.text, values }],
        rowCount: 1,
      }),
    };
    const sql: SqlExecutor = client;

    await expect(sql.query("SELECT $1::integer AS value", [1])).resolves.toMatchObject({
      rows: [{ text: "SELECT $1::integer AS value", values: [1] }],
    });
  });
});
