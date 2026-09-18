import { describe, expect, it, vi } from "vitest";

import type { PaymentExecutionResult } from "../../../src/domains/payment/types.js";
import type {
  AutomaticRenewalCycleSnapshot,
  AutomaticRenewalDue,
  AutomaticRenewalPaymentRail,
  AutomaticRenewalReadback,
  AutomaticRenewalReservationResult,
} from "./automaticRenewalPorts.js";
import {
  runAutomaticSubscriptionRenewals,
  runOneAutomaticSubscriptionRenewal,
  type AutomaticRenewalRunDeps,
} from "./runAutomaticSubscriptionRenewal.js";

const NOW = "2026-08-15T10:00:00.000Z";

describe("runOneAutomaticSubscriptionRenewal", () => {
  it("executes one external attempt and applies success only after provider readback", async () => {
    const fixture = createFixture();
    fixture.rail.readOutcome.mockResolvedValue({
      status: "succeeded", occurredAt: NOW, reason: null,
      amountMinor: 2500, currency: "PLN",
    });

    await expect(runOneAutomaticSubscriptionRenewal(fixture.deps, due(), NOW)).resolves.toMatchObject({
      status: "succeeded", reason: null,
    });

    expect(fixture.execution.execute).toHaveBeenCalledTimes(1);
    expect(fixture.execution.execute).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `${readback().identityKey}:provider-attempt`,
      providerRequestFingerprint: "a".repeat(64),
      mode: "subscription_cycle",
      providerFlow: "off_session_payment",
    }));
    expect(fixture.settlement.acknowledgeExternalAttempt).toHaveBeenCalledWith(expect.objectContaining({
      externalAttemptRef: "external-attempt-1",
    }));
    expect(fixture.settlement.recordTerminalOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "succeeded", externalRef: "external-attempt-1",
    }));
    expect(fixture.failure.handoffFailure).not.toHaveBeenCalled();
  });

  it("refuses insufficient ATP before preparing or executing payment and never opens dunning", async () => {
    const fixture = createFixture();
    fixture.inventory.reserve.mockResolvedValue({
      reserved: false, replayed: false, reservationId: null,
      status: "refused", reason: "insufficient_atp",
    });

    await expect(runOneAutomaticSubscriptionRenewal(fixture.deps, due(), NOW)).resolves.toMatchObject({
      status: "refused", reason: "insufficient_atp",
    });
    expect(fixture.settlement.prepareRenewal).not.toHaveBeenCalled();
    expect(fixture.execution.execute).not.toHaveBeenCalled();
    expect(fixture.failure.handoffFailure).not.toHaveBeenCalled();
  });

  it("hands an explicit provider refusal to the lifecycle before recording terminal state", async () => {
    const fixture = createFixture();
    fixture.execution.execute.mockResolvedValue(execution({
      providerDecline: { code: "declined", mandateUnsupported: false },
    }));
    const sequence: string[] = [];
    fixture.failure.handoffFailure.mockImplementation(async () => {
      sequence.push("handoff");
      return { caseId: "case-1", replayed: false };
    });
    fixture.settlement.recordTerminalOutcome.mockImplementation(async () => {
      sequence.push("terminal");
      return {};
    });

    await expect(runOneAutomaticSubscriptionRenewal(fixture.deps, due(), NOW)).resolves.toMatchObject({
      status: "refused", reason: "provider_declined",
    });
    expect(sequence).toEqual(["handoff", "terminal"]);
    expect(fixture.failure.handoffFailure).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `${readback().identityKey}:failure-handoff`,
      cycleId: "cycle-1", orderId: "order-1", paymentIntentId: "intent-1",
      clientId: due().clientId, failureClass: "indeterminate",
      amountMinor: 2500, currency: "PLN",
    }));
  });

  it("does not retry a prepared external boundary after restart", async () => {
    const operation = readback({
      state: "attempt_prepared", acquired: true, replayed: true,
      externalAttemptRef: null, cycleId: "cycle-1", orderId: "order-1",
      settlementIntentId: "intent-1",
    });
    const fixture = createFixture(operation);

    await expect(runOneAutomaticSubscriptionRenewal(fixture.deps, due(), NOW)).resolves.toMatchObject({
      status: "awaiting_provider", reason: "prepared_attempt_ack_missing",
    });
    expect(fixture.execution.execute).not.toHaveBeenCalled();
    expect(fixture.settlement.prepareRenewal).not.toHaveBeenCalled();
  });

  it("reads back an acknowledged prepared attempt without executing a second charge", async () => {
    const operation = readback({
      state: "attempt_prepared", acquired: true, replayed: true,
      externalAttemptRef: "external-attempt-1", cycleId: "cycle-1", orderId: "order-1",
      settlementIntentId: "intent-1",
    });
    const fixture = createFixture(operation);
    fixture.rail.readOutcome.mockResolvedValue({
      status: "pending", occurredAt: null, reason: null, amountMinor: 2500, currency: "PLN",
    });

    await expect(runOneAutomaticSubscriptionRenewal(fixture.deps, due(), NOW)).resolves.toMatchObject({
      status: "awaiting_provider", reason: "provider_pending",
    });
    expect(fixture.execution.execute).not.toHaveBeenCalled();
    expect(fixture.rail.readOutcome).toHaveBeenCalledTimes(1);
  });

  it("recovers a provider attempt accepted before the local acknowledgement was persisted", async () => {
    const operation = readback({
      state: "attempt_prepared", acquired: true, replayed: true,
      externalAttemptRef: null, cycleId: "cycle-1", orderId: "order-1",
      settlementIntentId: "intent-1",
    });
    const fixture = createFixture(operation);
    fixture.rail.findExternalAttempt.mockResolvedValue("recovered-attempt-1");
    fixture.rail.readOutcome.mockResolvedValue({
      status: "succeeded", occurredAt: NOW, reason: null, amountMinor: 2500, currency: "PLN",
    });

    await expect(runOneAutomaticSubscriptionRenewal(fixture.deps, due(), NOW)).resolves.toMatchObject({
      status: "succeeded",
    });
    expect(fixture.execution.execute).not.toHaveBeenCalled();
    expect(fixture.settlement.acknowledgeExternalAttempt).toHaveBeenCalledWith(expect.objectContaining({
      externalAttemptRef: "recovered-attempt-1",
    }));
  });

  it("keeps a thrown provider call indeterminate and does not create dunning", async () => {
    const fixture = createFixture();
    fixture.execution.execute.mockRejectedValue(new Error("timeout"));

    await expect(runOneAutomaticSubscriptionRenewal(fixture.deps, due(), NOW)).resolves.toMatchObject({
      status: "awaiting_provider", reason: "provider_execution_indeterminate",
    });
    expect(fixture.settlement.recordTerminalOutcome).not.toHaveBeenCalled();
    expect(fixture.failure.handoffFailure).not.toHaveBeenCalled();
  });

  it("records local provider validation as an operator refusal without dunning", async () => {
    const fixture = createFixture();
    fixture.execution.validateInput.mockImplementation(() => { throw new Error("invalid"); });

    await expect(runOneAutomaticSubscriptionRenewal(fixture.deps, due(), NOW)).resolves.toMatchObject({
      status: "refused", reason: "provider_input_invalid",
    });
    expect(fixture.execution.execute).not.toHaveBeenCalled();
    expect(fixture.settlement.recordTerminalOutcome).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "refused", reason: "provider_input_invalid",
    }));
    expect(fixture.failure.handoffFailure).not.toHaveBeenCalled();
  });
});

describe("runAutomaticSubscriptionRenewals", () => {
  it("isolates a poison row and continues the due batch", async () => {
    const fixture = createFixture();
    const second = { ...due(), subscriptionId: "33333333-3333-4333-8333-333333333333" };
    fixture.store.listDue.mockResolvedValue([due(), second]);
    fixture.store.buildCycleSnapshots
      .mockRejectedValueOnce(new Error("bad row"))
      .mockResolvedValueOnce({ ...snapshot(), subscriptionId: second.subscriptionId });
    fixture.store.claimDue.mockResolvedValueOnce(readback({ subscriptionId: second.subscriptionId }));

    const results = await runAutomaticSubscriptionRenewals(fixture.deps);

    expect(results).toHaveLength(2);
    expect(fixture.inventory.expireReservations).toHaveBeenCalledWith({
      now: NOW,
      limit: 100,
    });
    expect(fixture.inventory.expireReservations.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.store.listDue.mock.invocationCallOrder[0],
    );
    expect(results[0]).toMatchObject({ status: "error", reason: "renewal_processing_failed" });
    expect(results[1]).toMatchObject({ status: "awaiting_provider" });
    expect(fixture.execution.execute).toHaveBeenCalledOnce();
  });
});

function createFixture(operation = readback()) {
  const executionPort = {
    validateInput: vi.fn(),
    execute: vi.fn(async () => execution()),
  };
  const readOutcome: AutomaticRenewalPaymentRail["readOutcome"] = async () => ({
    status: "pending", occurredAt: null, reason: null,
    amountMinor: 2500, currency: "PLN",
  });
  const rail = {
    executionPort,
    findExternalAttempt: vi.fn(async () => null as string | null),
    readOutcome: vi.fn(readOutcome),
  };
  const store = {
    listDue: vi.fn(async () => [due()]),
    buildCycleSnapshots: vi.fn(async () => snapshot()),
    readMandateEvidence: vi.fn(async () => ({
      authorized: true as const, authorizationRef: "authorization-1", authorizedAt: NOW,
    })),
    admitDeliveryAlignment: vi.fn(async () => ({ allowed: true, reason: null })),
    claimDue: vi.fn(async () => operation),
    readRenewal: vi.fn(async () => operation),
    refuseBeforePayment: vi.fn(async () => readback({
      state: "refused", terminalOutcome: "refused", terminalReason: "preflight_refused",
    })),
  };
  const reserve: () => Promise<AutomaticRenewalReservationResult> = async () => ({
      reserved: true, replayed: false, reservationId: "reservation-1" as string | null,
      status: "held", reason: null,
    });
  const inventory = {
    reserve: vi.fn(reserve),
    releaseReservation: vi.fn(async () => ({})),
    expireReservations: vi.fn(async () => 0),
  };
  const settlement = {
    prepareRenewal: vi.fn(async () => ({
      contractVersion: "platform.subscription.renewal.v1" as const,
      replayed: false, operationId: "operation-1", operationFingerprint: "a".repeat(64),
      cycleId: "cycle-1", orderId: "order-1", settlementIntentId: "intent-1",
      state: "attempt_prepared" as const,
    })),
    acknowledgeExternalAttempt: vi.fn(async () => ({})),
    recordTerminalOutcome: vi.fn(async () => ({})),
  };
  const failure = {
    handoffFailure: vi.fn(async () => ({ caseId: "case-1", replayed: false })),
  };
  const deps: AutomaticRenewalRunDeps = {
    store, inventory, settlement,
    paymentRails: { resolve: () => rail },
    failureHandoff: failure,
    workerId: "worker-1",
    now: () => NOW,
  };
  return { deps, execution: executionPort, rail, store, inventory, settlement, failure };
}

function due(): AutomaticRenewalDue {
  return {
    subscriptionId: "11111111-1111-4111-8111-111111111111",
    clientId: "22222222-2222-4222-8222-222222222222",
    scheduledAt: NOW, cadenceDays: 30, cycleNumber: 4, currency: "PLN",
    stockSourceKey: "primary", settlementChannelKey: "configured",
    authorizationRef: "authorization-1", payerAccountRef: "payer-1",
    unattendedChargeAuthorizedAt: NOW, deliveryAdmission: "allowed", deliveryBlockReason: null,
  };
}

function snapshot(): AutomaticRenewalCycleSnapshot {
  return {
    contractVersion: "platform.subscription.renewal.v1",
    subscriptionId: due().subscriptionId, clientId: due().clientId,
    scheduledAt: NOW, cycleNumber: 4,
    currency: "PLN", totalAmountMinor: 2500, stockSourceKey: "primary",
    settlementChannelKey: "configured", authorizationRef: "authorization-1",
    payerAccountRef: "payer-1",
    lines: [{ lineOrdinal: 1, sku: "SKU-1", quantity: 2, unitAmountMinor: 1250 }],
  };
}

function readback(override: Partial<AutomaticRenewalReadback> = {}): AutomaticRenewalReadback {
  return {
    contractVersion: "platform.subscription.renewal.v1", acquired: true, replayed: false,
    reason: "claimed", operationId: "operation-1",
    identityKey: `subscription:${due().subscriptionId}:cycle:${NOW}`,
    operationFingerprint: "a".repeat(64), subscriptionId: due().subscriptionId,
    scheduledAt: NOW, cycleNumber: 4, state: "claimed", claimToken: "claim-1",
    claimGeneration: 1, leaseExpiresAt: "2026-08-15T10:05:00.000Z",
    cycleSnapshot: snapshot(), externalAttemptRef: null,
    externalAttemptAcknowledgedAt: null, terminalOutcome: null, terminalReason: null,
    terminalAt: null, reservationId: null, cycleId: null, orderId: null,
    settlementIntentId: null, ...override,
  };
}

function execution(override: Partial<PaymentExecutionResult> = {}): PaymentExecutionResult {
  return {
    provider: "stripe", providerAttemptId: "external-attempt-1", providerSessionId: null,
    attemptStatus: "processing", nextActionKind: null, providerDecline: null,
    requestPayload: {}, responsePayload: {}, ...override,
  };
}
