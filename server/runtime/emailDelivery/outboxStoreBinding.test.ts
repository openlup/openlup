import { describe, expect, it, vi } from "vitest";

import { resolveOutboxStoreBinding } from "./outboxStoreBinding.js";

const MANAGED_ENV = {
  SUPABASE_URL: "https://project.example.test",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("outbox store binding", () => {
  it("fails closed when the managed capability lacks its service credentials", () => {
    expect(resolveOutboxStoreBinding({})).toEqual({ error: "supabase_env_required" });
  });

  it("exposes only the neutral store plus managed diagnostics", async () => {
    const client = {
      rpc: vi.fn(async (name: string) => {
        if (name === "outbox_claim_batch_v3") return { data: [], error: null };
        if (name === "outbox_queue_stats") return { data: { pending: 2 }, error: null };
        return { data: null, error: null };
      }),
    };
    const gateway = { asService: vi.fn(async (work) => work(client)) };
    const gatewayFactory = vi.fn(() => gateway);
    const resolved = resolveOutboxStoreBinding(MANAGED_ENV, { gatewayFactory });

    expect(gatewayFactory).not.toHaveBeenCalled();
    const result = await resolved.binding?.run(async ({ store, diagnostics }) => ({
      claimed: await store.claimBatch({
        eventTypes: ["commerce.order_draft.created"],
        batchSize: 1,
        visibilitySeconds: 300,
        maxAttempts: 8,
      }),
      queue: await diagnostics?.queueStats(),
    }));

    expect(result).toEqual({ claimed: [], queue: { pending: 2 } });
    expect(gatewayFactory).toHaveBeenCalledWith({
      url: MANAGED_ENV.SUPABASE_URL,
      anonKey: "",
      serviceRoleKey: MANAGED_ENV.SUPABASE_SERVICE_ROLE_KEY,
    });
    expect(client.rpc).toHaveBeenCalledWith("outbox_claim_batch_v3", expect.any(Object));
    expect(client.rpc).toHaveBeenCalledWith("outbox_queue_stats", {});
  });

  it("resolves a role-free Postgres store only when DATABASE_URL is present", () => {
    expect(resolveOutboxStoreBinding({ PLATFORM_BUNDLE: "node-postgres" }))
      .toEqual({ error: "database_url_required" });
    const resolved = resolveOutboxStoreBinding({
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgres://postgres:secret@localhost:5432/platform",
    });
    expect(typeof resolved.binding?.run).toBe("function");
  });

  it("closes the Postgres store after the binding callback without extending its transactions", async () => {
    const close = vi.fn(async () => {});
    const store = {
      claimBatch: vi.fn(async () => []),
      markProcessed: vi.fn(async () => ({ applied: true })),
      markFailed: vi.fn(async () => ({ status: "failed" as const })),
      releaseUnprocessed: vi.fn(async () => 0),
      close,
    };
    const resolved = resolveOutboxStoreBinding({
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgres://postgres:secret@localhost:5432/platform",
    }, { postgresStoreFactory: vi.fn(() => store) });

    await expect(resolved.binding?.run(async ({ store: bound }) => {
      expect(bound).toBe(store);
      return "done";
    })).resolves.toBe("done");
    expect(close).toHaveBeenCalledOnce();
  });
});
