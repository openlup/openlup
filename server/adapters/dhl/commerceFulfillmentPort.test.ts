import { beforeEach, describe, expect, it, vi } from "vitest";
import { deliveryContactFixture } from "../../../src/domains/commerce/omsClient.fixtures.js";

const dhlSoap = vi.hoisted(() => {
  class MockDhlProviderFault extends Error {
    retryable: boolean;

    constructor(message: string, retryable: boolean) {
      super(message);
      this.retryable = retryable;
    }
  }

  return {
    DhlProviderFault: MockDhlProviderFault,
    createDhlShipmentWithLabel: vi.fn(),
    nextWarsawBusinessDate: vi.fn(() => "2026-06-22"),
    parseStreet: vi.fn(() => ({ street: "Main", houseNumber: "10" })),
    sanitizeProviderText: vi.fn((value: unknown) => String(value)),
  };
});

vi.mock("../../infra/dhl/commerceShipmentSoap.js", () => dhlSoap);

import { createDhlOrderPaidFulfillmentPort } from "./commerceFulfillmentPort.js";

describe("DHL paid-order fulfillment adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dhlSoap.createDhlShipmentWithLabel.mockResolvedValue({
      trackingNumber: "DHL123",
      dispatchId: "dispatch-1",
      shipmentDate: "2026-06-22",
      labelPdf: new Uint8Array([1, 2, 3]),
    });
  });

  it("fails closed when DHL credentials are missing", async () => {
    const client = createClient();
    const port = createDhlOrderPaidFulfillmentPort(client as never, {});

    await expect(port.ensureFulfilledFromPaidOrder({
      orderUuid: "order-1",
      outboxEventId: "event-1",
      signal: new AbortController().signal,
    })).resolves.toEqual({ kind: "fatal", reason: "dhl_env_required" });
    expect(client.rpc).not.toHaveBeenCalled();
    expect(dhlSoap.createDhlShipmentWithLabel).not.toHaveBeenCalled();
  });

  it("records the DHL dispatch, label, and fulfillment handoff without exposing raw client contact data in attempt evidence", async () => {
    const client = createClient();
    const port = createDhlOrderPaidFulfillmentPort(client as never, {
      DHL_API_USERNAME: "dhl-user",
      DHL_API_PASSWORD: "dhl-pass",
      DHL_ACCOUNT_NUMBER: "account-1",
    }, { now: () => new Date("2026-06-20T10:00:00.000Z") });

    await expect(port.ensureFulfilledFromPaidOrder({
      orderUuid: "order-1",
      outboxEventId: "event-1",
      signal: new AbortController().signal,
    })).resolves.toEqual({
      kind: "completed",
      detail: { fulfillmentOrderId: "fulfillment-1", status: "handed_over" },
    });

    expect(client.rpc.mock.calls.map(([name]) => name)).toEqual([
      "commerce_fulfillment_preflight_split_shipment",
      "commerce_fulfillment_create_order",
      "commerce_fulfillment_record_provider_attempt",
      "commerce_fulfillment_record_label_created",
      "commerce_fulfillment_mark_handed_over",
    ]);
    expect(dhlSoap.createDhlShipmentWithLabel).toHaveBeenCalledWith(expect.objectContaining({
      auth: { username: "dhl-user", password: "dhl-pass", accountNumber: "account-1" },
      shipmentDate: "2026-06-22",
      receiver: expect.objectContaining({
        name: "Ada Lovelace",
        email: "ada@example.test",
        phone: "+48123123123",
      }),
    }));
    expect(client.storage.from).toHaveBeenCalledWith("dhl-labels");
    expect(client.selects).toContainEqual([
      "commerce_fulfillment_orders",
      "id, order_id, status, shipping_address_snapshot, commerce_orders!commerce_fulfillment_orders_order_id_fkey(order_number), clients!commerce_fulfillment_orders_client_id_fkey(email, first_name, last_name, phone)",
    ]);

    const attemptPayload = client.rpc.mock.calls.find(([name]) => name === "commerce_fulfillment_record_provider_attempt")?.[1] as Record<string, unknown> | undefined;
    expect(attemptPayload).toMatchObject({
      p_idempotency_key: "order-paid-dhl-dispatch:order-1:attempt",
      p_fulfillment_order_id: "fulfillment-1",
      p_provider_kind: "dhl",
      p_status: "succeeded",
      p_request_payload: {
        source: "order-paid-dhl-dispatch",
        providerKind: "dhl",
        orderId: "order-1",
        orderNumber: "V-1001",
        shipmentDate: "2026-06-22",
        service: "dhl_courier_standard",
        deliveryContactRevision: 1,
        deliveryContactSource: "checkout_submission",
      },
      p_response_payload: {
        trackingNumber: "DHL123",
        dispatchId: "dispatch-1",
        labelUploaded: true,
      },
    });
    expect(JSON.stringify(attemptPayload?.p_request_payload)).not.toContain("ada@example.test");
    expect(JSON.stringify(attemptPayload?.p_request_payload)).not.toContain("+48123123123");
  });

  it("fails before the provider call when a present canonical contact is incomplete", async () => {
    const client = createClient({
      snapshot: {
        deliveryContact: {
          schemaVersion: 1, source: "checkout_submission", revision: 1,
          recipientName: "Ada Lovelace", contactEmail: "ada@example.test",
          line1: "Main 10", line2: null, postalCode: "00-001", city: "Warsaw",
          selectedDelivery: null, deliveryInstructions: null, courierInstructions: null,
        },
      },
    });
    const port = createDhlOrderPaidFulfillmentPort(client as never, credentials());

    await expect(run(port)).resolves.toEqual({ kind: "fatal", reason: "dhl_delivery_contact_invalid" });
    expect(dhlSoap.createDhlShipmentWithLabel).not.toHaveBeenCalled();
  });

  it("does not emit a synthetic legacy email", async () => {
    const client = createClient({
      snapshot: { line1: "Main 10", postalCode: "00-001", city: "Warsaw" },
      clients: { email: "placeholder@example.invalid", first_name: "Ada", last_name: "Lovelace", phone: "+48123123123" },
    });
    const port = createDhlOrderPaidFulfillmentPort(client as never, credentials());

    await expect(run(port)).resolves.toEqual({ kind: "fatal", reason: "dhl_receiver_email_required" });
    expect(dhlSoap.createDhlShipmentWithLabel).not.toHaveBeenCalled();
  });

  it("redacts echoed contact data before recording a failed attempt", async () => {
    dhlSoap.createDhlShipmentWithLabel.mockRejectedValueOnce(new dhlSoap.DhlProviderFault(
      "Ada Lovelace ada@example.test +48123123123 Main 10",
      false,
    ));
    const client = createClient();
    const port = createDhlOrderPaidFulfillmentPort(client as never, credentials());

    const result = await run(port);
    const attempt = client.rpc.mock.calls.find(([name]) => name === "commerce_fulfillment_record_provider_attempt")?.[1];
    expect(result).toMatchObject({ kind: "fatal" });
    expect(JSON.stringify(attempt)).not.toContain("Ada Lovelace");
    expect(JSON.stringify(attempt)).not.toContain("ada@example.test");
    expect(JSON.stringify(attempt)).not.toContain("+48123123123");
    expect(JSON.stringify(attempt)).not.toContain("Main 10");
  });
});

function credentials() {
  return { DHL_API_USERNAME: "dhl-user", DHL_API_PASSWORD: "dhl-pass", DHL_ACCOUNT_NUMBER: "account-1" };
}

function run(port: ReturnType<typeof createDhlOrderPaidFulfillmentPort>) {
  return port.ensureFulfilledFromPaidOrder({
    orderUuid: "order-1", outboxEventId: "event-1", signal: new AbortController().signal,
  });
}

function createClient(overrides: {
  snapshot?: Record<string, unknown>;
  clients?: Record<string, unknown>;
} = {}) {
  const selects: Array<[string, string]> = [];
  const rpc = vi.fn(async (name: string, _payload?: Record<string, unknown>) => {
    if (name === "commerce_fulfillment_preflight_split_shipment") {
      return { data: { splitRequired: false, locationCount: 1 }, error: null };
    }
    if (name === "commerce_fulfillment_create_order") {
      return { data: { fulfillmentOrderId: "fulfillment-1", status: "created" }, error: null };
    }
    if (name === "commerce_fulfillment_record_label_created") {
      return { data: { status: "label_created" }, error: null };
    }
    if (name === "commerce_fulfillment_mark_handed_over") {
      return { data: { status: "handed_over" }, error: null };
    }
    return { data: {}, error: null };
  });
  const storage = {
    from: vi.fn(() => ({
      upload: vi.fn(async () => ({ error: null })),
      getPublicUrl: vi.fn(() => ({ data: { publicUrl: "https://labels.example/DHL123.pdf" } })),
    })),
  };

  return {
    rpc,
    from: (table: string) => new QueryBuilder(table, selects, overrides),
    storage,
    selects,
  };
}

class QueryBuilder {
  constructor(
    private readonly table: string,
    private readonly selects: Array<[string, string]>,
    private readonly overrides: { snapshot?: Record<string, unknown>; clients?: Record<string, unknown> },
  ) {}

  select(selector: string) {
    this.selects.push([this.table, selector]);
    return this;
  }

  eq() {
    return this;
  }

  like() {
    return this;
  }

  async maybeSingle() {
    if (this.table === "shipment_external_refs") {
      return { data: null, error: null };
    }
    if (this.table === "commerce_fulfillment_orders") {
      return {
        data: {
          id: "fulfillment-1",
          order_id: "order-1",
          status: "created",
          shipping_address_snapshot: this.overrides.snapshot ?? {
            deliveryContact: deliveryContactFixture({
              recipientName: "Ada Lovelace",
              contactEmail: "ada@example.test",
              contactPhone: "+48123123123",
              line1: "Main 10",
              city: "Warsaw",
            }).canonical,
            line1: "Main 10",
            postalCode: "00-001",
            city: "Warsaw",
            country: "PL",
          },
          commerce_orders: { order_number: "V-1001" },
          clients: this.overrides.clients ?? {
            email: "changed@example.test",
            first_name: "Changed",
            last_name: "Profile",
            phone: "+48999999999",
          },
        },
        error: null,
      };
    }
    return { data: null, error: null };
  }

  then<TResult1 = { data: unknown; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve({
      data: [
        { key: "dhl_shipper_name", value: JSON.stringify("openlup Warehouse") },
        { key: "dhl_shipper_street", value: JSON.stringify("Example Street") },
        { key: "dhl_shipper_house_number", value: JSON.stringify("11") },
      ],
      error: null,
    }).then(onfulfilled, onrejected);
  }
}
