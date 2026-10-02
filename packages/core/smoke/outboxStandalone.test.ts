import { describe, expect, expectTypeOf, it } from "vitest";
import {
  OUTBOX_EVENT_ROW_FIELDS,
  OUTBOX_HANDLER_OUTCOME_KINDS,
  PLATFORM_OUTBOX_EVENT_TYPES,
  matchOutboxEventTypeDeclaration,
  type OutboxEventRow,
  type OutboxEventTypeDeclaration,
  type OutboxHandler,
  type OutboxHandlerContext,
  type OutboxHandlerOutcome,
} from "@openlup/core/outbox";

// Byte-equality pins. These strings are persisted: a store writes them, SQL
// reads them, and rows already in a database carry them. Change one only with a
// migration, never to make this test pass.
const PERSISTED_ROW_FIELDS =
  '["id","created_at","available_at","processed_at","aggregate_type","aggregate_id","event_type","idempotency_key","status","attempts","payload","error","metadata"]';
const PERSISTED_OUTCOME_KINDS = '["processed","retry","discard","snooze"]';

// Measured from OpenLup's platform SQL: every literal event type an INSERT into
// outbox_events writes, in the managed baseline (37 types) and the portable
// chain (11 types), 39 distinct. Two names are spelled `cancelled` and one
// `canceled`; the SQL emits them that way and the vocabulary keeps them.
const MEASURED_EVENT_TYPES =
  '["channel.order.ingested","commerce.checkout.expired","commerce.checkout_recovery","commerce.fulfillment.handed_over","commerce.order.canceled","commerce.order.cancelled","commerce.order.paid","commerce.order.paid.email","commerce.order.refunded","commerce.order.reorder_reminder","commerce.order.review_effects","commerce.order.review_request","commerce.order_draft.abandoned.1h","commerce.order_draft.abandoned.24h","commerce.order_draft.abandoned.72h","commerce.order_draft.created","commerce.payment.failed","commerce.payment_attempt.requested","commerce.product.back_in_stock","commerce.return.approved","commerce.return.rejected","commerce.settlement.settled","commerce.shipment.delivered","commerce.shipment.dispatched","commerce.shipment.exception","commerce.subscription_payment.requested","commerce.subscription_payment.retry_requested","personalization.declension_requested","subscription.activation_action_required","subscription.address_changed","subscription.cancelled","subscription.created","subscription.cycle_skipped","subscription.delivery_rescheduled","subscription.package_changed","subscription.pause_reminder_due","subscription.paused","subscription.renewal_upcoming","subscription.resumed"]';

const row: OutboxEventRow = {
  id: "00000000-0000-4000-8000-000000000001",
  created_at: "2026-01-01T00:00:00.000Z",
  available_at: "2026-01-01T00:00:00.000Z",
  processed_at: null,
  aggregate_type: "example_aggregate",
  aggregate_id: "00000000-0000-4000-8000-000000000002",
  event_type: "example.item.created",
  idempotency_key: "example.item.created:1",
  status: "processing",
  attempts: 1,
  payload: { itemId: "1" },
  error: null,
  metadata: { claimToken: "token" },
};

const declaration = (
  eventType: string,
  state: OutboxEventTypeDeclaration["state"] = "dormant",
): OutboxEventTypeDeclaration => ({ eventType, state, owner: "example", reason: "No handler ships yet." });

describe("outbox standalone", () => {
  it("pins the persisted row fields byte for byte", () => {
    expect(JSON.stringify(OUTBOX_EVENT_ROW_FIELDS)).toBe(PERSISTED_ROW_FIELDS);
    expect(JSON.stringify(Object.keys(row))).toBe(PERSISTED_ROW_FIELDS);
    expectTypeOf<(typeof OUTBOX_EVENT_ROW_FIELDS)[number]>().toEqualTypeOf<keyof OutboxEventRow>();
  });

  it("pins the persisted outcome names and fields byte for byte", () => {
    expect(JSON.stringify(OUTBOX_HANDLER_OUTCOME_KINDS)).toBe(PERSISTED_OUTCOME_KINDS);
    expectTypeOf<(typeof OUTBOX_HANDLER_OUTCOME_KINDS)[number]>().toEqualTypeOf<OutboxHandlerOutcome["kind"]>();
    expectTypeOf<Extract<OutboxHandlerOutcome, { kind: "processed" }>>().toEqualTypeOf<{
      kind: "processed";
      detail?: Record<string, unknown>;
    }>();
    expectTypeOf<Extract<OutboxHandlerOutcome, { kind: "retry" }>>().toEqualTypeOf<{ kind: "retry"; reason: string }>();
    expectTypeOf<Extract<OutboxHandlerOutcome, { kind: "discard" }>>().toEqualTypeOf<{
      kind: "discard";
      reason: string;
      benign?: boolean;
    }>();
    expectTypeOf<Extract<OutboxHandlerOutcome, { kind: "snooze" }>>().toEqualTypeOf<{ kind: "snooze"; reason: string }>();
  });

  it("carries a handler's reason and detail through unchanged", async () => {
    const phases: string[] = [];
    const ctx: OutboxHandlerContext = { setPhase: (phase) => phases.push(phase) };
    const reason = "Example_Reason:with spaces/and:colons";
    const handler: OutboxHandler = {
      eventType: "example.item.created",
      timeoutMs: 1000,
      async handle(received, signal, context) {
        context?.setPhase("send");
        if (signal.aborted) return { kind: "snooze", reason };
        return received.attempts > 1
          ? { kind: "discard", reason, benign: true }
          : { kind: "processed", detail: { providerMessageId: "message-1" } };
      },
    };
    const controller = new AbortController();

    await expect(handler.handle(row, controller.signal, ctx)).resolves.toEqual({
      kind: "processed",
      detail: { providerMessageId: "message-1" },
    });
    await expect(handler.handle({ ...row, attempts: 2 }, controller.signal)).resolves.toEqual({
      kind: "discard",
      reason,
      benign: true,
    });
    controller.abort();
    await expect(handler.handle(row, controller.signal, ctx)).resolves.toEqual({ kind: "snooze", reason });
    expect(phases).toEqual(["send", "send"]);
  });

  it("holds exactly the measured platform vocabulary, with an owner per entry", () => {
    const eventTypes = PLATFORM_OUTBOX_EVENT_TYPES.map((entry) => entry.eventType);

    expect(PLATFORM_OUTBOX_EVENT_TYPES).toHaveLength(39);
    expect(JSON.stringify(eventTypes)).toBe(MEASURED_EVENT_TYPES);
    expect([...eventTypes].sort()).toEqual(eventTypes);
    expect(new Set(eventTypes).size).toBe(eventTypes.length);
    for (const entry of PLATFORM_OUTBOX_EVENT_TYPES) {
      expect(entry.owner).toBe(entry.eventType.split(".")[0]);
      expect(Object.isFrozen(entry)).toBe(true);
    }
    expect(Object.isFrozen(PLATFORM_OUTBOX_EVENT_TYPES)).toBe(true);
    expect([...new Set(PLATFORM_OUTBOX_EVENT_TYPES.map((entry) => entry.owner))].sort()).toEqual([
      "channel",
      "commerce",
      "personalization",
      "subscription",
    ]);
    // The split is kept, not corrected.
    expect(eventTypes.filter((eventType) => /cancel+ed$/.test(eventType))).toEqual([
      "commerce.order.canceled",
      "commerce.order.cancelled",
      "subscription.cancelled",
    ]);
  });

  it("matches exact declarations before the longest prefix", () => {
    const exact = declaration("commerce.return.approved", "ignored");
    const shortPrefix = declaration("commerce.");
    const longPrefix = declaration("commerce.return.");
    const declarations = [shortPrefix, longPrefix, exact];

    expect(matchOutboxEventTypeDeclaration("commerce.return.approved", declarations)).toBe(exact);
    expect(matchOutboxEventTypeDeclaration("commerce.return.received", declarations)).toBe(longPrefix);
    expect(matchOutboxEventTypeDeclaration("commerce.order.paid", declarations)).toBe(shortPrefix);
    expect(matchOutboxEventTypeDeclaration("subscription.paused", declarations)).toBeUndefined();
    // A declaration without a trailing dot is exact only.
    expect(matchOutboxEventTypeDeclaration("commerce.return.approved.v2", [exact])).toBeUndefined();
    expect(matchOutboxEventTypeDeclaration("commerce.returns.opened", [longPrefix])).toBeUndefined();
    expect(matchOutboxEventTypeDeclaration("commerce.return.approved", [])).toBeUndefined();
  });
});
