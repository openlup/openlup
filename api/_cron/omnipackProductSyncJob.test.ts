import { describe, expect, it, vi } from "vitest";
import { runOmnipackProductSyncCron } from "./omnipackProductSyncJob.js";
import type { OmnipackProductSyncProvider } from "../../server/domains/fulfillment/omnipackProductSyncWorker.js";
import { createSupabaseOmnipackCronGateway } from "../../server/runtime/fulfillment/omnipackCronGateway.js";

describe("OmniPack product sync cron", () => {
  it("fails closed before provider/db calls when disabled", async () => {
    const gatewayFactory = vi.fn();
    await expect(runOmnipackProductSyncCron(request(), { CRON_SECRET: "secret" }, gatewayFactory as never))
      .resolves.toMatchObject({ status: 200, body: { ok: true, skipped: true, reason: "omnipack_product_sync_disabled" } });
    expect(gatewayFactory).not.toHaveBeenCalled();
  });

  it("requires configured provider credentials when enabled", async () => {
    await expect(runOmnipackProductSyncCron(
      request(),
      { CRON_SECRET: "secret", COMMERCE_OMNIPACK_PRODUCT_SYNC_ENABLED: "true" },
      vi.fn() as never,
    )).resolves.toMatchObject({ status: 503, body: { ok: false, error: "omnipack_provider_not_configured" } });
  });

  it("rejects unauthorized cron requests", async () => {
    await expect(runOmnipackProductSyncCron(
      request("POST", "wrong"),
      { CRON_SECRET: "secret", COMMERCE_OMNIPACK_PRODUCT_SYNC_ENABLED: "true" },
    )).resolves.toMatchObject({ status: 401 });
  });

  it("runs the sync behind cron auth + job lease + service role, then records success", async () => {
    const client = fakeClient();
    const gatewayFactory = gatewayFactoryFor(client);
    const provider: OmnipackProductSyncProvider = {
      ensureProduct: vi.fn(async () => ({ replayed: false })),
      getProductPacks: vi.fn(async () => []),
      addProductPack: vi.fn(async () => {}),
      listStockedSkus: vi.fn(async () => []),
    };

    await expect(runOmnipackProductSyncCron(
      request(),
      {
        CRON_SECRET: "secret",
        COMMERCE_OMNIPACK_PRODUCT_SYNC_ENABLED: "true",
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role",
      },
      gatewayFactory,
      provider,
    )).resolves.toMatchObject({ status: 200, body: { ok: true, failures: 0 } });

    expect(client.rpc).toHaveBeenCalledWith("platform_claim_job_run", expect.objectContaining({ p_job_name: "omnipack-product-sync" }));
    expect(client.rpc).toHaveBeenCalledWith("platform_finish_job_run_v2", expect.objectContaining({ p_job_name: "omnipack-product-sync", p_status: "success" }));
  });

  it("is PULL-ONLY: never invokes the push methods (write to OmniPack), even when they would throw", async () => {
    const client = fakeClient();
    const gatewayFactory = gatewayFactoryFor(client);
    const ensureProduct = vi.fn(async () => { throw new Error("push must not run"); });
    const addProductPack = vi.fn(async () => { throw new Error("push must not run"); });
    const provider: OmnipackProductSyncProvider = {
      ensureProduct,
      addProductPack,
      getProductPacks: vi.fn(async () => []),
      listStockedSkus: vi.fn(async () => ["OPENLUP-DOG-LAMB-CAN-400G"]),
    };

    await expect(runOmnipackProductSyncCron(
      request(),
      { CRON_SECRET: "secret", COMMERCE_OMNIPACK_PRODUCT_SYNC_ENABLED: "true", SUPABASE_URL: "https://supabase.test", SUPABASE_SERVICE_ROLE_KEY: "service-role" },
      gatewayFactory,
      provider,
    )).resolves.toMatchObject({ status: 200, body: { ok: true, failures: 0, pushedProducts: 0, pushedPacks: 0 } });

    expect(ensureProduct).not.toHaveBeenCalled();
    expect(addProductPack).not.toHaveBeenCalled();
  });

  it("records a failed job run when the worker throws", async () => {
    const client = fakeClient();
    const gatewayFactory = gatewayFactoryFor(client);
    const provider: OmnipackProductSyncProvider = {
      ensureProduct: vi.fn(async () => ({ replayed: false })),
      getProductPacks: vi.fn(async () => []),
      addProductPack: vi.fn(async () => {}),
      listStockedSkus: vi.fn(async () => { throw new Error("provider boom"); }),
    };

    await expect(runOmnipackProductSyncCron(
      request(),
      {
        CRON_SECRET: "secret",
        COMMERCE_OMNIPACK_PRODUCT_SYNC_ENABLED: "true",
        SUPABASE_URL: "https://supabase.test",
        SUPABASE_SERVICE_ROLE_KEY: "service-role",
      },
      gatewayFactory,
      provider,
    )).resolves.toMatchObject({ status: 502, body: { ok: false, failures: 1 } });

    expect(client.rpc).toHaveBeenCalledWith("platform_finish_job_run_v2", expect.objectContaining({ p_status: "failed" }));
  });
});

function request(method = "POST", token = "secret") {
  return { method, headers: { authorization: `Bearer ${token}` }, body: {}, query: {} } as never;
}

function gatewayFactoryFor(client: ReturnType<typeof fakeClient>) {
  return vi.fn((env) => createSupabaseOmnipackCronGateway(env, vi.fn(() => client) as never)!);
}

function fakeClient() {
  return {
    from() {
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn(() => builder),
        then: (resolve: (r: { data: unknown; error: unknown }) => unknown) => resolve({ data: [], error: null }),
      };
      return builder;
    },
    rpc: vi.fn(async (name: string) => {
      if (name === "platform_claim_job_run") {
        return { data: { acquired: true, run_id: "run-1", reason: "claimed" }, error: null };
      }
      return { data: { conflict: "none", replayed: false, resolved: 0 }, error: null };
    }),
  };
}
