import { describe, expect, it, vi } from "vitest";
import type {
  PaymentProviderCapabilityDescriptor,
  PaymentProviderCapabilityRegistry,
} from "@openlup/core/payment";
import {
  runSubscriptionRenewalBatch,
  type SubscriptionRenewalBatchDependencies,
} from "./subscriptionRenewalInvocation.js";
const mockCharge = vi.hoisted(() => vi.fn());
vi.mock("./chargeSubscriptionCycleOffSession.js", () => ({
  chargeSubscriptionCycleOffSession: mockCharge,
}));
// One shared due row for every case here: the renewal preflight admits only a
// closed set of provider kinds, so the fixture cannot be neutral without the
// batch blocking before it ever reaches the code under test.
const due = {
  subscriptionId: "00000000-0000-4000-8000-000000000099", clientId: "11111111-1111-4111-8111-111111111111",
  nextCycleAt: "2026-08-01T00:00:00.000Z", currency: "USD",
  providerKind: "stripe", providerCustomerRef: "cus_99",
  providerMethodRef: "pm_99", methodKind: "card",
  payerEmail: "customer@example.test", payerName: "Customer",
  methodStatus: "active", methodActive: true, methodExpiresAt: null,
  methodClientId: "11111111-1111-4111-8111-111111111111",
};
// The batch hands the charge what the row's rail can do with a stored consent.
const capabilityRegistry = (kinds: readonly string[]): PaymentProviderCapabilityRegistry => ({
  get: (providerKind) => kinds.includes(providerKind)
    ? { providerKind } as PaymentProviderCapabilityDescriptor
    : null,
  kinds: () => [...kinds],
});
const publishedCapabilities = capabilityRegistry([due.providerKind]);

function persistenceWithNote(
  rpc: (name: string, args: Record<string, unknown>) => Promise<unknown>,
): SubscriptionRenewalBatchDependencies["persistence"] {
  return {
    noteRowOutcome: (input: { subscriptionId: string; scheduledAt: string; errorKey: string | null }) => rpc("subscription_renewal_note_row_outcome", {
      p_subscription_id: input.subscriptionId,
      p_scheduled_at: input.scheduledAt,
      p_error_key: input.errorKey,
    }).then(() => undefined),
  } as unknown as SubscriptionRenewalBatchDependencies["persistence"];
}

describe("runSubscriptionRenewalBatch", () => {
  it("passes the injected clock through due selection and charge retry timing", async () => {
    const asOf = new Date("2026-08-01T10:00:00.000Z");
    const retryNow = new Date("2026-08-01T10:00:03.000Z");
    const clock = { now: vi.fn().mockReturnValueOnce(asOf).mockReturnValueOnce(asOf).mockReturnValueOnce(retryNow) };
    const duePort = { listDue: vi.fn(async () => [due]) };
    const admitted = { allowed: true as const, state: "none", reason: "on_time" };
    const admitDeliveryAlignment = vi.fn(async () => admitted);
    mockCharge.mockImplementation(async (chargeDeps, chargeDue) => {
      expect(chargeDeps.now()).toBe(retryNow.toISOString());
      expect(chargeDeps.deliveryAlignmentAdmission).toBe(admitted);
      return {
        subscriptionId: chargeDue.subscriptionId, outcome: "charged",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "succeeded",
        replayed: false,
      };
    });
    const deps: SubscriptionRenewalBatchDependencies = {
      persistence: persistenceWithNote(async () => undefined),
      deliveryAlignment: { admitDeliveryAlignment },
      chargeFailurePropagation:
        {} as SubscriptionRenewalBatchDependencies["chargeFailurePropagation"],
      paymentPort: {} as SubscriptionRenewalBatchDependencies["paymentPort"],
      duePort,
      resolveExecutionPort: () => ({ port: { execute: vi.fn() }, reason: null }),
      capabilities: publishedCapabilities,
      clock,
    };
    await expect(runSubscriptionRenewalBatch(deps)).resolves.toMatchObject({
      kind: "completed",
      startedRows: 1,
      results: [expect.objectContaining({ outcome: "charged" })],
    });
    expect(duePort.listDue).toHaveBeenCalledWith(50, asOf);
    expect(admitDeliveryAlignment).toHaveBeenCalledTimes(1);
  });

  // ---- quarantine bookkeeping (PR-0c) --------------------------------------
  // A row that throws identically on every tick re-presents the same work
  // forever. The batch has to report each row outcome so the lane can degrade a
  // provably-stuck row to a slow retry — and has to clear that state the moment
  // the row completes, or the degrade becomes a stop.
  describe("renewal-lane quarantine bookkeeping", () => {
    function harness(rpcImpl?: (fn: string, args: Record<string, unknown>) => unknown) {
      const asOf = new Date("2026-08-01T10:00:00.000Z");
      const rpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
        if (rpcImpl) return rpcImpl(fn, args) as { data: unknown; error: null };
        return { data: null, error: null };
      });
      const deps = {
        persistence: persistenceWithNote(rpc),
        deliveryAlignment: {
          admitDeliveryAlignment: vi.fn(async () => ({ allowed: true, state: "none", reason: "on_time" })),
        },
        chargeFailurePropagation:
        {} as SubscriptionRenewalBatchDependencies["chargeFailurePropagation"],
      paymentPort: {} as SubscriptionRenewalBatchDependencies["paymentPort"],
        duePort: { listDue: vi.fn(async () => [due]) },
        resolveExecutionPort: () => ({ port: { execute: vi.fn() }, reason: null }),
        capabilities: publishedCapabilities,
        clock: { now: () => asOf },
      } as SubscriptionRenewalBatchDependencies;
      const noteCalls = () => rpc.mock.calls
        .filter((c) => c[0] === "subscription_renewal_note_row_outcome")
        .map((c) => c[1] as Record<string, unknown>);
      return { deps, rpc, noteCalls };
    }

    it.each([
      ["customer payment block", { ...due, methodStatus: "revoked", methodActive: false }, { port: { execute: vi.fn() }, reason: null }],
      ["operator provider block", due, { port: null, reason: "subscription_provider_disabled" }],
    ])("protects delivery before the %s can create preflight artifacts", async (_label, blockedDue, resolution) => {
      const asOf = new Date("2026-08-01T10:00:00.000Z");
      const admitDeliveryAlignment = vi.fn(async () => ({
        allowed: false, state: "protected", reason: "delivery_alignment_protected",
      }));
      const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: null, error: null }));
      const resolveExecutionPort = vi.fn(() => resolution);
      const deps = {
        persistence: persistenceWithNote(rpc),
        deliveryAlignment: { admitDeliveryAlignment },
        paymentPort: {},
        duePort: { listDue: vi.fn(async () => [blockedDue]) },
        resolveExecutionPort,
        capabilities: publishedCapabilities,
        clock: { now: () => asOf },
      } as unknown as SubscriptionRenewalBatchDependencies;
      mockCharge.mockClear();

      const result = await runSubscriptionRenewalBatch(deps);

      expect(result).toMatchObject({
        kind: "completed",
        results: [expect.objectContaining({ outcome: "skipped", reason: "delivery_alignment_protected" })],
      });
      expect(admitDeliveryAlignment).toHaveBeenCalledWith({
        subscriptionId: blockedDue.subscriptionId,
        scheduledAt: blockedDue.nextCycleAt,
        asOf: asOf.toISOString(),
      });
      expect(resolveExecutionPort).not.toHaveBeenCalled();
      expect(mockCharge).not.toHaveBeenCalled();
      expect(rpc.mock.calls.some(([name]) => name === "subscription_create_cycle_order_with_outbox")).toBe(false);
    });

    it("fails the row closed when delivery admission cannot be parsed", async () => {
      const asOf = new Date("2026-08-01T10:00:00.000Z");
      const rpc = vi.fn(async (_name: string, _args: Record<string, unknown>) => ({ data: null, error: null }));
      const resolveExecutionPort = vi.fn(() => ({ port: { execute: vi.fn() }, reason: null }));
      const deps = {
        persistence: persistenceWithNote(rpc),
        deliveryAlignment: {
          admitDeliveryAlignment: vi.fn().mockRejectedValue(
            new Error("subscription_delivery_alignment_admission_invalid_response"),
          ),
        },
        paymentPort: {},
        duePort: { listDue: vi.fn(async () => [due]) },
        resolveExecutionPort,
        capabilities: publishedCapabilities,
        clock: { now: () => asOf },
      } as unknown as SubscriptionRenewalBatchDependencies;
      mockCharge.mockClear();

      const result = await runSubscriptionRenewalBatch(deps);

      expect(result).toMatchObject({
        kind: "completed",
        results: [],
        errors: [expect.objectContaining({ reason: "subscription_delivery_alignment_admission_invalid_response" })],
      });
      expect(resolveExecutionPort).not.toHaveBeenCalled();
      expect(mockCharge).not.toHaveBeenCalled();
      expect(rpc.mock.calls.some(([name]) => name === "subscription_create_cycle_order_with_outbox")).toBe(false);
    });

    it("reports the normalized error key so a repeated failure can be recognised", async () => {
      const { deps, noteCalls } = harness();
      mockCharge.mockImplementation(async () => {
        throw new Error("commerce_payment_control_apply_result failed: payment_control_result_idempotency_conflict");
      });

      const result = await runSubscriptionRenewalBatch(deps);

      expect(result).toMatchObject({ kind: "completed", errors: [expect.objectContaining({ subscription_id: due.subscriptionId })] });
      expect(noteCalls()).toEqual([{
        p_subscription_id: due.subscriptionId,
        p_scheduled_at: due.nextCycleAt,
        // The same key the run ledger counts, so "three identical failures"
        // means the same thing to the quarantine and to an operator.
        p_error_key: "payment_control_result_idempotency_conflict",
      }]);
    });

    it("clears the streak on a row that completed and progressed", async () => {
      const { deps, noteCalls } = harness();
      mockCharge.mockImplementation(async () => ({
        subscriptionId: due.subscriptionId, outcome: "failed",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "failed", replayed: false, reason: "card_declined",
      }));

      await runSubscriptionRenewalBatch(deps);

      // An unhappy outcome is still an outcome: this decline ADVANCED the
      // ladder, so it is progress and must not count toward a quarantine.
      expect(noteCalls()).toEqual([expect.objectContaining({ p_error_key: null })]);
    });

    it("counts a completed-but-replayed row as NON-progress", async () => {
      // The failure mode this wave would otherwise create: the durable instant
      // stops the 23505, so every tick now SUCCEEDS while changing nothing. The
      // row never throws, so the error handler never sees it; without this the
      // 15-minute loop would just go quiet, ladder frozen and nothing paging.
      const { deps, noteCalls } = harness();
      mockCharge.mockImplementation(async () => ({
        subscriptionId: due.subscriptionId, outcome: "failed",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "failed", replayed: false, applyReplayed: true,
        dunningCaseId: "case_1", retryAttempt: 1, reason: "provider_declined",
      }));

      await runSubscriptionRenewalBatch(deps);

      expect(noteCalls()).toEqual([expect.objectContaining({
        p_error_key: "renewal_apply_replayed_no_progress",
      })]);
    });

    it("feeds consecutive replays one identical key, which is what earns a quarantine", async () => {
      // The streak only advances on an IDENTICAL key, so the loop is only
      // degraded if every tick reports the same one. Three passes here stand in
      // for three cron ticks; the RPC's own counting is pinned in pgTAP.
      const { deps, noteCalls } = harness();
      mockCharge.mockImplementation(async () => ({
        subscriptionId: due.subscriptionId, outcome: "failed",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "failed", replayed: false, applyReplayed: true,
        dunningCaseId: "case_1", retryAttempt: 1, reason: "provider_declined",
      }));

      await runSubscriptionRenewalBatch(deps);
      await runSubscriptionRenewalBatch(deps);
      await runSubscriptionRenewalBatch(deps);

      const keys = noteCalls().map((call) => call.p_error_key);
      expect(keys).toEqual([
        "renewal_apply_replayed_no_progress",
        "renewal_apply_replayed_no_progress",
        "renewal_apply_replayed_no_progress",
      ]);
    });

    it("clears a preflight-blocked row that progressed, and flags one that only replayed", async () => {
      // The preflight block is THE path the live incident runs through, and it
      // reaches the batch through a different call site than the charge above.
      const progressed = harness();
      mockCharge.mockImplementation(async () => ({
        subscriptionId: due.subscriptionId, outcome: "failed",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "failed", replayed: false, reason: "payment_method_revoked",
      }));
      await runSubscriptionRenewalBatch(progressed.deps);
      expect(progressed.noteCalls()).toEqual([expect.objectContaining({ p_error_key: null })]);

      const stuck = harness();
      mockCharge.mockImplementation(async () => ({
        subscriptionId: due.subscriptionId, outcome: "failed",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "failed", replayed: false, applyReplayed: true,
        reason: "payment_method_revoked",
      }));
      await runSubscriptionRenewalBatch(stuck.deps);
      expect(stuck.noteCalls()).toEqual([expect.objectContaining({
        p_error_key: "renewal_apply_replayed_no_progress",
      })]);
    });

    it("never charges a row whose rail publishes no capability", async () => {
      // Fail closed at the charge boundary: a resolved port says the adapter
      // exists, not that this deployment can state what the rail may do with a
      // stored consent. Charging on that gap would mean inventing its rules.
      const { deps, rpc } = harness();
      const undescribed = { ...deps, capabilities: capabilityRegistry([]) };
      mockCharge.mockClear();
      mockCharge.mockImplementation(async () => {
        throw new Error("charge must not run without a published capability");
      });

      const result = await runSubscriptionRenewalBatch(undescribed);

      expect(mockCharge).not.toHaveBeenCalled();
      expect(result).toMatchObject({ kind: "completed", errors: [] });
      expect(rpc.mock.calls.some(([fn]) => fn === "commerce_payment_control_record_attempt")).toBe(false);
    });

    // ---- dunning propagation failure (PR-0d) -------------------------------
    it("counts a failed dunning propagation as NON-progress", async () => {
      // The charge failed, apply_result advanced the ladder, and the row did
      // not throw — so every existing signal reads "handled". What actually
      // happened is that the customer got no case, no recovery token and no
      // email. Without this the row repeats that silently, ladder rung by rung.
      const { deps, noteCalls } = harness();
      mockCharge.mockImplementation(async () => ({
        subscriptionId: due.subscriptionId, outcome: "failed",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "failed", replayed: false,
        dunningCaseId: null, retryAttempt: 1, dunningPropagationFailed: true,
        reason: "provider_declined",
      }));

      await runSubscriptionRenewalBatch(deps);

      expect(noteCalls()).toEqual([expect.objectContaining({
        p_error_key: "renewal_dunning_propagation_failed",
      })]);
    });

    it("feeds consecutive dunning-propagation failures one identical key, which earns the quarantine", async () => {
      const { deps, noteCalls } = harness();
      mockCharge.mockImplementation(async () => ({
        subscriptionId: due.subscriptionId, outcome: "failed",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "failed", replayed: false,
        dunningCaseId: null, retryAttempt: 1, dunningPropagationFailed: true,
        reason: "provider_declined",
      }));

      await runSubscriptionRenewalBatch(deps);
      await runSubscriptionRenewalBatch(deps);
      await runSubscriptionRenewalBatch(deps);

      expect(noteCalls().map((call) => call.p_error_key)).toEqual([
        "renewal_dunning_propagation_failed",
        "renewal_dunning_propagation_failed",
        "renewal_dunning_propagation_failed",
      ]);
    });

    it("reports ONE key when a row both replayed and lost its dunning step", async () => {
      // Two non-progress signals, one streak. Alternating keys would reset the
      // count every tick and the row would never be quarantined at all.
      const { deps, noteCalls } = harness();
      mockCharge.mockImplementation(async () => ({
        subscriptionId: due.subscriptionId, outcome: "failed",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "failed", replayed: false,
        applyReplayed: true, dunningPropagationFailed: true,
        reason: "provider_declined",
      }));

      await runSubscriptionRenewalBatch(deps);

      expect(noteCalls()).toEqual([expect.objectContaining({
        p_error_key: "renewal_dunning_propagation_failed",
      })]);
    });

    it("clears the streak when the dunning case did open", async () => {
      const { deps, noteCalls } = harness();
      mockCharge.mockImplementation(async () => ({
        subscriptionId: due.subscriptionId, outcome: "failed",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "failed", replayed: false,
        dunningCaseId: "case_1", retryAttempt: 1, dunningPropagationFailed: false,
        reason: "provider_declined",
      }));

      await runSubscriptionRenewalBatch(deps);

      expect(noteCalls()).toEqual([expect.objectContaining({ p_error_key: null })]);
    });

    it("never lets bookkeeping failure become a row failure", async () => {
      // Bookkeeping exists to protect the batch; a version of it that can break
      // the batch would be a second source of the same outage.
      const rejecting = harness((fn) => fn === "subscription_renewal_note_row_outcome"
        ? { data: null, error: { message: "bookkeeping down" } }
        : { data: null, error: null });
      mockCharge.mockImplementation(async () => ({
        subscriptionId: due.subscriptionId, outcome: "charged",
        cycleId: null, cycleNumber: null, orderId: null, paymentIntentId: null,
        attemptStatus: "succeeded", replayed: false,
      }));
      await expect(runSubscriptionRenewalBatch(rejecting.deps)).resolves.toMatchObject({
        kind: "completed", errors: [], results: [expect.objectContaining({ outcome: "charged" })],
      });

      const throwing = harness((fn) => {
        if (fn === "subscription_renewal_note_row_outcome") throw new Error("bookkeeping exploded");
        return { data: null, error: null };
      });
      await expect(runSubscriptionRenewalBatch(throwing.deps)).resolves.toMatchObject({
        kind: "completed", errors: [],
      });
    });
  });
});
