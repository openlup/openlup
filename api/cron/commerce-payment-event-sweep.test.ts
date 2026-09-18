import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runCommercePaymentEventSweepCron } from "./commerce-payment-event-sweep.js";

const FULL_ENV = {
  CRON_SECRET: "s3cr3t-value",
  COMMERCE_PAYMENT_EVENT_SWEEP_ENABLED: "true",
  COMMERCE_PAYMENT_EVENT_SWEEP_GRACE_MINUTES: "120",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("commerce-payment-event-sweep cron", () => {
  it("keeps the cron composition free of direct Supabase DB primitives", () => {
    const source = readFileSync("api/cron/commerce-payment-event-sweep.ts", "utf8");
    expect(source).not.toMatch(/@supabase\/supabase-js|createClient\s*\(|\.rpc\s*\(|\.from\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain(".asService(");
    expect(source).toContain("createSupabasePaymentEventSweepPort");
  });

  it("rejects non GET/POST methods", async () => {
    const result = await runCommercePaymentEventSweepCron(request("PUT"), FULL_ENV, vi.fn() as never);
    expect(result.status).toBe(405);
    expect(result.headers?.allow).toBe("GET, POST");
  });

  it("fails closed before gateway work when CRON_SECRET is unset", async () => {
    const factory = vi.fn();
    const result = await runCommercePaymentEventSweepCron(authedReq(), { ...FULL_ENV, CRON_SECRET: undefined }, factory as never);
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("cron_secret_required");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token before gateway work", async () => {
    const factory = vi.fn();
    const result = await runCommercePaymentEventSweepCron(request("POST", "Bearer wrong"), FULL_ENV, factory as never);
    expect(result.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it("skips when the sweep flag is disabled before gateway work", async () => {
    const factory = vi.fn();
    const result = await runCommercePaymentEventSweepCron(
      authedReq(),
      { ...FULL_ENV, COMMERCE_PAYMENT_EVENT_SWEEP_ENABLED: "false" },
      factory as never,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: "sweep_disabled", eventsIgnored: 0 });
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase env is missing before gateway work", async () => {
    const factory = vi.fn();
    const result = await runCommercePaymentEventSweepCron(
      authedReq(),
      { ...FULL_ENV, SUPABASE_URL: undefined, VITE_SUPABASE_URL: undefined },
      factory as never,
    );
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("supabase_env_missing");
    expect(factory).not.toHaveBeenCalled();
  });

  it("sweeps orphan events and records job ledger success with one service client", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_sweep_orphan_payment_events") {
        return { data: { contractVersion: "commerce.v0", orphanEventSweep: { eventsIgnored: 7 } }, error: null };
      }
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory, asService } = fakeGatewayFactory(client);

    const result = await runCommercePaymentEventSweepCron(authedReq(), FULL_ENV, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, graceMinutes: 120, eventsIgnored: 7, staleSetupReceived: 0 });
    expect(asService).toHaveBeenCalledOnce();
    expect(calls.map((call) => call.name)).toEqual([
      "platform_claim_job_run",
      "commerce_sweep_orphan_payment_events",
      "platform_finish_job_run_v2",
    ]);
    expect(calls[1]?.args).toMatchObject({
      p_idempotency_prefix: "commerce-payment-event-sweep-run",
      p_grace_minutes: 120,
      p_limit: 200,
    });
    expect(calls[2]?.args).toMatchObject({
      p_status: "success",
      p_metadata: expect.objectContaining({ driver: "vercel_cron", eventsIgnored: 7, staleSetupReceived: 0 }),
    });
  });

  it("surfaces stale received setup events in the response, job metadata and error log", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { client, calls } = fakeClient((name) => {
        if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
        if (name === "commerce_sweep_orphan_payment_events") {
          return {
            data: { contractVersion: "commerce.v0", orphanEventSweep: { eventsIgnored: 0, staleSetupReceived: 3 } },
            error: null,
          };
        }
        if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
        throw new Error(`unexpected rpc ${name}`);
      });
      const { factory } = fakeGatewayFactory(client);

      const result = await runCommercePaymentEventSweepCron(authedReq(), FULL_ENV, factory as never);

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true, staleSetupReceived: 3 });
      expect(calls.at(-1)?.args).toMatchObject({
        p_status: "success",
        p_metadata: expect.objectContaining({ staleSetupReceived: 3 }),
      });
      expect(errorSpy).toHaveBeenCalledWith(
        "[cron/commerce-payment-event-sweep] stale received setup events",
        expect.objectContaining({ staleSetupReceived: 3 }),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("no-ops when the job lease is not acquired", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: false, reason: "leased_elsewhere" }], error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);

    const result = await runCommercePaymentEventSweepCron(authedReq(), FULL_ENV, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "leased_elsewhere" });
    expect(calls.find((call) => call.name === "commerce_sweep_orphan_payment_events")).toBeUndefined();
  });

  it("records a failed job run when the sweep RPC fails", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_sweep_orphan_payment_events") return { data: null, error: { message: "boom" } };
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);

    const result = await runCommercePaymentEventSweepCron(authedReq(), FULL_ENV, factory as never);

    expect(result.status).toBe(500);
    expect(result.body.error).toBe("rpc_failed");
    expect(calls.at(-1)).toMatchObject({
      name: "platform_finish_job_run_v2",
      args: expect.objectContaining({ p_status: "failed", p_error: "rpc_sweep: boom" }),
    });
  });
});

function request(method = "POST", authorization = "Bearer s3cr3t-value"): VercelRequest {
  return { method, headers: { authorization } } as never;
}

function authedReq(): VercelRequest {
  return request();
}

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

function fakeGatewayFactory(client: unknown) {
  const asService = vi.fn(async (callback: (serviceClient: unknown) => unknown) => callback(client));
  const factory = vi.fn(() => ({ asService }));
  return { factory, asService };
}
