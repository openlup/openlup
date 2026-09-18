import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runCommerceReservationSweepCron } from "./commerce-reservation-sweep.js";

const FULL_ENV = {
  CRON_SECRET: "s3cr3t-value",
  COMMERCE_RESERVATION_SWEEP_ENABLED: "true",
  COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES: "1440",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("commerce-reservation-sweep cron", () => {
  it("keeps the cron composition free of direct Supabase DB primitives", () => {
    const source = readFileSync("api/cron/commerce-reservation-sweep.ts", "utf8");
    expect(source).not.toMatch(/@supabase\/supabase-js|createClient\s*\(|\.rpc\s*\(|\.from\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain(".asService(");
    expect(source).toContain("createManagedReservationSweepPort");
  });

  it("rejects GET so a scheduler cannot invoke the manual repair surface", async () => {
    const result = await runCommerceReservationSweepCron(request("GET"), FULL_ENV, vi.fn() as never);
    expect(result.status).toBe(405);
    expect(result.headers?.allow).toBe("POST");
  });

  it("fails closed before gateway work when CRON_SECRET is unset", async () => {
    const factory = vi.fn();
    const result = await runCommerceReservationSweepCron(authedReq(), { ...FULL_ENV, CRON_SECRET: undefined }, factory as never);
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("cron_secret_required");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token before gateway work", async () => {
    const factory = vi.fn();
    const result = await runCommerceReservationSweepCron(request("POST", "Bearer wrong"), FULL_ENV, factory as never);
    expect(result.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it("skips when the sweep flag is disabled before gateway work", async () => {
    const factory = vi.fn();
    const result = await runCommerceReservationSweepCron(
      authedReq(),
      { ...FULL_ENV, COMMERCE_RESERVATION_SWEEP_ENABLED: "false" },
      factory as never,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: "sweep_disabled", ordersExpired: 0 });
    // Byte-exact key set: the disabled body must NOT leak windowMinutes (only the
    // success body carries it). toMatchObject above is partial and would miss a stray key.
    expect(Object.keys(result.body).sort()).toEqual([
      "ok",
      "ordersChecked",
      "ordersExpired",
      "reservationsReleased",
      "skipped",
      "skippedPaid",
      "skippedSubscription",
      "skippedTerminal",
    ]);
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase env is missing before gateway work", async () => {
    const factory = vi.fn();
    const result = await runCommerceReservationSweepCron(
      authedReq(),
      { ...FULL_ENV, SUPABASE_URL: undefined, VITE_SUPABASE_URL: undefined },
      factory as never,
    );
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("supabase_env_missing");
    expect(factory).not.toHaveBeenCalled();
  });

  it("sweeps expired reservation holds and records job ledger success with one service client", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_sweep_expired_reservation_holds") {
        return {
          data: {
            contractVersion: "commerce.v0",
            sweep: {
              ordersChecked: 3,
              ordersExpired: 1,
              reservationsReleased: 2,
              skippedPaid: 1,
              skippedTerminal: 0,
              skippedSubscription: 1,
            },
          },
          error: null,
        };
      }
      if (name === "commerce_sweep_expired_retry_holds") {
        return {
          data: {
            contractVersion: "commerce.v0",
            retrySweep: { holdsChecked: 4, holdsReleased: 4, skippedPaid: 0, swept: [] },
          },
          error: null,
        };
      }
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory, asService } = fakeGatewayFactory(client);

    const result = await runCommerceReservationSweepCron(authedReq(), FULL_ENV, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      windowMinutes: 1440,
      ordersChecked: 3,
      reservationsReleased: 2,
      retrySweep: { holdsChecked: 4, holdsReleased: 4, skippedPaid: 0 },
    });
    expect(asService).toHaveBeenCalledOnce();
    expect(calls.map((call) => call.name)).toEqual([
      "platform_claim_job_run",
      "commerce_sweep_expired_reservation_holds",
      "commerce_sweep_expired_retry_holds",
      "platform_finish_job_run_v2",
    ]);
    expect(calls[1]?.args).toMatchObject({
      p_idempotency_prefix: "commerce-reservation-sweep-run",
      p_limit: 50,
    });
    expect(calls[0]?.args).toMatchObject({
      p_driver: "manual_admin",
      p_metadata: expect.objectContaining({
        driver: "manual_admin",
        triggerSource: "manual_admin",
      }),
    });
    expect(calls[2]?.args).toMatchObject({ p_limit: 50 });
    expect(calls[3]?.args).toMatchObject({
      p_status: "success",
      p_checked: 7,
      p_updated: 5,
      p_metadata: expect.objectContaining({
        driver: "manual_admin",
        invocationSource: "authenticated_manual_repair",
        reservationsReleased: 2,
        retryHoldsReleased: 4,
      }),
    });
  });

  it("no-ops when the job lease is not acquired", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: false, reason: "leased_elsewhere" }], error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);

    const result = await runCommerceReservationSweepCron(authedReq(), FULL_ENV, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "leased_elsewhere" });
    expect(calls.find((call) => call.name === "commerce_sweep_expired_reservation_holds")).toBeUndefined();
  });

  it("records a failed job run when the sweep RPC fails", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_sweep_expired_reservation_holds") return { data: null, error: { message: "boom" } };
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);

    const result = await runCommerceReservationSweepCron(authedReq(), FULL_ENV, factory as never);

    expect(result.status).toBe(500);
    expect(result.body.error).toBe("rpc_failed");
    expect(calls.at(-1)).toMatchObject({
      name: "platform_finish_job_run_v2",
      args: expect.objectContaining({
        p_status: "failed",
        p_error: "rpc_sweep: boom",
        p_metadata: expect.objectContaining({
          driver: "manual_admin",
          invocationSource: "authenticated_manual_repair",
        }),
      }),
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
