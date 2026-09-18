import { describe, expect, it } from "vitest";
import { COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import type {
  CheckoutExpiredEmailInput,
  OrderPaymentLifecyclePort,
  OrderRecipientPort,
  TransactionalEmailPort,
} from "./outboxOrderDraftEmailPorts.js";
import { createOutboxCheckoutExpiredEmailHandler, OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG } from "./outboxCheckoutExpiredEmailHandler.js";

const ORDER_UUID = "0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f";

function makeRow(payload: Record<string, unknown>): OutboxEventRow {
  return {
    id: "11111111-2222-4333-8444-555555555555",
    created_at: "2026-07-11T10:00:00.000+00:00",
    available_at: "2026-07-11T10:00:00.000+00:00",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: ORDER_UUID,
    event_type: COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE,
    idempotency_key: "checkout_expired:x",
    status: "processing",
    attempts: 1,
    payload,
    error: null,
    metadata: {},
  };
}

describe("outboxCheckoutExpiredEmailHandler", () => {
  it("claims checkout expired and sends formatted amount", async () => {
    const sendCalls: CheckoutExpiredEmailInput[] = [];
    const emailPort = {
      findExistingSend: async () => false,
      sendCheckoutExpiredNotice: async (input: CheckoutExpiredEmailInput) => {
        sendCalls.push(input);
        return { ok: true as const, resendId: "re_ce_1", httpStatus: 200, providerError: null, aborted: false };
      },
    } as unknown as TransactionalEmailPort;
    const recipientPort: OrderRecipientPort = {
      resolve: async () => ({ email: "k@example.com", firstName: "Ola" }),
    };
    const lifecyclePort: OrderPaymentLifecyclePort = {
      read: async () => ({
        orderStatus: "expired",
        paymentStatus: "expired",
        hasPayment: true,
        paymentUpdatedAt: "2026-07-11T10:00:00.000+00:00",
      }),
    };
    const handler = createOutboxCheckoutExpiredEmailHandler({ emailPort, recipientPort, lifecyclePort });

    expect(handler.eventType).toBe(COMMERCE_CHECKOUT_EXPIRED_EVENT_TYPE);
    expect(OUTBOX_CHECKOUT_EXPIRED_TEMPLATE_SLUG).toBe("commerce-checkout-expired");
    await expect(handler.handle(makeRow({
      orderUuid: ORDER_UUID,
      orderId: `order_${ORDER_UUID}`,
      totalCents: 12999,
      currency: "PLN",
    }), new AbortController().signal)).resolves.toEqual({ kind: "processed", detail: { resendId: "re_ce_1" } });
    expect(sendCalls[0].amountLabel).toBe("129,99\u00a0zł");
    expect(sendCalls[0].recoveryToken).toBeNull();
  });

  it("passes checkout-recovery token from expired payload to the email port", async () => {
    const sendCalls: CheckoutExpiredEmailInput[] = [];
    const emailPort = {
      findExistingSend: async () => false,
      sendCheckoutExpiredNotice: async (input: CheckoutExpiredEmailInput) => {
        sendCalls.push(input);
        return { ok: true as const, resendId: "re_ce_2", httpStatus: 200, providerError: null, aborted: false };
      },
    } as unknown as TransactionalEmailPort;
    const recipientPort: OrderRecipientPort = {
      resolve: async () => ({ email: "k@example.com", firstName: "Ola", country: "PL" }),
    };
    const lifecyclePort: OrderPaymentLifecyclePort = {
      read: async () => ({
        orderStatus: "expired",
        paymentStatus: "expired",
        hasPayment: true,
        paymentUpdatedAt: "2026-07-11T10:00:00.000+00:00",
      }),
    };
    const handler = createOutboxCheckoutExpiredEmailHandler({ emailPort, recipientPort, lifecyclePort });

    await expect(handler.handle(makeRow({
      orderUuid: ORDER_UUID,
      orderId: `order_${ORDER_UUID}`,
      totalCents: 12999,
      currency: "PLN",
      recoveryToken: "rcv_recoverable_expired",
    }), new AbortController().signal)).resolves.toEqual({ kind: "processed", detail: { resendId: "re_ce_2" } });

    expect(sendCalls[0]).toMatchObject({
      orderId: `order_${ORDER_UUID}`,
      amountLabel: "129,99\u00a0zł",
      recoveryToken: "rcv_recoverable_expired",
    });
  });

  it("skips stale checkout-expired rows when the order is not expired anymore", async () => {
    const sendCalls: CheckoutExpiredEmailInput[] = [];
    const emailPort = {
      findExistingSend: async () => false,
      sendCheckoutExpiredNotice: async (input: CheckoutExpiredEmailInput) => {
        sendCalls.push(input);
        return { ok: true as const, resendId: "re_ce_1", httpStatus: 200, providerError: null, aborted: false };
      },
    } as unknown as TransactionalEmailPort;
    const recipientPort: OrderRecipientPort = {
      resolve: async () => ({ email: "k@example.com", firstName: "Ola" }),
    };
    const lifecyclePort: OrderPaymentLifecyclePort = {
      read: async () => ({
        orderStatus: "paid",
        paymentStatus: "succeeded",
        hasPayment: true,
        paymentUpdatedAt: "2026-07-11T10:00:00.000+00:00",
      }),
    };
    const handler = createOutboxCheckoutExpiredEmailHandler({ emailPort, recipientPort, lifecyclePort });

    await expect(handler.handle(makeRow({
      orderUuid: ORDER_UUID,
      orderId: `order_${ORDER_UUID}`,
    }), new AbortController().signal)).resolves.toEqual({
      kind: "processed",
      detail: { skipped: "order_not_expired" },
    });
    expect(sendCalls).toHaveLength(0);
  });
});
