import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runSubscriptionAutoResumeCron } from "./subscriptionAutoResumeJob.js";

const BASE_ENV = {
  CRON_SECRET: "secret",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("subscription auto-resume cron", () => {
  it("keeps disabled runs before gateway construction", async () => {
    const factory = vi.fn();

    const result = await runSubscriptionAutoResumeCron(authedReq(), BASE_ENV, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "subscription_auto_resume_disabled" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("runs maintenance RPC and writes ledger metadata through the gateway", async () => {
    const client = fakeClient("subscription_auto_resume_due", {
      data: { ok: true, scanned: 3, resumed: 2, skipped: 1, failed: 0 },
      error: null,
    });
    const { factory, asService } = fakeGatewayFactory(client);

    const result = await runSubscriptionAutoResumeCron(authedReq(), {
      ...BASE_ENV,
      COMMERCE_SUBSCRIPTION_AUTO_RESUME_ENABLED: "true",
    }, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, scanned: 3, resumed: 2 });
    expect(asService).toHaveBeenCalledOnce();
    expect(client.rpc).toHaveBeenCalledWith("subscription_auto_resume_due", { p_limit: 100 });
    expect(client.rpc).toHaveBeenCalledWith("platform_finish_job_run_v2", expect.objectContaining({
      p_job_name: "subscription-auto-resume",
      p_status: "success",
      p_checked: 3,
      p_updated: 2,
      p_metadata: expect.objectContaining({ driver: "vercel_cron", rpc: "subscription_auto_resume_due" }),
    }));
  });

  it("uses the production subscriber-retention binding for the direct bundle", async () => {
    const factory = vi.fn();
    const autoResumeDue = vi.fn(async () => ({
      ok: true, scanned: 2, resumed: 1, skippedRows: 1, failed: 0,
    }));
    const resolver = vi.fn(() => ({
      binding: {
        identity: "node-postgres" as const,
        run: (work: (messaging: { autoResumeDue: typeof autoResumeDue }) => Promise<unknown>) =>
          work({ autoResumeDue }),
      },
    }));

    const result = await runSubscriptionAutoResumeCron(authedReq(), {
      ...BASE_ENV,
      PLATFORM_BUNDLE: "node-postgres",
      DATABASE_URL: "postgres://db",
      COMMERCE_SUBSCRIPTION_AUTO_RESUME_ENABLED: "true",
    }, factory as never, resolver as never);

    expect(result).toEqual({
      status: 200,
      body: { ok: true, scanned: 2, resumed: 1, skippedRows: 1, failed: 0 },
    });
    expect(autoResumeDue).toHaveBeenCalledWith(100);
    expect(factory).not.toHaveBeenCalled();
  });
});

function authedReq(): VercelRequest {
  return { method: "POST", headers: { authorization: "Bearer secret" } } as never;
}

function fakeClient(
  jobRpcName: string,
  jobRpcResult: { data: unknown; error: { code?: string; message?: string } | null },
) {
  return {
    rpc: vi.fn(async (name: string) => {
      if (name === "platform_claim_job_run") {
        return { data: { acquired: true, run_id: "run-1", reason: "claimed" }, error: null };
      }
      if (name === "platform_finish_job_run_v2") {
        return { data: null, error: null };
      }
      if (name === jobRpcName) return jobRpcResult;
      return { data: null, error: { message: `unexpected rpc ${name}` } };
    }),
  };
}

function fakeGatewayFactory(client: unknown) {
  const asService = vi.fn(async (callback: (serviceClient: unknown) => unknown) => callback(client));
  const factory = vi.fn(() => ({ asService }));
  return { factory, asService };
}
