/* eslint-disable @typescript-eslint/no-explicit-any -- fluent Supabase fake mirrors an untyped query boundary. */
import { describe, expect, it, vi } from "vitest";
import {
  FulfillmentPreflightError,
  FulfillmentProviderError,
} from "../../../src/domains/fulfillment/ports.js";
import { createCarrierPickupBookingAction } from "./courierBookingAction.js";
import {
  CARRIER_DISPLAY_NAME,
  CARRIER_NAMESPACE,
  CARRIER_PROVIDER_ID,
} from "../../infra/dhl/adminDhlSoap.js";
import {
  CARRIER_PERSISTENCE,
  CARRIER_SHIPPER_SETTING,
} from "./courierPickupStore.js";

const input = {
  accessToken: "admin-token", pickupDate: "2040-08-17", pickupTimeFrom: "10:00", pickupTimeTo: "12:00",
  additionalInfo: "Gate & bell", testerIds: ["tester-1"],
};
const tester = {
  id: "tester-1",
  status: "packing",
  tracking_number: "TRK-1",
  label_url: "label-1",
  [CARRIER_PERSISTENCE.shipmentDispatchId]: "SHIP-1",
  [CARRIER_PERSISTENCE.shipmentDate]: "2040-08-17",
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
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(bookingReceipt()));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const action = createCarrierPickupBookingAction({ client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z", sendEmail });

    await expect(action(input)).resolves.toEqual({ pickupDate: input.pickupDate, pickupTime: "10:00-12:00", shipmentsCount: 1, courierOrderId: "ORD-1" });
    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({ headers: { SOAPAction: `${CARRIER_NAMESPACE}#bookCourier` } });
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain("<shipmentIdList>");
    expect(String(fetchImpl.mock.calls[0]?.[1]?.body)).toContain("<contactPerson>Warehouse</contactPerson>");
    expect(fake.pickup()).toMatchObject({ status: "succeeded", courier_order_id: "ORD-1", requested_by: "admin-1" });
    await expect(action(input)).resolves.toMatchObject({ courierOrderId: "ORD-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith("tester-1", "shipped", CARRIER_PERSISTENCE.bookingEmailSource);
  });

  it("records a fault as non-retryable already_booked provider evidence", async () => {
    const fake = bookingClient();
    const message = "Supplemental provider context. ".repeat(12) + "Po przesy&#322;k&#281; o id SHIP-1 jest&#160;już\nzamówiony kurier";
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(clientRefusalEnvelope(message), 500));
    const action = createCarrierPickupBookingAction({ client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z" });

    await expect(action(input)).rejects.toMatchObject({ provider: CARRIER_PROVIDER_ID, retryable: false, details: { reason: "already_booked", blockingShipmentId: "SHIP-1" } } satisfies Partial<FulfillmentProviderError>);
    expect(fake.pickup()).toMatchObject({ status: "failed", retryable: false, raw_response_excerpt: expect.stringContaining("faultstring") });
  });

  it("fences an unconfirmed HTTP response as indeterminate instead of calling the provider twice", async () => {
    const fake = bookingClient();
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse("upstream timeout", 504));
    const action = createCarrierPickupBookingAction({
      client: fake.client,
      fetchImpl,
      auth: { username: "u", password: "p" },
      now: () => "2040-08-16T08:00:00.000Z",
    });

    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fake.pickup()).toMatchObject({
      status: "indeterminate",
      raw_response_excerpt: "upstream timeout",
    });

    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["read", "claim", "shipments"] as const)("stops before the carrier call when the %s write or read fails", async (failure) => {
    const fake = bookingClient({ failure });
    const fetchImpl = vi.fn();
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z",
    });

    await expect(action(input)).rejects.toMatchObject({ details: { errorCode: "LOCAL_PICKUP_STORE_UNAVAILABLE" } });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("admits only one booking when two reads both report no previous attempt", async () => {
    const fake = bookingClient({ concurrentInitialReads: true });
    const response = deferred<ReturnType<typeof xmlResponse>>();
    const started = deferred<void>();
    const fetchImpl = vi.fn(() => {
      started.resolve();
      return response.promise;
    });
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl: fetchImpl as never, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z",
    });

    const bookings = [action(input), action(input)];
    await started.promise;
    expect(fake.pickup()).toMatchObject({ status: "pending" });
    await expect(Promise.race(bookings)).rejects.toMatchObject({ retryable: false });
    response.resolve(xmlResponse(bookingReceipt()));
    expect(await Promise.allSettled(bookings)).toEqual(expect.arrayContaining([{
      status: "fulfilled",
      value: expect.objectContaining({ courierOrderId: "ORD-1" }),
    }]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fences a stale concurrent retry even when the new attempt has already failed", async () => {
    const fault = clientRefusalEnvelope();
    const fake = bookingClient({
      existing: {
        status: "failed", retryable: true, support_code: `${CARRIER_DISPLAY_NAME}-20400816080000-ABC123:pickup-v1:carrier-refused`,
      },
      concurrentInitialReads: true,
      delaySecondRetryUntilOutcome: true,
    });
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(fault));
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z",
    });

    const outcomes = await Promise.allSettled([action(input), action(input)]);
    expect(outcomes).toEqual(expect.arrayContaining([
      { status: "rejected", reason: expect.objectContaining({ retryable: true }) },
      { status: "rejected", reason: expect.objectContaining({ retryable: false }) },
    ]));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retains the claim if the carrier confirms but the outcome write fails", async () => {
    const fake = bookingClient({ failure: "outcome" });
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(bookingReceipt()));
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z",
    });

    await expect(action(input)).rejects.toMatchObject({ retryable: false, message: expect.stringContaining("ORD-1") });
    expect(fake.pickup()).toMatchObject({ status: "pending" });
    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps an ambiguous transport exception out of the retry path", async () => {
    const fake = bookingClient();
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connection lost"));
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z",
    });

    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fake.pickup()).toMatchObject({ status: "indeterminate" });
    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reclaims a refusal classified from the full carrier response", async () => {
    const fault = clientRefusalEnvelope();
    const fetchImpl = vi.fn().mockResolvedValueOnce(xmlResponse(" ".repeat(2_001) + fault, 500))
      .mockResolvedValueOnce(xmlResponse(bookingReceipt()));
    const fake = bookingClient();
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z",
    });

    await expect(action(input)).rejects.toMatchObject({ retryable: true });
    expect(fake.pickup()).toMatchObject({
      status: "failed", raw_response_excerpt: " ".repeat(2_000), support_code: expect.stringMatching(/:pickup-v1:carrier-refused$/u),
    });
    await expect(action(input)).resolves.toMatchObject({ courierOrderId: "ORD-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unwrapped body", "<faultcode>SOAP-ENV:Client</faultcode><faultstring>Invalid pickup window</faultstring>", 200],
    ["gateway response", clientRefusalEnvelope(), 502],
    ["incomplete SOAP", clientRefusalEnvelope().replace("</SOAP-ENV:Body>", ""), 500],
    ["unknown namespace", clientRefusalEnvelope().replaceAll("faultcode", "other:faultcode").replace(
      "<SOAP-ENV:Fault>", '<SOAP-ENV:Fault xmlns:other="urn:unrelated">',
    ), 500],
    ["qualified fault field", clientRefusalEnvelope().replaceAll("faultcode", "SOAP-ENV:faultcode"), 500],
    ["processing instruction", "<?context unsupported?>" + clientRefusalEnvelope(), 500],
    ["unqualified header", clientRefusalEnvelope().replace(
      "<SOAP-ENV:Body>", "<SOAP-ENV:Header><context/></SOAP-ENV:Header><SOAP-ENV:Body>",
    ), 500],
    ["unqualified envelope attribute", clientRefusalEnvelope().replace(
      "<SOAP-ENV:Envelope ", '<SOAP-ENV:Envelope context="unknown" ',
    ), 500],
    ["unqualified fault code", clientRefusalEnvelope().replace("SOAP-ENV:Client", "Client"), 500],
  ])("keeps a %s outside the retry path", async (_case, body, status) => {
    const fake = bookingClient();
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(body, status));
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z",
    });
    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fake.pickup()).toMatchObject({ status: "indeterminate", retryable: false });
    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a legacy failure without recorded dispatch evidence", async () => {
    const legacy = bookingClient({ existing: {
      status: "failed", retryable: true, support_code: `${CARRIER_DISPLAY_NAME}-20400816080000-ABC123`,
      raw_response_excerpt: "<faultcode>SOAP-ENV:Client</faultcode><faultstring>Invalid pickup window</faultstring>",
    } });
    const fetchImpl = vi.fn();
    const action = createCarrierPickupBookingAction({
      client: legacy.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z",
    });
    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("can retry a recorded local failure before dispatch", async () => {
    const fake = bookingClient({ failure: "shipments" });
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(bookingReceipt()));
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z",
    });
    await expect(action(input)).rejects.toMatchObject({ details: { errorCode: "LOCAL_PICKUP_STORE_UNAVAILABLE" } });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(fake.pickup()).toMatchObject({ status: "failed", support_code: expect.stringMatching(/:pickup-v1:not-dispatched$/u) });
    fake.allowShipmentWrite();
    await expect(action(input)).resolves.toMatchObject({ courierOrderId: "ORD-1" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("reconciles a confirmed pickup after its window without another carrier call", async () => {
    const fake = bookingClient({ testerUpdateError: "write failed" });
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(bookingReceipt()));
    const sendEmail = vi.fn();
    const action = (now: string) => createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => now, sendEmail,
    });
    await expect(action("2040-08-16T08:00:00.000Z")(input))
      .rejects.toMatchObject({ details: { errorCode: "LOCAL_STATUS_UPDATE_FAILED" } });
    expect(fake.pickup()?.status).toBe("succeeded");
    fake.allowTesterUpdate();

    const expired = action("2040-08-18T08:00:00.000Z");
    await expect(expired(input)).resolves.toMatchObject({ courierOrderId: "ORD-1" });
    await expect(expired({ ...input, pickupDate: "2040-08-15" })).rejects.toBeInstanceOf(FulfillmentPreflightError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it.each([
    [503, "<orderId>ORD-1</orderId>"],
    [200, `<orderId>ORD-1</orderId>${" ".repeat(2100)}<faultstring>Uncertain result</faultstring>`],
  ])("does not treat an ambiguous %s response excerpt as pickup confirmation", async (status, body) => {
    const fake = bookingClient();
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(body, status));
    const sendEmail = vi.fn();
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z", sendEmail,
    });
    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fake.pickup()?.status).toBe("indeterminate");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each([
    ["an isolated result", "<orderId>ORD-1</orderId>"],
    ["a comment", bookingReceipt().replace("<item>ORD-1</item>", "<!-- <item>ORD-1</item> -->")],
    ["incomplete XML", bookingReceipt().replace("</SOAP-ENV:Body>", "")],
    ["inconsistent fault detail", clientRefusalEnvelope("<![CDATA[Incomplete]]>").replace(
      "</SOAP-ENV:Fault>", "<detail><orderId>ORD-1</orderId></detail></SOAP-ENV:Fault>",
    )],
  ])("does not reconcile a booking from %s", async (_case, response) => {
    const fake = bookingClient();
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(response));
    const sendEmail = vi.fn();
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z", sendEmail,
    });
    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fake.pickup()).toMatchObject({ status: "indeterminate" });
    expect(fake.testerStatus()).toBe("packing");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("keeps legacy success without recorded confirmation out of local reconciliation", async () => {
    const fake = bookingClient({ existing: {
      status: "succeeded", retryable: null, courier_order_id: "ORD-1",
      shipments_count: 1, raw_response_excerpt: "<orderId>ORD-1</orderId>",
    } });
    const fetchImpl = vi.fn();
    const sendEmail = vi.fn();
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-18T08:00:00.000Z", sendEmail,
    });
    await expect(action(input)).rejects.toMatchObject({ retryable: false });
    expect(fake.testerStatus()).toBe("packing");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("keeps a later status for the same shipment when reconciliation loses a race", async () => {
    const fake = bookingClient({ statusBeforeUpdate: "delivered" });
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(bookingReceipt()));
    const sendEmail = vi.fn();
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z", sendEmail,
    });
    await expect(action(input)).rejects.toMatchObject({ details: { errorCode: "LOCAL_STATUS_UPDATE_FAILED" } });
    expect(fake.testerStatus()).toBe("delivered");
    expect(fake.pickup()?.status).toBe("succeeded");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it.each(["before replay", "before update"])("refuses to mark a replacement shipment shipped %s", async when => {
    const fake = bookingClient({ testerUpdateError: "write failed" });
    const fetchImpl = vi.fn().mockResolvedValue(xmlResponse(bookingReceipt()));
    const sendEmail = vi.fn();
    const action = createCarrierPickupBookingAction({
      client: fake.client, fetchImpl, auth: { username: "u", password: "p" }, now: () => "2040-08-16T08:00:00.000Z", sendEmail,
    });
    await expect(action(input)).rejects.toMatchObject({ details: { errorCode: "LOCAL_STATUS_UPDATE_FAILED" } });
    fake.allowTesterUpdate();
    if (when === "before replay") fake.replaceShipment();
    else fake.replaceBeforeUpdate();
    await expect(action(input)).rejects.toThrow();
    expect(fake.testerStatus()).toBe("packing");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

function bookingClient(options: {
  existing?: Record<string, unknown>;
  testerUpdateError?: string;
  failure?: "read" | "claim" | "shipments" | "outcome";
  concurrentInitialReads?: boolean;
  delaySecondRetryUntilOutcome?: boolean;
  statusBeforeUpdate?: string;
} = {}) {
  const pendingRow = { id: "pickup-1", updated_at: "2040-08-16T08:00:00Z" };
  let pickup = options.existing ? { ...pendingRow, ...options.existing } : null;
  let currentTester = { ...tester };
  let snapshots: Record<string, unknown>[] = [];
  let testerUpdateError = options.testerUpdateError;
  let shipmentWriteFails = options.failure === "shipments";
  let replaceBeforeUpdate = false;
  const replaceShipment = () => { currentTester = { ...currentTester, [CARRIER_PERSISTENCE.shipmentDispatchId]: "REPLACEMENT" }; };
  let reads = 0;
  let retries = 0;
  const firstOutcome = deferred<void>();
  const bothRead = deferred<void>();
  const error = { message: "write unavailable" };
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null }) },
    from(table: string) {
      const filters = new Map<string, unknown>();
      let updateValues: Record<string, unknown> | null = null;
      let insertValues: Record<string, unknown> | null = null;
      const query: any = {
        select: () => query,
        eq: (field: string, value: unknown) => {
          if (table === CARRIER_PERSISTENCE.pickupShipmentTable) {
            return Promise.resolve({ data: snapshots, error: null });
          }
          filters.set(field, value);
          return query;
        },
        in: () => Promise.resolve({ data: [{ ...currentTester }], error: null }),
        like: () => Promise.resolve({ data: [
          { key: CARRIER_SHIPPER_SETTING.contactPerson, value: '"Warehouse"' },
          { key: CARRIER_SHIPPER_SETTING.phone, value: '"123"' },
        ] }),
        async maybeSingle() {
          if (table === "admin_users") return { data: { id: "admin-1" }, error: null };
          if (table === "testers" && updateValues) {
            if (replaceBeforeUpdate) replaceShipment();
            if (options.statusBeforeUpdate) currentTester = { ...currentTester, status: options.statusBeforeUpdate };
            if (testerUpdateError) return { data: null, error };
            if (![...filters].every(([field, value]) => Object.is(currentTester[field as keyof typeof tester], value))) {
              return { data: null, error: null };
            }
            currentTester = { ...currentTester, status: String(updateValues.status) };
            return { data: { id: currentTester.id }, error: null };
          }
          if (insertValues) {
            if (options.failure === "claim") return { data: null, error };
            if (pickup) return { data: null, error: null };
            pickup = { ...pendingRow, ...insertValues };
            return { data: pickup, error: null };
          }
          if (updateValues) {
            const claiming = updateValues.status === "pending";
            if (claiming && options.delaySecondRetryUntilOutcome && ++retries === 2) await firstOutcome.promise;
            if (options.failure === "outcome") return { data: null, error };
            if (!pickup || ![...filters].every(([field, value]) => Object.is((pickup as Record<string, unknown>)[field], value))) {
              return { data: null, error: null };
            }
            pickup = { ...pickup, ...updateValues };
            if (!claiming) firstOutcome.resolve();
            return { data: pickup, error: null };
          }
          const pickupKey = (pickup as Record<string, unknown> | null)?.idempotency_key;
          const matchesKey = pickupKey === undefined || pickupKey === filters.get(CARRIER_PERSISTENCE.idempotencyKey);
          const result = { data: matchesKey ? pickup : null, error: options.failure === "read" ? error : null };
          if (options.concurrentInitialReads && ++reads <= 2) {
            if (reads === 2) bothRead.resolve();
            await bothRead.promise;
          }
          return result;
        },
        update: (values: Record<string, unknown>) => { updateValues = values; return query; },
        upsert: (row: Record<string, unknown>, conflict: { ignoreDuplicates?: boolean }) => {
          if (table === CARRIER_PERSISTENCE.pickupShipmentTable) {
            if (shipmentWriteFails) return Promise.resolve({ error });
            if (!Array.isArray(row)) throw new Error("Expected snapshot rows");
            snapshots = row;
            return Promise.resolve({ error: null });
          }
          expect(conflict).toEqual({ onConflict: CARRIER_PERSISTENCE.idempotencyKey, ignoreDuplicates: true });
          insertValues = row;
          return query;
        },
      };
      return query;
    },
  };
  return {
    client: client as never,
    pickup: () => pickup as Record<string, unknown> | null,
    testerStatus: () => currentTester.status,
    allowTesterUpdate: () => { testerUpdateError = undefined; },
    allowShipmentWrite: () => { shipmentWriteFails = false; },
    replaceShipment,
    replaceBeforeUpdate: () => { replaceBeforeUpdate = true; },
  };
}

function xmlResponse(text: string, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

function clientRefusalEnvelope(reason = "Invalid pickup window") {
  return `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/">
    <SOAP-ENV:Body><SOAP-ENV:Fault>
      <faultcode>SOAP-ENV:Client</faultcode><faultstring>${reason}</faultstring>
    </SOAP-ENV:Fault></SOAP-ENV:Body>
  </SOAP-ENV:Envelope>`;
}

// bookCourierOut in the provider's WebAPI v2 WSDL binds this SOAP Body result.
function bookingReceipt() {
  return `<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:api="${CARRIER_NAMESPACE}">
    <SOAP-ENV:Body><api:bookCourierResponse>
      <bookCourierResult><item>ORD-1</item></bookCourierResult>
    </api:bookCourierResponse></SOAP-ENV:Body>
  </SOAP-ENV:Envelope>`;
}
