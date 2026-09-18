import { describe, expect, it, vi } from "vitest";

import {
  CommerceFulfillmentConflictError,
  CommerceFulfillmentPersistenceError,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import {
  createSupabaseCommerceFulfillmentMutationPort,
} from "./commerceFulfillmentMutationPort.js";
import { createSupabaseFulfillmentShipmentSpinePort } from "./fulfillmentCompositionPorts.js";
import type { CommerceFulfillmentSupabaseClient, RpcError } from "./commerceFulfillmentPort.js";

const ORDER_ID = "42222222-2222-4222-8222-222222222221";
const FULFILLMENT_ORDER_ID = "52222222-2222-4222-8222-222222222221";
const ACTOR_USER_ID = "62222222-2222-4222-8222-222222222221";

const RESPONSE = {
  contractVersion: "commerce.fulfillment.v0",
  fulfillmentOrderId: FULFILLMENT_ORDER_ID,
  orderId: ORDER_ID,
  status: "created",
  replayed: false,
} as const;

describe("supabase commerce fulfillment mutation port", () => {
  it("freezes all six RPC names, argument maps, defaults and response identity", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: RESPONSE, error: null });
    const port = createSupabaseCommerceFulfillmentMutationPort(client(rpc));

    await expect(port.createCommerceFulfillmentOrder({
      idempotencyKey: "create-order-1",
      orderId: ORDER_ID,
      actorUserId: ACTOR_USER_ID,
    })).resolves.toBe(RESPONSE);
    await expect(port.recordCommerceFulfillmentProviderAttempt({
      idempotencyKey: "provider-attempt-1",
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      providerKind: "warehouse",
      status: "succeeded",
      requestPayload: { request: true },
      responsePayload: { accepted: true },
      actorUserId: ACTOR_USER_ID,
    })).resolves.toBe(RESPONSE);
    await expect(port.recordCommerceFulfillmentLabel({
      idempotencyKey: "record-label-1",
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      providerKind: "carrier",
      providerTrackingId: "tracking-1",
      rawProviderPayload: { label: true },
      actorUserId: ACTOR_USER_ID,
    })).resolves.toBe(RESPONSE);
    await expect(port.handOffCommerceFulfillmentOrder({
      idempotencyKey: "hand-off-order-1",
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      actorUserId: ACTOR_USER_ID,
    })).resolves.toBe(RESPONSE);
    await expect(port.recordCommerceFulfillmentTrackingEvent({
      idempotencyKey: "tracking-event-1",
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      status: "in_transit",
      rawEvent: { position: 1 },
      actorUserId: ACTOR_USER_ID,
    })).resolves.toBe(RESPONSE);
    await expect(port.cancelCommerceFulfillmentOrder({
      idempotencyKey: "cancel-order-1",
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      reason: "operator request",
      actorUserId: ACTOR_USER_ID,
    })).resolves.toBe(RESPONSE);

    expect(rpc.mock.calls).toEqual([
      ["commerce_fulfillment_create_order", {
        p_idempotency_key: "create-order-1",
        p_order_id: ORDER_ID,
        p_actor_user_id: ACTOR_USER_ID,
        p_metadata: {},
      }],
      ["commerce_fulfillment_record_provider_attempt", {
        p_idempotency_key: "provider-attempt-1",
        p_fulfillment_order_id: FULFILLMENT_ORDER_ID,
        p_provider_kind: "warehouse",
        p_status: "succeeded",
        p_request_payload: { request: true },
        p_response_payload: { accepted: true },
        p_error: null,
        p_actor_user_id: ACTOR_USER_ID,
        p_metadata: {},
      }],
      ["commerce_fulfillment_record_label_created", {
        p_idempotency_key: "record-label-1",
        p_fulfillment_order_id: FULFILLMENT_ORDER_ID,
        p_provider_kind: "carrier",
        p_provider_tracking_id: "tracking-1",
        p_label_url: null,
        p_delivery_estimate_days: null,
        p_raw_provider_payload: { label: true },
        p_actor_user_id: ACTOR_USER_ID,
        p_metadata: {},
      }],
      ["commerce_fulfillment_mark_handed_over", {
        p_idempotency_key: "hand-off-order-1",
        p_fulfillment_order_id: FULFILLMENT_ORDER_ID,
        p_actor_user_id: ACTOR_USER_ID,
        p_metadata: {},
      }],
      ["commerce_fulfillment_record_tracking_event", {
        p_idempotency_key: "tracking-event-1",
        p_fulfillment_order_id: FULFILLMENT_ORDER_ID,
        p_status: "in_transit",
        p_provider_tracking_id: null,
        p_raw_event: { position: 1 },
        p_actor_user_id: ACTOR_USER_ID,
        p_metadata: {},
      }],
      ["commerce_fulfillment_cancel_order", {
        p_idempotency_key: "cancel-order-1",
        p_fulfillment_order_id: FULFILLMENT_ORDER_ID,
        p_reason: "operator request",
        p_actor_user_id: ACTOR_USER_ID,
        p_metadata: {},
      }],
    ]);
  });

  it.each([
    [{ code: "23505", message: "duplicate" }, CommerceFulfillmentConflictError],
    [{ code: "22023", message: "commerce_fulfillment_handoff_requires_label" }, CommerceFulfillmentConflictError],
    [{ code: "XX000", message: "database unavailable" }, CommerceFulfillmentPersistenceError],
  ] as const)("maps RPC error %j to %s", async (error, expected) => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error });
    const port = createSupabaseCommerceFulfillmentMutationPort(client(rpc));

    await expect(port.handOffCommerceFulfillmentOrder({
      idempotencyKey: "hand-off-order-1",
      fulfillmentOrderId: FULFILLMENT_ORDER_ID,
      actorUserId: ACTOR_USER_ID,
    })).rejects.toBeInstanceOf(expected);
  });
});

describe("Supabase fulfillment shipment spine", () => {
  const at = "2026-08-13T09:00:00.000Z";

  it("maps all six spine actions without a provider-attempt call", async () => {
    const managed = spineClient();
    const port = createSupabaseFulfillmentShipmentSpinePort(managed as never, { providerKind: "omnipack" });

    await expect(port.createShipment({ idempotencyKey: "spine-create", orderId: ORDER_ID, metadata: { source: "proof" }, requestedAt: at }))
      .resolves.toEqual(spineResult("created"));
    await expect(port.recordLabel({ idempotencyKey: "spine-label", shipmentId: FULFILLMENT_ORDER_ID, externalRef: "TRACK-1", requestedAt: at }))
      .resolves.toEqual(spineResult("label_created"));
    await expect(port.handOff({ idempotencyKey: "spine-handoff", shipmentId: FULFILLMENT_ORDER_ID, requestedAt: at }))
      .resolves.toEqual(spineResult("handed_over"));
    await expect(port.recordTracking({ idempotencyKey: "spine-track", shipmentId: FULFILLMENT_ORDER_ID, status: "delivered", externalRef: "TRACK-1", requestedAt: at }))
      .resolves.toEqual(spineResult("delivered"));
    await expect(port.cancel({ idempotencyKey: "spine-cancel", shipmentId: FULFILLMENT_ORDER_ID, reason: "operator", requestedAt: at }))
      .resolves.toEqual(spineResult("cancelled"));
    await expect(port.raiseException({ idempotencyKey: "spine-exception", shipmentId: FULFILLMENT_ORDER_ID, reason: "provider rejected", metadata: { evidence: "sanitized" }, requestedAt: at }))
      .resolves.toEqual(spineResult("created"));

    expect(managed.rpc.mock.calls).toEqual([
      ["commerce_fulfillment_create_order", {
        p_idempotency_key: "spine-create", p_order_id: ORDER_ID, p_actor_user_id: null,
        p_metadata: { source: "proof" },
      }],
      ["commerce_fulfillment_record_label_created", {
        p_idempotency_key: "spine-label", p_fulfillment_order_id: FULFILLMENT_ORDER_ID,
        p_provider_kind: "omnipack", p_provider_tracking_id: "TRACK-1", p_label_url: null,
        p_delivery_estimate_days: null, p_raw_provider_payload: {}, p_actor_user_id: null, p_metadata: {},
      }],
      ["commerce_fulfillment_mark_handed_over", {
        p_idempotency_key: "spine-handoff", p_fulfillment_order_id: FULFILLMENT_ORDER_ID,
        p_actor_user_id: null, p_metadata: {},
      }],
      ["commerce_fulfillment_record_tracking_event", {
        p_idempotency_key: "spine-track", p_fulfillment_order_id: FULFILLMENT_ORDER_ID, p_status: "delivered",
        p_provider_tracking_id: "TRACK-1", p_raw_event: { occurredAt: at }, p_actor_user_id: null, p_metadata: {},
      }],
      ["commerce_fulfillment_cancel_order", {
        p_idempotency_key: "spine-cancel", p_fulfillment_order_id: FULFILLMENT_ORDER_ID,
        p_reason: "operator", p_actor_user_id: null, p_metadata: {},
      }],
      ["commerce_fulfillment_record_provider_exception", {
        p_idempotency_key: "spine-exception", p_order_id: ORDER_ID, p_reason: "provider rejected",
        p_metadata: { evidence: "sanitized", fulfillmentOrderId: FULFILLMENT_ORDER_ID, providerKind: "omnipack" },
      }],
    ]);
    expect(managed.reads).toBe(2);
    expect(managed.rpc.mock.calls.some(([name]) => name === "commerce_fulfillment_record_provider_attempt")).toBe(false);
  });

  it("fails closed on config, malformed responses, conflicts and persistence errors", async () => {
    expect(() => createSupabaseFulfillmentShipmentSpinePort(spineClient() as never, { providerKind: "  " }))
      .toThrow("fulfillment_shipment_spine_provider_kind_required");
    await expect(createSupabaseFulfillmentShipmentSpinePort(spineClient({ malformed: true }) as never, { providerKind: "omnipack" }).createShipment({
      idempotencyKey: "spine-create", orderId: ORDER_ID,
    })).rejects.toBeInstanceOf(CommerceFulfillmentPersistenceError);
    await expect(createSupabaseFulfillmentShipmentSpinePort(spineClient({ error: { code: "23505", message: "conflict" } }) as never, { providerKind: "omnipack" }).handOff({
      idempotencyKey: "spine-conflict", shipmentId: FULFILLMENT_ORDER_ID,
    })).rejects.toBeInstanceOf(CommerceFulfillmentConflictError);
    await expect(createSupabaseFulfillmentShipmentSpinePort(spineClient({ error: { code: "08006", message: "lost" } }) as never, { providerKind: "omnipack" }).handOff({
      idempotencyKey: "spine-failed", shipmentId: FULFILLMENT_ORDER_ID,
    })).rejects.toBeInstanceOf(CommerceFulfillmentPersistenceError);
  });
});

function client(
  rpc: (functionName: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: RpcError | null }>,
): CommerceFulfillmentSupabaseClient {
  return { rpc, from: vi.fn() } as unknown as CommerceFulfillmentSupabaseClient;
}

function spineResult(status: string) {
  return { shipmentId: FULFILLMENT_ORDER_ID, orderId: ORDER_ID, status, replayed: false };
}

function spineClient(options: {
  error?: { code?: string; message?: string };
  malformed?: boolean;
} = {}) {
  let reads = 0;
  const rpc = vi.fn(async (name: string) => {
    if (options.error) return { data: null, error: options.error };
    if (options.malformed) return { data: {}, error: null };
    if (name === "commerce_fulfillment_record_provider_exception") {
      return { data: { orderId: ORDER_ID, replayed: false }, error: null };
    }
    const status = name === "commerce_fulfillment_create_order" ? "created"
      : name === "commerce_fulfillment_record_label_created" ? "label_created"
        : name === "commerce_fulfillment_mark_handed_over" ? "handed_over"
          : name === "commerce_fulfillment_record_tracking_event" ? "delivered"
            : "cancelled";
    return {
      data: { fulfillmentOrderId: FULFILLMENT_ORDER_ID, orderId: ORDER_ID, status, replayed: false },
      error: null,
    };
  });
  return {
    rpc,
    get reads() { return reads; },
    from() {
      const builder = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          reads += 1;
          return { data: { id: FULFILLMENT_ORDER_ID, order_id: ORDER_ID, status: "created" }, error: null };
        },
      };
      return builder;
    },
  };
}
