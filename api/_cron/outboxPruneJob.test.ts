import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { OUTBOX_PRUNE_JOB_NAME, runOutboxPruneCron } from "./outboxPruneJob.js";

const ENV = {
  CRON_SECRET: "secret",
  COMMERCE_OUTBOX_PRUNE_ENABLED: "true",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
};

function request(headers: Record<string, string> = {}, method = "POST"): VercelRequest {
  return { method, headers, query: {} } as VercelRequest;
}

function authed(): VercelRequest {
  return request({ authorization: "Bearer secret" });
}

function client(script: (name: string, args: Record<string, unknown>) => { data: unknown; error: { message?: string } | null }) {
  return {
    rpc: vi.fn(async (name: string, args: Record<string, unknown>) => script(name, args)),
  };
}

describe("outbox prune cron", () => {
  it("keeps composition free of direct Supabase client construction", () => {
    const source = readFileSync("api/_cron/outboxPruneJob.ts", "utf8");
    expect(source).not.toMatch(/@supabase\/supabase-js|createClient\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain("resolveCheckoutRecoveryOperationsBinding");
    expect(source).toContain("resolved.binding.run(");
  });

  it("rejects unauthorized requests before client creation", async () => {
    const clientFactory = vi.fn();

    await expect(
      runOutboxPruneCron(request({ authorization: "Bearer wrong" }), ENV, clientFactory as never),
    ).resolves.toEqual({ status: 401, body: { ok: false, error: "unauthorized" } });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("skips before client creation when the prune flag is off", async () => {
    const clientFactory = vi.fn();

    await expect(
      runOutboxPruneCron(authed(), { CRON_SECRET: "secret" }, clientFactory as never),
    ).resolves.toEqual({
      status: 200,
      body: { ok: true, skipped: true, reason: "outbox_prune_disabled" },
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("fails closed before client creation when Supabase env is missing", async () => {
    const clientFactory = vi.fn();

    await expect(
      runOutboxPruneCron(authed(), {
        CRON_SECRET: "secret",
        COMMERCE_OUTBOX_PRUNE_ENABLED: "true",
      }, clientFactory as never),
    ).resolves.toEqual({ status: 503, body: { ok: false, error: "supabase_env_required" } });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it("skips without pruning when the platform job lease is not acquired", async () => {
    const fake = client((name) => {
      if (name === "platform_claim_job_run") {
        return { data: [{ acquired: false, run_id: null, reason: "job_disabled" }], error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    });

    const { factory, asService } = fakeGatewayFactory(fake);
    const result = await runOutboxPruneCron(authed(), ENV, factory as never);

    expect(result).toEqual({
      status: 200,
      body: { ok: true, skipped: true, reason: "job_disabled", run_id: null },
    });
    expect(asService).toHaveBeenCalledOnce();
    expect(fake.rpc).not.toHaveBeenCalledWith("outbox_prune", expect.anything());
  });

  it("claims the ledger, prunes, and finishes success", async () => {
    const fake = client((name) => {
      if (name === "platform_claim_job_run") {
        return { data: [{ acquired: true, run_id: "run-1", reason: "claimed" }], error: null };
      }
      if (name === "outbox_prune") {
        return { data: { compacted: 3, processed: 2, discarded: 1 }, error: null };
      }
      if (name === "communication_email_deliveries_prune") {
        return { data: { stale_deleted: 5, orphan_deleted: 2, limit: 500 }, error: null };
      }
      if (name === "platform_finish_job_run_v2") {
        return { data: true, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory, asService } = fakeGatewayFactory(fake);
    const result = await runOutboxPruneCron(authed(), ENV, factory as never);

    expect(result).toEqual({
      status: 200,
      body: { ok: true, compacted: 3, processed: 2, discarded: 1, staleDeleted: 5, orphanDeleted: 2 },
    });
    expect(asService).toHaveBeenCalledOnce();
    expect(fake.rpc).toHaveBeenCalledWith("platform_claim_job_run", expect.objectContaining({
      p_job_name: OUTBOX_PRUNE_JOB_NAME,
      p_driver: "vercel_cron",
    }));
    expect(fake.rpc).toHaveBeenCalledWith("outbox_prune", { p_limit: 500 });
    expect(fake.rpc).toHaveBeenCalledWith("communication_email_deliveries_prune", { p_limit: 500 });
    expect(fake.rpc).toHaveBeenCalledWith("platform_finish_job_run_v2", expect.objectContaining({
      p_job_name: OUTBOX_PRUNE_JOB_NAME,
      p_checked: 3,
      p_updated: 3,
      p_status: "success",
      p_metadata: expect.objectContaining({ compacted: 3, processed: 2, discarded: 1, staleDeleted: 5, orphanDeleted: 2 }),
    }));
  });

  it("logs delivery prune RPC failures without failing the main prune job", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fake = client((name) => {
      if (name === "platform_claim_job_run") {
        return { data: [{ acquired: true, run_id: "run-1", reason: "claimed" }], error: null };
      }
      if (name === "outbox_prune") {
        return { data: { compacted: 3, processed: 2, discarded: 1 }, error: null };
      }
      if (name === "communication_email_deliveries_prune") {
        return { data: null, error: { message: "delivery boom" } };
      }
      if (name === "platform_finish_job_run_v2") {
        return { data: true, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(fake);

    const result = await runOutboxPruneCron(authed(), ENV, factory as never);

    expect(result).toEqual({
      status: 200,
      body: { ok: true, compacted: 3, processed: 2, discarded: 1, staleDeleted: 0, orphanDeleted: 0 },
    });
    expect(consoleSpy).toHaveBeenCalledWith("[outbox-prune] deliveries_prune_failed", "delivery boom");
    consoleSpy.mockRestore();
  });

  it("finishes failed and returns 502 when the prune RPC fails", async () => {
    const fake = client((name) => {
      if (name === "platform_claim_job_run") {
        return { data: [{ acquired: true, run_id: "run-1", reason: "claimed" }], error: null };
      }
      if (name === "outbox_prune") {
        return { data: null, error: { message: "boom" } };
      }
      if (name === "communication_email_deliveries_prune") {
        return { data: { stale_deleted: 0, orphan_deleted: 0, limit: 500 }, error: null };
      }
      if (name === "platform_finish_job_run_v2") {
        return { data: true, error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    });

    const { factory, asService } = fakeGatewayFactory(fake);
    const result = await runOutboxPruneCron(authed(), ENV, factory as never);

    expect(result.status).toBe(502);
    expect(result.body).toMatchObject({ ok: false, reason: "boom" });
    expect(asService).toHaveBeenCalledOnce();
    expect(fake.rpc).toHaveBeenCalledWith("platform_finish_job_run_v2", expect.objectContaining({
      p_status: "failed",
      p_error: "boom",
      p_checked: 0,
      p_updated: 0,
    }));
  });
});

function fakeGatewayFactory(serviceClient: unknown) {
  const asService = vi.fn(async (callback: (client: unknown) => unknown) => callback(serviceClient));
  const factory = vi.fn(() => ({ asService }));
  return { factory, asService };
}
