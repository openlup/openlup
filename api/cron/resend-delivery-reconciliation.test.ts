import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runResendDeliveryReconciliationCron } from "./resend-delivery-reconciliation.js";
import { getResendEmail } from "../../server/infra/resend/resendEmailClient.js";

vi.mock("../../server/infra/resend/resendEmailClient.js", () => ({
  getResendEmail: vi.fn().mockResolvedValue({
    ok: true,
    httpStatus: 200,
    lastEvent: "sent",
    recipientEmail: "sink@example.com",
    providerError: null,
  }),
}));

// The worker is mocked, but it exercises the injected `readEmail` reader once so
// tests can assert which Resend key the poll is issued with.
vi.mock("../../server/domains/communications/resendDeliveryReconciliationWorker.js", () => ({
  runResendDeliveryReconciliation: vi.fn().mockImplementation(async ({ readEmail }: { readEmail: (id: string) => Promise<unknown> }) => {
    await readEmail("re_msg_1");
    return {
      checked: 3,
      reconciled: 2,
      stillPending: 1,
      terminalPolled: 1,
      failures: 0,
      abandoned: 0,
      failureBreakdown: { notFound: 0, authFailed: 0, network: 0, providerError: 0, other: 0 },
    };
  }),
}));

const FULL_ENV = {
  CRON_SECRET: "secret",
  COMMERCE_RESEND_DELIVERY_RECONCILIATION_ENABLED: "true",
  RESEND_API_KEY: "re_key",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service",
};

function authedReq(): VercelRequest {
  return { method: "POST", headers: { authorization: "Bearer secret" }, query: {}, body: {} } as VercelRequest;
}

function fakeGateway(rpcImpl: (name: string) => { data: unknown; error: unknown }) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: vi.fn().mockImplementation((name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve(rpcImpl(name));
    }),
    from: vi.fn(),
  };
  const asService = vi.fn(async <T,>(work: (c: unknown) => Promise<T>) => work(client));
  const factory = vi.fn(() => ({ asActor: vi.fn(), asService }));
  return { factory, calls };
}

describe("resend-delivery-reconciliation cron", () => {
  beforeEach(() => {
    vi.mocked(getResendEmail).mockClear();
  });

  it("requires the cron secret and the env flag", async () => {
    const { factory } = fakeGateway(() => ({ data: {}, error: null }));
    const noSecret = await runResendDeliveryReconciliationCron(authedReq(), { ...FULL_ENV, CRON_SECRET: undefined }, factory as never);
    expect(noSecret.status).toBe(503);

    const disabled = await runResendDeliveryReconciliationCron(
      authedReq(),
      { ...FULL_ENV, COMMERCE_RESEND_DELIVERY_RECONCILIATION_ENABLED: "false" },
      factory as never,
    );
    expect(disabled.body).toMatchObject({ ok: true, skipped: "resend_delivery_reconciliation_disabled" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails closed without the Resend API key", async () => {
    const { factory } = fakeGateway(() => ({ data: {}, error: null }));
    const result = await runResendDeliveryReconciliationCron(authedReq(), { ...FULL_ENV, RESEND_API_KEY: undefined }, factory as never);
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("resend_api_key_required");
  });

  it("fails closed in sandbox mode when the sandbox key is missing", async () => {
    const { factory } = fakeGateway(() => ({ data: {}, error: null }));
    const result = await runResendDeliveryReconciliationCron(
      authedReq(),
      { ...FULL_ENV, RESEND_API_KEY: undefined, RESEND_PROVIDER_MODE: "sandbox", RESEND_SANDBOX_API_KEY: undefined },
      factory as never,
    );
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("resend_api_key_required");
  });

  it("resolves the sandbox key on staging and polls with it (RESEND_API_KEY forbidden there)", async () => {
    const { factory } = fakeGateway((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });

    const result = await runResendDeliveryReconciliationCron(
      authedReq(),
      // Mirrors the hidden-preview runtime: no RESEND_API_KEY, sandbox mode + sandbox key.
      { ...FULL_ENV, RESEND_API_KEY: undefined, RESEND_PROVIDER_MODE: "sandbox", RESEND_SANDBOX_API_KEY: "re_sandbox_key" },
      factory as never,
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, checked: 3, reconciled: 2 });
    // The poll must use the SAME account the message was sent with: the sandbox key.
    expect(getResendEmail).toHaveBeenCalledWith({ apiKey: "re_sandbox_key", resendId: "re_msg_1" });
  });

  it("claims the job lease and records the run in the ledger", async () => {
    const { factory, calls } = fakeGateway((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });

    const result = await runResendDeliveryReconciliationCron(authedReq(), FULL_ENV, factory as never);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, checked: 3, reconciled: 2, stillPending: 1 });
    expect(calls.map((call) => call.name)).toEqual(["platform_claim_job_run", "platform_finish_job_run_v2"]);
    expect(calls[1]?.args).toMatchObject({
      p_status: "success",
      p_checked: 3,
      p_updated: 2,
      p_metadata: expect.objectContaining({
        driver: "vercel_cron",
        stillPending: 1,
        terminalPolled: 1,
        abandoned: 0,
        failureBreakdown: { notFound: 0, authFailed: 0, network: 0, providerError: 0, other: 0 },
      }),
    });
    // Live mode (no provider mode set) polls with RESEND_API_KEY — unchanged behavior.
    expect(getResendEmail).toHaveBeenCalledWith({ apiKey: "re_key", resendId: "re_msg_1" });
  });

  it("no-ops when the lease is held elsewhere", async () => {
    const { factory } = fakeGateway((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: false, reason: "lease_active" }], error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const result = await runResendDeliveryReconciliationCron(authedReq(), FULL_ENV, factory as never);
    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "lease_active" });
  });
});
