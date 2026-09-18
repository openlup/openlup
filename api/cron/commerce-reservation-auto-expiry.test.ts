import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runCommerceReservationAutoExpiryCron } from "./commerce-reservation-auto-expiry.js";

const FULL_ENV = {
  CRON_SECRET: "s3cr3t-value",
  COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED: "true",
  COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES: "1440",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("commerce-reservation-auto-expiry cron", () => {
  it("keeps the cron composition free of direct Supabase DB primitives", () => {
    const source = readFileSync("api/cron/commerce-reservation-auto-expiry.ts", "utf8");
    expect(source).not.toMatch(/@supabase\/supabase-js|createClient\s*\(|\.rpc\s*\(|\.from\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain(".asService(");
    expect(source).toContain("createManagedReservationSweepPort");
  });

  it("rejects non GET/POST methods", async () => {
    const result = await runCommerceReservationAutoExpiryCron(request("PUT"), FULL_ENV, vi.fn() as never);
    expect(result.status).toBe(405);
    expect(result.headers?.allow).toBe("GET, POST");
  });

  it("fails closed before gateway work when CRON_SECRET is unset", async () => {
    const factory = vi.fn();
    const result = await runCommerceReservationAutoExpiryCron(authedReq(), { ...FULL_ENV, CRON_SECRET: undefined }, factory as never);
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("cron_secret_required");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token before gateway work", async () => {
    const factory = vi.fn();
    const result = await runCommerceReservationAutoExpiryCron(request("GET", "Bearer wrong"), FULL_ENV, factory as never);
    expect(result.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it("skips when the auto-expiry flag is disabled before gateway work", async () => {
    const factory = vi.fn();
    const result = await runCommerceReservationAutoExpiryCron(
      authedReq(),
      { ...FULL_ENV, COMMERCE_RESERVATION_AUTO_EXPIRY_ENABLED: "false" },
      factory as never,
    );
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      skipped: "reservation_auto_expiry_disabled",
      ordersExpired: 0,
      retrySweep: { holdsReleased: 0 },
    });
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase env is missing before gateway work", async () => {
    const factory = vi.fn();
    const result = await runCommerceReservationAutoExpiryCron(
      authedReq(),
      { ...FULL_ENV, SUPABASE_URL: undefined, VITE_SUPABASE_URL: undefined },
      factory as never,
    );
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("supabase_env_missing");
    expect(factory).not.toHaveBeenCalled();
  });

  it("expires abandoned checkout holds and records job ledger success with one service client", async () => {
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

    const result = await runCommerceReservationAutoExpiryCron(request("GET"), FULL_ENV, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      windowMinutes: 1440,
      ordersChecked: 3,
      ordersExpired: 1,
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
    expect(calls[0]?.args).toMatchObject({
      p_job_name: "commerce-reservation-auto-expiry",
      p_driver: "vercel_cron",
    });
    expect(calls[1]?.args).toMatchObject({
      p_idempotency_prefix: "commerce-reservation-sweep-run",
      p_limit: 50,
    });
    expect(calls[2]?.args).toMatchObject({ p_limit: 50 });
    expect(calls[3]?.args).toMatchObject({
      p_status: "success",
      p_checked: 7,
      p_updated: 5,
      p_metadata: expect.objectContaining({
        driver: "vercel_cron",
        invocationSource: "scheduled_abandoned_checkout_expiry",
        windowMinutes: 1440,
        reservationsReleased: 2,
        retryHoldsReleased: 4,
      }),
    });
  });

  it("clamps the reported auto-expiry window to 24-36h", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_sweep_expired_reservation_holds") {
        return {
          data: { contractVersion: "commerce.v0", sweep: zeroSweepResult() },
          error: null,
        };
      }
      if (name === "commerce_sweep_expired_retry_holds") {
        return {
          data: { contractVersion: "commerce.v0", retrySweep: zeroRetrySweepResult() },
          error: null,
        };
      }
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);

    const tooShort = await runCommerceReservationAutoExpiryCron(
      request("GET"),
      { ...FULL_ENV, COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES: "60" },
      factory as never,
    );
    expect(tooShort.body.windowMinutes).toBe(1440);
    expect(calls.at(-1)?.args.p_metadata).toMatchObject({ windowMinutes: 1440 });

    const tooLong = await runCommerceReservationAutoExpiryCron(
      request("GET"),
      { ...FULL_ENV, COMMERCE_CHECKOUT_RESERVATION_TTL_MINUTES: "3000" },
      factory as never,
    );
    expect(tooLong.body.windowMinutes).toBe(2160);
    expect(calls.at(-1)?.args.p_metadata).toMatchObject({ windowMinutes: 2160 });
  });

  it("no-ops when the job lease is not acquired", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: false, reason: "leased_elsewhere" }], error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);

    const result = await runCommerceReservationAutoExpiryCron(authedReq(), FULL_ENV, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "leased_elsewhere" });
    expect(calls.find((call) => call.name === "commerce_sweep_expired_reservation_holds")).toBeUndefined();
  });

  it("records a failed job run when the checkout sweep RPC fails", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_sweep_expired_reservation_holds") return { data: null, error: { message: "boom" } };
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);

    const result = await runCommerceReservationAutoExpiryCron(authedReq(), FULL_ENV, factory as never);

    expect(result.status).toBe(500);
    expect(result.body.error).toBe("rpc_failed");
    expect(calls.at(-1)).toMatchObject({
      name: "platform_finish_job_run_v2",
      args: expect.objectContaining({
        p_status: "failed",
        p_error: "rpc_sweep: boom",
        p_metadata: expect.objectContaining({
          driver: "vercel_cron",
          invocationSource: "scheduled_abandoned_checkout_expiry",
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

function zeroSweepResult() {
  return {
    ordersChecked: 0,
    ordersExpired: 0,
    reservationsReleased: 0,
    skippedPaid: 0,
    skippedTerminal: 0,
    skippedSubscription: 0,
  };
}

function zeroRetrySweepResult() {
  return {
    holdsChecked: 0,
    holdsReleased: 0,
    skippedPaid: 0,
  };
}
