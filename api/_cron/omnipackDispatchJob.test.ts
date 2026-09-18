import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { createSupabaseOmnipackCronGateway } from "../../server/runtime/fulfillment/omnipackCronGateway.js";
import { runOmnipackDispatchCron } from "./omnipackDispatchJob.js";

function request(headers: Record<string, string> = {}, method = "POST"): VercelRequest {
  return { method, headers, query: {} } as VercelRequest;
}

describe("OmniPack dispatch cron", () => {
  it("fails closed before DB/provider setup when auth or dispatch flag is missing", async () => {
    const gatewayFactory = vi.fn();
    const providerFactory = vi.fn();

    await expect(runOmnipackDispatchCron(request(), {}, gatewayFactory as never, providerFactory)).resolves.toEqual({
      status: 500,
      body: { ok: false, error: "cron_secret_not_configured" },
    });
    await expect(runOmnipackDispatchCron(
      request({ authorization: "Bearer wrong" }),
      { CRON_SECRET: "secret" },
      gatewayFactory as never,
      providerFactory,
    )).resolves.toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    await expect(runOmnipackDispatchCron(
      request({ authorization: "Bearer secret" }),
      { CRON_SECRET: "secret" },
      gatewayFactory as never,
      providerFactory,
    )).resolves.toMatchObject({ status: 200, body: { skipped: true, reason: "omnipack_dispatch_disabled" } });

    expect(gatewayFactory).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("fails live mode closed before DB/provider setup when production credentials are absent", async () => {
    const gatewayFactory = vi.fn();
    const providerFactory = vi.fn(() => null);
    const env = {
      CRON_SECRET: "secret",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "live",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    };

    await expect(runOmnipackDispatchCron(
      request({ authorization: "Bearer secret" }),
      env,
      gatewayFactory as never,
      providerFactory,
    )).resolves.toMatchObject({
      status: 200,
      body: { ok: true, skipped: true, reason: "omnipack_provider_not_configured" },
    });
    // Live still fails closed before any DB/provider setup without real prod creds.
    expect(gatewayFactory).not.toHaveBeenCalled();
    expect(providerFactory).not.toHaveBeenCalled();
  });

  it("refuses stage mode that does not meet the controlled batch readiness", async () => {
    const gatewayFactory = vi.fn();
    const env = {
      CRON_SECRET: "secret",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_MODE: "stage",
      COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "10",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    };

    await expect(runOmnipackDispatchCron(
      request({ authorization: "Bearer secret" }),
      env,
      gatewayFactory as never,
      vi.fn(() => null),
    )).resolves.toMatchObject({
      status: 200,
      body: { ok: true, skipped: true, reason: "omnipack_stage_batch_limit_must_be_1" },
    });
    expect(gatewayFactory).not.toHaveBeenCalled();
  });

  it("claims the job and finishes success for an empty shadow batch without provider setup", async () => {
    const client = rpcClient();
    const gatewayFactory = gatewayFactoryFor(client);
    const providerFactory = vi.fn();
    const env = {
      CRON_SECRET: "secret",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    };

    const result = await runOmnipackDispatchCron(
      request({ authorization: "Bearer secret" }),
      env,
      gatewayFactory,
      providerFactory,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      mode: "shadow",
      checked: 0,
      updated: 0,
      providerCalls: 0,
    });
    expect(providerFactory).not.toHaveBeenCalled();
    expect(client.rpc).toHaveBeenCalledWith("platform_claim_job_run", expect.objectContaining({
      p_job_name: "omnipack-dispatch",
      p_driver: "vercel_cron",
      p_metadata: expect.objectContaining({ driver: "vercel_cron" }),
    }));
    expect(client.rpc).toHaveBeenCalledWith("platform_finish_job_run_v2", expect.objectContaining({
      p_job_name: "omnipack-dispatch",
      p_status: "success",
      p_metadata: expect.objectContaining({
        driver: "vercel_cron",
      }),
    }));
  });

  it("ignores removed provider-command authority env values", async () => {
    const client = rpcClient();
    const gatewayFactory = gatewayFactoryFor(client);
    const env = {
      CRON_SECRET: "secret",
      COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
      COMMERCE_OMNIPACK_DISPATCH_AUTHORITY: "provider_command",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "service",
    };

    const result = await runOmnipackDispatchCron(
      request({ authorization: "Bearer secret" }),
      env,
      gatewayFactory,
      vi.fn(),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      mode: "shadow",
      checked: 0,
      providerCalls: 0,
    });
    expect(result.body).not.toHaveProperty("authorityMode");
    expect(result.body).not.toHaveProperty("providerCommandObserved");

    const rpcCalls = client.rpc.mock.calls as unknown as Array<[string, Record<string, unknown>]>;
    const finishCall = rpcCalls.find(([name]) => name === "platform_finish_job_run_v2");
    const finishMetadata = finishCall?.[1]?.p_metadata as Record<string, unknown> | undefined;
    expect(finishMetadata).not.toHaveProperty("authorityMode");
    expect(finishMetadata).not.toHaveProperty("providerCommandObserved");
  });
});

function rpcClient() {
  const chain = {
    select: vi.fn(() => chain),
    in: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(async () => ({ data: [], error: null })),
  };
  return {
    rpc: vi.fn(async (name: string) => {
      if (name === "platform_claim_job_run") return { data: { acquired: true, run_id: "run-1", reason: "claimed" }, error: null };
      if (name === "platform_finish_job_run_v2") return { data: true, error: null };
      return { data: [], error: null };
    }),
    from: vi.fn(() => chain),
  };
}

function gatewayFactoryFor(client: ReturnType<typeof rpcClient>) {
  return vi.fn((env) => createSupabaseOmnipackCronGateway(env, vi.fn(() => client) as never)!);
}
