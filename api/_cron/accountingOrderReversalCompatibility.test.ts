import { describe, expect, it } from "vitest";
import {
  ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
} from "../../src/domains/accounting/outboxReversalContracts.js";
import {
  COMMERCE_ORDER_CANCELED_EVENT_TYPE,
  COMMERCE_ORDER_REFUNDED_EVENT_TYPE,
} from "../../src/domains/commerce/outboxEventContracts.js";
import {
  adaptAccountingOrderReversalRequested,
  adaptLegacyCommerceOrderReversal,
} from "./accountingOrderReversalHandlers.js";

const row = (eventType: string, payload: Record<string, unknown> = {
  orderUuid: "11111111-1111-4111-8111-111111111111",
  orderId: "ORDER-1",
}) => ({
  id: "event-1",
  event_type: eventType,
  payload,
});

describe("accounting order reversal compatibility", () => {
  it.each([
    [COMMERCE_ORDER_CANCELED_EVENT_TYPE, "order_canceled"],
    [COMMERCE_ORDER_REFUNDED_EVENT_TYPE, "order_refunded"],
  ] as const)("maps the legacy %s row to the canonical accounting obligation", (eventType, reason) => {
    expect(adaptLegacyCommerceOrderReversal(row(eventType), eventType)).toEqual({
      kind: "ready",
      request: {
        eventType: ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
        idempotencyKey: "event-1:accounting-reversal",
        orderUuid: "11111111-1111-4111-8111-111111111111",
        reason,
        payload: {
          outboxEventId: "event-1",
          eventType,
          orderId: "ORDER-1",
        },
      },
    });
  });

  it("keeps legacy payload validation terminal before an accounting effect", () => {
    expect(adaptLegacyCommerceOrderReversal(
      row(COMMERCE_ORDER_REFUNDED_EVENT_TYPE, { orderId: "ORDER-1" }),
      COMMERCE_ORDER_REFUNDED_EVENT_TYPE,
    )).toEqual({ kind: "invalid_payload" });
  });

  it("maps the independent accounting payload through its stable business key and source provenance", () => {
    expect(adaptAccountingOrderReversalRequested(row(
      ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
      {
        businessIdempotencyKey: "order-1:reversal-request",
        orderUuid: "11111111-1111-4111-8111-111111111111",
        orderId: "ORDER-1",
        reason: "order_refunded",
        sourceEvent: { id: "payment-refund-1", eventType: "payment.refund.confirmed" },
      },
    ))).toEqual({
      kind: "ready",
      request: {
        eventType: ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
        idempotencyKey: "order-1:reversal-request",
        orderUuid: "11111111-1111-4111-8111-111111111111",
        reason: "order_refunded",
        payload: {
          outboxEventId: "event-1",
          eventType: ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
          orderId: "ORDER-1",
          sourceEvent: { id: "payment-refund-1", eventType: "payment.refund.confirmed" },
        },
      },
    });
  });
});
