import { describe, expect, it } from "vitest";
import { COMMERCE_ORDER_PAID_EVENT_TYPE } from "../../../src/domains/commerce/outboxEventContracts.js";
import type { OutboxEventRow } from "./outboxDispatchContracts.js";
import { createOutboxOrderPaidFulfillmentHandler } from "./outboxOrderPaidFulfillmentHandler.js";
import type {
  OrderPaidFulfillmentPort,
  OrderPaidFulfillmentResult,
} from "./outboxOrderPaidFulfillmentPorts.js";

const ORDER_UUID = "0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f";
const EVENT_ID = "11111111-2222-4333-8444-555555555555";

function makeRow(payload: Record<string, unknown>): OutboxEventRow {
  return {
    id: EVENT_ID,
    created_at: "2026-06-13T10:00:00.000+00:00",
    available_at: "2026-06-13T10:00:00.000+00:00",
    processed_at: null,
    aggregate_type: "commerce_order",
    aggregate_id: ORDER_UUID,
    event_type: COMMERCE_ORDER_PAID_EVENT_TYPE,
    idempotency_key: `order_paid:${ORDER_UUID}`,
    status: "processing",
    attempts: 1,
    payload,
    error: null,
    metadata: {},
  };
}

const validPayload = {
  orderId: `order_${ORDER_UUID}`,
  orderUuid: ORDER_UUID,
  mode: "one_time",
  occurredAt: "2026-06-13T10:00:00.000+00:00",
};

function makePort(results: OrderPaidFulfillmentResult[]) {
  const calls: Array<{ orderUuid: string; outboxEventId: string; signal: AbortSignal }> = [];
  let index = 0;
  const port: OrderPaidFulfillmentPort = {
    async ensureFulfilledFromPaidOrder(input) {
      calls.push(input);
      const result = results[Math.min(index, results.length - 1)];
      index += 1;
      return result;
    },
  };
  return { port, calls };
}

function makeHandler(options: { results?: OrderPaidFulfillmentResult[] }) {
  const fulfillment = makePort(
    options.results ?? [{ kind: "completed", detail: { status: "handed_over" } }],
  );
  const handler = createOutboxOrderPaidFulfillmentHandler({
    fulfillmentPort: fulfillment.port,
  });
  return { handler, fulfillment };
}

describe("outboxOrderPaidFulfillmentHandler", () => {
  it("claims the order.paid event type with a 15s timeout", () => {
    const { handler } = makeHandler({});
    expect(handler.eventType).toBe(COMMERCE_ORDER_PAID_EVENT_TYPE);
    expect(handler.timeoutMs).toBe(15_000);
  });

  it("processes when the port completes the fulfillment chain", async () => {
    const { handler, fulfillment } = makeHandler({
      results: [{ kind: "completed", detail: { fulfillmentOrderId: "f-1", status: "handed_over" } }],
    });
    const outcome = await handler.handle(makeRow(validPayload), new AbortController().signal);
    expect(outcome).toEqual({
      kind: "processed",
      detail: { fulfillmentOrderId: "f-1", status: "handed_over" },
    });
    expect(fulfillment.calls).toHaveLength(1);
    expect(fulfillment.calls[0].orderUuid).toBe(ORDER_UUID);
    expect(fulfillment.calls[0].outboxEventId).toBe(EVENT_ID);
  });

  it("processes a skipped result the same as completed", async () => {
    const { handler } = makeHandler({
      results: [{ kind: "skipped", detail: { reason: "already_handed_over" } }],
    });
    const outcome = await handler.handle(makeRow(validPayload), new AbortController().signal);
    expect(outcome).toEqual({ kind: "processed", detail: { reason: "already_handed_over" } });
  });

  it("discards with contract_parse_failed on a payload missing orderUuid (port untouched)", async () => {
    const { handler, fulfillment } = makeHandler({});
    const outcome = await handler.handle(
      makeRow({ orderId: "order_x", mode: "one_time" }),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("discard");
    if (outcome.kind !== "discard") throw new Error("expected discard");
    expect(outcome.reason).toMatch(/^contract_parse_failed: /);
    expect(fulfillment.calls).toHaveLength(0);
  });

  it("discards on a non-uuid orderUuid even when the flag is on", async () => {
    const { handler, fulfillment } = makeHandler({});
    const outcome = await handler.handle(
      makeRow({ ...validPayload, orderUuid: "not-a-uuid" }),
      new AbortController().signal,
    );
    expect(outcome.kind).toBe("discard");
    expect(fulfillment.calls).toHaveLength(0);
  });

  it("retries when the port reports a retryable error", async () => {
    const { handler } = makeHandler({
      results: [{ kind: "retryable", reason: "connection reset" }],
    });
    const outcome = await handler.handle(makeRow(validPayload), new AbortController().signal);
    expect(outcome).toEqual({ kind: "retry", reason: "connection reset" });
  });

  it("snoozes when the port reports a provider outage", async () => {
    const { handler } = makeHandler({
      results: [{ kind: "snooze", reason: "omnipack_selected_but_not_ready:omnipack_provider_not_configured" }],
    });
    const outcome = await handler.handle(makeRow(validPayload), new AbortController().signal);
    expect(outcome).toEqual({
      kind: "snooze",
      reason: "omnipack_selected_but_not_ready:omnipack_provider_not_configured",
    });
  });

  it("discards when the port reports a fatal terminal error", async () => {
    const { handler } = makeHandler({
      results: [{ kind: "fatal", reason: "commerce_fulfillment_missing_inventory_reservation" }],
    });
    const outcome = await handler.handle(makeRow(validPayload), new AbortController().signal);
    expect(outcome).toEqual({
      kind: "discard",
      reason: "commerce_fulfillment_missing_inventory_reservation",
    });
  });

  it("settles a manual_review (split shipment) result as processed, NOT a silent discard", async () => {
    const { handler } = makeHandler({
      results: [
        {
          kind: "manual_review",
          reason: "split_shipment_unsupported",
          detail: { locationCount: 2, holdId: "hold-1" },
        },
      ],
    });
    const outcome = await handler.handle(makeRow(validPayload), new AbortController().signal);
    expect(outcome).toEqual({
      kind: "processed",
      detail: {
        locationCount: 2,
        holdId: "hold-1",
        outcome: "manual_review",
        reason: "split_shipment_unsupported",
      },
    });
    expect(outcome.kind).not.toBe("discard");
  });

  it("is idempotent on replay: a port that completes twice processes both times", async () => {
    const { handler } = makeHandler({
      results: [{ kind: "completed", detail: { status: "handed_over" } }],
    });
    const first = await handler.handle(makeRow(validPayload), new AbortController().signal);
    const second = await handler.handle(makeRow(validPayload), new AbortController().signal);
    expect(first).toEqual({ kind: "processed", detail: { status: "handed_over" } });
    expect(second).toEqual({ kind: "processed", detail: { status: "handed_over" } });
  });

  it("forwards the abort signal to the port", async () => {
    const { handler, fulfillment } = makeHandler({});
    const controller = new AbortController();
    await handler.handle(makeRow(validPayload), controller.signal);
    expect(fulfillment.calls[0].signal).toBe(controller.signal);
  });

  it("propagates errors thrown by the port (worker maps thrown -> retry)", async () => {
    const port: OrderPaidFulfillmentPort = {
      ensureFulfilledFromPaidOrder: async () => {
        throw new Error("db unreachable");
      },
    };
    const handler = createOutboxOrderPaidFulfillmentHandler({
      fulfillmentPort: port,
    });
    await expect(
      handler.handle(makeRow(validPayload), new AbortController().signal),
    ).rejects.toThrow("db unreachable");
  });
});
