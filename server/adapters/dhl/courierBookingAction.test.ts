/* eslint-disable @typescript-eslint/no-explicit-any -- fluent Supabase fake mirrors an untyped query boundary. */
import { describe, expect, it, vi } from "vitest";
import {
  FulfillmentPreflightError,
  FulfillmentProviderError,
} from "../../../src/domains/fulfillment/ports.js";
import { createCarrierPickupBookingAction } from "./courierBookingAction.js";
import {
  CARRIER_NAMESPACE,
  CARRIER_PROVIDER_ID,
} from "../../infra/dhl/adminDhlSoap.js";
import {
  CARRIER_PERSISTENCE,
  CARRIER_SHIPPER_SETTING,
} from "./courierPickupStore.js";

const input = {
  accessToken: "admin-token", pickupDate: "2026-08-17", pickupTimeFrom: "10:00", pickupTimeTo: "12:00",
  additionalInfo: "Gate & bell", testerIds: ["tester-1"],
};
const tester = {
  id: "tester-1",
  status: "packing",
  tracking_number: "TRK-1",
  label_url: "label-1",
  [CARRIER_PERSISTENCE.shipmentDispatchId]: "SHIP-1",
  [CARRIER_PERSISTENCE.shipmentDate]: "2026-08-17",
};

describe("carrier pickup booking action", () => {
  it("does not call the provider without an authenticated actor", async () => {
    const fetchImpl = vi.fn();
    const action = createCarrierPickupBookingAction({ client: {} as never, fetchImpl, auth: { username: "u", password: "p" } });
    await expect(action({ ...input, accessToken: null })).rejects.toBeInstanceOf(FulfillmentPreflightError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("writes golden courier SOAP/evidence, then reconciles and sends email", async () => {
    const fake = bookingClient();
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse("<bookCourierResult><item>ORD-1</item></bookCourierResult>"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const action = createCarrierPickupBookingAction({ client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2026-08-16T08:00:00.000Z", sendEmail });

    await expect(action(input)).resolves.toEqual({ pickupDate: input.pickupDate, pickupTime: "10:00-12:00", shipmentsCount: 1, courierOrderId: "ORD-1" });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: { SOAPAction: `${CARRIER_NAMESPACE}#bookCourier` } });
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain("<shipmentIdList>");
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain("<contactPerson>Warehouse</contactPerson>");
    expect(fake.pickupRows[0]).toMatchObject({ status: "succeeded", courier_order_id: "ORD-1", requested_by: "admin-1" });
    expect(sendEmail).toHaveBeenCalledWith("tester-1", "shipped", CARRIER_PERSISTENCE.bookingEmailSource);
  });

  it("records a fault as non-retryable already_booked provider evidence", async () => {
    const fake = bookingClient();
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse("<faultstring>Po przesyłkę o id SHIP-1 jest już zamówiony kurier</faultstring>"));
    const action = createCarrierPickupBookingAction({ client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2026-08-16T08:00:00.000Z" });

    await expect(action(input)).rejects.toMatchObject({ provider: CARRIER_PROVIDER_ID, retryable: false, details: { reason: "already_booked", blockingShipmentId: "SHIP-1" } } satisfies Partial<FulfillmentProviderError>);
    expect(fake.pickupRows[0]).toMatchObject({ status: "failed", retryable: false, raw_response_excerpt: expect.stringContaining("faultstring") });
  });

  it("fences an unconfirmed HTTP response as indeterminate instead of calling the provider twice", async () => {
    const fake = bookingClient();
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse("upstream timeout", 504));
    const action = createCarrierPickupBookingAction({
      client: fake.client,
      fetchImpl,
      auth: { username: "u", password: "p" },
      now: () => "2026-08-16T08:00:00.000Z",
    });

    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fake.pickupRows[0]).toMatchObject({
      status: "indeterminate",
      raw_response_excerpt: "upstream timeout",
    });

    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps pickup evidence and exposes LOCAL_STATUS_UPDATE_FAILED for normal and recovered paths", async () => {
    const normal = bookingClient({ testerUpdateError: "write failed" });
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse("<orderId>ORD-1</orderId>"));
    const normalAction = createCarrierPickupBookingAction({ client: normal.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2026-08-16T08:00:00.000Z" });
    await expect(normalAction(input)).rejects.toMatchObject({ details: { errorCode: "LOCAL_STATUS_UPDATE_FAILED" } } satisfies Partial<FulfillmentPreflightError>);
    expect(normal.pickupRows[0]?.status).toBe("succeeded");

    const recovery = bookingClient({ existing: { status: "indeterminate", courier_order_id: null, shipments_count: 1, raw_response_excerpt: "<orderId>ORD-1</orderId>" }, testerUpdateError: "write failed" });
    const recoveryAction = createCarrierPickupBookingAction({ client: recovery.client, fetchImpl: vi.fn(), auth: { username: "u", password: "p" }, now: () => "2026-08-16T08:00:00.000Z" });
    await expect(recoveryAction(input)).rejects.toMatchObject({ details: { errorCode: "LOCAL_STATUS_UPDATE_FAILED" } } satisfies Partial<FulfillmentPreflightError>);
    expect(recovery.pickupRows[0]?.status).toBe("succeeded");
  });
});

function bookingClient(options: { existing?: Record<string, unknown> | null; testerUpdateError?: string } = {}) {
  const pickupRows: Record<string, unknown>[] = [];
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null }) },
    from(table: string) {
      let updateValues: Record<string, unknown> | null = null;
      const query: any = {
        select: () => query,
        eq: () => table === "testers" && updateValues ? Promise.resolve({ error: options.testerUpdateError ? { message: options.testerUpdateError } : null }) : query,
        in: () => Promise.resolve({ data: [tester], error: null }),
        like: () => Promise.resolve({ data: [
          { key: CARRIER_SHIPPER_SETTING.contactPerson, value: '"Warehouse"' },
          { key: CARRIER_SHIPPER_SETTING.phone, value: '"123"' },
        ] }),
        maybeSingle: () => Promise.resolve({
          data: table === "admin_users"
            ? { id: "admin-1" }
            : options.existing ?? pickupRows.at(-1) ?? null,
          error: null,
        }),
        update: (values: Record<string, unknown>) => { updateValues = values; return query; },
        upsert: (row: Record<string, unknown>) => {
          if (table === CARRIER_PERSISTENCE.pickupTable) pickupRows.push(row);
          return query;
        },
        single: () => Promise.resolve({ data: { id: "pickup-1" }, error: null }),
      };
      return query;
    },
  };
  return { client: client as never, pickupRows };
}

function xmlResponse(text: string, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}
