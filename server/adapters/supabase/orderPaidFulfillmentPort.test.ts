import { describe, expect, it } from "vitest";
import {
  createSupabaseOrderPaidFulfillmentPort,
  ORDER_PAID_DISPATCH_KEY_PREFIX,
  ORDER_PAID_DISPATCH_PROVIDER_KIND,
  type OrderPaidFulfillmentSupabaseClient,
} from "./orderPaidFulfillmentPort.js";

const ORDER_UUID = "0f8c5b1e-7a2d-4c3b-9e6f-1a2b3c4d5e6f";
const FULFILLMENT_ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const EVENT_ID = "11111111-2222-4333-8444-555555555555";

interface RpcCall {
  fn: string;
  args: Record<string, unknown>;
}

type RpcResponse = { data: unknown; error: { code?: string; message?: string } | null };

function makeClient(responder: (fn: string, args: Record<string, unknown>) => RpcResponse) {
  const calls: RpcCall[] = [];
  const client: OrderPaidFulfillmentSupabaseClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve(responder(fn, args));
    },
  };
  return { client, calls };
}

const completedStatuses: Record<string, string> = {
  commerce_fulfillment_create_order: "created",
  commerce_fulfillment_record_provider_attempt: "created",
  commerce_fulfillment_record_label_created: "label_created",
  commerce_fulfillment_mark_handed_over: "handed_over",
};

function happyResponder(fn: string): RpcResponse {
  if (fn === "commerce_fulfillment_preflight_split_shipment") {
    return { data: { orderId: ORDER_UUID, splitRequired: false, locationCount: 1 }, error: null };
  }
  return {
    data: { fulfillmentOrderId: FULFILLMENT_ID, orderId: ORDER_UUID, status: completedStatuses[fn], replayed: false },
    error: null,
  };
}

describe("createSupabaseOrderPaidFulfillmentPort", () => {
  it("walks create -> attempt -> label -> handoff in order with derived idempotency keys", async () => {
    const { client, calls } = makeClient(happyResponder);
    const port = createSupabaseOrderPaidFulfillmentPort(client);
    const result = await port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID,
      outboxEventId: EVENT_ID,
      signal: new AbortController().signal,
    });

    expect(result).toEqual({ kind: "completed", detail: { fulfillmentOrderId: FULFILLMENT_ID, status: "handed_over" } });
    expect(calls.map((call) => call.fn)).toEqual([
      "commerce_fulfillment_preflight_split_shipment",
      "commerce_fulfillment_create_order",
      "commerce_fulfillment_record_provider_attempt",
      "commerce_fulfillment_record_label_created",
      "commerce_fulfillment_mark_handed_over",
    ]);

    const base = `${ORDER_PAID_DISPATCH_KEY_PREFIX}:${ORDER_UUID}`;
    expect(calls[0].args.p_idempotency_key).toBe(`${base}:split-review`);
    expect(calls[0].args.p_order_id).toBe(ORDER_UUID);
    expect(calls[1].args.p_idempotency_key).toBe(`${base}:create`);
    expect(calls[1].args.p_order_id).toBe(ORDER_UUID);
    expect(calls[2].args.p_idempotency_key).toBe(`${base}:attempt`);
    expect(calls[2].args.p_fulfillment_order_id).toBe(FULFILLMENT_ID);
    expect(calls[2].args.p_provider_kind).toBe(ORDER_PAID_DISPATCH_PROVIDER_KIND);
    expect(calls[2].args.p_status).toBe("succeeded");
    expect(calls[3].args.p_idempotency_key).toBe(`${base}:label`);
    expect(calls[3].args.p_provider_tracking_id).toBe(`${base}`);
    expect(calls[3].args.p_delivery_estimate_days).toBe(2);
    expect(calls[3].args.p_label_url).toBeNull();
    expect(calls[4].args.p_idempotency_key).toBe(`${base}:handoff`);
    expect(calls[4].args.p_fulfillment_order_id).toBe(FULFILLMENT_ID);
  });

  it("routes a multi-location (split) order to manual_review WITHOUT creating any fulfillment order or label", async () => {
    const { client, calls } = makeClient((fn) => {
      if (fn === "commerce_fulfillment_preflight_split_shipment") {
        return {
          data: { orderId: ORDER_UUID, splitRequired: true, locationCount: 2, holdId: "hold-1", replayed: false },
          error: null,
        };
      }
      // Any create/attempt/label/handoff call here is the orphan-side-effect bug.
      throw new Error(`unexpected RPC after split detection: ${fn}`);
    });
    const port = createSupabaseOrderPaidFulfillmentPort(client);
    const result = await port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID,
      outboxEventId: EVENT_ID,
      signal: new AbortController().signal,
    });

    // Non-silent terminal outcome: manual review with the durable hold id, NOT fatal.
    expect(result).toEqual({
      kind: "manual_review",
      reason: "split_shipment_unsupported",
      detail: { locationCount: 2, holdId: "hold-1" },
    });
    // Ordering guarantee: split detection happens FIRST and is the ONLY RPC.
    // No create / attempt / label / handoff -> no orphan label_created row.
    expect(calls.map((call) => call.fn)).toEqual(["commerce_fulfillment_preflight_split_shipment"]);
    expect(calls[0].args.p_idempotency_key).toBe(`${ORDER_PAID_DISPATCH_KEY_PREFIX}:${ORDER_UUID}:split-review`);
  });

  it("classifies a transient preflight error as retryable (paid order not stranded)", async () => {
    const { client, calls } = makeClient((fn) => {
      if (fn === "commerce_fulfillment_preflight_split_shipment") {
        return { data: null, error: { code: "08006", message: "connection failure" } };
      }
      throw new Error(`unexpected RPC after preflight error: ${fn}`);
    });
    const port = createSupabaseOrderPaidFulfillmentPort(client);
    const result = await port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID,
      outboxEventId: EVENT_ID,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ kind: "retryable", reason: "connection failure" });
    expect(calls.map((call) => call.fn)).toEqual(["commerce_fulfillment_preflight_split_shipment"]);
  });

  it("treats an idempotent replay (create returns already-handed-over) as completed, skipping attempt+label", async () => {
    const { client, calls } = makeClient((fn) => {
      if (fn === "commerce_fulfillment_create_order") {
        return { data: { fulfillmentOrderId: FULFILLMENT_ID, status: "handed_over", replayed: true }, error: null };
      }
      // handoff replays to handed_over
      return { data: { fulfillmentOrderId: FULFILLMENT_ID, status: "handed_over", replayed: true }, error: null };
    });
    const port = createSupabaseOrderPaidFulfillmentPort(client);
    const result = await port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID,
      outboxEventId: EVENT_ID,
      signal: new AbortController().signal,
    });

    expect(result.kind).toBe("completed");
    // attempt + label are skipped because the order is already labelled/handed-over
    expect(calls.map((call) => call.fn)).toEqual([
      "commerce_fulfillment_preflight_split_shipment",
      "commerce_fulfillment_create_order",
      "commerce_fulfillment_mark_handed_over",
    ]);
  });

  it("maps a transient connection error (SQLSTATE 08006) to retryable", async () => {
    const { client } = makeClient((fn) => {
      if (fn === "commerce_fulfillment_create_order") {
        return { data: null, error: { code: "08006", message: "connection failure" } };
      }
      return happyResponder(fn);
    });
    const port = createSupabaseOrderPaidFulfillmentPort(client);
    const result = await port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID,
      outboxEventId: EVENT_ID,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ kind: "retryable", reason: "connection failure" });
  });

  it("maps a terminal validation error (22023 missing inventory) to fatal", async () => {
    const { client } = makeClient((fn) => {
      if (fn === "commerce_fulfillment_create_order") {
        return {
          data: null,
          error: { code: "22023", message: "commerce_fulfillment_missing_inventory_reservation" },
        };
      }
      return happyResponder(fn);
    });
    const port = createSupabaseOrderPaidFulfillmentPort(client);
    const result = await port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID,
      outboxEventId: EVENT_ID,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("fatal");
    if (result.kind !== "fatal") throw new Error("expected fatal");
    expect(result.reason).toContain("commerce_fulfillment_missing_inventory_reservation");
  });

  it("retries order-not-found fulfillment races instead of immediately discarding a paid order", async () => {
    const { client } = makeClient((fn) => {
      if (fn === "commerce_fulfillment_create_order") {
        return {
          data: null,
          error: { code: "22023", message: "commerce_fulfillment_order_not_found" },
        };
      }
      return happyResponder(fn);
    });
    const port = createSupabaseOrderPaidFulfillmentPort(client);
    const result = await port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID,
      outboxEventId: EVENT_ID,
      signal: new AbortController().signal,
    });
    expect(result).toEqual({ kind: "retryable", reason: "commerce_fulfillment_order_not_found" });
  });

  it("returns retryable without issuing any RPC when the signal is already aborted", async () => {
    const { client, calls } = makeClient(happyResponder);
    const controller = new AbortController();
    controller.abort();
    const port = createSupabaseOrderPaidFulfillmentPort(client);
    const result = await port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID,
      outboxEventId: EVENT_ID,
      signal: controller.signal,
    });
    expect(result).toEqual({ kind: "retryable", reason: "outbox_handler_timeout" });
    expect(calls).toHaveLength(0);
  });

  it("flags a handoff that ends in an unexpected status as fatal", async () => {
    const { client } = makeClient((fn) => {
      if (fn === "commerce_fulfillment_mark_handed_over") {
        return { data: { fulfillmentOrderId: FULFILLMENT_ID, status: "label_created", replayed: false }, error: null };
      }
      return happyResponder(fn);
    });
    const port = createSupabaseOrderPaidFulfillmentPort(client);
    const result = await port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_UUID,
      outboxEventId: EVENT_ID,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe("fatal");
  });
});
