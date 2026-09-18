import { describe, expect, it } from "vitest";
import { COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import type {
  OrderConfirmationEmailInput,
  OrderPaymentLifecyclePort,
  OrderPaymentLifecycleState,
  OrderRecipient,
  OrderRecipientPort,
  TransactionalEmailPort,
  TransactionalEmailSendOutcome,
} from "./outboxOrderDraftEmailPorts.js";
import { OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG as PORTS_TEMPLATE_SLUG } from "./outboxOrderDraftEmailPorts.js";
import {
  createOutboxOrderDraftEmailHandler,
  OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG,
} from "./outboxOrderDraftEmailHandler.js";

const ORDER_UUID = "0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f";
const EVENT_ID = "11111111-2222-4333-8444-555555555555";

function makeRow(payload: Record<string, unknown>): OutboxEventRow {
  return {
    id: EVENT_ID,
    created_at: "2026-06-12T10:00:00.000+00:00",
    available_at: "2026-06-12T10:00:00.000+00:00",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: ORDER_UUID,
    event_type: COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE,
    idempotency_key: "idem-key-1",
    status: "processing",
    attempts: 1,
    payload,
    error: null,
    metadata: {},
  };
}

const minimalPayload = {
  orderUuid: ORDER_UUID,
  orderId: `order_${ORDER_UUID}`,
};

const fullPayload = {
  ...minimalPayload,
  orderDraftSnapshot: {
    contractVersion: "ignored.by.handler",
    lines: [
      { sku: "SKU-1", productSlug: "karma-dla-psa", quantity: 2, unitPriceGross: {}, lineSubtotalGross: { amountMinor: 10000, currency: "PLN" } },
      { sku: "SKU-2", quantity: 1, lineSubtotalGross: { amountMinor: 2345, currency: "PLN" } },
      { quantity: "broken" },
    ],
    totals: {
      subtotalGross: { amountMinor: 14000, currency: "PLN" },
      discountTotalGross: { amountMinor: 1655, currency: "PLN" },
      totalGross: { amountMinor: 12345, currency: "PLN" },
    },
  },
};

function makeRecipientPort(recipient: OrderRecipient | null) {
  const calls: Array<{ orderUuid: string; signal: AbortSignal }> = [];
  const port: OrderRecipientPort = {
    async resolve(orderUuid, signal) {
      calls.push({ orderUuid, signal });
      return recipient;
    },
  };
  return { port, calls };
}

function makeLifecyclePort(state: OrderPaymentLifecycleState | null = {
  orderStatus: "draft",
  paymentStatus: null,
  hasPayment: false,
}) {
  const calls: Array<{ orderUuid: string; signal: AbortSignal }> = [];
  const port: OrderPaymentLifecyclePort = {
    async read(orderUuid, signal) {
      calls.push({ orderUuid, signal });
      return state;
    },
  };
  return { port, calls };
}

function makeEmailPort(options?: {
  existing?: boolean;
  outcome?: TransactionalEmailSendOutcome;
}) {
  const findCalls: Array<{ templateSlug: string; outboxEventId: string }> = [];
  const sendCalls: OrderConfirmationEmailInput[] = [];
  // Cast: the draft handler only calls findExistingSend + sendOrderConfirmation.
  const port = {
    async findExistingSend(templateSlug: string, outboxEventId: string) {
      findCalls.push({ templateSlug, outboxEventId });
      return options?.existing ?? false;
    },
    async sendOrderConfirmation(input: OrderConfirmationEmailInput) {
      sendCalls.push(input);
      return (
        options?.outcome ?? {
          ok: true,
          resendId: "re_test_1",
          httpStatus: 200,
          providerError: null,
          aborted: false,
        }
      );
    },
  } as unknown as TransactionalEmailPort;
  return { port, findCalls, sendCalls };
}

function makeHandler(options?: {
  recipient?: OrderRecipient | null;
  existing?: boolean;
  outcome?: TransactionalEmailSendOutcome;
  lifecycle?: OrderPaymentLifecycleState | null;
}) {
  const recipient = makeRecipientPort(
    options?.recipient === undefined
      ? { email: "klient@example.com", firstName: "Ola", petName: "Fistaszek" }
      : options.recipient,
  );
  const email = makeEmailPort({ existing: options?.existing, outcome: options?.outcome });
  const lifecycle = makeLifecyclePort(options?.lifecycle);
  const handler = createOutboxOrderDraftEmailHandler({
    emailPort: email.port,
    recipientPort: recipient.port,
    lifecyclePort: lifecycle.port,
  });
  return { handler, recipient, email, lifecycle };
}

describe("outboxOrderDraftEmailHandler", () => {
  it("claims the order_draft.created event type with a 10s timeout", () => {
    const { handler } = makeHandler();
    expect(handler.eventType).toBe(COMMERCE_ORDER_DRAFT_CREATED_EVENT_TYPE);
    expect(handler.timeoutMs).toBe(10_000);
    expect(OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG).toBe("commerce-order-confirmation");
    // Single-sourced slug: the handler re-export IS the ports constant.
    expect(OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG).toBe(PORTS_TEMPLATE_SLUG);
  });

  it("discards with contract_parse_failed on a broken payload and never touches ports", async () => {
    const { handler, recipient, email, lifecycle } = makeHandler();
    const outcome = await handler.handle(
      makeRow({ orderUuid: "not-a-uuid" }),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("discard");
    if (outcome.kind !== "discard") throw new Error("expected discard");
    expect(outcome.reason).toMatch(/^contract_parse_failed: /);
    expect(recipient.calls).toHaveLength(0);
    expect(lifecycle.calls).toHaveLength(0);
    expect(email.findCalls).toHaveLength(0);
    expect(email.sendCalls).toHaveLength(0);
  });

  it("skips stale draft confirmation when the order is no longer a draft", async () => {
    const { handler, recipient, email, lifecycle } = makeHandler({
      lifecycle: { orderStatus: "paid", paymentStatus: "succeeded", hasPayment: true },
    });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({
      kind: "processed",
      detail: { skipped: "order_no_longer_draft" },
    });
    expect(lifecycle.calls[0].orderUuid).toBe(ORDER_UUID);
    expect(recipient.calls).toHaveLength(0);
    expect(email.sendCalls).toHaveLength(0);
  });

  it("skips draft confirmation once any payment row exists", async () => {
    const { handler, recipient, email } = makeHandler({
      lifecycle: { orderStatus: "draft", paymentStatus: "failed", hasPayment: true },
    });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({
      kind: "processed",
      detail: { skipped: "order_no_longer_draft" },
    });
    expect(recipient.calls).toHaveLength(0);
    expect(email.sendCalls).toHaveLength(0);
  });

  it("still sends when ALL optional snapshot fields are missing (no lines, no totals)", async () => {
    const { handler, email } = makeHandler();
    const outcome = await handler.handle(makeRow(minimalPayload), new AbortController().signal);
    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_test_1" } });
    expect(email.sendCalls).toHaveLength(1);
    expect(email.sendCalls[0].items).toEqual([]);
    expect(email.sendCalls[0].totals).toBeNull();
  });

  it("degrades malformed snapshot pieces per-line instead of failing the parse", async () => {
    const { handler, email } = makeHandler();
    const outcome = await handler.handle(
      makeRow({ ...minimalPayload, orderDraftSnapshot: { lines: "not-an-array", totals: 7 } }),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("processed");
    expect(email.sendCalls[0].items).toEqual([]);
    expect(email.sendCalls[0].totals).toBeNull();
  });

  it("returns processed with a recipient_unresolved skip and never calls the email port", async () => {
    const { handler, recipient, email } = makeHandler({ recipient: null });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({
      kind: "processed",
      detail: { skipped: "recipient_unresolved" },
    });
    expect(recipient.calls).toHaveLength(1);
    expect(recipient.calls[0].orderUuid).toBe(ORDER_UUID);
    expect(email.findCalls).toHaveLength(0);
    expect(email.sendCalls).toHaveLength(0);
  });

  it("dedupes on an existing send for this outbox event and never sends again", async () => {
    const { handler, email } = makeHandler({ existing: true });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({
      kind: "processed",
      detail: { dedupe: "email_already_sent" },
    });
    expect(email.findCalls).toEqual([
      { templateSlug: OUTBOX_ORDER_CONFIRMATION_TEMPLATE_SLUG, outboxEventId: EVENT_ID },
    ]);
    expect(email.sendCalls).toHaveLength(0);
  });

  it("sends the rendered summary and returns processed with the resendId", async () => {
    const { handler, email } = makeHandler({
      outcome: { ok: true, resendId: "re_ok_42", httpStatus: 200, providerError: null, aborted: false },
    });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({ kind: "processed", detail: { resendId: "re_ok_42" } });
    expect(email.sendCalls).toHaveLength(1);
    const sent = email.sendCalls[0];
    expect(sent.to).toBe("klient@example.com");
    expect(sent.firstName).toBe("Ola");
    expect(sent.petName).toBe("Fistaszek");
    expect(sent.orderId).toBe(`order_${ORDER_UUID}`);
    expect(sent.outboxEventId).toBe(EVENT_ID);
    expect(sent.items).toEqual([
      { name: "Produkt", quantity: 2, lineTotalLabel: "100,00\u00a0zł" },
      // Drafts have no frozen label → generic label, never a current catalog name.
      { name: "Produkt", quantity: 1, lineTotalLabel: "23,45\u00a0zł" },
    ]);
    expect(sent.totals).toEqual({ subtotalLabel: "140,00\u00a0zł", discountLabel: "-16,55\u00a0zł", totalLabel: "123,45\u00a0zł" });
  });

  it("omits the subtotal (null) when unparseable instead of aliasing the grand total", async () => {
    const { handler, email } = makeHandler();
    const payload = {
      ...fullPayload,
      orderDraftSnapshot: {
        ...fullPayload.orderDraftSnapshot,
        totals: {
          subtotalGross: "broken",
          discountTotalGross: { amountMinor: 1655, currency: "PLN" },
          totalGross: { amountMinor: 12345, currency: "PLN" },
        },
      },
    };
    await handler.handle(makeRow(payload), new AbortController().signal);
    // subtotalLabel is null (row omitted), NOT "123,45 zł" aliased from the total.
    expect(email.sendCalls[0].totals).toEqual({
      subtotalLabel: null,
      discountLabel: "-16,55\u00a0zł",
      totalLabel: "123,45\u00a0zł",
    });
  });

  it("does not look up current catalog names for draft snapshots", async () => {
    const { handler, email } = makeHandler();
    await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(email.sendCalls[0].items[0].name).toBe("Produkt");
    expect(email.sendCalls[0].items[0].name).not.toBe("Karma dla psa");
  });

  it("snoozes on 429 with the provider error as reason", async () => {
    const { handler } = makeHandler({
      outcome: { ok: false, resendId: null, httpStatus: 429, providerError: "rate limited", aborted: false },
    });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({ kind: "snooze", reason: "rate limited" });
  });

  it("snoozes on 503", async () => {
    const { handler } = makeHandler({
      outcome: { ok: false, resendId: null, httpStatus: 503, providerError: "service down", aborted: false },
    });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({ kind: "snooze", reason: "service down" });
  });

  it("snoozes on network failure (httpStatus 0, aborted:false) with resend_unavailable fallback reason", async () => {
    const { handler } = makeHandler({
      outcome: { ok: false, resendId: null, httpStatus: 0, providerError: null, aborted: false },
    });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({ kind: "snooze", reason: "resend_unavailable" });
  });

  it("retries with outbox_handler_timeout on an aborted send (never the snooze refund path)", async () => {
    const { handler } = makeHandler({
      outcome: { ok: false, resendId: null, httpStatus: 0, providerError: "aborted", aborted: true },
    });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({ kind: "retry", reason: "outbox_handler_timeout" });
  });

  it("discards on a hard 422 rejection", async () => {
    const { handler } = makeHandler({
      outcome: { ok: false, resendId: null, httpStatus: 422, providerError: null, aborted: false },
    });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({ kind: "discard", reason: "resend_rejected" });
  });

  it("retries on a not-ok outcome that is neither outage nor rejection", async () => {
    const { handler } = makeHandler({
      outcome: { ok: false, resendId: null, httpStatus: 200, providerError: null, aborted: false },
    });
    const outcome = await handler.handle(makeRow(fullPayload), new AbortController().signal);
    expect(outcome).toEqual({ kind: "retry", reason: "resend_post_failed" });
  });

  it("forwards the abort signal to both recipient resolution and the email send", async () => {
    const { handler, recipient, email } = makeHandler();
    const controller = new AbortController();
    await handler.handle(makeRow(fullPayload), controller.signal);
    expect(recipient.calls[0].signal).toBe(controller.signal);
    expect(email.sendCalls[0].signal).toBe(controller.signal);
  });

  it("propagates errors thrown by ports (worker maps thrown -> retry)", async () => {
    const recipientPort: OrderRecipientPort = {
      resolve: async () => {
        throw new Error("db unreachable");
      },
    };
    const { port: emailPort } = makeEmailPort();
    const handler = createOutboxOrderDraftEmailHandler({
      emailPort,
      recipientPort,
      lifecyclePort: makeLifecyclePort().port,
    });
    await expect(
      handler.handle(makeRow(fullPayload), new AbortController().signal),
    ).rejects.toThrow("db unreachable");
  });
});
