import { describe, expect, it, vi } from "vitest";
import { CommerceRuntimeConflictError } from "../../../../src/domains/commerce/runtimePorts.js";
import {
  createManagedPaymentControlRuntimePort,
} from "./paymentControlRuntimePort.js";

const PREPARE_PROVIDER_ATTEMPT_IDEMPOTENCY_CONFLICT =
  "payment_control_provider_attempt_prepare_idempotency_conflict";

describe("managed payment-control runtime port", () => {
  it("passes provider-attempt preparation facts to the prepare RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        paymentAttempt: {
          id: "11111111-1111-4111-8111-111111111111",
          status: "created",
          replayed: false,
          providerAttemptId: null,
          providerSessionId: null,
          nextActionKind: null,
        },
      },
      error: null,
    });
    const port = createManagedPaymentControlRuntimePort({ rpc });

    const result = await port.prepareProviderAttempt({
      idempotencyKey: "payment-attempt-prepare-1",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      provider: "stripe",
      providerIdempotencyKey: "operation:gateway:intent:attempt",
      providerRequestFingerprint: "gateway|intent|1490|XTS|subscription_cycle|order_1",
      providerFlow: "off_session_payment",
      paymentMethodRef: "pm_123",
      requestPayload: { amountMinor: 1490, currency: "XTS" },
    });

    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_prepare_provider_attempt", {
      p_idempotency_key: "payment-attempt-prepare-1",
      p_payment_intent_id: "22222222-2222-4222-8222-222222222222",
      p_provider: "stripe",
      p_provider_idempotency_key: "operation:gateway:intent:attempt",
      p_provider_request_fingerprint: "gateway|intent|1490|XTS|subscription_cycle|order_1",
      p_provider_flow: "off_session_payment",
      p_payment_method_ref: "pm_123",
      p_request_payload: { amountMinor: 1490, currency: "XTS" },
    });
    expect(result).toEqual({
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      status: "created",
      replayed: false,
      providerAttemptId: null,
      providerSessionId: null,
      nextActionKind: null,
    });
  });

  it("preserves the exact not-chargeable reason from a compensated prepare response", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        contractVersion: "commerce.v0",
        paymentAttemptAdmission: {
          status: "skipped_not_chargeable",
          reason: "payment_control_subscription_not_chargeable",
          paymentIntentId: "22222222-2222-4222-8222-222222222222",
        },
      },
      error: null,
    });
    const port = createManagedPaymentControlRuntimePort({ rpc });

    await expect(port.prepareProviderAttempt({
      idempotencyKey: "payment-attempt-prepare-skip",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      provider: "stripe",
      providerIdempotencyKey: "operation:gateway:intent:skip",
      providerRequestFingerprint: "gateway|intent|1490|XTS|subscription_cycle|order_1",
      providerFlow: "off_session_payment",
      paymentMethodRef: "pm_123",
      requestPayload: {},
    })).rejects.toMatchObject({
      name: "CommerceRuntimeConflictError",
      details: {
        code: "55000",
        reason: "payment_control_subscription_not_chargeable",
      },
    });
  });

  it("maps the legacy SQL not-chargeable error to the same typed reason", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "55000", message: "payment_control_subscription_not_chargeable" },
    });
    const port = createManagedPaymentControlRuntimePort({ rpc });

    await expect(port.prepareProviderAttempt({
      idempotencyKey: "payment-attempt-prepare-old-error",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      provider: "stripe",
      providerIdempotencyKey: "operation:gateway:intent:old-error",
      providerRequestFingerprint: "gateway|intent|1490|XTS|subscription_cycle|order_1",
      providerFlow: "off_session_payment",
      paymentMethodRef: "pm_123",
      requestPayload: {},
    })).rejects.toMatchObject({
      name: "CommerceRuntimeConflictError",
      details: { reason: "payment_control_subscription_not_chargeable" },
    });
  });

  it.each(["message", "details", "hint"] as const)(
    "keeps the named prepare conflict when Supabase returns it in %s",
    async (field) => {
      const rpc = vi.fn().mockResolvedValue({
        data: null,
        error: { code: "23505", [field]: `ERROR: ${PREPARE_PROVIDER_ATTEMPT_IDEMPOTENCY_CONFLICT}` },
      });
      const port = createManagedPaymentControlRuntimePort({ rpc });

      await expect(port.prepareProviderAttempt(providerAttemptPrepareInput())).rejects.toMatchObject({
        name: "CommerceRuntimeConflictError",
        details: {
          code: "23505",
          reason: PREPARE_PROVIDER_ATTEMPT_IDEMPOTENCY_CONFLICT,
        },
      });
    },
  );

  it("keeps an unrelated 23505 generic", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { code: "23505", message: "payment_control_result_idempotency_conflict" },
    });
    const port = createManagedPaymentControlRuntimePort({ rpc });

    const failure = await port.prepareProviderAttempt(providerAttemptPrepareInput()).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(CommerceRuntimeConflictError);
    expect((failure as CommerceRuntimeConflictError).details).toEqual({ code: "23505" });
  });

  it("passes provider-attempt finalization facts to the finalize RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        paymentAttempt: {
          id: "11111111-1111-4111-8111-111111111111",
          status: "processing",
          replayed: false,
          providerAttemptId: "pi_123",
          providerSessionId: "pi_123",
          nextActionKind: null,
        },
      },
      error: null,
    });
    const port = createManagedPaymentControlRuntimePort({ rpc });

    const result = await port.finalizeProviderAttempt({
      idempotencyKey: "payment-attempt-finalize-1",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      providerIdempotencyKey: "operation:gateway:intent:attempt",
      providerRequestFingerprint: "gateway|intent|1490|XTS|subscription_cycle|order_1",
      providerAttemptId: "pi_123",
      providerSessionId: "pi_123",
      attemptStatus: "processing",
      nextActionKind: null,
      requestPayload: { providerCall: true },
      responsePayload: { providerCall: true, webhookExpected: true },
    });

    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_finalize_provider_attempt", {
      p_idempotency_key: "payment-attempt-finalize-1",
      p_payment_intent_id: "22222222-2222-4222-8222-222222222222",
      p_payment_attempt_id: "11111111-1111-4111-8111-111111111111",
      p_provider_idempotency_key: "operation:gateway:intent:attempt",
      p_provider_request_fingerprint: "gateway|intent|1490|XTS|subscription_cycle|order_1",
      p_provider_attempt_id: "pi_123",
      p_provider_session_id: "pi_123",
      p_attempt_status: "processing",
      p_next_action_kind: null,
      p_request_payload: { providerCall: true },
      p_response_payload: { providerCall: true, webhookExpected: true },
    });
    expect(result).toEqual({
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      status: "processing",
      replayed: false,
      providerAttemptId: "pi_123",
      providerSessionId: "pi_123",
      nextActionKind: null,
    });
  });

  it("terminalizes only an exhausted trusted no-dispatch interactive attempt through its dedicated RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
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
    const port = createManagedPaymentControlRuntimePort({ rpc });

    await expect(port.reopenInteractivePreparedAttempt({
      idempotencyKey: "interactive-prepared-reopen-0001",
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      expectedOrderId: "33333333-3333-4333-8333-333333333333",
      expectedSubscriptionId: "44444444-4444-4444-8444-444444444444",
      expectedSubscriptionCycleId: "55555555-5555-4555-8555-555555555555",
      evidence: {
        mode: "trusted_pre_dispatch",
        dispatchState: "not_dispatched",
        phase: "transaction_dispatch",
        reasonCode: "tpay_request_deadline_exhausted",
      },
    })).resolves.toEqual({
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      paymentAttemptStatus: "failed",
      paymentIntentStatus: "failed",
      replayed: false,
    });

    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_reopen_interactive_prepared_attempt", {
      p_idempotency_key: "interactive-prepared-reopen-0001",
      p_payment_attempt_id: "11111111-1111-4111-8111-111111111111",
      p_expected_payment_intent_id: "22222222-2222-4222-8222-222222222222",
      p_expected_order_id: "33333333-3333-4333-8333-333333333333",
      p_expected_subscription_id: "44444444-4444-4444-8444-444444444444",
      p_expected_subscription_cycle_id: "55555555-5555-4555-8555-555555555555",
      p_reopen_mode: "trusted_pre_dispatch",
      p_dispatch_state: "not_dispatched",
      p_phase: "transaction_dispatch",
      p_reason_code: "tpay_request_deadline_exhausted",
      p_operator_ref: null,
      p_absence_checked_at: null,
      p_absence_evidence: {},
    });
  });

  it("passes provider attempt, session, and next-action facts to the record-attempt RPC", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: {
        paymentAttempt: {
          id: "11111111-1111-4111-8111-111111111111",
          status: "requires_action",
          replayed: false,
        },
      },
      error: null,
    });
    const port = createManagedPaymentControlRuntimePort({ rpc });

    const result = await port.recordAttempt({
      idempotencyKey: "payment-attempt-wave1",
      paymentIntentId: "22222222-2222-4222-8222-222222222222",
      provider: "hidden_rehearsal",
      providerAttemptId: "psp_attempt_123",
      providerSessionId: "psp_session_123",
      attemptStatus: "requires_action",
      nextActionKind: "sca_required",
      requestPayload: { amountMinor: 1490, currency: "XTS" },
      responsePayload: { providerCall: false, redirectUrlPresent: true },
    });

    expect(rpc).toHaveBeenCalledWith("commerce_payment_control_record_attempt", {
      p_idempotency_key: "payment-attempt-wave1",
      p_payment_intent_id: "22222222-2222-4222-8222-222222222222",
      p_provider: "hidden_rehearsal",
      p_provider_attempt_id: "psp_attempt_123",
      p_provider_session_id: "psp_session_123",
      p_attempt_status: "requires_action",
      p_next_action_kind: "sca_required",
      p_request_payload: { amountMinor: 1490, currency: "XTS" },
      p_response_payload: { providerCall: false, redirectUrlPresent: true },
    });
    expect(result).toEqual({
      paymentAttemptId: "11111111-1111-4111-8111-111111111111",
      status: "requires_action",
      replayed: false,
    });
  });
});

// The widest of the four seams. Every synchronous refusal that is not a webhook
// or a reconciliation sweep lands here: interactive checkout via
// `finalizeDeclinedAttempt`, the recovery-pay finalizer in
// `checkoutRecoveryPayService`, and the admin runtime payment-result route.
// None of them emit anything themselves, which is the point of signalling from
// the port that performs the write rather than from each producer.
describe("terminal decline signal", () => {
  async function applyAndCaptureSignals(
    rpcResult: { status: string; replayed: boolean },
    input: Record<string, unknown>,
  ) {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const rpc = vi.fn().mockResolvedValue({
        data: {
          paymentResult: {
            paymentIntentId: "intent-1",
            paymentAttemptId: "attempt-1",
            paymentId: "payment-1",
            orderId: "order-1",
            status: rpcResult.status,
            kind: "state_changed",
            replayed: rpcResult.replayed,
          },
        },
        error: null,
      });
      await createManagedPaymentControlRuntimePort({ rpc }).applyResult({
        idempotencyKey: "apply-1",
        orderId: "order-1",
        paymentIntentId: "intent-1",
        occurredAt: "2026-08-26T09:14:00.000Z",
        ...input,
      } as never);
      return consoleInfo.mock.calls
        .map(([line]) => String(line))
        .filter((line) => line.includes("payment_decline_terminal"));
    } finally {
      consoleInfo.mockRestore();
    }
  }

  it("reports a refusal this port actually wrote, carrying the class it was given", async () => {
    const signals = await applyAndCaptureSignals(
      { status: "failed", replayed: false },
      {
        resultStatus: "failed",
        failureReason: "blik_recurring_unsupported_bank",
        failureClassification: { failureClass: "mandate_dead", decidedBy: "neutral_hint" },
      },
    );

    expect(signals).toHaveLength(1);
    expect(JSON.parse(signals[0])).toMatchObject({
      name: "payment_decline_terminal",
      domain: "payment",
      surface: "hidden",
      details: {
        provider: null,
        failureClass: "mandate_dead",
        failureReason: "blik_recurring_unsupported_bank",
        resultStatus: "failed",
        occurredAt: "2026-08-26T09:14:00.000Z",
      },
    });
  });

  // A buyer who resubmits replays the same idempotency key. One refusal is one
  // signal, however many times the browser asks.
  it("stays silent when the write replayed an already-recorded refusal", async () => {
    expect(await applyAndCaptureSignals(
      { status: "failed", replayed: true },
      { resultStatus: "failed", failureReason: "provider_declined" },
    )).toHaveLength(0);
  });

  it("stays silent when the port applied a successful payment", async () => {
    expect(await applyAndCaptureSignals(
      { status: "succeeded", replayed: false },
      { resultStatus: "succeeded", failureReason: null },
    )).toHaveLength(0);
  });

  // An unclassified refusal is not evidence the instrument is dead, so it must
  // reach the rate monitor rather than the first-occurrence one.
  it("reports a null class rather than guessing one the caller never supplied", async () => {
    const signals = await applyAndCaptureSignals(
      { status: "failed", replayed: false },
      { resultStatus: "failed", failureReason: "provider_declined" },
    );
    expect(JSON.parse(signals[0]).details.failureClass).toBeNull();
  });
});

function providerAttemptPrepareInput() {
  return {
    idempotencyKey: "payment-attempt-prepare-conflict",
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    provider: "stripe" as const,
    providerIdempotencyKey: "operation:gateway:intent:conflict",
    providerRequestFingerprint: "gateway|intent|1490|XTS|subscription_cycle|order_1",
    providerFlow: "off_session_payment",
    paymentMethodRef: "pm_123",
    requestPayload: {},
  };
}
