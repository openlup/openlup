import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createPostgresPaymentTruthPort } from "./paymentTruth.js";
import type { PaymentTruthEvent } from "../../domains/payment/paymentTruth.js";

const EVENT_ID = "22222222-2222-4222-8222-222222222222";
const response = (overrides: Record<string, unknown> = {}) => ({
  event: {
    id: EVENT_ID,
    sourceEventId: "simulator:event-1",
    fingerprint: "a".repeat(64),
    state: "settled",
    outcome: "captured",
    replayed: false,
  },
  effects: { paymentResultRecorded: true, dunningOpened: false, accountingRequested: true },
  financial: {
    settlementStatus: "settled",
    orderStatus: "paid",
    subscriptionStatus: "active",
    accountingStatus: "issue_requested",
    amountMinor: 2599,
    currency: "XTS",
  },
  ...overrides,
});

const event = (): PaymentTruthEvent => ({
  sourceEventId: "simulator:event-1",
  idempotencyKey: "payment-event:simulator:event-1",
  settlementIntentId: "11111111-1111-4111-8111-111111111111",
  outcome: "captured",
  amountMinor: 2599,
  currency: "XTS",
  occurredAt: "2026-08-15T12:00:00.000Z",
  failure: null,
  evidence: {
    sourceKind: "accepted_event",
    sourceReference: "simulator:event-1",
    observedStatus: "captured",
    observedAt: "2026-08-15T12:00:00.000Z",
    payloadFingerprint: createHash("sha256").update("event-1").digest("hex"),
  },
});

const options = {
  dunningTemplateSlug: "payment_failed",
  recoveryUrlPath: "/recover-payment",
  recoveryTemplateSlug: "payment_recovered",
};

describe("postgres payment truth", () => {
  it("persists an event with canonical fingerprint, currency and neutral source evidence", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ response: response() }] }));
    const port = createPostgresPaymentTruthPort({ query }, options);
    await expect(port.ingestEvent(event())).resolves.toEqual(response());
    expect(query).toHaveBeenCalledOnce();
    const values = query.mock.calls[0]![1] as unknown[];
    expect(values[0]).toBe("simulator:event-1");
    expect(values[1]).toMatch(/^[0-9a-f]{64}$/);
    expect(values[6]).toBe("XTS");
    expect(JSON.parse(String(values[10]))).toEqual(event().evidence);
    expect(values).not.toContain("tpay");
    expect(values).not.toContain("stripe");
  });

  it("records failed reconciliation as indeterminate evidence", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ response: response({
      event: { ...response().event, state: "open", outcome: "indeterminate" },
      effects: { paymentResultRecorded: false, dunningOpened: false, accountingRequested: false },
      financial: { ...response().financial, settlementStatus: "created", orderStatus: "pending_payment", accountingStatus: null },
    }) }] }));
    const port = createPostgresPaymentTruthPort({ query }, options);
    await port.recordReconciliation({
      eventId: EVENT_ID,
      idempotencyKey: "reconcile:event-1:read-1",
      evidenceStatus: "failed",
      outcome: "indeterminate",
      occurredAt: "2026-08-15T12:05:00.000Z",
      failure: null,
      evidence: { ...event().evidence, sourceKind: "reconciliation_read", observedStatus: "read_failed" },
    });
    const values = query.mock.calls[0]![1] as unknown[];
    expect(values[2]).toMatch(/^[0-9a-f]{64}$/);
    expect(values.slice(3, 5)).toEqual(["failed", "indeterminate"]);
  });

  it("reads only open sweep IDs and exposes settled rows as ignored", async () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [{ response: {
      claimed: 1, settledIgnored: 2, eventIds: [EVENT_ID],
    } }] }));
    await expect(createPostgresPaymentTruthPort({ query }, options).sweepOpenEvents({
      now: "2026-08-15T13:00:00.000Z", limit: 10,
    })).resolves.toEqual({ claimed: 1, settledIgnored: 2, eventIds: [EVENT_ID] });
  });

  it("refuses a binding without durable dunning composition labels", () => {
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
    expect(() => createPostgresPaymentTruthPort({ query }, {
      ...options, recoveryUrlPath: "",
    })).toThrow("payment_truth_recovery_path_required");
  });
});
