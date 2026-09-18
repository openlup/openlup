import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runPaymentProviderReconciliationCron } from "./payment-provider-reconciliation.js";

const FULL_ENV = {
  CRON_SECRET: "s3cr3t-value",
  COMMERCE_PSP_OBSERVABILITY_ENABLED: "true",
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
};

describe("payment-provider-reconciliation cron", () => {
  it("keeps the cron composition free of direct Supabase DB primitives", () => {
    const source = readFileSync("api/cron/payment-provider-reconciliation.ts", "utf8");
    expect(source).not.toMatch(/@supabase\/supabase-js|createClient\s*\(|\.rpc\s*\(|\.from\s*\(/);
    expect(source).toContain("createSupabaseDataGateway");
    expect(source).toContain(".asService(");
    expect(source).toContain("createSupabasePaymentProviderReconciliationPort");
    expect(source).not.toContain("createManagedPaymentControlRuntimePort");
  });

  it("rejects non GET/POST methods", async () => {
    const result = await runPaymentProviderReconciliationCron(request("PUT"), FULL_ENV, vi.fn() as never);
    expect(result.status).toBe(405);
    expect(result.headers?.allow).toBe("GET, POST");
  });

  it("fails closed before gateway work when CRON_SECRET is unset", async () => {
    const factory = vi.fn();
    const result = await runPaymentProviderReconciliationCron(authedReq(), {
      ...FULL_ENV,
      CRON_SECRET: undefined,
    }, factory as never);
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("cron_secret_required");
    expect(factory).not.toHaveBeenCalled();
  });

  it("rejects an invalid bearer token before gateway work", async () => {
    const factory = vi.fn();
    const result = await runPaymentProviderReconciliationCron(request("POST", "Bearer wrong"), FULL_ENV, factory as never);
    expect(result.status).toBe(401);
    expect(factory).not.toHaveBeenCalled();
  });

  it("skips when PSP observability is disabled before gateway work", async () => {
    const factory = vi.fn();
    const result = await runPaymentProviderReconciliationCron(authedReq(), {
      ...FULL_ENV,
      COMMERCE_PSP_OBSERVABILITY_ENABLED: "false",
    }, factory as never);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "psp_observability_disabled" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails closed when Supabase env is missing before gateway work", async () => {
    const factory = vi.fn();
    const result = await runPaymentProviderReconciliationCron(authedReq(), {
      ...FULL_ENV,
      SUPABASE_URL: undefined,
      VITE_SUPABASE_URL: undefined,
    }, factory as never);
    expect(result.status).toBe(503);
    expect(result.body.error).toBe("supabase_env_missing");
    expect(factory).not.toHaveBeenCalled();
  });

  it("fails closed when provider registry construction fails before gateway work", async () => {
    const factory = vi.fn();
    const result = await runPaymentProviderReconciliationCron(
      authedReq(),
      FULL_ENV,
      factory as never,
      () => {
        throw new Error("bad provider env");
      },
    );
    expect(result.status).toBe(503);
    expect(result.body).toMatchObject({ ok: false, error: "provider_registry_failed" });
    expect(factory).not.toHaveBeenCalled();
  });

  it("no-ops when the job lease is not acquired", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: false, reason: "lease_active" }], error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory, asService } = fakeGatewayFactory(client);

    const result = await runPaymentProviderReconciliationCron(authedReq(), FULL_ENV, factory as never, vi.fn(() => ({})));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, skipped: true, reason: "lease_active" });
    expect(asService).toHaveBeenCalledOnce();
    expect(calls.map((call) => call.name)).toEqual(["platform_claim_job_run"]);
  });

  it("claims stale attempts and records a successful job ledger result when there is nothing to correct", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_payment_reconciliation_claim_prepared_attempts") return { data: [], error: null };
      if (name === "commerce_payment_reconciliation_claim_stale_attempts") return { data: [], error: null };
      if (name === "subscription_reconcile_paid_activation_gaps") return { data: { paidActivationGapReconciliation: { enqueued: 0, overdue: 0 } }, error: null };
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory, asService } = fakeGatewayFactory(client);

    const result = await runPaymentProviderReconciliationCron(authedReq(), FULL_ENV, factory as never, vi.fn(() => ({})));

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ ok: true, checked: 0, corrected: 0, providerCalls: 0 });
    expect(asService).toHaveBeenCalledOnce();
    expect(calls.map((call) => call.name)).toEqual([
      "platform_claim_job_run",
      "commerce_payment_reconciliation_claim_prepared_attempts",
      "commerce_payment_reconciliation_claim_stale_attempts",
      "subscription_reconcile_paid_activation_gaps",
      "platform_finish_job_run_v2",
    ]);
    expect(calls[1]?.args).toMatchObject({ p_claim_key: "payment-provider-reconciliation:run_1:prepared" });
    expect(calls[2]?.args).toMatchObject({ p_claim_key: "payment-provider-reconciliation:run_1" });
    expect(calls[4]?.args).toMatchObject({
      p_job_name: "payment-provider-reconciliation",
      p_status: "success",
      p_updated: 0,
    });
    expect(calls[4]?.args?.p_metadata).toMatchObject({
      preparedWithoutProviderAck: 0,
      preparedAttemptsReopened: 0,
    });
  });

  it("imports Stripe payout evidence through the existing accounting RPC in the same leased job", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_payment_reconciliation_claim_prepared_attempts") return { data: [], error: null };
      if (name === "commerce_payment_reconciliation_claim_stale_attempts") return { data: [], error: null };
      if (name === "subscription_reconcile_paid_activation_gaps") return { data: { paidActivationGapReconciliation: { enqueued: 0, overdue: 0 } }, error: null };
      if (name === "accounting_record_payment_settlement") {
        return { data: { settlementItemId: "77777777-7777-4777-8777-777777777777", replayed: false }, error: null };
      }
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);
    const reader = {
      listRecentSettledPayoutItems: vi.fn(async () => [{
        payoutId: "po_1", balanceTransactionId: "txn_1", providerPaymentId: "pi_1",
        grossMinor: 1000, feeMinor: 29, netMinor: 971, currency: "PLN",
        bankReceivedAt: "2026-07-16T10:00:00.000Z",
      }]),
    };

    const result = await runPaymentProviderReconciliationCron(
      authedReq(), FULL_ENV, factory as never, vi.fn(() => ({})), () => reader,
    );

    expect(result.status).toBe(200);
    expect(result.body.stripeSettlement).toEqual({ checked: 1, recorded: 1, replayed: 0 });
    expect(calls.map((call) => call.name)).toEqual([
      "platform_claim_job_run",
      "commerce_payment_reconciliation_claim_prepared_attempts",
      "commerce_payment_reconciliation_claim_stale_attempts",
      "subscription_reconcile_paid_activation_gaps",
      "accounting_record_payment_settlement",
      "platform_finish_job_run_v2",
    ]);
    expect(calls[4]?.args).toMatchObject({
      p_provider_kind: "stripe",
      p_provider_batch_id: "po_1",
      p_provider_payment_id: "pi_1",
      p_payment_intent_id: null,
      p_status: "matched",
    });
  });

  it("does not turn an optional Stripe settlement read failure into a payment-reconciliation failure", async () => {
    const { client } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_payment_reconciliation_claim_prepared_attempts") return { data: [], error: null };
      if (name === "commerce_payment_reconciliation_claim_stale_attempts") return { data: [], error: null };
      if (name === "subscription_reconcile_paid_activation_gaps") return { data: { paidActivationGapReconciliation: { enqueued: 0, overdue: 0 } }, error: null };
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);

    const result = await runPaymentProviderReconciliationCron(
      authedReq(), FULL_ENV, factory as never, vi.fn(() => ({})),
      () => ({ listRecentSettledPayoutItems: vi.fn(async () => { throw new Error("stripe_payout_read_failed"); }) }),
    );

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      ok: true,
      stripeSettlement: { failed: true, reason: "stripe_payout_read_failed" },
    });
  });

  it("fails the leased job when the paid-activation scanner or outbox enqueue fails", async () => {
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_payment_reconciliation_claim_prepared_attempts") return { data: [], error: null };
      if (name === "commerce_payment_reconciliation_claim_stale_attempts") return { data: [], error: null };
      if (name === "subscription_reconcile_paid_activation_gaps") {
        return { data: null, error: { message: "activation_gap_scan_failed" } };
      }
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);

    const result = await runPaymentProviderReconciliationCron(
      authedReq(), FULL_ENV, factory as never, vi.fn(() => ({})),
    );

    expect(result.status).toBe(500);
    expect(result.body).toMatchObject({
      ok: false,
      error: "payment_provider_reconciliation_failed",
      reason: expect.stringContaining("activation_gap_scan_failed"),
    });
    expect(calls.at(-1)).toMatchObject({
      name: "platform_finish_job_run_v2",
      args: { p_status: "failed" },
    });
  });

  it("does not auto-reopen prepared attempts unless COMMERCE_PSP_PREPARED_ABSENCE_AUTO_REOPEN_ENABLED is true", async () => {
    // A stranded prepared attempt (created, no provider refs, 60 min old) with
    // the flag ABSENT: the run records evidence but never calls the reopen RPC.
    const preparedRow = {
      payment_attempt_id: "11111111-1111-4111-8111-111111111111",
      payment_intent_id: "22222222-2222-4222-8222-222222222222",
      payment_id: "33333333-3333-4333-8333-333333333333",
      order_id: "44444444-4444-4444-8444-444444444444",
      subscription_id: "55555555-5555-4555-8555-555555555555",
      subscription_cycle_id: "66666666-6666-4666-8666-666666666666",
      provider: "stripe",
      provider_payment_id: null,
      provider_attempt_id: null,
      provider_session_id: null,
      attempt_status: "created",
      intent_status: "processing",
      amount_cents: 1200,
      currency: "PLN",
      order_mode: "subscription_cycle",
      cycle_retry_attempt: 0,
      cycle_next_retry_at: null,
      local_updated_at: "2020-01-01T00:00:00.000Z",
    };
    const { client, calls } = fakeClient((name) => {
      if (name === "platform_claim_job_run") return { data: [{ acquired: true, run_id: "run_1" }], error: null };
      if (name === "commerce_payment_reconciliation_claim_prepared_attempts") return { data: [preparedRow], error: null };
      if (name === "commerce_payment_reconciliation_claim_stale_attempts") return { data: [], error: null };
      if (name === "subscription_reconcile_paid_activation_gaps") return { data: { paidActivationGapReconciliation: { enqueued: 0, overdue: 0 } }, error: null };
      if (name === "commerce_payment_control_record_reconciliation") {
        return { data: { paymentReconciliation: { recorded: true } }, error: null };
      }
      if (name === "platform_finish_job_run_v2") return { data: {}, error: null };
      throw new Error(`unexpected rpc ${name}`);
    });
    const { factory } = fakeGatewayFactory(client);

    const result = await runPaymentProviderReconciliationCron(authedReq(), FULL_ENV, factory as never, vi.fn(() => ({})));

    expect(result.status).toBe(502); // stranded attempt keeps the run red
    expect(result.body).toMatchObject({ preparedWithoutProviderAck: 1, preparedAttemptsReopened: 0 });
    expect(calls.map((call) => call.name)).not.toContain(
      "commerce_payment_control_reopen_prepared_attempt_after_absence",
    );
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
