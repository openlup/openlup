import { describe, expect, it } from "vitest";
import { COMMERCE_ORDER_CANCELED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import type {
  OrderCanceledEmailInput,
  OrderRecipient,
  OrderRecipientPort,
  TransactionalEmailPort,
  TransactionalEmailSendOutcome,
} from "./outboxOrderDraftEmailPorts.js";
import {
  createOutboxOrderCanceledEmailHandler,
  OUTBOX_ORDER_CANCELED_TEMPLATE_SLUG,
} from "./outboxOrderCanceledEmailHandler.js";

const ORDER_UUID = "0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f";
const EVENT_ID = "11111111-2222-4333-8444-555555555555";

function makeRow(payload: Record<string, unknown>): OutboxEventRow {
  return {
    id: EVENT_ID,
    created_at: "2026-06-15T10:00:00.000+00:00",
    available_at: "2026-06-15T10:00:00.000+00:00",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: ORDER_UUID,
    event_type: COMMERCE_ORDER_CANCELED_EVENT_TYPE,
    idempotency_key: "order_canceled:x",
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
  totalCents: 12999,
  currency: "PLN",
};

function makeDeps(options?: {
  recipient?: OrderRecipient | null;
  existing?: boolean;
  outcome?: TransactionalEmailSendOutcome;
}) {
  const sendCalls: OrderCanceledEmailInput[] = [];
  const emailPort = {
    async findExistingSend() {
      return options?.existing ?? false;
    },
    async sendOrderCanceledNotice(input: OrderCanceledEmailInput) {
      sendCalls.push(input);
      return (
        options?.outcome ?? {
          ok: true,
          resendId: "re_oc_1",
          httpStatus: 200,
          providerError: null,
          aborted: false,
        }
      );
    },
  } as unknown as TransactionalEmailPort;
  const recipientPort: OrderRecipientPort = {
    resolve: async () =>
      options?.recipient === undefined ? { email: "k@example.com", firstName: "Ola" } : options.recipient,
  };
  const handler = createOutboxOrderCanceledEmailHandler({ emailPort, recipientPort });
  return { handler, sendCalls };
}

const signal = () => new AbortController().signal;

describe("outboxOrderCanceledEmailHandler", () => {
  it("claims commerce.order.canceled with a 10s timeout and the canceled slug", () => {
    const { handler } = makeDeps();
    expect(handler.eventType).toBe(COMMERCE_ORDER_CANCELED_EVENT_TYPE);
    expect(handler.timeoutMs).toBe(10_000);
    expect(OUTBOX_ORDER_CANCELED_TEMPLATE_SLUG).toBe("commerce-order-canceled");
  });

  it("discards a broken payload", async () => {
    const { handler } = makeDeps();
    expect((await handler.handle(makeRow({ orderUuid: "nope" }), signal())).kind).toBe("discard");
  });

  it("skips an unresolved recipient and dedupes an already-sent notice", async () => {
    const skip = makeDeps({ recipient: null });
    expect(await skip.handler.handle(makeRow(payload), signal())).toEqual({
      kind: "processed",
      detail: { skipped: "recipient_unresolved" },
    });

    const dup = makeDeps({ existing: true });
    expect(await dup.handler.handle(makeRow(payload), signal())).toEqual({
      kind: "processed",
      detail: { dedupe: "email_already_sent" },
    });
    expect(dup.sendCalls).toHaveLength(0);
  });

  it("sends with a formatted amount label, null when totals absent", async () => {
    const withAmount = makeDeps();
    const outcome = await withAmount.handler.handle(makeRow(payload), signal());
    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_oc_1" } });
    expect(withAmount.sendCalls[0].orderId).toBe(`order_${ORDER_UUID}`);
    expect(withAmount.sendCalls[0].amountLabel).toBe("129,99\u00a0zł");

    const noAmount = makeDeps();
    await noAmount.handler.handle(makeRow({ orderUuid: ORDER_UUID, orderId: `order_${ORDER_UUID}` }), signal());
    expect(noAmount.sendCalls[0].amountLabel).toBeNull();
  });

  it("snoozes on a 503 and discards on a 422", async () => {
    const snooze = makeDeps({
      outcome: { ok: false, resendId: null, httpStatus: 503, providerError: "down", aborted: false },
    });
    expect(await snooze.handler.handle(makeRow(payload), signal())).toEqual({ kind: "snooze", reason: "down" });

    const discard = makeDeps({
      outcome: { ok: false, resendId: null, httpStatus: 422, providerError: null, aborted: false },
    });
    expect(await discard.handler.handle(makeRow(payload), signal())).toEqual({
      kind: "discard",
      reason: "resend_rejected",
    });
  });
});
