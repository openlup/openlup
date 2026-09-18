import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runSubscriptionSweepCron } from "./subscription-sweep.js";

const BASE_ENV = {
  CRON_SECRET: "s3cr3t-value",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("subscription-sweep cron", () => {
  it("keeps composition free of direct Supabase client construction", () => {
    const source = readFileSync("api/cron/subscription-sweep.ts", "utf8");
    expect(source).not.toMatch(/@supabase\/supabase-js|createClient\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain(".asService(");
  });

  it("rejects non GET/POST methods", async () => {
    const result = await runSubscriptionSweepCron({ method: "PUT", headers: {} } as never, BASE_ENV, vi.fn() as never);
    expect(result.status).toBe(405);
    expect(result.headers?.allow).toBe("GET, POST");
  });

  it("fails closed when CRON_SECRET is unset", async () => {
    const result = await runSubscriptionSweepCron({ method: "POST", headers: {} } as never, {}, vi.fn() as never);
    expect(result.status).toBe(503);
  });

  it("rejects an invalid bearer token", async () => {
    const result = await runSubscriptionSweepCron(
      { method: "POST", headers: { authorization: "Bearer wrong" } } as never,
      BASE_ENV,
      vi.fn() as never,
    );
    expect(result.status).toBe(401);
  });

  it("skips when the sweep flag is disabled", async () => {
    const factory = vi.fn();
    const result = await runSubscriptionSweepCron(authedReq(), BASE_ENV, factory as never);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: "sweep_disabled" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("sweeps provisional subscriptions and reports the result", async () => {
    const client = fakeClient(async (name: string) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "subscription_sweep_unpaid_provisional") {
        return {
          data: { contractVersion: "commerce.v0", sweep: { count: 2, swept: [
            { subscriptionId: "s1", orderId: "o1" },
            { subscriptionId: "s2", orderId: null },
          ] } },
          error: null,
        };
      }
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory, asService } = fakeGatewayFactory(client);

    const result = await runSubscriptionSweepCron(authedReq(), {
      ...BASE_ENV,
      COMMERCE_SUBSCRIPTION_SWEEP_ENABLED: "true",
      SUBSCRIPTION_ACTIVATION_WINDOW_MINUTES: "90",
    }, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, windowMinutes: 90, swept: 2 });
    expect(asService).toHaveBeenCalledOnce();
    const sweepCall = client.rpc.mock.calls.find(([n]) => n === "subscription_sweep_unpaid_provisional");
    expect(sweepCall).toBeDefined();
    const sweepArgs = sweepCall?.[1] as Record<string, unknown>;
    expect(sweepArgs).toMatchObject({ p_idempotency_prefix: "subscription-sweep-run", p_limit: 50 });
    expect(typeof sweepArgs.p_older_than).toBe("string");
    expect(client.rpc).toHaveBeenCalledWith("platform_finish_job_run_v2", expect.objectContaining({ p_status: "success" }));
  });

  it("no-ops when the job lease is not acquired", async () => {
    const client = fakeClient(async (name: string) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: false, reason: "leased_elsewhere" }], error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory, asService } = fakeGatewayFactory(client);

    const result = await runSubscriptionSweepCron(authedReq(), {
      ...BASE_ENV,
      COMMERCE_SUBSCRIPTION_SWEEP_ENABLED: "true",
    }, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "leased_elsewhere" });
    expect(asService).toHaveBeenCalledOnce();
    expect(client.rpc).not.toHaveBeenCalledWith("subscription_sweep_unpaid_provisional", expect.anything());
  });
});

function authedReq(): VercelRequest {
  return { method: "POST", headers: { authorization: "Bearer s3cr3t-value" } } as never;
}

function fakeClient(impl: (name: string, args?: Record<string, unknown>) => unknown) {
  return { rpc: vi.fn(impl) };
}

function fakeGatewayFactory(client: unknown) {
  const asService = vi.fn(async (callback: (serviceClient: unknown) => unknown) => callback(client));
  const factory = vi.fn(() => ({ asService }));
  return { factory, asService };
}
