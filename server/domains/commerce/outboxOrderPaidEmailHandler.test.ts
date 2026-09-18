import { describe, expect, it } from "vitest";
import { COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import type {
  OrderPaidConfirmationEmailInput,
  OrderPaidLinesPort,
  OrderPaidRawData,
  OrderRecipient,
  OrderRecipientPort,
  TransactionalEmailPort,
  TransactionalEmailSendOutcome,
} from "./outboxOrderDraftEmailPorts.js";
import {
  createOutboxOrderPaidEmailHandler,
  OUTBOX_ORDER_PAID_TEMPLATE_SLUG,
} from "./outboxOrderPaidEmailHandler.js";

const ORDER_UUID = "0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f";
const EVENT_ID = "11111111-2222-4333-8444-555555555555";

function makeRow(payload: Record<string, unknown>): OutboxEventRow {
  return {
    id: EVENT_ID,
    created_at: "2026-06-14T10:00:00.000+00:00",
    available_at: "2026-06-14T10:00:00.000+00:00",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: ORDER_UUID,
    event_type: COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE,
    idempotency_key: "order_paid_email:x",
    status: "processing",
    attempts: 1,
    payload,
    error: null,
    metadata: {},
  };
}

const paidPayload = { orderUuid: ORDER_UUID, orderId: `order_${ORDER_UUID}`, mode: "one_time" };

const sampleData: OrderPaidRawData = {
  currency: "PLN",
  subtotalMinor: 14000,
  discountMinor: 1655,
  totalMinor: 12345,
  lines: [
    { label: "Karma Jagnięcina", quantity: 2, lineTotalMinor: 10000 },
    { label: null, quantity: 1, lineTotalMinor: 2000 },
  ],
};

function makeDeps(options?: {
  recipient?: OrderRecipient | null;
  existing?: boolean;
  outcome?: TransactionalEmailSendOutcome;
  data?: OrderPaidRawData | null;
  readThrows?: boolean;
}) {
  const sendCalls: OrderPaidConfirmationEmailInput[] = [];
  const emailPort: TransactionalEmailPort = {
    async findExistingSend() {
      return options?.existing ?? false;
    },
    async sendOrderConfirmation() {
      throw new Error("draft path unused here");
    },
    async sendCheckoutRecovery() {
      throw new Error("checkout-recovery path unused here");
    },
    async sendPaymentFailedNotice() {
      throw new Error("payment-failed path unused here");
    },
    async sendCheckoutExpiredNotice() {
      throw new Error("checkout-expired path unused here");
    },
    async sendOrderCanceledNotice() {
      throw new Error("order-canceled path unused here");
    },
    async sendOrderRefundedNotice() {
      throw new Error("order-refunded path unused here");
    },
    async sendShipmentDispatchedNotice() {
      throw new Error("shipment-dispatched path unused here");
    },
    async sendShipmentDeliveredNotice() {
      throw new Error("shipment-delivered path unused here");
    },
    async sendShipmentExceptionNotice() {
      throw new Error("shipment-exception path unused here");
    },
    async sendReturnApprovedNotice() {
      throw new Error("return-approved path unused here");
    },
    async sendReturnRejectedNotice() {
      throw new Error("return-rejected path unused here");
    },
    async sendOrderPaidConfirmation(input) {
      sendCalls.push(input);
      return (
        options?.outcome ?? {
          ok: true,
          resendId: "re_paid_1",
          httpStatus: 200,
          providerError: null,
          aborted: false,
        }
      );
    },
  };
  const recipientPort: OrderRecipientPort = {
    resolve: async () =>
      options?.recipient === undefined
        ? { email: "k@example.com", firstName: "Ola", petName: "Fistaszek" }
        : options.recipient,
  };
  const linesPort: OrderPaidLinesPort = {
    read: async () => {
      if (options?.readThrows) throw new Error("lines down");
      return options?.data === undefined ? sampleData : options.data;
    },
  };
  const handler = createOutboxOrderPaidEmailHandler({
    emailPort,
    recipientPort,
    linesPort,
  });
  return { handler, sendCalls };
}

const signal = () => new AbortController().signal;

describe("outboxOrderPaidEmailHandler", () => {
  it("claims commerce.order.paid.email with a 10s timeout and the paid slug", () => {
    const { handler } = makeDeps();
    expect(handler.eventType).toBe(COMMERCE_ORDER_PAID_EMAIL_EVENT_TYPE);
    expect(handler.timeoutMs).toBe(10_000);
    expect(OUTBOX_ORDER_PAID_TEMPLATE_SLUG).toBe("commerce-order-paid");
  });

  it("discards on a broken payload", async () => {
    const { handler } = makeDeps();
    const outcome = await handler.handle(makeRow({ orderUuid: "nope" }), signal());
    expect(outcome.kind).toBe("discard");
  });

  it("skips when the recipient is unresolved", async () => {
    const { handler, sendCalls } = makeDeps({ recipient: null });
    const outcome = await handler.handle(makeRow(paidPayload), signal());
    expect(outcome).toEqual({ kind: "processed", detail: { skipped: "recipient_unresolved" } });
    expect(sendCalls).toHaveLength(0);
  });

  it("dedupes an already-sent paid email", async () => {
    const { handler, sendCalls } = makeDeps({ existing: true });
    const outcome = await handler.handle(makeRow(paidPayload), signal());
    expect(outcome).toEqual({ kind: "processed", detail: { dedupe: "email_already_sent" } });
    expect(sendCalls).toHaveLength(0);
  });

  it.each([
    {
      scenario: "no discount",
      data: { ...sampleData, discountMinor: 0, totalMinor: 14000 },
      totals: { subtotalLabel: "140,00\u00a0zł", discountLabel: null, totalLabel: "140,00\u00a0zł" },
    },
    {
      scenario: "product discount",
      data: sampleData,
      totals: { subtotalLabel: "140,00\u00a0zł", discountLabel: "−16,55\u00a0zł", totalLabel: "123,45\u00a0zł" },
    },
    {
      scenario: "paid shipping represented only by the final total",
      data: { ...sampleData, discountMinor: 0, totalMinor: 15500 },
      totals: { subtotalLabel: "140,00\u00a0zł", discountLabel: null, totalLabel: "155,00\u00a0zł" },
    },
    {
      scenario: "free shipping with no outward shipping row",
      data: { ...sampleData, discountMinor: 0, totalMinor: 14000 },
      totals: { subtotalLabel: "140,00\u00a0zł", discountLabel: null, totalLabel: "140,00\u00a0zł" },
    },
  ])("sends the exact confirmation input for $scenario", async ({ data, totals }) => {
    const { handler, sendCalls } = makeDeps({ data });
    const abortSignal = signal();
    const outcome = await handler.handle(makeRow(paidPayload), abortSignal);

    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_paid_1" } });
    expect(sendCalls).toEqual([{
      to: "k@example.com",
      firstName: "Ola",
      petName: "Fistaszek",
      orderId: `order_${ORDER_UUID}`,
      mode: "one_time",
      outboxEventId: EVENT_ID,
      items: [
        { name: "Karma Jagnięcina", quantity: 2, lineTotalLabel: "100,00\u00a0zł" },
        // Sparse legacy snapshot → neutral label, never a current catalog name.
        { name: "Produkt", quantity: 1, lineTotalLabel: "20,00\u00a0zł" },
      ],
      totals,
      locale: "pl",
      signal: abortSignal,
    }]);
  });

  it("sends the reconciled first-subscription presentation and suppresses intermediate item prices", async () => {
    const { handler, sendCalls } = makeDeps({
      data: {
        ...sampleData,
        subtotalMinor: 49_580,
        discountMinor: 22_015,
        totalMinor: 27_565,
        firstSubscriptionPricePresentation: {
          catalogProductsMinor: 55_130,
          productDiscountMinor: 27_565,
          productPayableMinor: 27_565,
          shippingGrossMinor: 1_500,
          shippingDiscountMinor: 1_500,
          shippingEffectiveMinor: 0,
          totalMinor: 27_565,
          discountPercent: 50,
        },
      },
    });

    await handler.handle(makeRow(paidPayload), signal());

    expect(sendCalls[0]).toMatchObject({
      items: [
        { name: "Karma Jagnięcina", quantity: 2, lineTotalLabel: "" },
        { name: "Produkt", quantity: 1, lineTotalLabel: "" },
      ],
      totals: {
        subtotalLabel: "551,30\u00a0zł",
        discountLabel: "−275,65\u00a0zł",
        totalLabel: "275,65\u00a0zł",
        firstSubscription: {
          catalogLabel: "551,30\u00a0zł",
          productPayableLabel: "275,65\u00a0zł",
          shippingLabel: null,
          shippingFree: true,
        },
      },
    });
  });

  it("retries (does NOT send a contentless receipt) when the order data is not yet readable", async () => {
    const { handler, sendCalls } = makeDeps({ data: null });
    const outcome = await handler.handle(makeRow(paidPayload), signal());
    expect(outcome).toEqual({ kind: "retry", reason: "order_paid_data_unavailable" });
    expect(sendCalls).toHaveLength(0);
  });

  it("propagates a lines read error so the worker retries", async () => {
    const { handler } = makeDeps({ readThrows: true });
    await expect(handler.handle(makeRow(paidPayload), signal())).rejects.toThrow("lines down");
  });

  it("snoozes on a 503 and discards on a 422", async () => {
    const snooze = makeDeps({
      outcome: { ok: false, resendId: null, httpStatus: 503, providerError: "down", aborted: false },
    });
    expect(await snooze.handler.handle(makeRow(paidPayload), signal())).toEqual({ kind: "snooze", reason: "down" });

    const discard = makeDeps({
      outcome: { ok: false, resendId: null, httpStatus: 422, providerError: null, aborted: false },
    });
    expect(await discard.handler.handle(makeRow(paidPayload), signal())).toEqual({
      kind: "discard",
      reason: "resend_rejected",
    });
  });
});
