import { describe, expect, it } from "vitest";
import { COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import type {
  OrderRecipient,
  OrderRecipientPort,
  ShipmentExceptionEmailInput,
  TransactionalEmailPort,
  TransactionalEmailSendOutcome,
} from "./outboxOrderDraftEmailPorts.js";
import {
  createOutboxShipmentExceptionEmailHandler,
  OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG,
} from "./outboxShipmentExceptionEmailHandler.js";

const ORDER_UUID = "0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f";
const EVENT_ID = "11111111-2222-4333-8444-666666666666";

function makeRow(payload: Record<string, unknown>): OutboxEventRow {
  return {
    id: EVENT_ID,
    created_at: "2026-07-02T10:00:00.000+00:00",
    available_at: "2026-07-02T10:00:00.000+00:00",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: ORDER_UUID,
    event_type: COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE,
    idempotency_key: "shipment_exception:x",
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
  customerNotification: "shipment_exception",
};

function makeDeps(options?: {
  recipient?: OrderRecipient | null;
  existing?: boolean;
  outcome?: TransactionalEmailSendOutcome;
}) {
  const sendCalls: ShipmentExceptionEmailInput[] = [];
  const emailPort = {
    async findExistingSend() {
      return options?.existing ?? false;
    },
    async sendShipmentExceptionNotice(input: ShipmentExceptionEmailInput) {
      sendCalls.push(input);
      return (
        options?.outcome ?? {
          ok: true,
          resendId: "re_ex_1",
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
  const handler = createOutboxShipmentExceptionEmailHandler({ emailPort, recipientPort });
  return { handler, sendCalls };
}

const signal = () => new AbortController().signal;

describe("outboxShipmentExceptionEmailHandler", () => {
  it("claims commerce.shipment.exception with a 10s timeout and the exception slug", () => {
    const { handler } = makeDeps();
    expect(handler.eventType).toBe(COMMERCE_SHIPMENT_EXCEPTION_EVENT_TYPE);
    expect(handler.timeoutMs).toBe(10_000);
    expect(OUTBOX_SHIPMENT_EXCEPTION_TEMPLATE_SLUG).toBe("commerce-shipment-exception");
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

  it("skips internal fulfillment holds that are not customer-visible shipment exceptions", async () => {
    const internal = makeDeps();
    expect(await internal.handler.handle(
      makeRow({ orderUuid: ORDER_UUID, orderId: `order_${ORDER_UUID}` }),
      signal(),
    )).toEqual({
      kind: "processed",
      detail: { skipped: "internal_fulfillment_hold" },
    });
    expect(internal.sendCalls).toHaveLength(0);
  });

  it("sends the exception notice with the order id", async () => {
    const sent = makeDeps();
    const outcome = await sent.handler.handle(makeRow(payload), signal());
    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_ex_1" } });
    expect(sent.sendCalls[0].orderId).toBe(`order_${ORDER_UUID}`);
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
