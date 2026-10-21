import { describe, expect, it, vi } from "vitest";
import { executePreparedAttemptMechanism } from "@openlup/platform/payments";
import type { PaymentExecutionBaseInput } from "@openlup/core/payment";
import type { PreparedAttemptFailurePolicy, PreparedAttemptPersistenceResult, PreparedAttemptPrepareInput, PreparedAttemptFinalizeInput } from "@openlup/platform/payments/contracts";

const policy: PreparedAttemptFailurePolicy<Error, string> = {
  replayError: (attempt) => Object.assign(new Error("in-flight"), { code: "provider_attempt_in_flight",
    paymentAttemptId: attempt.paymentAttemptId, attemptStatus: attempt.status, dispatchState: "unknown" }),
  isTrustedNoCharge: (error): error is Error => error instanceof Error && error.message === "exact-no-charge",
  logRetry: () => {},
  exhaustedError: (error) => error,
  executionError: (_error, attempt) => Object.assign(new Error("execution"), { code: "provider_execution_failed",
    paymentAttemptId: attempt.paymentAttemptId, dispatchState: "unknown" }),
  finalizationError: (error) => error instanceof Error ? error : new Error("finalization"),
};

function fixture() {
  const trace: string[] = [];
  const stored: PreparedAttemptPersistenceResult = { paymentAttemptId: "attempt-original", status: "created",
    replayed: false, providerAttemptId: null, providerSessionId: null, nextActionKind: null };
  const execution = { provider: "provider-a", providerAttemptId: "remote-original", providerSessionId: null,
    attemptStatus: "processing" as const, nextActionKind: null, requestPayload: {}, responsePayload: {} };
  const paymentPort = {
    prepareProviderAttempt: vi.fn(async (_input: PreparedAttemptPrepareInput) => { trace.push("prepare"); return stored; }),
    finalizeProviderAttempt: vi.fn(async (_input: PreparedAttemptFinalizeInput) => { trace.push("finalize"); return { ...stored, status: "processing" as const }; }),
  };
  const executionPort = { validateInput: vi.fn(() => { trace.push("validate"); }),
    execute: vi.fn(async (_input: PaymentExecutionBaseInput) => { trace.push("execute"); return execution; }) };
  const input = { paymentPort, executionPort, provider: "provider-a", paymentIntentId: "intent-original",
    executionInput: { idempotencyKey: "execution", providerIdempotencyKey: "provider-key",
      providerRequestFingerprint: "fingerprint", paymentIntentId: "intent-original", amountMinor: 4900,
      currency: "XXX", mode: "one_time" as "one_time" | "subscription_cycle", orderRef: "order-original" },
    prepareIdempotencyKey: "prepare", finalizeIdempotencyKey: "finalize", providerIdempotencyKey: "provider-key",
    providerRequestFingerprint: "fingerprint", providerFlow: "one_time", prepareRequestPayload: {} };
  const run = () => executePreparedAttemptMechanism(input, policy);
  return { trace, stored, execution, paymentPort, executionPort, input, run };
}

describe("published prepared attempt key forwarding", () => {
  const intent = "88888888-8888-4888-8888-888888888888";
  it.each([
    ["checkout:original:payment-execution", 4990, "one_time", "order_wave-a"],
    ["checkout:original:payment-execution:attempt:1", 4990, "one_time", "order_wave-a"],
    ["subscription:sub-original:cycle:2026-10-21T00:00:00Z:payment-execution:attempt:0", 7200, "subscription_cycle", "order_renewal"],
    ["subscription:sub-original:cycle:2026-10-21T00:00:00Z:payment-execution:attempt:0:provider-seq:2", 7200, "subscription_cycle", "order_renewal"],
  ] as const)("preserves host key %s through prepare, execution and finalize", async (key, amountMinor, mode, orderRef) => {
    const f = fixture();
    const providerKey = `veli:provider-a:${intent}:${key.toLowerCase()}`;
    const fingerprint = `provider-a|${intent}|${amountMinor}|XXX|${mode}|${orderRef}`;
    Object.assign(f.input, { paymentIntentId: intent, prepareIdempotencyKey: `${key}:prepare-attempt`,
      finalizeIdempotencyKey: `${key}:finalize-attempt`, providerIdempotencyKey: providerKey,
      providerRequestFingerprint: fingerprint, prepareRequestPayload: { providerRequestFingerprint: fingerprint } });
    Object.assign(f.input.executionInput, { idempotencyKey: key, providerIdempotencyKey: providerKey,
      providerRequestFingerprint: fingerprint, paymentIntentId: intent, amountMinor, mode, orderRef });
    await f.run();
    expect(f.executionPort.execute).toHaveBeenCalledExactlyOnceWith(f.input.executionInput);
    expect(f.executionPort.execute.mock.calls[0][0]).toMatchObject({ idempotencyKey: key,
      providerIdempotencyKey: providerKey, providerRequestFingerprint: fingerprint });
    expect(f.paymentPort.prepareProviderAttempt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      idempotencyKey: `${key}:prepare-attempt`, providerIdempotencyKey: providerKey,
      providerRequestFingerprint: fingerprint, requestPayload: { providerRequestFingerprint: fingerprint } }));
    expect(f.paymentPort.finalizeProviderAttempt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      idempotencyKey: `${key}:finalize-attempt`, providerIdempotencyKey: providerKey, providerRequestFingerprint: fingerprint }));
  });
});

describe("published prepared attempt acknowledgement boundary", () => {
  it("keeps external acceptance ahead of local acknowledgement", async () => {
    const f = fixture(); let acknowledge!: () => void;
    const accepted = new Promise<void>((resolve) => { acknowledge = resolve; });
    let sawAcceptance!: () => void;
    const acceptance = new Promise<void>((resolve) => { sawAcceptance = resolve; });
    f.executionPort.execute.mockImplementationOnce(async () => {
      f.trace.push("provider-accepted"); sawAcceptance(); await accepted; return f.execution;
    });
    const pending = f.run(); await acceptance;
    expect(f.trace).toEqual(["validate", "prepare", "provider-accepted"]);
    expect(f.paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
    acknowledge();
    await expect(pending).resolves.toMatchObject({ attempt: { paymentAttemptId: "attempt-original", status: "processing" } });
    expect(f.trace).toEqual(["validate", "prepare", "provider-accepted", "finalize"]);
  });

  it("keeps an accepted-but-unanswered execution ambiguous on the next invocation", async () => {
    const f = fixture();
    f.executionPort.execute.mockRejectedValueOnce(new Error("reply_lost_after_acceptance"));
    await expect(f.run()).rejects.toMatchObject({ code: "provider_execution_failed", dispatchState: "unknown",
      paymentAttemptId: "attempt-original" });
    f.paymentPort.prepareProviderAttempt.mockResolvedValueOnce({ ...f.stored, replayed: true });
    await expect(f.run()).rejects.toMatchObject({ code: "provider_attempt_in_flight",
      paymentAttemptId: "attempt-original", attemptStatus: "created", dispatchState: "unknown" });
    expect(f.executionPort.execute).toHaveBeenCalledTimes(1);
    expect(f.paymentPort.finalizeProviderAttempt).not.toHaveBeenCalled();
  });

  it("recovers a lost finalize reply with the identical acknowledgement and one dispatch", async () => {
    const f = fixture();
    f.paymentPort.finalizeProviderAttempt.mockRejectedValueOnce(new Error("reply_lost"));
    const result = await f.run();
    expect(result.execution).toBe(f.execution);
    expect(f.executionPort.execute).toHaveBeenCalledTimes(1);
    expect(f.paymentPort.finalizeProviderAttempt.mock.calls).toHaveLength(2);
    expect(f.paymentPort.finalizeProviderAttempt.mock.calls[1]).toEqual(f.paymentPort.finalizeProviderAttempt.mock.calls[0]);
    expect(f.trace).toEqual(["validate", "prepare", "execute", "finalize"]);
    f.paymentPort.prepareProviderAttempt.mockResolvedValueOnce({ ...f.stored, status: "processing", replayed: true,
      providerAttemptId: "remote-original" });
    await expect(f.run()).rejects.toMatchObject({ code: "provider_attempt_in_flight", attemptStatus: "processing",
      paymentAttemptId: "attempt-original" });
    expect(f.executionPort.execute).toHaveBeenCalledTimes(1);
    expect(f.paymentPort.finalizeProviderAttempt).toHaveBeenCalledTimes(2);
  });
});
