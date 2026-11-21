import { createPostgresProviderPaymentRail, runPaymentProviderReconciliationWorker } from "@openlup/platform/payments";
import type { PaymentAdapter, ProviderReconciliationStatus } from "@openlup/platform/payments/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { paymentProviderCapabilityDescriptors, paymentProviderCapabilityRegistry } from "../../server/adapters/paymentProviderCapabilityRegistry.js";
import type { VercelRequest } from "../../server/_lib/types/vercel.js";
import { runPaymentProviderReconciliationCron } from "./payment-provider-reconciliation.js";

const NOW = "2024-05-11T10:00:00.000Z";
const OLD = "2024-05-10T08:00:00.000Z";
const KEY = "payment-provider-reconciliation:fixture-job";
const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const INTENT = "22222222-2222-4222-8222-222222222222";
const PAYMENT = "33333333-3333-4333-8333-333333333333";
const ORDER = "44444444-4444-4444-8444-444444444444";
const RECEIPT = "55555555-5555-4555-8555-555555555555";
const capability = paymentProviderCapabilityDescriptors[0];
const provider = capability.providerKind;
const remote = "synthetic-readback-reference";

const claim = {
  payment_attempt_id: ATTEMPT, payment_intent_id: INTENT, payment_id: PAYMENT, order_id: ORDER,
  provider, provider_payment_id: remote, provider_attempt_id: remote, provider_session_id: null,
  attempt_status: "processing", intent_status: "processing", amount_cents: 1200, currency: "XTS",
  subscription_id: null, subscription_cycle_id: null, order_mode: "one_time",
  cycle_retry_attempt: 0, cycle_next_retry_at: null, local_updated_at: OLD,
};

const pending: ProviderReconciliationStatus = {
  status: "pending", providerStatus: "processing", occurredAt: null,
  failureReason: null, amountMinor: 1200, currency: "XTS", rawPayload: { synthetic: true },
};
const capture: ProviderReconciliationStatus = {
  ...pending, status: "succeeded", providerStatus: "paid", occurredAt: OLD,
  capturedAmountBasis: "provider_capture_v1",
};

const preparedClaim = "commerce_payment_reconciliation_claim_prepared_attempts";
const staleClaim = "commerce_payment_reconciliation_claim_stale_attempts";
const recordEvidence = "commerce_payment_control_record_reconciliation";
const applyResult = "commerce_payment_control_apply_reconciliation_result";
const finishJob = "platform_finish_job_run_v2";

const expectedEvidence = {
  source: "payment-provider-reconciliation.v0",
  provider, providerPaymentId: remote, paymentIntentId: INTENT, paymentAttemptId: ATTEMPT,
  orderId: ORDER, subscriptionId: null, subscriptionCycleId: null,
  localAttemptStatus: "processing", localIntentStatus: "processing",
  failureReason: null, amountMinorPresent: true, currency: "XTS", providerPayload: { synthetic: true },
};

function readback(status: ProviderReconciliationStatus, steps: string[]) {
  return {
    [provider]: {
      async readPayment({ providerPaymentId }: { providerPaymentId: string }) {
        expect(providerPaymentId).toBe(remote);
        steps.push("provider:read");
        return status;
      },
    },
  };
}

function applied() {
  return {
    paymentReconciliationApply: {
      paymentReconciliation: { id: RECEIPT },
      correctionStatus: "corrected",
      replayed: true,
      paymentResult: { paymentIntentId: INTENT, paymentAttemptId: ATTEMPT, paymentId: PAYMENT,
        orderId: ORDER, status: "succeeded", kind: "replayed", replayed: true },
      subscriptionWebhookDunning: null,
    },
  };
}

async function runManaged(status: ProviderReconciliationStatus) {
  const steps: string[] = [];
  const calls = new Map<string, Record<string, unknown>>();
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      steps.push(name);
      calls.set(name, args);
      switch (name) {
        case "platform_claim_job_run": return { data: [{ acquired: true, run_id: "fixture-job" }], error: null };
        case preparedClaim: return { data: [], error: null };
        case staleClaim: return { data: [claim], error: null };
        case recordEvidence: return { data: { paymentReconciliation: { id: RECEIPT } }, error: null };
        case applyResult: return { data: applied(), error: null };
        case "subscription_reconcile_paid_activation_gaps":
          return { data: { paidActivationGapReconciliation: { enqueued: 0, overdue: 0 } }, error: null };
        case finishJob: return { data: {}, error: null };
        default: throw new Error(`Unexpected managed call ${name}`);
      }
    },
  };
  const asService = async <T>(use: (serviceClient: typeof client) => Promise<T>) => use(client);
  const env = {
    PLATFORM_BUNDLE: "vercel-supabase",
    CRON_SECRET: "fixture-job-authorization",
    COMMERCE_PSP_OBSERVABILITY_ENABLED: "true",
    SUPABASE_URL: "https://database.example.invalid",
    SUPABASE_SERVICE_ROLE_KEY: "fixture-service-role",
  };
  const request = { method: "POST", headers: { authorization: `Bearer ${env.CRON_SECRET}` } } as VercelRequest;
  const response = await runPaymentProviderReconciliationCron(request, env, (() => ({ asService })) as never,
    () => readback(status, steps), () => null);
  return { response, steps, calls };
}

function unexpected(): never { throw new Error("Unexpected provider capability call"); }

async function runNative(status: ProviderReconciliationStatus) {
  const steps: string[] = [];
  const calls = new Map<string, unknown[]>();
  const adapter: PaymentAdapter = {
    capabilities: {
      ...capability, captureFlows: [], supportedCurrencies: ["XTS"],
      unattended: "unsupported", readback: "supported", close: "unsupported", exactAbsence: "unsupported",
      refundObservation: "unsupported", refundCreate: "unsupported", authorizationCaptureSplit: "unsupported",
    },
    attemptPort: { validateInput: unexpected, execute: unexpected },
    verifyPort: { verifyAndNormalize: unexpected },
    readbackPort: { readPayment: unexpected },
  };
  const executor = {
    async query(text: string, values: unknown[]) {
      const name = /public\.(\w+)\(/u.exec(text)?.[1];
      if (!name) throw new Error(`Unexpected SQL statement ${text}`);
      steps.push(name);
      calls.set(name, values);
      switch (name) {
        case preparedClaim: return { rows: [] };
        case staleClaim: return { rows: [claim] };
        case recordEvidence: return { rows: [{ response: { paymentReconciliation: { id: RECEIPT } } }] };
        case applyResult: return { rows: [{ response: applied() }] };
        default: throw new Error(`Unexpected native call ${name}`);
      }
    },
  };
  const rail = createPostgresProviderPaymentRail({
    executor, adapter, mode: "test", resolveMethodOwner: unexpected, resolveSavedMethodOwner: unexpected,
    truth: { dunningTemplateSlug: "fixture-dunning", recoveryUrlPath: "/fixture/recovery", recoveryTemplateSlug: "fixture-recovery" },
  });
  const result = await runPaymentProviderReconciliationWorker({
    port: rail.reconciliation, providers: readback(status, steps), capabilities: paymentProviderCapabilityRegistry,
    now: NOW, claimKey: KEY,
  });
  return { result, steps, calls };
}

describe("managed cron and installed PostgreSQL reconciliation", () => {
  beforeEach(() => vi.useFakeTimers({ now: new Date(NOW), toFake: ["Date"] }));
  afterEach(() => vi.useRealTimers());

  it("orders claims and provider observation alike and records the same nonterminal evidence", async () => {
    const managed = await runManaged(pending);
    const native = await runNative(pending);
    expect(managed.response.status).toBe(200);
    const counts = { pending: 1, silenceOverdue: 1, manualReview: 1, corrected: 0, providerCalls: 1 };
    expect(managed.response.body).toMatchObject(counts);
    expect(native.result).toMatchObject(counts);

    expect(native.steps).toEqual([preparedClaim, staleClaim, "provider:read", recordEvidence]);
    expect(managed.steps).toEqual(["platform_claim_job_run", ...native.steps, "subscription_reconcile_paid_activation_gaps", finishJob]);
    expect(native.calls.get(preparedClaim)).toEqual([NOW, 900, 2, `${KEY}:prepared`]);
    expect(native.calls.get(staleClaim)).toEqual([NOW, 900, 4, KEY]);
    expect(managed.calls.get(preparedClaim)).toEqual({
      p_now: NOW, p_stale_after_seconds: 900, p_limit: 2, p_claim_key: `${KEY}:prepared`,
    });
    expect(managed.calls.get(staleClaim)).toEqual({
      p_now: NOW, p_stale_after_seconds: 900, p_limit: 4, p_claim_key: KEY,
    });
    const key = `payment-provider-reconciliation:${ATTEMPT}:observed:pending:953012`;
    const observation = {
      ...expectedEvidence, providerStatus: "processing", normalizedStatus: "pending", applied: false, silenceOverdue: true,
    };
    expect(managed.calls.get(recordEvidence)).toEqual({
      p_idempotency_key: key, p_provider: provider, p_provider_payment_id: remote, p_payment_intent_id: INTENT,
      p_payment_attempt_id: ATTEMPT, p_local_status: "processing", p_provider_status: "processing",
      p_correction_status: "observed", p_checked_at: NOW, p_payload: observation,
    });
    const nativeObservation = native.calls.get(recordEvidence)!;
    expect(nativeObservation).toEqual([
      key, provider, remote, INTENT, ATTEMPT, "processing", "processing", "observed", NOW, expect.any(String),
    ]);
    expect(JSON.parse(String(nativeObservation[9]))).toEqual(observation);
  });

  it("reuses the terminal receipt key with each rail's evidence contract", async () => {
    const managed = await runManaged(capture);
    const native = await runNative(capture);
    expect(managed.response.status).toBe(200);
    const counts = { replayed: 1, corrected: 0, succeeded: 1, providerCalls: 1 };
    expect(managed.response.body).toMatchObject(counts);
    expect(native.result).toMatchObject(counts);

    expect(native.steps).toEqual([preparedClaim, staleClaim, "provider:read", applyResult]);
    expect(managed.steps).toEqual(["platform_claim_job_run", ...native.steps, "subscription_reconcile_paid_activation_gaps", finishJob]);
    const key = `payment-provider-reconciliation:${ATTEMPT}:apply:succeeded`;
    const success = {
      ...expectedEvidence, providerStatus: "paid", normalizedStatus: "succeeded", applied: true, resultStatus: "succeeded",
      amountMinor: 1200, capturedAmountBasis: "provider_capture_v1",
    };
    expect(managed.calls.get(applyResult)).toEqual({
      p_idempotency_key: key, p_expected_order_id: ORDER, p_expected_payment_intent_id: INTENT,
      p_expected_payment_attempt_id: ATTEMPT, p_expected_payment_id: PAYMENT, p_provider: provider,
      p_provider_payment_id: remote, p_local_status: "processing", p_provider_status: "paid",
      p_result_status: "succeeded", p_occurred_at: OLD, p_failure_reason: null, p_checked_at: NOW,
      p_payload: success, p_failure_class: null, p_failure_class_decided_by: null,
    });
    const nativeApply = native.calls.get(applyResult)!;
    expect(nativeApply).toEqual([
      key, ORDER, INTENT, ATTEMPT, PAYMENT, provider, remote, "processing", "paid", "succeeded", OLD,
      null, NOW, expect.any(String), null, null, "fixture-dunning", "/fixture/recovery", "fixture-recovery",
    ]);
    expect(JSON.parse(String(nativeApply[13]))).toEqual(success);
  });
});
