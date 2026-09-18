import { describe, expect, it, vi } from "vitest";

import { resolveChannelIngestStoreBinding } from "./channelIngestStoreBinding.js";
import type { PostgresChannelIngestStore } from "../../adapters/postgres/channelIngestStore.js";

const MANAGED_ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

function createFakePostgresStore(): PostgresChannelIngestStore & { closed: number } {
  const store = {
    closed: 0,
    recordInboundEvent: vi.fn(),
    upsertBuyer: vi.fn(),
    createChannelOrder: vi.fn(),
    advanceLedger: vi.fn(),
    quarantine: vi.fn(),
    close: vi.fn(async () => {
      store.closed += 1;
    }),
  } as unknown as PostgresChannelIngestStore & { closed: number };
  return store;
}

describe("channel ingest store binding", () => {
  it("resolves the managed store and its channel read on the default bundle", async () => {
    const asService = vi.fn(async (work: (gateway: unknown) => Promise<unknown>) =>
      work({ rpc: vi.fn(), from: vi.fn() }),
    );
    const resolution = resolveChannelIngestStoreBinding(MANAGED_ENV, {
      gatewayFactory: () => ({ asService }) as never,
    });

    expect(resolution.error).toBeUndefined();
    const context = await resolution.binding!.run(async (bound) => bound);
    expect(context.store.recordInboundEvent).toBeTypeOf("function");
    expect(context.channels?.readChannelBySlug).toBeTypeOf("function");
    expect(asService).toHaveBeenCalledTimes(1);
  });

  it("reports missing managed configuration instead of binding a half-built store", () => {
    const resolution = resolveChannelIngestStoreBinding({});

    expect(resolution).toEqual({ error: "supabase_env_required" });
  });

  it("resolves the direct store on the postgres bundle and closes its pool", async () => {
    const store = createFakePostgresStore();
    const resolution = resolveChannelIngestStoreBinding(
      { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://x" },
      { postgresStoreFactory: () => store },
    );

    expect(resolution.error).toBeUndefined();
    const context = await resolution.binding!.run(async (bound) => bound);

    expect(context.store).toBe(store);
    // No channel read on this lane: the platform catalogue authors no connection embed for it.
    expect(context.channels).toBeUndefined();
    expect(store.closed).toBe(1);
  });

  it("closes the direct pool even when the work throws", async () => {
    const store = createFakePostgresStore();
    const resolution = resolveChannelIngestStoreBinding(
      { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://x" },
      { postgresStoreFactory: () => store },
    );

    await expect(
      resolution.binding!.run(async () => {
        throw new Error("work failed");
      }),
    ).rejects.toThrow("work failed");
    expect(store.closed).toBe(1);
  });

  it("reports a missing connection string on the postgres bundle", () => {
    const resolution = resolveChannelIngestStoreBinding({ PLATFORM_BUNDLE: "node-postgres" });

    expect(resolution).toEqual({ error: "database_url_required" });
  });
});
