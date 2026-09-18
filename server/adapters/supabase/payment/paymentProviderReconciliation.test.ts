import { describe, expect, it, vi } from "vitest";
import { normalizeTpayTransaction } from "../../tpay/tpayPaymentReconciliationProvider.js";
import { classificationOf } from "../../../domains/payment/paymentProviderReconciliationEvidence.js";
// Aliased at the import site: the factory is constructed in a dozen cases, and
// the adapter's vendor name is a fact about the import, not about each case.
import { createSupabasePaymentProviderReconciliationPort as createPort } from "./paymentProviderReconciliation.js";

describe("createSupabasePaymentProviderReconciliationPort", () => {
  it("claims prepared attempts through the service-role RPC and permits missing provider payment ids", async () => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({ data: [claimedRow({
      subscription_id: null,
      subscription_cycle_id: null,
      provider_payment_id: null,
      provider_attempt_id: null,
      provider_session_id: null,
      attempt_status: "created",
      order_mode: "one_time",
    })], error: null });

    const port = createPort(client as never);
    const rows = await port.claimPreparedAttempts({
      now: "2026-07-03T10:00:00.000Z",
      staleAfterSeconds: 900,
      limit: 5,
      claimKey: "claim-prepared-1",
    });

    expect(client.rpc).toHaveBeenCalledWith("commerce_payment_reconciliation_claim_prepared_attempts", {
      p_now: "2026-07-03T10:00:00.000Z",
      p_stale_after_seconds: 900,
      p_limit: 5,
      p_claim_key: "claim-prepared-1",
    });
    expect(rows[0]).toMatchObject({
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      provider: "stripe",
      providerPaymentId: null,
      attemptStatus: "created",
      orderMode: "one_time",
      subscriptionId: null,
      subscriptionCycleId: null,
    });
  });

  it("claims stale attempts through the service-role RPC and maps snake_case rows", async () => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({ data: [claimedRow()], error: null });

    const port = createPort(client as never);
    const rows = await port.claimStaleAttempts({
      now: "2026-07-03T10:00:00.000Z",
      staleAfterSeconds: 900,
      limit: 5,
      claimKey: "claim-1",
    });

    expect(client.rpc).toHaveBeenCalledWith("commerce_payment_reconciliation_claim_stale_attempts", {
      p_now: "2026-07-03T10:00:00.000Z",
      p_stale_after_seconds: 900,
      p_limit: 5,
      p_claim_key: "claim-1",
    });
    expect(rows[0]).toMatchObject({
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      provider: "stripe",
      providerPaymentId: "pi_test",
      amountMinor: 1200,
      orderMode: "subscription_cycle",
    });
  });

  it.each([
    ["one-time rows carrying subscription references", { order_mode: "one_time" }],
    ["subscription rows missing subscription references", {
      order_mode: "subscription_cycle",
      subscription_id: null,
      subscription_cycle_id: null,
    }],
  ])("rejects %s", async (_label, overrides) => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({ data: [claimedRow(overrides)], error: null });
    const port = createPort(client as never);

    await expect(port.claimStaleAttempts({
      now: "2026-07-03T10:00:00.000Z",
      staleAfterSeconds: 900,
      limit: 5,
      claimKey: "claim-invalid-context",
    })).rejects.toThrow("invalid payment context");
  });

  it("records reconciliation evidence through payment-control", async () => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({
      data: { paymentReconciliation: { id: "rec-1" } },
      error: null,
    });
    const port = createPort(client as never);

    await expect(port.recordEvidence({
      idempotencyKey: "evidence-1",
      provider: "stripe",
      providerPaymentId: "pi_test",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      localStatus: "processing",
      providerStatus: "succeeded",
      correctionStatus: "corrected",
      checkedAt: "2026-07-03T10:00:00.000Z",
      payload: { source: "test" },
    })).resolves.toEqual({ replayed: false });
    expect(client.rpc).toHaveBeenCalledWith("commerce_payment_control_record_reconciliation", expect.objectContaining({
      p_idempotency_key: "evidence-1",
      p_provider_status: "succeeded",
      p_correction_status: "corrected",
    }));
  });

  it("applies a terminal result, dunning, and evidence through one RPC", async () => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({
      data: {
        paymentReconciliationApply: {
          paymentResult: {
            paymentIntentId: "22222222-2222-4222-8222-222222222222",
            paymentAttemptId: "11111111-1111-4111-8111-111111111111",
            paymentId: "33333333-3333-4333-8333-333333333333",
            orderId: "44444444-4444-4444-8444-444444444444",
            status: "failed",
            kind: "state_changed",
            replayed: false,
          },
          correctionStatus: "corrected",
          replayed: false,
          paymentReconciliation: { id: "rec-1" },
          subscriptionWebhookDunning: { opened: true, replayed: false, caseId: "case-1" },
        },
      },
      error: null,
    });
    const port = createPort(client as never);
    const payload = { source: "test" };

    await expect(port.applyTerminalResult({
      idempotencyKey: "apply-1",
      expectedOrderId: "44444444-4444-4444-8444-444444444444",
      expectedPaymentIntentId: "22222222-2222-4222-8222-222222222222",
      expectedPaymentAttemptId: "11111111-1111-4111-8111-111111111111",
      expectedPaymentId: "33333333-3333-4333-8333-333333333333",
      provider: "stripe",
      providerPaymentId: "pi_test",
      localStatus: "processing",
      providerStatus: "requires_action",
      resultStatus: "failed",
      failureReason: "stripe_requires_action",
      occurredAt: "2026-07-03T10:00:00.000Z",
      checkedAt: "2026-07-03T10:01:00.000Z",
      payload,
    })).resolves.toMatchObject({
      correctionStatus: "corrected",
      replayed: false,
      paymentResult: { status: "failed", kind: "state_changed", replayed: false },
      subscriptionWebhookDunning: { opened: true, replayed: false, caseId: "case-1" },
    });
    expect(client.rpc).toHaveBeenCalledOnce();
    expect(client.rpc).toHaveBeenCalledWith("commerce_payment_control_apply_reconciliation_result", {
      p_idempotency_key: "apply-1",
      p_expected_order_id: "44444444-4444-4444-8444-444444444444",
      p_expected_payment_intent_id: "22222222-2222-4222-8222-222222222222",
      p_expected_payment_attempt_id: "11111111-1111-4111-8111-111111111111",
      p_expected_payment_id: "33333333-3333-4333-8333-333333333333",
      p_provider: "stripe",
      p_provider_payment_id: "pi_test",
      p_local_status: "processing",
      p_provider_status: "requires_action",
      p_result_status: "failed",
      p_occurred_at: "2026-07-03T10:00:00.000Z",
      p_failure_reason: "stripe_requires_action",
      p_checked_at: "2026-07-03T10:01:00.000Z",
      p_payload: payload,
      p_failure_class: null,
      p_failure_class_decided_by: null,
    });

    // ---- audit scenario 2(b) of 2026-08-09, closed by wave 3i-b -------------
    //
    // The exact argument list above is the WHOLE call, and both classification
    // parameters are now in it. A caller that classified nothing sends them as
    // explicit NULL rather than omitting them: the RPC defaults both to NULL, and
    // the SQL treats a NULL class as "stamp nothing", so this is byte-identical
    // to the pre-3i-b write while still proving the parameters are wired.
    //
    // Rail-generic: this is the one SQL contract every rail's reconciled result
    // travels, which is why the class had to arrive here rather than in an
    // adapter.
    //
    // ⚠️ This changed `PaymentProviderReconciliationPort`, whose contract has
    // three live consumers and belongs to the Checkpoint C/D delegated pool.
    // Edited here ahead of that sub-programme under the programme §W6 exception,
    // attributed to the C/D owner in the wave plan §1 and the PR body rather than
    // opening a second register.
    const args = client.rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(Object.keys(args)).toContain("p_failure_class");
    expect(Object.keys(args)).toContain("p_failure_class_decided_by");
  });

  it("forwards a supplied classification into both SQL parameters", async () => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({
      data: {
        paymentReconciliationApply: {
          paymentResult: {
            paymentIntentId: "intent-1",
            paymentAttemptId: "attempt-1",
            paymentId: "payment-1",
            orderId: "order-1",
            status: "failed",
            kind: "state_changed",
            replayed: false,
          },
          correctionStatus: "corrected",
          replayed: false,
          subscriptionWebhookDunning: { opened: true, replayed: false, caseId: "case-1" },
        },
      },
      error: null,
    });
    const port = createPort(client as never);

    await port.applyTerminalResult({
      ...terminalInput(),
      resultStatus: "failed",
      // Rail-neutral on purpose: this block asserts the two classification
      // parameters, and nothing about it depends on which rail refused.
      failureReason: "provider_requires_action",
      failureClassification: { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
    });

    const args = client.rpc.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(args.p_failure_class).toBe("mandate_dead");
    expect(args.p_failure_class_decided_by).toBe("neutral_hint");
  });

  it("maps an ignored terminal replay and keeps dunning absent", async () => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({
      data: {
        paymentReconciliationApply: {
          paymentResult: {
            paymentIntentId: "intent-1",
            paymentAttemptId: "attempt-1",
            paymentId: "payment-1",
            orderId: "order-1",
            status: "succeeded",
            kind: "ignored_terminal",
            replayed: true,
          },
          correctionStatus: "ignored",
          replayed: true,
          subscriptionWebhookDunning: null,
        },
      },
      error: null,
    });
    const port = createPort(client as never);

    await expect(port.applyTerminalResult(terminalInput())).resolves.toMatchObject({
      correctionStatus: "ignored",
      replayed: true,
      paymentResult: { kind: "ignored_terminal", replayed: true },
      subscriptionWebhookDunning: null,
    });
  });

  it("propagates atomic replay conflicts with the RPC name", async () => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "reconciliation_result_idempotency_conflict", code: "23505" },
    });
    const port = createPort(client as never);

    await expect(port.applyTerminalResult(terminalInput())).rejects.toThrow(
      /commerce_payment_control_apply_reconciliation_result: .*idempotency_conflict/,
    );
  });

  it("reopens a prepared attempt after absence through the operator RPC with sensitive-key-free evidence", async () => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({
      data: { preparedAttemptReopen: { paymentAttemptId: "11111111-1111-4111-8111-111111111111", replayed: false } },
      error: null,
    });
    const port = createPort(client as never);
    const absenceEvidence = {
      providerAbsenceConfirmed: true,
      source: "payment-provider-reconciliation.auto-reopen.v0",
      basis: "stripe_intent_correlated_search_absent",
      probedAt: "2026-07-03T10:00:00.000Z",
    };

    await expect(port.reopenPreparedAttemptAfterAbsence({
      idempotencyKey: "payment-provider-reconciliation:11111111-1111-4111-8111-111111111111:absence-reopen",
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      expectedPaymentIntentId: "22222222-2222-4222-8222-222222222222",
      expectedSubscriptionCycleId: "66666666-6666-4666-8666-666666666666",
      operatorRef: "payment-provider-reconciliation@auto",
      absenceCheckedAt: "2026-07-03T10:00:00.000Z",
      nextRetryAt: "2026-07-03T10:00:00.000Z",
      absenceEvidence,
    })).resolves.toEqual({ replayed: false });

    expect(client.rpc).toHaveBeenCalledWith("commerce_payment_control_reopen_prepared_attempt_after_absence", {
      p_idempotency_key: "payment-provider-reconciliation:11111111-1111-4111-8111-111111111111:absence-reopen",
      p_payment_attempt_id: "11111111-1111-4111-8111-111111111111",
      p_expected_payment_intent_id: "22222222-2222-4222-8222-222222222222",
      p_expected_subscription_cycle_id: "66666666-6666-4666-8666-666666666666",
      p_operator_ref: "payment-provider-reconciliation@auto",
      p_absence_checked_at: "2026-07-03T10:00:00.000Z",
      p_next_retry_at: "2026-07-03T10:00:00.000Z",
      p_absence_evidence: absenceEvidence,
    });
    // Guard against the RPC's sensitive-evidence regex (migration
    // 20260711153000 line 75): the auto payload must never trip it.
    const sensitive = /(paymentmethodref|payment_method_ref|providermethodref|provider_method_ref|providercustomerref|provider_customer_ref|clientsecret|client_secret|recoverytoken|recovery_token|token_hash|blikcode|blik_code|payid|pay_id)/;
    expect(JSON.stringify(absenceEvidence).toLowerCase()).not.toMatch(sensitive);
  });

  it("keeps interactive manual absence separate from renewal retry reopening", async () => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({
      data: {
        interactivePreparedAttemptReopen: {
          paymentAttemptId: "11111111-1111-4111-8111-111111111111",
          paymentIntentId: "22222222-2222-4222-8222-222222222222",
          paymentAttemptStatus: "failed",
          paymentIntentStatus: "failed",
          replayed: false,
        },
      },
      error: null,
    });
    const port = createPort(client as never);
    const absenceEvidence = {
      providerAbsenceConfirmed: true as const,
      watchdogEvidence: true as const,
      evidenceCode: "operator_verified_absence" as const,
    };

    await expect(port.reopenInteractivePreparedAttemptAfterAbsence({
      idempotencyKey: "interactive-prepared-manual-absence-0001",
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      expectedPaymentIntentId: "22222222-2222-4222-8222-222222222222",
      expectedOrderId: "33333333-3333-4333-8333-333333333333",
      expectedSubscriptionId: "44444444-4444-4444-8444-444444444444",
      expectedSubscriptionCycleId: "55555555-5555-4555-8555-555555555555",
      operatorRef: "ops-ticket-105",
      absenceCheckedAt: "2026-08-28T12:00:00.000Z",
      absenceEvidence,
    })).resolves.toEqual({
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      paymentAttemptStatus: "failed",
      paymentIntentStatus: "failed",
      replayed: false,
    });

    expect(client.rpc).toHaveBeenCalledWith("commerce_payment_control_reopen_interactive_prepared_attempt", {
      p_idempotency_key: "interactive-prepared-manual-absence-0001",
      p_payment_attempt_id: "11111111-1111-4111-8111-111111111111",
      p_expected_payment_intent_id: "22222222-2222-4222-8222-222222222222",
      p_expected_order_id: "33333333-3333-4333-8333-333333333333",
      p_expected_subscription_id: "44444444-4444-4444-8444-444444444444",
      p_expected_subscription_cycle_id: "55555555-5555-4555-8555-555555555555",
      p_reopen_mode: "manual_provider_absence",
      p_dispatch_state: "provider_absence_confirmed",
      p_phase: "operator_reconciliation",
      p_reason_code: "operator_verified_absence",
      p_operator_ref: "ops-ticket-105",
      p_absence_checked_at: "2026-08-28T12:00:00.000Z",
      p_absence_evidence: absenceEvidence,
    });
    expect(client.rpc).not.toHaveBeenCalledWith(
      "commerce_payment_control_reopen_prepared_attempt_after_absence",
      expect.anything(),
    );
  });

  it("propagates reopen RPC errors with the RPC name prefixed", async () => {
    const client = fakeClient();
    client.rpc.mockResolvedValueOnce({
      data: null,
      error: { message: "prepared_attempt_absence_reopen_too_fresh", code: "22023" },
    });
    const port = createPort(client as never);

    await expect(port.reopenPreparedAttemptAfterAbsence({
      idempotencyKey: "payment-provider-reconciliation:11111111-1111-4111-8111-111111111111:absence-reopen",
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      expectedPaymentIntentId: "22222222-2222-4222-8222-222222222222",
      expectedSubscriptionCycleId: "66666666-6666-4666-8666-666666666666",
      operatorRef: "payment-provider-reconciliation@auto",
      absenceCheckedAt: "2026-07-03T10:00:00.000Z",
      nextRetryAt: "2026-07-03T10:00:00.000Z",
      absenceEvidence: { providerAbsenceConfirmed: true },
    })).rejects.toThrow(/commerce_payment_control_reopen_prepared_attempt_after_absence: .*too_fresh/);
  });
});

function fakeClient() {
  return { rpc: vi.fn() };
}

function terminalInput() {
  return {
    idempotencyKey: "apply-1",
    expectedOrderId: "order-1",
    expectedPaymentIntentId: "intent-1",
    expectedPaymentAttemptId: "attempt-1",
    expectedPaymentId: "payment-1",
    provider: "stripe" as const,
    providerPaymentId: "pi_test",
    localStatus: "processing",
    providerStatus: "succeeded",
    resultStatus: "succeeded" as const,
    occurredAt: "2026-07-03T10:00:00.000Z",
    failureReason: null,
    checkedAt: "2026-07-03T10:01:00.000Z",
    payload: {},
  };
}

function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    payment_attempt_id: "11111111-1111-4111-8111-111111111111",
    payment_intent_id: "22222222-2222-4222-8222-222222222222",
    payment_id: "33333333-3333-4333-8333-333333333333",
    order_id: "44444444-4444-4444-8444-444444444444",
    subscription_id: "55555555-5555-4555-8555-555555555555",
    subscription_cycle_id: "66666666-6666-4666-8666-666666666666",
    provider: "stripe",
    provider_payment_id: "pi_test",
    provider_attempt_id: "pi_test",
    provider_session_id: "pi_test",
    attempt_status: "processing",
    intent_status: "processing",
    amount_cents: 1200,
    currency: "PLN",
    order_mode: "subscription_cycle",
    cycle_retry_attempt: 0,
    cycle_next_retry_at: null,
    local_updated_at: "2026-07-03T09:30:00.000Z",
    ...overrides,
  };
}

// The rail that terminalised the 2026-08-12 refusal. Reconciliation, verify-now
// and recovery-pay all reach the control plane through this one port method, so
// it is the only seam of the four that is handed a real provider.
describe("terminal decline signal", () => {
  function applyResponse(overrides: {
    status?: string; replayed?: boolean; correctionStatus?: string;
  } = {}) {
    return {
      data: {
        paymentReconciliationApply: {
          paymentResult: {
            paymentIntentId: "intent-1",
            paymentAttemptId: "attempt-1",
            paymentId: "payment-1",
            orderId: "order-1",
            status: overrides.status ?? "failed",
            kind: "state_changed",
            replayed: overrides.replayed ?? false,
          },
          correctionStatus: overrides.correctionStatus ?? "corrected",
          replayed: overrides.replayed ?? false,
          subscriptionWebhookDunning: null,
        },
      },
      error: null,
    };
  }

  async function applyAndCaptureSignals(
    response: ReturnType<typeof applyResponse>,
    input: Record<string, unknown> = {},
  ) {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const client = fakeClient();
      client.rpc.mockResolvedValueOnce(response);
      await createPort(client as never).applyTerminalResult({
        ...terminalInput(),
        resultStatus: "failed",
        failureReason: "provider_declined",
        ...input,
      } as never);
      return consoleInfo.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("payment_decline_terminal"));
    } finally {
      consoleInfo.mockRestore();
    }
  }

  it("reports a refusal this rail actually applied, naming the provider it holds", async () => {
    const signals = await applyAndCaptureSignals(applyResponse(), {
      failureClassification: { failureClass: "hard_do_not_retry", decidedBy: "advice_code" },
    });

    expect(signals).toHaveLength(1);
    expect(JSON.parse(signals[0])).toMatchObject({
      name: "payment_decline_terminal",
      details: {
        provider: "stripe",
        failureClass: "hard_do_not_retry",
        failureReason: "provider_declined",
        resultStatus: "failed",
      },
    });
  });

  it("stays silent when the same sweep re-applies a refusal it already recorded", async () => {
    expect(await applyAndCaptureSignals(applyResponse({ replayed: true }))).toHaveLength(0);
  });

  // `ignored` means the control plane declined the correction: nothing moved, so
  // there is nothing to report.
  it("stays silent when the control plane ignored the correction", async () => {
    expect(await applyAndCaptureSignals(applyResponse({ correctionStatus: "ignored" }))).toHaveLength(0);
  });

  it("stays silent when the rail confirmed a payment rather than a refusal", async () => {
    const signals = await applyAndCaptureSignals(
      applyResponse({ status: "succeeded" }),
      { resultStatus: "succeeded", failureReason: null },
    );
    expect(signals).toHaveLength(0);
  });
});


it("carries diagnostics to the existing atomic persistence input without changing policy parameters", async () => {
  const rpc = vi.fn(async () => ({ error: null, data: { paymentReconciliationApply: {
    replayed: true, correctionStatus: "ignored", paymentResult: { paymentIntentId: "intent", paymentAttemptId: "attempt",
      paymentId: "payment", orderId: "order", status: "failed", kind: "ignored_duplicate_terminal_failure", replayed: true },
  } } }));
  const normalized = normalizeTpayTransaction({ transactionId: "01HX", status: "pending", payments: { attempts: [{ paymentErrorCode: "105" }] } });
  const result = await createPort({ rpc }).applyTerminalResult({
    idempotencyKey: "reconcile:attempt", expectedOrderId: "order", expectedPaymentIntentId: "intent",
    expectedPaymentAttemptId: "attempt", expectedPaymentId: "payment", provider: "tpay", providerPaymentId: "01HX",
    localStatus: "processing", providerStatus: "pending", resultStatus: "failed", occurredAt: "2026-09-11T10:00:00Z",
    failureReason: normalized.failureReason, checkedAt: "2026-09-11T10:00:00Z", ...classificationOf("failed", normalized),
    payload: { providerPayload: normalized.rawPayload },
  });
  expect(result.replayed).toBe(true);
  expect(rpc).toHaveBeenCalledWith("commerce_payment_control_apply_reconciliation_result", expect.objectContaining({
    p_failure_class: "indeterminate", p_failure_class_decided_by: "default", p_failure_reason: "tpay_decline_105",
    p_payload: { providerPayload: expect.objectContaining({ failureEvidence: expect.objectContaining({ declineCode: "105" }) }) },
  }));
});
