import { describe, expect, it, vi } from "vitest";

const { ingestEvent, applyEventResult, upsertFromWebhook, activation, dunning, deriveAlias } = vi.hoisted(() => ({
  ingestEvent: vi.fn(),
  applyEventResult: vi.fn(),
  upsertFromWebhook: vi.fn(),
  activation: vi.fn(),
  dunning: vi.fn(),
  deriveAlias: vi.fn(),
}));

vi.mock("./paymentWebhookGateway.js", () => ({
  createPaymentWebhookPortViaGateway: () => ({ ingestEvent, applyEventResult }),
  createPaymentWebhookMethodRefPortViaGateway: () => ({ upsertFromWebhook }),
  createTpayActivationAfterProcessedViaGateway: () => activation,
  createSubscriptionWebhookDunningAfterProcessedViaGateway: () => dunning,
  deriveSimulatorRecurringActivationAliasViaGateway: deriveAlias,
}));

import { readStuckRecurringAttempts, settleSimulatorTransaction } from "./tpaySimulatorSettlement.js";
import type { DataGatewayPort } from "../../../../src/domains/platform-runtime/ports.js";

const gateway = {} as DataGatewayPort;

function resetPorts() {
  ingestEvent.mockReset();
  applyEventResult.mockReset().mockResolvedValue({ replayed: false });
  upsertFromWebhook.mockReset().mockResolvedValue({ replayed: false });
  activation.mockReset().mockResolvedValue(undefined);
  dunning.mockReset().mockResolvedValue(undefined);
  deriveAlias.mockReset().mockResolvedValue(null);
}

function terminalFailure(resultStatus: "failed" | "expired", providerPaymentId = `tpay_sim_${resultStatus}`) {
  return {
    providerPaymentId,
    resultStatus,
    amountMinor: 41540,
    aliasResult: null,
    clientId: null,
    subscriptionId: null,
    providerMethodRef: null,
  } as const;
}

describe("settleSimulatorTransaction", () => {
  it("settles an off-session recurring renewal (no alias) when the mandate already exists", async () => {
    resetPorts();
    ingestEvent.mockResolvedValue({ paymentIntentId: "intent-1", paymentEventId: "event-1", replayed: false });

    const outcome = await settleSimulatorTransaction(gateway, {
      providerPaymentId: "tpay_sim_x",
      resultStatus: "succeeded",
      amountMinor: 41540,
      aliasResult: null,
      clientId: null,
      subscriptionId: null,
      providerMethodRef: null,
    });

    expect(outcome).toMatchObject({ matched: true, paymentIntentId: "intent-1", resultStatus: "succeeded", aliasResult: null });
    expect(applyEventResult).toHaveBeenCalledOnce();
    // Renewal: the derive returns null → no new method-ref is registered.
    expect(deriveAlias).toHaveBeenCalledWith(gateway, "intent-1");
    expect(upsertFromWebhook).not.toHaveBeenCalled();
    expect(activation).toHaveBeenCalledOnce();
    expect(dunning).not.toHaveBeenCalled();
  });

  it("uses the same durable occurrence time for first and replayed failed renewal dunning", async () => {
    resetPorts();
    const canonicalOccurredAt = "2026-07-23T06:00:00.000Z";
    const sink = { calls: [] as Array<[string, unknown]>, selects: [] as string[] };
    const failedGateway = gatewayFor(tableClient({
      commerce_payment_state_transitions: { data: [{ occurred_at: canonicalOccurredAt }], error: null },
    }, sink));
    const request = {
      providerPaymentId: "tpay_sim_declined",
      resultStatus: "failed" as const,
      amountMinor: 41540,
      aliasResult: null,
      clientId: null,
      subscriptionId: null,
      providerMethodRef: null,
    };
    ingestEvent
      .mockResolvedValueOnce({ paymentIntentId: "intent-1", paymentEventId: "event-1", replayed: false })
      .mockResolvedValueOnce({ paymentIntentId: "intent-1", paymentEventId: "event-1", replayed: true });
    applyEventResult
      .mockResolvedValueOnce({ replayed: false })
      .mockRejectedValueOnce(new Error("payment_control_result_idempotency_conflict"));

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-07-23T06:00:01.000Z"));
      await settleSimulatorTransaction(failedGateway, request);
      vi.setSystemTime(new Date("2026-07-23T06:00:05.000Z"));
      await settleSimulatorTransaction(failedGateway, request);
    } finally {
      vi.useRealTimers();
    }

    const [firstDunning, replayDunning] = dunning.mock.calls.map(([input]) => input);
    expect(applyEventResult.mock.calls.map(([input]) => input.occurredAt)).toEqual([
      "2026-07-23T06:00:01.000Z",
      "2026-07-23T06:00:05.000Z",
    ]);
    expect(firstDunning?.event.occurredAt).toBe(canonicalOccurredAt);
    expect(replayDunning?.event.occurredAt).toBe(canonicalOccurredAt);
    expect(ingestEvent.mock.calls[0]?.[0].event.provider_event_id).toBe(firstDunning?.event.providerEventId);
    expect(firstDunning).toMatchObject({
      event: {
        provider: "tpay",
        providerEventId: "sim:tpay_sim_declined:failed",
        eventType: "payment.failed",
        occurredAt: canonicalOccurredAt,
      },
      resultStatus: "failed",
    });
    expect(activation.mock.invocationCallOrder[0]).toBeLessThan(dunning.mock.invocationCallOrder[0]);
    expect(sink.calls).toContainEqual(["payment_intent_id", "intent-1"]);
    expect(sink.calls).toContainEqual([
      "idempotency_key",
      "tpay-simulator:tpay_sim_declined:failed:apply:payment_result",
    ]);
    expect(sink.calls).toContainEqual(["transition_kind", "business_result"]);
  });

  it("routes an expired renewal through failed dunning with its exact durable transition", async () => {
    resetPorts();
    const canonicalOccurredAt = "2026-07-23T06:00:00.000Z";
    ingestEvent.mockResolvedValue({ paymentIntentId: "intent-expired", paymentEventId: "event-expired", replayed: false });
    const expiredGateway = gatewayFor(tableClient({
      commerce_payment_state_transitions: { data: [{ occurred_at: canonicalOccurredAt }], error: null },
    }));

    await expect(settleSimulatorTransaction(expiredGateway, terminalFailure("expired")))
      .resolves.toMatchObject({ matched: true, resultStatus: "expired" });

    expect(applyEventResult).toHaveBeenCalledWith(expect.objectContaining({
      resultStatus: "expired",
      failureReason: "simulator_expired",
    }));
    expect(dunning).toHaveBeenCalledWith(expect.objectContaining({
      event: expect.objectContaining({
        providerEventId: "sim:tpay_sim_expired:expired",
        eventType: "payment.failed",
        occurredAt: canonicalOccurredAt,
      }),
      resultStatus: "failed",
    }));
  });

  it("fails closed without calling activation or dunning when the applied-result transition is missing", async () => {
    resetPorts();
    ingestEvent.mockResolvedValue({ paymentIntentId: "intent-1", paymentEventId: "event-1", replayed: false });
    const failedGateway = gatewayFor(tableClient({
      commerce_payment_state_transitions: { data: [], error: null },
    }));

    await expect(settleSimulatorTransaction(failedGateway, {
      providerPaymentId: "tpay_sim_missing_transition",
      resultStatus: "failed",
      amountMinor: 41540,
      aliasResult: null,
      clientId: null,
      subscriptionId: null,
      providerMethodRef: null,
    })).rejects.toThrow("canonical_payment_result_transition_missing");

    expect(applyEventResult).toHaveBeenCalledOnce();
    expect(activation).not.toHaveBeenCalled();
    expect(dunning).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "read error",
      transition: { data: null, error: { message: "db unavailable" } },
      expected: "canonical_payment_result_transition_read_failed: db unavailable",
    },
    {
      name: "invalid occurred_at",
      transition: { data: [{ occurred_at: "not-a-timestamp" }], error: null },
      expected: "canonical_payment_result_transition_invalid_occurred_at",
    },
    {
      name: "ambiguous durable evidence",
      transition: {
        data: [{ occurred_at: "2026-07-23T06:00:00.000Z" }, { occurred_at: "2026-07-23T06:00:01.000Z" }],
        error: null,
      },
      expected: "canonical_payment_result_transition_ambiguous",
    },
  ])("fails closed on $name without calling activation or dunning", async ({ transition, expected }) => {
    resetPorts();
    ingestEvent.mockResolvedValue({ paymentIntentId: "intent-1", paymentEventId: "event-1", replayed: false });
    const failedGateway = gatewayFor(tableClient({
      commerce_payment_state_transitions: transition,
    }));

    await expect(settleSimulatorTransaction(failedGateway, terminalFailure("failed")))
      .rejects.toThrow(expected);

    expect(applyEventResult).toHaveBeenCalledOnce();
    expect(activation).not.toHaveBeenCalled();
    expect(dunning).not.toHaveBeenCalled();
  });

  it("retries dunning with the same durable timestamp after a transient hook failure", async () => {
    resetPorts();
    const canonicalOccurredAt = "2026-07-23T06:00:00.000Z";
    ingestEvent
      .mockResolvedValueOnce({ paymentIntentId: "intent-1", paymentEventId: "event-1", replayed: false })
      .mockResolvedValueOnce({ paymentIntentId: "intent-1", paymentEventId: "event-1", replayed: true });
    applyEventResult
      .mockResolvedValueOnce({ replayed: false })
      .mockRejectedValueOnce(new Error("payment_control_result_idempotency_conflict"));
    dunning
      .mockRejectedValueOnce(new Error("subscription_webhook_dunning_failed: unavailable"))
      .mockResolvedValueOnce(undefined);
    const failedGateway = gatewayFor(tableClient({
      commerce_payment_state_transitions: { data: [{ occurred_at: canonicalOccurredAt }], error: null },
    }));
    const request = {
      providerPaymentId: "tpay_sim_dunning_error",
      resultStatus: "failed" as const,
      amountMinor: 41540,
      aliasResult: null,
      clientId: null,
      subscriptionId: null,
      providerMethodRef: null,
    };

    await expect(settleSimulatorTransaction(failedGateway, request))
      .rejects.toThrow("subscription_webhook_dunning_failed: unavailable");
    await expect(settleSimulatorTransaction(failedGateway, request))
      .resolves.toMatchObject({ matched: true, replayed: true });

    expect(applyEventResult).toHaveBeenCalledTimes(2);
    expect(dunning).toHaveBeenCalledTimes(2);
    expect(dunning.mock.calls.map(([input]) => input.event.occurredAt))
      .toEqual([canonicalOccurredAt, canonicalOccurredAt]);
  });

  it("returns unmatched when the event resolves no payment intent", async () => {
    resetPorts();
    ingestEvent.mockResolvedValue({ paymentIntentId: null, paymentEventId: "event-1", replayed: false });
    const outcome = await settleSimulatorTransaction(gateway, {
      providerPaymentId: "tpay_sim_missing",
      resultStatus: "succeeded",
      amountMinor: null,
      aliasResult: null,
      clientId: null,
      subscriptionId: null,
      providerMethodRef: null,
    });
    expect(outcome).toEqual({ matched: false });
    expect(applyEventResult).not.toHaveBeenCalled();
  });

  it("absorbs a benign 23505 re-delivery and still reports matched", async () => {
    resetPorts();
    ingestEvent.mockResolvedValue({ paymentIntentId: "intent-1", paymentEventId: "event-1", replayed: true });
    applyEventResult.mockRejectedValue(new Error("payment_control_result_idempotency_conflict"));

    const outcome = await settleSimulatorTransaction(gateway, {
      providerPaymentId: "tpay_sim_x", resultStatus: "succeeded", amountMinor: 41540,
      aliasResult: null, clientId: null, subscriptionId: null, providerMethodRef: null,
    });
    expect(outcome).toMatchObject({ matched: true, replayed: true });
    expect(dunning).not.toHaveBeenCalled();
  });
});

type Result = { data: unknown; error: unknown };

// Table-aware thenable builder: every filter returns `this` and both `.limit()` (attempts)
// and the terminal `.eq()` (intents) resolve the per-table result. Records eq/in/like/select.
function tableClient(byTable: Record<string, Result>, sink?: { calls: Array<[string, unknown]>; selects: string[] }) {
  const make = (table: string) => {
    const b: Record<string, unknown> = {};
    const self = () => b;
    Object.assign(b, {
      select: (c: string) => { sink?.selects.push(c); return b; },
      eq: (col: string, val: unknown) => { sink?.calls.push([col, val]); return b; },
      in: (col: string, val: unknown) => { sink?.calls.push([col, val]); return b; },
      like: (col: string, val: unknown) => { sink?.calls.push([col, val]); return b; },
      limit: self,
      then: (onF: (v: Result) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(byTable[table]).then(onF, onR),
    });
    return b;
  };
  return { from: (t: string) => make(t) };
}

function gatewayFor(client: unknown): DataGatewayPort {
  return { asService: async (work: (c: unknown) => Promise<unknown>) => work(client) } as unknown as DataGatewayPort;
}

describe("readStuckRecurringAttempts", () => {
  it("returns only attempts whose intent is still processing, and applies the renewal-only filter", async () => {
    const sink = { calls: [] as Array<[string, unknown]>, selects: [] as string[] };
    const client = tableClient({
      commerce_payment_attempts: {
        data: [
          { provider_attempt_id: "tpay_sim_x", amount_cents: 41540, payment_intent_id: "intent-open" },
          { provider_attempt_id: "tpay_sim_settled", amount_cents: 999, payment_intent_id: "intent-done" },
        ],
        error: null,
      },
      // intent-done is NOT returned here (already succeeded) → its stale attempt is dropped.
      commerce_payment_intents: { data: [{ id: "intent-open" }], error: null },
    }, sink);

    const rows = await readStuckRecurringAttempts(gatewayFor(client));

    expect(rows).toEqual([{ providerPaymentId: "tpay_sim_x", amountMinor: 41540 }]);
    expect(sink.selects[0]).toContain("provider_attempt_id");
    expect(sink.calls).toContainEqual(["provider_attempt_id", "tpay_sim_%"]);
    expect(sink.calls).toContainEqual(["request_payload->>providerFlow", "recurring_charge"]);
    expect(sink.calls).toContainEqual(["request_payload->>source", "subscription.renewal.cron.v0"]);
    // The idempotency filter: intents queried by id, filtered to status=processing.
    expect(sink.calls).toContainEqual(["id", ["intent-open", "intent-done"]]);
    expect(sink.calls).toContainEqual(["status", "processing"]);
  });

  it("returns [] without a second query when no candidate attempts exist", async () => {
    const client = tableClient({
      commerce_payment_attempts: { data: [], error: null },
      commerce_payment_intents: { data: [{ id: "should-not-be-read" }], error: null },
    });
    expect(await readStuckRecurringAttempts(gatewayFor(client))).toEqual([]);
  });

  it("throws when the attempt read errors", async () => {
    const client = tableClient({
      commerce_payment_attempts: { data: null, error: { message: "boom" } },
      commerce_payment_intents: { data: [], error: null },
    });
    await expect(readStuckRecurringAttempts(gatewayFor(client))).rejects.toThrow("boom");
  });
});
