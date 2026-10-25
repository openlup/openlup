import { describe, expect, it, vi } from "vitest";

import { createSupabaseCycleChargeFailurePropagationPort as createPort } from "./cycleChargeFailurePropagation.js";

// The renewal rail. An off-session cycle charge that the provider refuses is
// terminalised here, and this is the one seam of the four whose port method only
// ever applies `failed` — there is no success path through it to stay quiet for.
describe("cycle charge failure propagation terminal decline signal", () => {
  async function applyAndCaptureSignals(replayed: boolean) {
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      const client = {
        rpc: vi.fn(async () => ({
          data: { paymentResult: { replayed, paymentAttemptId: "durable-attempt-A" } },
          error: null,
        })),
        from: vi.fn(),
      };
      const applied = await createPort(client as never).applyFailedResult({
        idempotencyKey: "renewal-apply-1",
        paymentIntentId: "intent-1",
        occurredAt: "2026-08-26T09:14:00.000Z",
        failureReason: "provider_declined",
        failureClassification: { failureClass: "hard_do_not_retry", decidedBy: "advice_code" },
      });
      return {
        applied,
        signals: consoleInfo.mock.calls
          .map(([line]) => String(line))
          .filter((line) => line.includes("payment_decline_terminal")),
      };
    } finally {
      consoleInfo.mockRestore();
    }
  }

  it("reports the refusal that ended an off-session renewal charge", async () => {
    const { applied, signals } = await applyAndCaptureSignals(false);

    expect(applied).toEqual({ replayed: false, paymentAttemptId: "durable-attempt-A" });
    expect(signals).toHaveLength(1);
    expect(JSON.parse(signals[0])).toMatchObject({
      name: "payment_decline_terminal",
      domain: "payment",
      surface: "hidden",
      details: {
        provider: null,
        failureClass: "hard_do_not_retry",
        failureReason: "provider_declined",
        resultStatus: "failed",
        occurredAt: "2026-08-26T09:14:00.000Z",
      },
    });
  });

  // ⛔ The renewal cron replays the same row on a retried execution by design —
  // the idempotency keys are deliberately deterministic. A signal per replay
  // would page once per sweep for a refusal already reported.
  it("stays silent when the cron replayed a refusal it already propagated", async () => {
    const { applied, signals } = await applyAndCaptureSignals(true);

    expect(applied).toEqual({ replayed: true, paymentAttemptId: "durable-attempt-A" });
    expect(signals).toHaveLength(0);
  });
});


describe("cycle failure applied-attempt binding", () => {
  const input = { failedPaymentAttemptId: "durable-attempt-A", idempotencyKey: "observe-A", cycleId: "cycle", subscriptionId: "subscription",
    orderUuid: "order", paymentIntentId: "intent", retryAttempt: 1, nextRetryAt: null, failureReason: "declined", occurredAt: "2026-10-25T09:00:00Z", failureClass: "soft_retryable" };
  it("sends the exact applied attempt to the attributed overload", async () => {
    const rpc = vi.fn(async () => ({ data: { subscriptionDunning: { caseId: "case" } }, error: null }));
    expect(await createPort({ rpc, from: vi.fn() }).openDunningCase(input)).toEqual({ status: "opened", caseId: "case" });
    expect(rpc).toHaveBeenCalledWith("subscription_handle_payment_failure_dunning", expect.objectContaining({ p_failed_payment_attempt_id: "durable-attempt-A", p_failure_class: "soft_retryable" }));
  });
  it("preserves explicit NULL and the database's 55000 refusal", async () => {
    const rpc = vi.fn(async () => ({ data: null, error: { code: "55000", message: "subscription_dunning_failed_attempt_unattributed" } }));
    expect(await createPort({ rpc, from: vi.fn() }).openDunningCase({ ...input, failedPaymentAttemptId: null })).toEqual({ status: "rejected", code: "55000", reason: "subscription_dunning_failed_attempt_unattributed" });
    expect(rpc).toHaveBeenCalledWith("subscription_handle_payment_failure_dunning", expect.objectContaining({ p_failed_payment_attempt_id: null }));
  });
  it.each([undefined, null, 42])("returns missing or malformed apply attribution %s as NULL", async paymentAttemptId => {
    const rpc = vi.fn(async () => ({ data: { paymentResult: { replayed: true, paymentAttemptId } }, error: null }));
    expect(await createPort({ rpc, from: vi.fn() }).applyFailedResult({ idempotencyKey: "apply", paymentIntentId: "intent", occurredAt: input.occurredAt, failureReason: "declined", failureClassification: { failureClass: "soft_retryable", decidedBy: "test" } })).toEqual({ replayed: true, paymentAttemptId: null });
  });
});
