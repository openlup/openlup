import { formatMoney } from "./orderEmailLines.js";
import { registerEmailProviderOutcomeCases, registerEmailRecipientCases } from "../../shared/__tests__/outboxEmailHandler.testFixtures.js";
import { describe, expect, it } from "vitest";
import { COMMERCE_ORDER_REFUNDED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import type {
  OrderRecipient,
  OrderRecipientPort,
  OrderRefundedEmailInput,
  TransactionalEmailPort,
  TransactionalEmailSendOutcome,
} from "./outboxOrderDraftEmailPorts.js";
import {
  createOutboxOrderRefundedEmailHandler,
  OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG,
} from "./outboxOrderRefundedEmailHandler.js";

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
    event_type: COMMERCE_ORDER_REFUNDED_EVENT_TYPE,
    idempotency_key: "order_refunded:x",
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
  refundCents: 7777,
  refundEvidenceVersion: "provider-refund.v2",
  totalCents: 12999,
  currency: "PLN",
};

function makeDeps(options?: {
  recipient?: OrderRecipient | null;
  existing?: boolean;
  outcome?: TransactionalEmailSendOutcome;
}) {
  const sendCalls: OrderRefundedEmailInput[] = [];
  const emailPort = {
    async findExistingSend() {
      return options?.existing ?? false;
    },
    async sendOrderRefundedNotice(input: OrderRefundedEmailInput) {
      sendCalls.push(input);
      return (
        options?.outcome ?? {
          ok: true,
          resendId: "re_or_1",
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
  const handler = createOutboxOrderRefundedEmailHandler({ emailPort, recipientPort });
  return { handler, sendCalls };
}

const signal = () => new AbortController().signal;

describe("outboxOrderRefundedEmailHandler", () => {
  it("claims commerce.order.refunded with a 10s timeout and the refunded slug", () => {
    const { handler } = makeDeps();
    expect(handler.eventType).toBe(COMMERCE_ORDER_REFUNDED_EVENT_TYPE);
    expect(handler.timeoutMs).toBe(10_000);
    expect(OUTBOX_ORDER_REFUNDED_TEMPLATE_SLUG).toBe("commerce-order-refunded");
  });

  it("discards a broken payload", async () => {
    const { handler } = makeDeps();
    expect((await handler.handle(makeRow({ orderUuid: "nope" }), signal())).kind).toBe("discard");
  });

  registerEmailRecipientCases(makeDeps, () => makeRow(payload));

  it("sends with the provider refund amount label, null when amount absent", async () => {
    const withAmount = makeDeps();
    const outcome = await withAmount.handler.handle(makeRow(payload), signal());
    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_or_1" } });
    expect(withAmount.sendCalls[0].orderId).toBe(`order_${ORDER_UUID}`);
    expect(withAmount.sendCalls[0].amountLabel).toBe("77,77\u00a0zł");

    const noAmount = makeDeps();
    await noAmount.handler.handle(makeRow({ orderUuid: ORDER_UUID, orderId: `order_${ORDER_UUID}` }), signal());
    expect(noAmount.sendCalls[0].amountLabel).toBeNull();

    const historicalTotal = makeDeps();
    await historicalTotal.handler.handle(makeRow({ orderUuid: ORDER_UUID, orderId: `order_${ORDER_UUID}`, totalCents: 12999, currency: payload.currency }), signal());
    expect(historicalTotal.sendCalls[0].amountLabel).toBeNull();
  });

  registerEmailProviderOutcomeCases(makeDeps, () => makeRow(payload));

  it.each([undefined, "provider-refund.v1"])("keeps an unproven queued legacy amount unknown (%s)", async (version) => {
    const legacy = makeDeps();
    await legacy.handler.handle(makeRow({ ...payload, refundEvidenceVersion: version, refundCents: 20000,
      amountSource: "inbound_provider_events.amount_cents_sum_same_currency" }), signal());
    expect(legacy.sendCalls[0].amountLabel).toBeNull();
  });

  it("retains the proven new provider additive amount despite the legacy source label", async () => {
    const provider = makeDeps();
    await provider.handler.handle(makeRow({ ...payload, amountSource: "inbound_provider_events.amount_cents_sum_same_currency" }), signal());
    expect(provider.sendCalls[0].amountLabel).toBe(formatMoney(7777, payload.currency));
  });
});
