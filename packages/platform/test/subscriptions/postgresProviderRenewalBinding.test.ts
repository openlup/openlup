import { describe, expect, it, vi } from "vitest";
import { createPostgresProviderRenewalBinding, type ProviderRenewalPaymentPorts } from "../../src/subscriptions/postgresProviderRenewalBinding.js";
import type { NativeRenewalCodec, SubscriptionQueryExecutor } from "../../src/subscriptions/postgresRenewalStore.js";

const intentId = "11111111-1111-4111-8111-111111111111";
const operationId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";
const subscriptionId = "44444444-4444-4444-8444-444444444444";
const cycleId = "55555555-5555-4555-8555-555555555555";
const clientId = "66666666-6666-4666-8666-666666666666";
const attemptId = "77777777-7777-4777-8777-777777777777";
const paymentId = "88888888-8888-4888-8888-888888888888";

function createFixture(attemptStatus: "failed" | "pending" | null = "failed") {
  const executedSql: string[] = [];
  const query = vi.fn<SubscriptionQueryExecutor["query"]>(async sql => {
    executedSql.push(sql);
    if (sql.includes("FROM public.commerce_settlement_intents i")) {
      return {
        rows: [{
          id: operationId,
          subscription_id: subscriptionId,
          operation_fingerprint: "op-fp-1",
          identity_key: "renewal-key-1",
          cycle_snapshot: { correlated: true },
          order_id: orderId,
          amount_minor: 4900,
          currency_code: "XXX",
          settlement_status: "pending",
          subscription_cycle_id: cycleId,
          client_id: clientId,
        }],
      };
    }
    if (sql.includes("FROM public.subscription_retry_receipts r")) {
      return {
        rows: [{
          receipt_key: "retry-receipt-1",
          input: {
            evidenceKey: "ev-1",
            externalRef: "ext-attempt-1",
            occurredAt: "2026-09-01T12:00:00.000Z",
            firstRecordedAt: "2026-09-01T12:00:00.000Z",
            reason: "card_declined",
            failureClass: "hard_decline",
          },
        }],
      };
    }
    if (sql.includes("payment_reconciliation_open_dunning_from_failed_result")) {
      return {
        rows: [{
          response: {
            subscriptionWebhookDunning: { caseId: "dunning-case-1", replayed: false },
          },
        }],
      };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });

  const readAttempt = vi.fn<ProviderRenewalPaymentPorts["readAttempt"]>(async () => {
    if (attemptStatus === null) return null;
    return {
      orderId,
      settlementStatus: "failed",
      amountMinor: 4900,
      currency: "XXX",
      requestPayload: {},
      responsePayload: {},
      paymentAttempt: {
        id: attemptId,
        paymentId,
        provider: "provider_x",
        status: attemptStatus,
        providerAttemptId: "ext-attempt-1",
      },
    };
  });

  const paymentRail = {
    provider: "provider_x",
    mode: "test",
    control: {
      createIntent: vi.fn(),
      applyPaymentResult: vi.fn(),
    },
    controlFor: vi.fn(),
    readAttempt,
    execute: vi.fn(),
    adapter: { readbackPort: { readPayment: vi.fn() } },
    reconciliation: {
      recordEvidence: vi.fn(),
      applyTerminalResult: vi.fn(),
    },
  } as unknown as ProviderRenewalPaymentPorts;

  const codec = {
    decode: vi.fn(() => ({
      cycle: { status: "correlated" },
      settlementChannelKey: "provider_x_channel",
      scheduledAt: "2026-09-01T12:00:00.000Z",
    })),
    readback: vi.fn(),
  } as unknown as NativeRenewalCodec;

  const binding = createPostgresProviderRenewalBinding({
    enabled: true,
    channelKey: "provider_x_channel",
    executor: { query },
    withTransaction: work => work({ query }),
    paymentRail,
    codec,
    settlement: () => ({
      prepareRenewal: vi.fn(),
      acknowledgeExternalAttempt: vi.fn(),
      recordTerminalOutcome: vi.fn(),
    }),
    truth: {
      dunningTemplateSlug: "dunning",
      recoveryUrlPath: "/recover",
      recoveryTemplateSlug: "recovery",
    },
    search: vi.fn(async () => []),
    now: () => "2026-09-01T12:05:00.000Z",
  });

  return { binding, executedSql, readAttempt };
}

describe("postgresProviderRenewalBinding read deduplication", () => {
  it("reuses prefetched operation row in rail.readOutcome and prefetched failure facts in handoff", async () => {
    const { binding, executedSql, readAttempt } = createFixture("failed");

    const evidence = await binding.rail.readOutcome({
      operationId,
      subscriptionId,
      cycleId,
      orderId,
      settlementIntentId: intentId,
      amountMinor: 4900,
      currency: "XXX",
      externalAttemptRef: "ext-attempt-1",
    });

    expect(evidence).toMatchObject({
      operationId,
      status: "failed",
      disposition: "observed",
      eventKey: "retry-receipt-1",
      verifiedEvidenceRef: "ev-1",
      reason: "card_declined",
    });
    expect(readAttempt).toHaveBeenCalledTimes(1);
    expect(executedSql.filter(sql => sql.includes("FROM public.commerce_settlement_intents i"))).toHaveLength(1);
    expect(executedSql.filter(sql => sql.includes("FROM public.subscription_retry_receipts r"))).toHaveLength(1);
    expect(executedSql.filter(sql => sql.includes("payment_reconciliation_open_dunning_from_failed_result"))).toHaveLength(1);
  });

  it("reuses prefetched attempt in retryPayments.readOutcome without calling readAttempt twice", async () => {
    const { binding, executedSql, readAttempt } = createFixture("failed");

    const evidence = await binding.retryPayments.readOutcome({
      operationId,
      subscriptionId,
      cycleId,
      orderId,
      settlementIntentId: intentId,
      amountMinor: 4900,
      currency: "XXX",
      externalAttemptRef: "ext-attempt-1",
    });

    expect(evidence).toMatchObject({ status: "failed", disposition: "observed", eventKey: "retry-receipt-1" });
    expect(readAttempt).toHaveBeenCalledTimes(1);
    expect(executedSql.filter(sql => sql.includes("FROM public.commerce_settlement_intents i"))).toHaveLength(1);
    expect(executedSql.filter(sql => sql.includes("FROM public.subscription_retry_receipts r"))).toHaveLength(1);
  });

  it("reuses null attempt in retryPayments.readOutcome without a second readAttempt", async () => {
    const { binding, readAttempt } = createFixture(null);

    await expect(binding.retryPayments.readOutcome({
      operationId,
      subscriptionId,
      cycleId,
      orderId,
      settlementIntentId: intentId,
      amountMinor: 4900,
      currency: "XXX",
      externalAttemptRef: null,
    })).rejects.toThrow("payment_control_result_active_attempt_not_found");

    expect(readAttempt).toHaveBeenCalledTimes(1);
  });
});
