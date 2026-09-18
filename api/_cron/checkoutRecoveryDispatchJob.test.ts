import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runCheckoutRecoveryDispatchCron } from "./checkoutRecoveryDispatchJob.js";

function request(headers: Record<string, string> = {}, method = "GET"): VercelRequest {
  return { method, headers } as unknown as VercelRequest;
}
const authed = () => request({ authorization: "Bearer secret" });

const FULL_ENV = {
  CRON_SECRET: "secret",
  SUPABASE_URL: "https://x.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
  COMMERCE_CHECKOUT_RECOVERY_ENABLED: "true",
};

function fakeClient(rpcImpl: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message?: string } | null }) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve(rpcImpl(name, args));
    },
  };
  return { client, calls };
}

function defaultRpc(enqueue: { enqueued_1h: number; enqueued_20h: number }) {
  return (name: string) => {
    if (name === "platform_claim_job_run") {
      return { data: [{ acquired: true, run_id: "run_1", reason: "ok" }], error: null };
    }
    if (name === "enqueue_checkout_recovery_reminders") {
      return { data: enqueue, error: null };
    }
    return { data: null, error: null };
  };
}

describe("runCheckoutRecoveryDispatchCron — fail-closed guards", () => {
  it("keeps composition free of direct Supabase client construction", () => {
    const source = readFileSync("api/_cron/checkoutRecoveryDispatchJob.ts", "utf8");
    expect(source).not.toMatch(/@supabase\/supabase-js|createClient\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain("resolveCheckoutRecoveryOperationsBinding");
    expect(source).toContain("resolved.binding.run(");
  });

  it("405s a non-GET/POST method", async () => {
    expect((await runCheckoutRecoveryDispatchCron(request({}, "DELETE"), FULL_ENV, vi.fn() as never)).status).toBe(405);
  });

  it("503s when CRON_SECRET is unset", async () => {
    const r = await runCheckoutRecoveryDispatchCron(authed(), { ...FULL_ENV, CRON_SECRET: undefined }, vi.fn() as never);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("cron_secret_required");
  });

  it("401s on a wrong bearer", async () => {
    expect((await runCheckoutRecoveryDispatchCron(request({ authorization: "Bearer nope" }), FULL_ENV, vi.fn() as never)).status).toBe(401);
  });

  it("skips (200) when the flag is not 'true', before any client work", async () => {
    const factory = vi.fn();
    const r = await runCheckoutRecoveryDispatchCron(authed(), { ...FULL_ENV, COMMERCE_CHECKOUT_RECOVERY_ENABLED: "false" }, factory as never);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, skipped: true, reason: "checkout_recovery_disabled" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("503s when supabase env is missing", async () => {
    const r = await runCheckoutRecoveryDispatchCron(authed(), { ...FULL_ENV, SUPABASE_URL: undefined, VITE_SUPABASE_URL: undefined }, vi.fn() as never);
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("supabase_env_required");
  });
});

describe("runCheckoutRecoveryDispatchCron — enqueue", () => {
  it("calls the enqueue RPC and reports the wave counts", async () => {
    const { client, calls } = fakeClient(defaultRpc({ enqueued_1h: 2, enqueued_20h: 1 }));
    const { factory, asService } = fakeGatewayFactory(client);
    const r = await runCheckoutRecoveryDispatchCron(authed(), FULL_ENV, factory as never);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, enqueued1h: 2, enqueued20h: 1 });
    expect(asService).toHaveBeenCalledOnce();
    const enqueueCall = calls.find((c) => c.name === "enqueue_checkout_recovery_reminders");
    expect(enqueueCall?.args).toMatchObject({ p_limit: 200 });
  });

  it("502s when the enqueue RPC errors", async () => {
    const rpc = (name: string) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1", reason: "ok" }], error: null };
      if (name === "enqueue_checkout_recovery_reminders") return { data: null, error: { message: "boom" } };
      return { data: null, error: null };
    };
    const { client } = fakeClient(rpc);
    const { factory, asService } = fakeGatewayFactory(client);
    const r = await runCheckoutRecoveryDispatchCron(authed(), FULL_ENV, factory as never);
    expect(r.status).toBe(502);
    expect(r.body).toMatchObject({ ok: false, reason: "boom" });
    expect(asService).toHaveBeenCalledOnce();
  });

  it("skips (200) when the lease is not acquired", async () => {
    const rpc = (name: string) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: false, run_id: null, reason: "leased" }], error: null };
      return { data: null, error: null };
    };
    const { client } = fakeClient(rpc);
    const { factory, asService } = fakeGatewayFactory(client);
    const r = await runCheckoutRecoveryDispatchCron(authed(), FULL_ENV, factory as never);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, skipped: true });
    expect(asService).toHaveBeenCalledOnce();
  });
});

function fakeGatewayFactory(client: unknown) {
  const asService = vi.fn(async (callback: (serviceClient: unknown) => unknown) => callback(client));
  const factory = vi.fn(() => ({ asService }));
  return { factory, asService };
}
