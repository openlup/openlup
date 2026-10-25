import { registerEmailProviderOutcomeCases, registerEmailRecipientCases } from "../../shared/__tests__/outboxEmailHandler.testFixtures.js";
import { describe, expect, it } from "vitest";
import { COMMERCE_PAYMENT_FAILED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import type {
  OrderRecipient,
  OrderPaymentLifecyclePort,
  OrderRecipientPort,
  PaymentFailedEmailInput,
  TransactionalEmailPort,
  TransactionalEmailSendOutcome,
} from "./outboxOrderDraftEmailPorts.js";
import {
  createOutboxPaymentFailedEmailHandler,
  OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG,
} from "./outboxPaymentFailedEmailHandler.js";

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
    event_type: COMMERCE_PAYMENT_FAILED_EVENT_TYPE,
    idempotency_key: "payment_failed:x",
    status: "processing",
    attempts: 1,
    payload,
    error: null,
    metadata: {},
  };
}

const payload = {
  orderUuid: ORDER_UUID,
  orderId: `order_${ORDER_UUID}`,
  recoveryToken: "rcv_payment_failed",
  mode: "one_time",
  totalCents: 12999,
  currency: "PLN",
};

function makeDeps(options?: {
  recipient?: OrderRecipient | null;
  existing?: boolean;
  outcome?: TransactionalEmailSendOutcome;
  orderStatus?: string | null;
  paymentStatus?: string | null;
  paymentUpdatedAt?: string;
}) {
  const sendCalls: PaymentFailedEmailInput[] = [];
  const emailPort = {
    async findExistingSend() {
      return options?.existing ?? false;
    },
    async sendPaymentFailedNotice(input: PaymentFailedEmailInput) {
      sendCalls.push(input);
      return (
        options?.outcome ?? {
          ok: true,
          resendId: "re_pf_1",
          httpStatus: 200,
          providerError: null,
          aborted: false,
        }
      );
    },
  } as unknown as TransactionalEmailPort;
  const recipientPort: OrderRecipientPort = {
    resolve: async () =>
      options?.recipient === undefined ? { email: "k@example.com", firstName: "Buyer" } : options.recipient,
  };
  const lifecyclePort: OrderPaymentLifecyclePort = {
    read: async () => ({
      orderStatus: options?.orderStatus ?? "pending_payment",
      paymentStatus: options?.paymentStatus ?? "failed",
      hasPayment: true,
      paymentUpdatedAt: options?.paymentUpdatedAt ?? "2026-06-14T10:00:00.000+00:00",
    }),
  };
  const handler = createOutboxPaymentFailedEmailHandler({ emailPort, recipientPort, lifecyclePort });
  return { handler, sendCalls };
}

const signal = () => new AbortController().signal;

describe("outboxPaymentFailedEmailHandler", () => {
  it("claims commerce.payment.failed with a 10s timeout and the failed slug", () => {
    const { handler } = makeDeps();
    expect(handler.eventType).toBe(COMMERCE_PAYMENT_FAILED_EVENT_TYPE);
    expect(handler.timeoutMs).toBe(10_000);
    expect(OUTBOX_PAYMENT_FAILED_TEMPLATE_SLUG).toBe("commerce-payment-failed");
  });

  it("discards a broken payload", async () => {
    const { handler } = makeDeps();
    expect((await handler.handle(makeRow({ orderUuid: "nope" }), signal())).kind).toBe("discard");
  });

  registerEmailRecipientCases(makeDeps, () => makeRow(payload));

  it("sends with a formatted amount label", async () => {
    const { handler, sendCalls } = makeDeps();
    const phases: string[] = [];
    const outcome = await handler.handle(makeRow(payload), signal(), {
      setPhase: (phase) => phases.push(phase),
    });
    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_pf_1" } });
    expect(phases).toEqual(["lifecycle", "recipient", "dedupe", "email_send"]);
    expect(sendCalls[0].to).toBe("k@example.com");
    expect(sendCalls[0].orderId).toBe(`order_${ORDER_UUID}`);
    expect(sendCalls[0].amountLabel).toBe("129,99\u00a0zł");
    expect(sendCalls[0].recoveryToken).toBe("rcv_payment_failed");
    expect(sendCalls[0].mode).toBe("one_time");
  });

  it("skips stale rows when the order is no longer recoverable at send time", async () => {
    const paid = makeDeps({ orderStatus: "paid", paymentStatus: "succeeded" });
    await expect(paid.handler.handle(makeRow(payload), signal())).resolves.toEqual({
      kind: "processed",
      detail: { skipped: "order_not_pending_payment" },
    });
    expect(paid.sendCalls).toHaveLength(0);
  });

  // A live retry must not consume the earlier decline notice without sending:
  // the once-per-order producer key cannot emit a replacement notice.
  it("sends the decline notice while a second attempt is in flight", async () => {
    const { handler, sendCalls } = makeDeps({
      paymentStatus: "pending",
      paymentUpdatedAt: new Date().toISOString(),
    });
    await expect(handler.handle(makeRow(payload), signal())).resolves.toMatchObject({
      kind: "processed",
    });
    expect(sendCalls).toHaveLength(1);
  });

  it("sends with a null amount when the totals are absent from the payload", async () => {
    const { handler, sendCalls } = makeDeps();
    await handler.handle(makeRow({
      orderUuid: ORDER_UUID,
      orderId: `order_${ORDER_UUID}`,
      recoveryToken: "rcv_without_amount",
    }), signal());
    expect(sendCalls[0].amountLabel).toBeNull();
  });

  registerEmailProviderOutcomeCases(makeDeps, () => makeRow(payload));
});
