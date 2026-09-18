import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_STALE_AFTER_SECONDS,
  runPaymentProviderReconciliationWorker,
  type ClaimedPaymentAttempt,
  type PaymentProviderReconciliationPort,
  type ProviderReconciliationStatus,
  type ReconciliationProviderKind,
} from "./paymentProviderReconciliationWorker.js";
import { PSP_PROVIDER_KINDS } from "../../../src/domains/payment/pspIntegrationPlan.js";

const NOW = "2026-07-03T10:00:00.000Z";

describe("runPaymentProviderReconciliationWorker", () => {
  it("records stale prepared attempts as operator-only evidence without provider read or terminal apply", async () => {
    const attempt = claimedAttempt({
      attemptStatus: "created",
      providerPaymentId: null,
      providerAttemptId: null,
      providerSessionId: null,
    });
    const port = fakePort([], [], [attempt]);
    const readPayment = vi.fn();

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: { readPayment } },
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      checked: 1,
      preparedWithoutProviderAck: 1,
      failures: 1,
      providerCalls: 0,
      reason: "prepared_without_provider_ack",
    });
    expect(readPayment).not.toHaveBeenCalled();
    expect(port.applyTerminalResult).not.toHaveBeenCalled();
    expect(port.recordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      correctionStatus: "failed",
      providerPaymentId: null,
      providerStatus: "prepared_without_provider_ack",
      payload: expect.objectContaining({
        operatorReviewRequired: true,
        providerPayload: expect.objectContaining({
          providerAcknowledged: false,
          providerCallPlanned: true,
        }),
      }),
    }));
  });

  it("hard-caps a run and reserves finalized capacity despite an oversized requested batch", async () => {
    const prepared = [1, 2, 3, 4].map((index) => claimedAttempt({
      paymentAttemptId: `11111111-1111-4111-8111-11111111111${index}`,
      attemptStatus: "created",
      providerPaymentId: null,
      providerAttemptId: null,
      providerSessionId: null,
    }));
    const finalized = [1, 2, 3].map((index) => claimedAttempt({
      paymentAttemptId: `22222222-2222-4222-8222-22222222222${index}`,
    }));
    const port = fakePort(finalized, [], prepared);

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: provider(status("succeeded", "succeeded")) },
      now: NOW,
      batchSize: 500,
    });

    expect(result).toMatchObject({ checked: 4, preparedWithoutProviderAck: 2, providerCalls: 2 });
    expect(port.claimPreparedAttempts).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
    expect(port.claimStaleAttempts).toHaveBeenCalledWith(expect.objectContaining({ limit: 2 }));
  });

  it("records provider pending evidence without applying a local result", async () => {
    const attempt = claimedAttempt();
    const port = fakePort([attempt]);
    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: provider(status("pending", "processing")) },
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, checked: 1, pending: 1, corrected: 0, providerCalls: 1 });
    expect(port.applyTerminalResult).not.toHaveBeenCalled();
    expect(port.recordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      correctionStatus: "observed",
      providerStatus: "processing",
    }));
  });

  it("applies one-time terminal success and corrected evidence through one atomic port call", async () => {
    const attempt = claimedAttempt({
      orderMode: "one_time",
      subscriptionId: null,
      subscriptionCycleId: null,
    });
    const port = fakePort([attempt]);

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: provider(status("succeeded", "succeeded")) },
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, checked: 1, corrected: 1, succeeded: 1, dunningOpened: 0 });
    expect(port.applyTerminalResult).toHaveBeenCalledOnce();
    expect(port.applyTerminalResult).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `payment-provider-reconciliation:${attempt.paymentAttemptId}:apply:succeeded`,
      expectedOrderId: attempt.orderId,
      expectedPaymentIntentId: attempt.paymentIntentId,
      expectedPaymentAttemptId: attempt.paymentAttemptId,
      expectedPaymentId: attempt.paymentId,
      provider: "stripe",
      providerPaymentId: "pi_test",
      localStatus: "processing",
      providerStatus: "succeeded",
      resultStatus: "succeeded",
      failureReason: null,
      checkedAt: NOW,
      payload: expect.objectContaining({ applied: true, resultStatus: "succeeded" }),
    }));
    expect(port.recordEvidence).not.toHaveBeenCalled();
  });

  it("counts failure and dunning returned by the atomic terminal operation", async () => {
    const attempt = claimedAttempt();
    const port = fakePort([attempt]);
    vi.mocked(port.applyTerminalResult).mockResolvedValueOnce(terminalResult(attempt, {
      status: "failed",
      dunning: { opened: true, replayed: false, caseId: "dunning-1" },
    }));

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: provider(status("failed", "requires_action")) },
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, checked: 1, corrected: 1, failed: 1, dunningOpened: 1 });
    expect(port.applyTerminalResult).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: `payment-provider-reconciliation:${attempt.paymentAttemptId}:apply:failed`,
      resultStatus: "failed",
      failureReason: "provider_requires_action",
    }));
  });

  it("counts exact terminal replays without reporting a fresh correction or dunning open", async () => {
    const attempt = claimedAttempt();
    const port = fakePort([attempt]);
    vi.mocked(port.applyTerminalResult).mockResolvedValueOnce(terminalResult(attempt, {
      status: "failed",
      paymentResultReplayed: true,
      compositeReplayed: true,
      dunning: { opened: true, replayed: true, caseId: "dunning-1" },
    }));

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: provider(status("failed", "requires_action")) },
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: true,
      corrected: 0,
      failed: 1,
      dunningOpened: 0,
      replayed: 1,
    });
  });

  it("counts a historical partial apply as a fresh composite repair", async () => {
    const attempt = claimedAttempt();
    const port = fakePort([attempt]);
    vi.mocked(port.applyTerminalResult).mockResolvedValueOnce(terminalResult(attempt, {
      paymentResultReplayed: true,
      compositeReplayed: false,
    }));

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: provider(status("succeeded", "succeeded")) },
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, corrected: 1, succeeded: 1, replayed: 0 });
  });

  it("records provider amount drift as manual review without failing the scheduler", async () => {
    const attempt = claimedAttempt({ amountMinor: 1200 });
    const port = fakePort([attempt]);
    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: provider(status("succeeded", "succeeded", { amountMinor: 1300 })) },
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: true,
      checked: 1,
      failures: 0,
      manualReview: 1,
      amountCurrencyMismatches: 1,
    });
    expect(port.applyTerminalResult).not.toHaveBeenCalled();
    expect(port.recordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      correctionStatus: "failed",
      payload: expect.objectContaining({ failureReason: "provider_amount_mismatch" }),
    }));
  });

  it("counts an atomic ignored result when the webhook wins the terminal local race", async () => {
    const attempt = claimedAttempt();
    const port = fakePort([attempt]);
    vi.mocked(port.applyTerminalResult).mockResolvedValueOnce(terminalResult(attempt, {
      correctionStatus: "ignored",
      kind: "ignored_terminal",
    }));

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: provider(status("succeeded", "succeeded")) },
      now: NOW,
    });

    expect(result).toMatchObject({ ok: true, checked: 1, ignored: 1, corrected: 0 });
    expect(port.recordEvidence).not.toHaveBeenCalled();
  });

  it("records failed proof, not ignored proof, when the atomic RPC conflicts or errors", async () => {
    const attempt = claimedAttempt();
    const port = fakePort([attempt]);
    vi.mocked(port.applyTerminalResult).mockRejectedValueOnce(new Error("reconciliation_result_idempotency_conflict"));

    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { stripe: provider(status("succeeded", "succeeded")) },
      now: NOW,
    });

    expect(result).toMatchObject({
      ok: false,
      ignored: 0,
      corrected: 0,
      failures: 1,
      reason: "reconciliation_result_idempotency_conflict",
    });
    expect(port.recordEvidence).toHaveBeenCalledWith(expect.objectContaining({
      correctionStatus: "failed",
      providerStatus: "succeeded",
      payload: expect.objectContaining({ applied: false }),
    }));
  });
});

function fakePort(
  attempts: ClaimedPaymentAttempt[],
  calls: string[] = [],
  preparedAttempts: ClaimedPaymentAttempt[] = [],
): PaymentProviderReconciliationPort {
  return {
    claimPreparedAttempts: vi.fn(async ({ limit }) => preparedAttempts.slice(0, limit)),
    claimStaleAttempts: vi.fn(async ({ limit }) => attempts.slice(0, limit)),
    recordEvidence: vi.fn(async () => {
      calls.push("evidence");
      return { replayed: false };
    }),
    applyTerminalResult: vi.fn(async () => terminalResult(attempts[0] ?? claimedAttempt())),
    reopenPreparedAttemptAfterAbsence: vi.fn(async () => {
      calls.push("reopen");
      return { replayed: false };
    }),
  };
}

function terminalResult(
  attempt: ClaimedPaymentAttempt,
  overrides: {
    status?: "succeeded" | "failed";
    kind?: string;
    paymentResultReplayed?: boolean;
    compositeReplayed?: boolean;
    correctionStatus?: "corrected" | "ignored";
    dunning?: { opened: boolean; replayed: boolean; caseId: string | null } | null;
  } = {},
) {
  return {
    replayed: overrides.compositeReplayed ?? false,
    paymentResult: {
      paymentIntentId: attempt.paymentIntentId,
      paymentAttemptId: attempt.paymentAttemptId,
      paymentId: attempt.paymentId,
      orderId: attempt.orderId,
      status: overrides.status ?? "succeeded",
      kind: overrides.kind ?? "state_changed",
      replayed: overrides.paymentResultReplayed ?? false,
    },
    correctionStatus: overrides.correctionStatus ?? "corrected" as const,
    subscriptionWebhookDunning: overrides.dunning ?? null,
  };
}

function provider(next: ProviderReconciliationStatus) {
  return { readPayment: vi.fn(async () => next) };
}

function status(
  kind: ProviderReconciliationStatus["status"],
  providerStatus: string,
  overrides: Partial<ProviderReconciliationStatus> = {},
): ProviderReconciliationStatus {
  return {
    status: kind,
    providerStatus,
    occurredAt: null,
    failureReason: kind === "failed" ? `provider_${providerStatus}` : null,
    amountMinor: 1200,
    currency: "PLN",
    rawPayload: { providerStatus },
    ...overrides,
  };
}

function claimedAttempt(overrides: Partial<ClaimedPaymentAttempt> = {}): ClaimedPaymentAttempt {
  return {
    paymentAttemptId: "11111111-1111-4111-8111-111111111111",
    paymentIntentId: "22222222-2222-4222-8222-222222222222",
    paymentId: "33333333-3333-4333-8333-333333333333",
    orderId: "44444444-4444-4444-8444-444444444444",
    subscriptionId: "55555555-5555-4555-8555-555555555555",
    subscriptionCycleId: "66666666-6666-4666-8666-666666666666",
    provider: "stripe",
    providerPaymentId: "pi_test",
    providerAttemptId: "pi_test",
    providerSessionId: "pi_test",
    attemptStatus: "processing",
    intentStatus: "processing",
    amountMinor: 1200,
    currency: "PLN",
    orderMode: "subscription_cycle",
    cycleRetryAttempt: 0,
    cycleNextRetryAt: null,
    localUpdatedAt: "2026-07-03T09:30:00.000Z",
    ...overrides,
  };
}

/**
 * A rail that keeps answering non-terminally is indistinguishable from a healthy
 * slow one by polling alone. These cover the window that separates them, using
 * the shape of the historical failure mode of 2026-08-12: an attempt polled every
 * run for 33h, reported pending every time, and surfaced to nobody.
 */
describe("silence window", () => {
  const NOW = "2026-08-13T19:00:00.000Z";
  const window = (minutes: number) => ({
    get: () => ({ terminalOutcomeReporting: { silenceBecomesSuspectAfterMinutes: minutes } }),
  });
  // Keyed off the fixture's own rail rather than a literal, so this block adds
  // no provider vocabulary of its own.
  const silentRun = async (overrides: Record<string, unknown>) => {
    const attempt = claimedAttempt({ localUpdatedAt: "2026-08-12T10:00:03.000Z" });
    const port = fakePort([attempt]);
    const result = await runPaymentProviderReconciliationWorker({
      port,
      providers: { [attempt.provider]: pendingProvider() },
      now: NOW,
      ...overrides,
    });
    return { result, port };
  };

  it("counts an attempt whose rail has been silent past its declared window", async () => {
    const { result } = await silentRun({ capabilities: window(360) });
    expect(result).toMatchObject({ pending: 1, silenceOverdue: 1, manualReview: 1 });
  });

  it("never terminalizes from elapsed time alone", async () => {
    const { result } = await silentRun({ capabilities: window(360) });
    expect(result).toMatchObject({ failed: 0, succeeded: 0, corrected: 0, dunningOpened: 0 });
  });

  it("leaves a rail still inside its window alone", async () => {
    const { result } = await silentRun({ capabilities: window(60 * 24 * 30) });
    expect(result).toMatchObject({ pending: 1, silenceOverdue: 0, manualReview: 0 });
  });

  it("stays quiet when no capability is supplied at all", async () => {
    const { result } = await silentRun({});
    expect(result).toMatchObject({ pending: 1, silenceOverdue: 0, manualReview: 0 });
  });

  it("stays quiet when the rail declares an unusable window", async () => {
    const { result } = await silentRun({ capabilities: { get: () => ({}) } });
    expect(result).toMatchObject({ silenceOverdue: 0, manualReview: 0 });
  });

  it("marks the persisted evidence so an overdue poll is findable later", async () => {
    const { port } = await silentRun({ capabilities: window(360) });
    expect(port.recordEvidence).toHaveBeenCalledWith(
      expect.objectContaining({ payload: expect.objectContaining({ silenceOverdue: true }) }),
    );
  });
});

function pendingProvider() {
  return {
    resolvePaymentReference: (input: { providerPaymentId: string | null }) => input.providerPaymentId,
    readPayment: async () => ({
      status: "pending" as const,
      providerStatus: "processing",
      occurredAt: null,
      failureReason: null,
      amountMinor: 1200,
      currency: null,
      rawPayload: {},
    }),
  };
}

/**
 * Audit scenario 2(b) of 2026-08-09, at the worker. FLIPPED by wave 3i-b.
 *
 * The reconciliation rail is the one that discovers refusals nobody told us
 * about — the charge that goes quiet and is only found by polling. Both shipped
 * adapters translate what they read into a class through the shared
 * `classifyDecline` seam, and both put it in `rawPayload`. The worker used to
 * copy that blob into the evidence payload and stop there, because the terminal
 * write it composes had no classification field to put it in. It has one now, so
 * the class reaches the attempt and the dunning case instead of dying in a JSON
 * column no customer surface reads.
 */
describe("a reconciled refusal carries its class", () => {
  // Every shipped rail, read from the PSP register rather than listed here, so a
  // third rail joins this pin the day it joins the system. Nothing in this path
  // branches on which rail it is: if the carry were a single adapter's, one of
  // these rows would disagree.
  const RAILS: readonly ReconciliationProviderKind[] = PSP_PROVIDER_KINDS;

  it.each(RAILS)("%s: composes a terminal failure carrying the adapter's class", async (rail) => {
    const attempt = claimedAttempt({ provider: rail });
    const port = fakePort([attempt]);
    const read = status("failed", "requires_action", {
      rawPayload: {
        providerStatus: "requires_action",
        declineCode: "42",
        failureClass: "mandate_dead",
        failureClassDecidedBy: "neutral_hint",
      },
    });

    await runPaymentProviderReconciliationWorker({
      port,
      providers: { [rail]: provider(read) },
      now: NOW,
    });

    const applied = vi.mocked(port.applyTerminalResult).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(applied.resultStatus).toBe("failed");
    expect(applied.failureReason).toBe("provider_requires_action");
    // The verdict the adapter reached is READ, not re-derived: the worker never
    // classifies, so this is the adapter's own value arriving unchanged.
    expect(applied.failureClassification).toEqual({
      failureClass: "mandate_dead",
      decidedBy: "neutral_hint",
    });
    // Shape parity with the synchronous decline rail: one nested object, never a
    // pair of flattened keys. A flattened shape here would diverge from
    // `applyPaymentResultRpc` and quietly write nothing through the port.
    expect(Object.keys(applied)).not.toContain("failureClass");
    expect(Object.keys(applied)).not.toContain("failureClassDecidedBy");
    // Still in evidence too — the blob was never the problem, the missing
    // parameter was.
    expect(applied.payload).toMatchObject({
      providerPayload: expect.objectContaining({ failureClass: "mandate_dead" }),
    });
  });

  // The other direction, and the reason the contract's field is optional rather
  // than nullable: an adapter that reached no verdict must compose the exact call
  // it composed before the field existed. Absent, not present-and-null.
  it.each(RAILS)("%s: omits the field entirely when the adapter classified nothing", async (rail) => {
    const attempt = claimedAttempt({ provider: rail });
    const port = fakePort([attempt]);
    const read = status("failed", "requires_action", {
      rawPayload: { providerStatus: "requires_action", declineCode: "42" },
    });

    await runPaymentProviderReconciliationWorker({
      port,
      providers: { [rail]: provider(read) },
      now: NOW,
    });

    const applied = vi.mocked(port.applyTerminalResult).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(applied.resultStatus).toBe("failed");
    expect(Object.keys(applied)).not.toContain("failureClassification");
  });

  // A success has no refusal to classify, so the field stays absent there too
  // even when the blob happens to carry one.
  it.each(RAILS)("%s: omits the field on a reconciled success", async (rail) => {
    const attempt = claimedAttempt({ provider: rail });
    const port = fakePort([attempt]);
    const read = status("succeeded", "succeeded", {
      rawPayload: {
        providerStatus: "succeeded",
        failureClass: "mandate_dead",
        failureClassDecidedBy: "neutral_hint",
      },
    });

    await runPaymentProviderReconciliationWorker({
      port,
      providers: { [rail]: provider(read) },
      now: NOW,
    });

    const applied = vi.mocked(port.applyTerminalResult).mock.calls[0]?.[0] as Record<string, unknown>;
    expect(applied.resultStatus).toBe("succeeded");
    expect(Object.keys(applied)).not.toContain("failureClassification");
  });
});

describe("staleness window as a published claim threshold", () => {
  it("is the FLOOR of the window a checkout continuation has to outlive", () => {
    // ⛔ Read this together with the checkout TTL, and read the direction
    // carefully — it was stated backwards here until 2026-08-27. This number is
    // when the worker becomes ELIGIBLE to claim an attempt, not when it does: the
    // reference contract permits an adopter-owned reconciliation lag of at most 30 minutes, so an attempt that goes stale at 15 minutes
    // is claimed somewhere between 15 and 45. Throughout that hold the
    // provider-attempt admission gate refuses a second provider call, so a
    // checkout continuation that expired AT this threshold died inside the hold
    // and left the buyer with no route back — discarded marker, and every
    // re-submit answering `provider_attempt_in_flight`.
    //
    // So this is the floor the continuation TTL must clear, not the ceiling it
    // must respect. The other half of the pair is
    // `server/domains/commerce/checkoutPaymentContinuationCredential.test.ts`,
    // which pins CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS to 2700 and carries
    // the argument. The two are pinned separately rather than compared, because
    // commerce may not import this domain's internals. RAISING this window past
    // that TTL is the change that breaks the pair, and it breaks this test.
    expect(DEFAULT_STALE_AFTER_SECONDS).toBe(900);
  });
});
