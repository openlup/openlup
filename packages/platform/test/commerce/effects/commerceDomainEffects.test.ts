import { describe, expect, it, vi } from "vitest";
import type { OutboxEventRow } from "@openlup/core/outbox";
import {
  COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE, COMMERCE_ORDER_PAID_EVENT_TYPE, COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE,
  COMMERCE_ORDER_CANCELED_EVENT_TYPE, COMMERCE_RETURN_APPROVED_EVENT_TYPE, COMMERCE_RETURN_REJECTED_EVENT_TYPE,
} from "../../../src/commerce/index.js";
import {
  composeOutboxHandlerDescriptors, createOutboxDispatchRegistry as createRegistry, describeCoreOutboxHandlers,
  type CommerceEmailRuntime, type TransactionalEmailRegistryDeps,
} from "../../../src/commerce/server/index.js";
import type { OutboxHandler } from "../../../src/commerce/index.js";

// The rail algorithm is exercised by rebound reference tests; this conformance
// binding records unique core consumers without implementing same-event composition.
const createOutboxDispatchRegistry = (deps: Omit<Parameters<typeof createRegistry>[0], "uniqueRegistry">) =>
  createRegistry({ ...deps, uniqueRegistry: (handlers) => new Map(handlers.map((handler) => [handler.eventType, handler])) });
const claimAllowlist = (registry: ReadonlyMap<string, OutboxHandler>) => [...registry.keys()];
const events = (transactionalEmail: boolean, fulfillmentEnabled: boolean) =>
  describeCoreOutboxHandlers({ transactionalEmail, fulfillmentEnabled }).map(({ eventType }) => eventType);
const unused = (): never => { throw new Error("unexpected_host_call"); };
const runtime: CommerceEmailRuntime = {
  parseOutboxPayload: (schema, payload) => ({ ok: true, data: schema.parse(payload) }),
  mapSendOutcome: () => ({ kind: "processed" }),
  createTransactionalEmailHandler: ({ eventType, timeoutMs }) => ({ eventType, timeoutMs, handle: unused }),
  resolveLocale: () => "en", formatMoney: (minor, currency) => `${currency}:${minor}`, genericItemLabel: () => "Item",
  presentPaidOrder: () => null, providerOwnsDeliveredNotification: () => false,
  normalizeCarrierKind: () => null, carrierTrackingUrl: () => null, legacyTrackingUrl: () => null,
};
function emailDeps(): TransactionalEmailRegistryDeps {
  return { runtime, recipientPort: { resolve: async () => ({ email: "buyer@example.test", firstName: null }) },
    lifecyclePort: { read: unused }, orderPaidLinesPort: { read: async () => ({ currency: "XXX", subtotalMinor: 100,
      discountMinor: 0, totalMinor: 100, lines: [] }) },
    emailPort: { findExistingSend: async () => false, sendOrderPaidConfirmation: vi.fn(async () => ({ ok: true,
      messageId: "message-1", httpStatus: 200, providerError: null, aborted: false })),
    sendReturnApprovedNotice: unused, sendReturnRejectedNotice: unused, sendOrderConfirmation: unused,
    sendCheckoutRecovery: unused, sendPaymentFailedNotice: unused, sendCheckoutExpiredNotice: unused,
    sendOrderCanceledNotice: unused, sendOrderRefundedNotice: unused, sendShipmentDispatchedNotice: unused,
    sendShipmentDeliveredNotice: unused, sendShipmentExceptionNotice: unused } };
}
const fulfillmentPort = { ensureFulfilledFromPaidOrder: vi.fn(async () => ({ kind: "completed" as const })) };
const row = (eventType: string): OutboxEventRow => ({ id: "event-1", created_at: "2026-10-22T10:00:00Z",
  available_at: "2026-10-22T10:00:00Z", processed_at: null, aggregate_type: "commerce_order", aggregate_id: "order-1",
  event_type: eventType, idempotency_key: "effect-1", status: "processing", attempts: 1, error: null, metadata: {},
  payload: { orderUuid: "11111111-1111-4111-8111-111111111111", orderId: "order-1" } });

describe("neutral commerce domain effects (W8)", () => {
  it("pins durable fact names and separates draft, payment, fulfillment and return duties", () => {
    expect([COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE, COMMERCE_ORDER_PAID_EVENT_TYPE, COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE,
      COMMERCE_ORDER_CANCELED_EVENT_TYPE, COMMERCE_RETURN_APPROVED_EVENT_TYPE, COMMERCE_RETURN_REJECTED_EVENT_TYPE])
      .toEqual(["commerce.order_draft.created", "commerce.order.paid", "commerce.order.paid.email", "commerce.order.canceled",
        "commerce.return.approved", "commerce.return.rejected"]);
    expect(events(true, false)).toEqual(["commerce.order_draft.created", "commerce.checkout_recovery", "commerce.order.paid.email",
      "commerce.payment.failed", "commerce.checkout.expired", "commerce.order.refunded", "commerce.shipment.dispatched",
      "commerce.shipment.delivered", "commerce.shipment.exception", "commerce.return.approved", "commerce.return.rejected"]);
    expect(events(false, true)).toEqual(["commerce.order.paid"]);
    expect(events(false, false)).toEqual([]);
    expect(events(true, false)).not.toContain(COMMERCE_ORDER_PAID_EVENT_TYPE);
    expect(events(false, true)).not.toContain(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE);
    expect(events(true, true).filter((event) => event.startsWith("commerce.return.")))
      .toEqual(["commerce.return.approved", "commerce.return.rejected"]);
    expect(events(true, true).filter((event) => /invoice|goods.receipt|return.refund/.test(event))).toEqual([]);
  });

  it("keeps actual registration and its allowlist aligned for independent flags and missing ports", () => {
    for (const transactionalEmail of [false, true]) for (const fulfillmentEnabled of [false, true]) {
      const registry = createOutboxDispatchRegistry({ transactionalEmail: transactionalEmail ? emailDeps() : undefined,
        fulfillmentPort, fulfillmentEnabled });
      expect(claimAllowlist(registry)).toEqual(events(transactionalEmail, fulfillmentEnabled));
      expect([...registry.values()].map(({ eventType, timeoutMs }) => ({ eventType, timeoutMs })))
        .toEqual(describeCoreOutboxHandlers({ transactionalEmail, fulfillmentEnabled }));
    }
    expect(claimAllowlist(createOutboxDispatchRegistry({ fulfillmentEnabled: true }))).toEqual([]);
  });

  it("leaves cancellation unclaimed until the adopter supplies its accounting consumer", () => {
    expect(events(true, true)).not.toContain(COMMERCE_ORDER_CANCELED_EVENT_TYPE);
    const extra: OutboxHandler = { eventType: COMMERCE_ORDER_CANCELED_EVENT_TYPE, timeoutMs: 1000, handle: unused };
    const registry = createOutboxDispatchRegistry({ fulfillmentEnabled: false, extraHandlers: [extra] });
    expect(claimAllowlist(registry)).toEqual([COMMERCE_ORDER_CANCELED_EVENT_TYPE]);
    expect(registry.get(COMMERCE_ORDER_CANCELED_EVENT_TYPE)).toBe(extra);
  });

  it("refuses descriptor drift and preserves additive same-event timeout composition", () => {
    const extra: OutboxHandler = { eventType: COMMERCE_ORDER_PAID_EVENT_TYPE, timeoutMs: 1000, handle: unused };
    expect(composeOutboxHandlerDescriptors([{ eventType: extra.eventType, timeoutMs: 15_000 }, extra]))
      .toEqual([{ eventType: extra.eventType, timeoutMs: 16_000 }]);
    expect(() => createOutboxDispatchRegistry({ fulfillmentEnabled: true, fulfillmentPort, expectedDescriptors: () => [] }))
      .toThrow("outbox_registry_descriptor_mismatch");
  });

  it("reads channel policy live per event and settles suppression without calling the sender", async () => {
    const transactionalEmail = emailDeps();
    const readOrderBuyerCommsPolicy = vi.fn().mockResolvedValueOnce({ sourceKind: "external", buyerCommsOwner: "channel" })
      .mockResolvedValueOnce({ sourceKind: "external", buyerCommsOwner: "platform" });
    const registry = createOutboxDispatchRegistry({ fulfillmentEnabled: false,
      transactionalEmail: { ...transactionalEmail, buyerCommsPolicyReader: { readOrderBuyerCommsPolicy } } });
    const handler = registry.get(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE)!;
    const signal = new AbortController().signal;
    expect(await handler.handle(row(handler.eventType), signal))
      .toEqual({ kind: "processed", detail: { skipped: "channel_owns_buyer_comms" } });
    expect(transactionalEmail.emailPort.sendOrderPaidConfirmation).not.toHaveBeenCalled();
    expect(await handler.handle(row(handler.eventType), signal)).toEqual({ kind: "processed" });
    expect(readOrderBuyerCommsPolicy).toHaveBeenCalledTimes(2);
    expect(transactionalEmail.emailPort.sendOrderPaidConfirmation).toHaveBeenCalledTimes(1);
  });
});
