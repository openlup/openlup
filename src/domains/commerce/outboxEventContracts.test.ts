import { describe, expect, it } from "vitest";
import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import type { CreateQuoteResponse } from "./contracts.js";
import { createOrderDraftSnapshotFromQuoteSnapshot } from "./orderDraftSnapshotContracts.js";
import {
  COMMERCE_ORDER_DRAFT_CREATED_EVENT_CONTRACT_VERSION,
  COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
  COMMERCE_ORDER_PAID_EVENT_TYPE,
  commerceOrderDraftCreatedOutboxRecordSchema,
  commerceOrderPaidOutboxRecordSchema,
  parseCommerceOrderDraftCreatedOutboxEvent,
} from "./outboxEventContracts.js";

describe("commerce outbox event contracts", () => {
  it("parses the DB order-draft-created row into a typed v1 event", () => {
    const record = outboxRecord();

    const event = parseCommerceOrderDraftCreatedOutboxEvent(record);

    expect(commerceOrderDraftCreatedOutboxRecordSchema.parse(record)).toEqual(record);
    expect(event).toMatchObject({
      contractVersion: COMMERCE_ORDER_DRAFT_CREATED_EVENT_CONTRACT_VERSION,
      eventType: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
      aggregateType: "commerce_order",
      aggregateId: record.aggregate_id,
      idempotencyKey: "quote-2026-06-01-lamb",
      payload: {
        orderId: `order_${record.aggregate_id}`,
        orderUuid: record.aggregate_id,
      },
    });
  });

  it("rejects unrelated or future provider/payment event types", () => {
    expect(
      commerceOrderDraftCreatedOutboxRecordSchema.safeParse({
        ...outboxRecord(),
        event_type: "commerce.payment.created",
      }).success,
    ).toBe(false);
  });

  it("rejects outbox rows where aggregate id and payload order uuid diverge", () => {
    expect(
      commerceOrderDraftCreatedOutboxRecordSchema.safeParse({
        ...outboxRecord(),
        aggregate_id: "550e8400-e29b-41d4-a716-446655440099",
      }).success,
    ).toBe(false);
  });

  it("rejects payloads without the quote and order draft snapshots", () => {
    const record = outboxRecord();

    expect(
      commerceOrderDraftCreatedOutboxRecordSchema.safeParse({
        ...record,
        payload: {
          orderId: record.payload.orderId,
          orderUuid: record.payload.orderUuid,
        },
      }).success,
    ).toBe(false);
  });

  it("rejects event payloads whose draft snapshot no longer mirrors the quote", () => {
    const record = outboxRecord();
    record.payload.orderDraftSnapshot.totals.totalGross.amountMinor = 1;

    expect(commerceOrderDraftCreatedOutboxRecordSchema.safeParse(record).success).toBe(
      false,
    );
  });
});

describe("commerce.order.paid outbox contract", () => {
  it("parses a well-formed order-paid row for both modes", () => {
    for (const mode of ["one_time", "subscription_cycle"]) {
      const parsed = commerceOrderPaidOutboxRecordSchema.safeParse(orderPaidRecord({ mode }));
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.event_type).toBe(COMMERCE_ORDER_PAID_EVENT_TYPE);
        expect(parsed.data.payload.mode).toBe(mode);
      }
    }
  });

  it("tolerates an unknown future mode (provider-agnostic, never retro-DLQ)", () => {
    expect(
      commerceOrderPaidOutboxRecordSchema.safeParse(orderPaidRecord({ mode: "future_mode_x" })).success,
    ).toBe(true);
  });

  it("rejects a wrong event_type, a broken orderId<->uuid binding, and a divergent aggregate id", () => {
    expect(
      commerceOrderPaidOutboxRecordSchema.safeParse({
        ...orderPaidRecord(),
        event_type: "commerce.order_draft.created",
      }).success,
    ).toBe(false);

    const mismatchedOrderId = orderPaidRecord();
    mismatchedOrderId.payload.orderId = "order_550e8400-e29b-41d4-a716-446655449999";
    expect(commerceOrderPaidOutboxRecordSchema.safeParse(mismatchedOrderId).success).toBe(false);

    expect(
      commerceOrderPaidOutboxRecordSchema.safeParse({
        ...orderPaidRecord(),
        aggregate_id: "550e8400-e29b-41d4-a716-446655440099",
      }).success,
    ).toBe(false);
  });
});

function orderPaidRecord(overrides?: { mode?: string }) {
  const orderUuid = "550e8400-e29b-41d4-a716-446655440000";
  return {
    id: "550e8400-e29b-41d4-a716-446655440002",
    created_at: "2026-06-13T20:00:00.000Z",
    available_at: "2026-06-13T20:00:00.000Z",
    processed_at: null,
    aggregate_type: "commerce_order" as const,
    aggregate_id: orderUuid,
    event_type: COMMERCE_ORDER_PAID_EVENT_TYPE,
    idempotency_key: `order_paid:${orderUuid}`,
    status: "pending",
    attempts: 0,
    payload: {
      orderId: `order_${orderUuid}`,
      orderUuid,
      mode: overrides?.mode ?? "one_time",
      occurredAt: "2026-06-13T20:00:00.000Z",
    },
    error: null,
    metadata: { source: "commerce_emit_order_paid_outbox" },
  };
}

function outboxRecord() {
  const orderUuid = "550e8400-e29b-41d4-a716-446655440000";
  const quoteSnapshot = quoteResponse();

  return {
    id: "550e8400-e29b-41d4-a716-446655440001",
    created_at: "2026-06-01T20:00:00.000Z",
    available_at: "2026-06-01T20:00:00.000Z",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: orderUuid,
    event_type: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
    idempotency_key: "quote-2026-06-01-lamb",
    status: "pending",
    attempts: 0,
    payload: {
      orderId: `order_${orderUuid}`,
      orderUuid,
      quoteSnapshot,
      orderDraftSnapshot: createOrderDraftSnapshotFromQuoteSnapshot(quoteSnapshot),
    },
    error: null,
    metadata: {
      boundary: "commerce_create_order_draft_with_outbox",
    },
  };
}

function quoteResponse(): CreateQuoteResponse {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    quote: {
      currency: "PLN",
      taxIncluded: true,
      lines: [
        {
          sku: "OPENLUP-DOG-LAMB-CAN-400G",
          productSlug: "lamb",
          quantity: 1,
          unitPriceGross: { amountMinor: 1490, currency: "PLN" },
          lineSubtotalGross: { amountMinor: 1490, currency: "PLN" },
          tax: {
            included: true,
            country: "PL",
            category: "pet_food",
            vatRateBps: 800,
            legalBasis: "PL VAT Annex 3 item 10c",
            netAmount: { amountMinor: 1380, currency: "PLN" },
            vatAmount: { amountMinor: 110, currency: "PLN" },
            grossAmount: { amountMinor: 1490, currency: "PLN" },
          },
        },
      ],
      discounts: [],
      subtotalGross: { amountMinor: 1490, currency: "PLN" },
      discountTotalGross: { amountMinor: 0, currency: "PLN" },
      totalGross: { amountMinor: 1490, currency: "PLN" },
      netTotal: { amountMinor: 1380, currency: "PLN" },
      taxTotal: { amountMinor: 110, currency: "PLN" },
    },
  };
}
