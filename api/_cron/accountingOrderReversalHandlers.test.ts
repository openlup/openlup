import { describe, expect, it, vi } from "vitest";
import { ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE } from "../../src/domains/accounting/outboxReversalContracts.js";
import {
  COMMERCE_ORDER_CANCELED_EVENT_TYPE,
  COMMERCE_ORDER_REFUNDED_EVENT_TYPE,
} from "../../src/domains/commerce/outboxEventContracts.js";
import type { AccountingCorrectionScaffoldPort } from "../../src/domains/accounting/ports.js";
import { buildAccountingOrderReversalHandlers } from "./accountingOrderReversalHandlers.js";

describe("accounting order reversal outbox handlers", () => {
  it("is disabled unless accounting shadow handlers are explicitly enabled", () => {
    expect(buildAccountingOrderReversalHandlers({
      accountingPort: portStub(),
      providerKind: "fakturownia",
      enabled: false,
    })).toEqual([]);
  });

  it("preserves invoice-reversal requests for canceled and refunded legacy events", async () => {
    const port = portStub();
    const handlers = buildAccountingOrderReversalHandlers({
      accountingPort: port,
      providerKind: "fakturownia",
      enabled: true,
    });

    await expect(handlers.find((handler) => handler.eventType === COMMERCE_ORDER_CANCELED_EVENT_TYPE)?.handle(
      row(COMMERCE_ORDER_CANCELED_EVENT_TYPE),
      new AbortController().signal,
    )).resolves.toMatchObject({ kind: "processed" });
    await expect(handlers.find((handler) => handler.eventType === COMMERCE_ORDER_REFUNDED_EVENT_TYPE)?.handle(
      row(COMMERCE_ORDER_REFUNDED_EVENT_TYPE),
      new AbortController().signal,
    )).resolves.toMatchObject({ kind: "processed" });

    expect(port.requestInvoiceReversalFromOrderStatus).toHaveBeenNthCalledWith(1, {
      idempotencyKey: "event-1:accounting-reversal",
      orderId: "11111111-1111-4111-8111-111111111111",
      reason: "order_canceled",
      providerKind: "fakturownia",
      payload: { outboxEventId: "event-1", eventType: COMMERCE_ORDER_CANCELED_EVENT_TYPE, orderId: "ORDER-1" },
    });
    expect(port.requestInvoiceReversalFromOrderStatus).toHaveBeenNthCalledWith(2, {
      idempotencyKey: "event-1:accounting-reversal",
      orderId: "11111111-1111-4111-8111-111111111111",
      reason: "order_refunded",
      providerKind: "fakturownia",
      payload: { outboxEventId: "event-1", eventType: COMMERCE_ORDER_REFUNDED_EVENT_TYPE, orderId: "ORDER-1" },
    });
  });

  it("processes the new accounting event with its producer-supplied business key", async () => {
    const port = portStub();
    const handlers = buildAccountingOrderReversalHandlers({
      accountingPort: port,
      providerKind: "fakturownia",
      enabled: true,
    });
    const handler = handlers.find((candidate) => candidate.eventType === ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE);

    await expect(handler?.handle(row(ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE, canonicalPayload()), new AbortController().signal))
      .resolves.toMatchObject({ kind: "processed" });

    expect(port.requestInvoiceReversalFromOrderStatus).toHaveBeenCalledWith({
      idempotencyKey: "order-1:reversal-request",
      orderId: "11111111-1111-4111-8111-111111111111",
      reason: "order_refunded",
      providerKind: "fakturownia",
      payload: {
        outboxEventId: "event-1",
        eventType: ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE,
        orderId: "ORDER-1",
        sourceEvent: { id: "payment-refund-1", eventType: "payment.refund.confirmed" },
      },
    });
  });

  it("independently discards invalid canonical payloads and retries canonical port failures", async () => {
    const port = portStub();
    const handler = buildAccountingOrderReversalHandlers({
      accountingPort: port,
      providerKind: "fakturownia",
      enabled: true,
    }).find((candidate) => candidate.eventType === ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE);

    await expect(handler?.handle(
      row(ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE, {
        ...canonicalPayload(),
        businessIdempotencyKey: "short",
      }),
      new AbortController().signal,
    )).resolves.toEqual({ kind: "discard", reason: "accounting_reversal_payload_invalid" });

    port.requestInvoiceReversalFromOrderStatus.mockRejectedValueOnce(new Error("provider unavailable"));
    await expect(handler?.handle(
      row(ACCOUNTING_ORDER_REVERSAL_REQUESTED_EVENT_TYPE, canonicalPayload()),
      new AbortController().signal,
    )).resolves.toEqual({ kind: "retry", reason: "provider unavailable" });
  });

  it("settles no-invoice reversals as processed", async () => {
    const port = portStub();
    port.requestInvoiceReversalFromOrderStatus.mockResolvedValueOnce({
      invoice: null,
      action: "no_invoice",
      replayed: true,
    });
    const [handler] = buildAccountingOrderReversalHandlers({
      accountingPort: port,
      providerKind: "fakturownia",
      enabled: true,
    });

    await expect(handler.handle(row(COMMERCE_ORDER_CANCELED_EVENT_TYPE), new AbortController().signal))
      .resolves.toEqual({
        kind: "processed",
        detail: { accountingReversalAction: "no_invoice", invoiceStatus: "no_invoice" },
      });
  });

  it("discards invalid payloads and retries port failures", async () => {
    const port = portStub();
    port.requestInvoiceReversalFromOrderStatus.mockRejectedValueOnce(new Error("provider unavailable"));
    const [handler] = buildAccountingOrderReversalHandlers({
      accountingPort: port,
      providerKind: "fakturownia",
      enabled: true,
    });

    await expect(handler.handle({ ...row(COMMERCE_ORDER_CANCELED_EVENT_TYPE), payload: { orderId: "ORDER-1" } }, new AbortController().signal))
      .resolves.toEqual({ kind: "discard", reason: "accounting_reversal_payload_invalid" });
    await expect(handler.handle(row(COMMERCE_ORDER_CANCELED_EVENT_TYPE), new AbortController().signal))
      .resolves.toEqual({ kind: "retry", reason: "provider unavailable" });
  });
});

function portStub(): AccountingCorrectionScaffoldPort & {
  requestInvoiceReversalFromOrderStatus: ReturnType<typeof vi.fn<AccountingCorrectionScaffoldPort["requestInvoiceReversalFromOrderStatus"]>>;
} {
  return {
    requestCorrectionScaffold: vi.fn(),
    requestInvoiceReversalFromOrderStatus: vi.fn(async () => ({
      invoice: { id: "invoice-1", status: "voided", providerInvoiceId: null },
      action: "voided",
      replayed: false,
    })),
  };
}

function row(eventType: string, payload: Record<string, unknown> = {
  orderUuid: "11111111-1111-4111-8111-111111111111",
  orderId: "ORDER-1",
}) {
  return {
    id: "event-1",
    created_at: "2026-06-26T10:00:00.000Z",
    available_at: "2026-06-26T10:00:00.000Z",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: "11111111-1111-4111-8111-111111111111",
    event_type: eventType,
    idempotency_key: "event-1",
    status: "pending",
    attempts: 0,
    payload,
    error: null,
    metadata: {},
  };
}

function canonicalPayload() {
  return {
    businessIdempotencyKey: "order-1:reversal-request",
    orderUuid: "11111111-1111-4111-8111-111111111111",
    orderId: "ORDER-1",
    reason: "order_refunded",
    sourceEvent: { id: "payment-refund-1", eventType: "payment.refund.confirmed" },
  };
}
