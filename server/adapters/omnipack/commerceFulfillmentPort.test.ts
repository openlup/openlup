import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ORDER_PAID_OMNIPACK_DISPATCH_KEY_PREFIX,
  createOmnipackOrderPaidFulfillmentPort,
} from "./commerceFulfillmentPort.js";

const ORDER_ID = "11111111-1111-4111-8111-111111111111";
const FULFILLMENT_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OmniPack order-paid fulfillment port", () => {
  it("records only the local fulfillment obligation without candidate, command, ref, or provider effects", async () => {
    const client = fakeClient();
    const providerPost = vi.fn(async () => {
      throw new Error("provider POST forbidden from commerce.order.paid");
    });
    vi.stubGlobal("fetch", providerPost);
    const port = createOmnipackOrderPaidFulfillmentPort({ client });

    await expect(port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_ID,
      outboxEventId: "event-1",
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: "completed",
      detail: {
        fulfillmentOrderId: FULFILLMENT_ID,
        providerKind: "omnipack",
        status: "created",
        outcome: "local_fulfillment_obligation_recorded",
      },
    });

    expect(client.rpc).toHaveBeenCalledWith("commerce_fulfillment_preflight_split_shipment", expect.objectContaining({
      p_idempotency_key: `${ORDER_PAID_OMNIPACK_DISPATCH_KEY_PREFIX}:${ORDER_ID}:split-review`,
      p_order_id: ORDER_ID,
    }));
    expect(client.rpc).toHaveBeenCalledWith("commerce_fulfillment_create_order", expect.objectContaining({
      p_idempotency_key: `${ORDER_PAID_OMNIPACK_DISPATCH_KEY_PREFIX}:${ORDER_ID}:create`,
      p_order_id: ORDER_ID,
      p_metadata: {
        source: ORDER_PAID_OMNIPACK_DISPATCH_KEY_PREFIX,
        providerKind: "omnipack",
        fulfillmentBoundary: "outbox-local-obligation",
      },
    }));
    const rpcNames = client.rpc.mock.calls.map(([name]) => name);
    expect(rpcNames).toEqual([
      "commerce_fulfillment_preflight_split_shipment",
      "commerce_fulfillment_create_order",
    ]);
    expect(rpcNames).not.toContain("commerce_fulfillment_enqueue_provider_command");
    expect(rpcNames).not.toContain("omnipack_record_dispatch_ref");
    expect(client.from).not.toHaveBeenCalled();
    expect(providerPost).not.toHaveBeenCalled();
  });

  it("replays the same local preflight and create identities", async () => {
    const client = fakeClient();
    const port = createOmnipackOrderPaidFulfillmentPort({ client });
    const args = {
      orderUuid: ORDER_ID,
      outboxEventId: "event-1",
      signal: new AbortController().signal,
    };

    await expect(port.ensureFulfilledFromPaidOrder(args)).resolves.toMatchObject({
      kind: "completed",
      detail: { outcome: "local_fulfillment_obligation_recorded" },
    });
    await expect(port.ensureFulfilledFromPaidOrder(args)).resolves.toMatchObject({
      kind: "completed",
      detail: { outcome: "local_fulfillment_obligation_recorded" },
    });

    const preflights = client.rpc.mock.calls.filter(([name]) => name === "commerce_fulfillment_preflight_split_shipment");
    const creates = client.rpc.mock.calls.filter(([name]) => name === "commerce_fulfillment_create_order");
    expect(preflights).toHaveLength(2);
    expect(preflights[1]?.[1]).toEqual(preflights[0]?.[1]);
    expect(creates).toHaveLength(2);
    expect(creates[1]?.[1]).toEqual(creates[0]?.[1]);
  });

  it("preserves labelled replay completion without any provider write", async () => {
    const client = fakeClient({ createOrderStatus: "label_created" });
    const port = createOmnipackOrderPaidFulfillmentPort({ client });

    await expect(port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_ID,
      outboxEventId: "event-1",
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: "completed",
      detail: {
        fulfillmentOrderId: FULFILLMENT_ID,
        providerKind: "omnipack",
        status: "label_created",
        replayed: true,
      },
    });

    const rpcNames = client.rpc.mock.calls.map(([name]) => name);
    expect(rpcNames).not.toContain("commerce_fulfillment_enqueue_provider_command");
    expect(rpcNames).not.toContain("omnipack_record_dispatch_ref");
    expect(client.from).not.toHaveBeenCalled();
  });

  it("routes split shipments to manual review before local create", async () => {
    const client = fakeClient({ splitRequired: true });
    const port = createOmnipackOrderPaidFulfillmentPort({ client });

    await expect(port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_ID,
      outboxEventId: "event-1",
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: "manual_review",
      reason: "split_shipment_unsupported",
      detail: { locationCount: 2, holdId: "hold-1" },
    });

    expect(client.rpc).toHaveBeenCalledTimes(1);
    expect(client.rpc.mock.calls[0]?.[0]).toBe("commerce_fulfillment_preflight_split_shipment");
  });

  it("returns retryable without RPCs when already aborted", async () => {
    const client = fakeClient();
    const controller = new AbortController();
    controller.abort();
    const port = createOmnipackOrderPaidFulfillmentPort({ client });

    await expect(port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_ID,
      outboxEventId: "event-1",
      signal: controller.signal,
    })).resolves.toEqual({ kind: "retryable", reason: "outbox_handler_timeout" });
    expect(client.rpc).not.toHaveBeenCalled();
  });

  it("returns retryable when aborted after the idempotent local create", async () => {
    const controller = new AbortController();
    const client = fakeClient({ afterCreate: () => controller.abort() });
    const port = createOmnipackOrderPaidFulfillmentPort({ client });

    await expect(port.ensureFulfilledFromPaidOrder({
      orderUuid: ORDER_ID,
      outboxEventId: "event-1",
      signal: controller.signal,
    })).resolves.toEqual({ kind: "retryable", reason: "outbox_handler_timeout" });
    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "commerce_fulfillment_preflight_split_shipment",
      "commerce_fulfillment_create_order",
    ]);
  });
});

function fakeClient(options: {
  createOrderStatus?: string;
  splitRequired?: boolean;
  afterCreate?: () => void;
} = {}) {
  return {
    rpc: vi.fn(async (name: string, _args: Record<string, unknown>) => {
      if (name === "commerce_fulfillment_preflight_split_shipment") {
        return options.splitRequired
          ? { data: { splitRequired: true, locationCount: 2, holdId: "hold-1" }, error: null }
          : { data: { splitRequired: false, locationCount: 1 }, error: null };
      }
      if (name === "commerce_fulfillment_create_order") {
        options.afterCreate?.();
        return {
          data: { fulfillmentOrderId: FULFILLMENT_ID, status: options.createOrderStatus ?? "created" },
          error: null,
        };
      }
      throw new Error(`unexpected rpc ${name}`);
    }),
    from: vi.fn(() => {
      throw new Error("candidate/provider-ref read forbidden from commerce.order.paid");
    }),
  };
}
