/* eslint-disable @typescript-eslint/no-explicit-any -- fluent Supabase fake mirrors an untyped query boundary. */
import { describe, expect, it, vi } from "vitest";
import {
  FulfillmentPreflightError,
  FulfillmentProviderError,
} from "../../../src/domains/fulfillment/ports.js";
import { carrierTrackingUrl, createCarrierShipmentAction } from "./createShipmentAction.js";
import { CARRIER_NAMESPACE } from "../../infra/dhl/adminDhlSoap.js";
import { CARRIER_PERSISTENCE } from "./courierPickupStore.js";

describe("create carrier shipment action", () => {
  it("fails before provider transport when no access token is supplied", async () => {
    const fetchImpl = vi.fn();
    const action = createCarrierShipmentAction({ client: {} as never, fetchImpl, auth: { username: "u", password: "p", accountNumber: "a" } });
    await expect(action({ accessToken: null, testerId: "tester-1", skipStatusChange: false })).rejects.toBeInstanceOf(FulfillmentPreflightError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("uses exact SOAP actions, stores the private label key, updates status, and emails", async () => {
    const fake = shipmentClient();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(xmlResponse("<shipmentId>TRK-1</shipmentId><dispatchIdentificationNumber>SHIP-1</dispatchIdentificationNumber>"))
      .mockResolvedValueOnce(xmlResponse("<labelData>cGRm</labelData>"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const action = createCarrierShipmentAction({ client: fake.client, fetchImpl, auth: { username: "u", password: "p", accountNumber: "a" }, nextShipmentDate: () => "2026-08-17", now: () => "2026-08-16T08:00:00.000Z", objectKey: () => "tester-1/label.pdf", sendEmail });

    await expect(action({ accessToken: "admin-token", testerId: "tester-1", skipStatusChange: false })).resolves.toEqual({ trackingNumber: "TRK-1", trackingUrl: carrierTrackingUrl("TRK-1"), labelUrl: "tester-1/label.pdf", shipmentDispatchId: "SHIP-1", shipmentDate: "2026-08-17" });
    expect(fetchImpl.mock.calls.map((call) => call[1]?.headers.SOAPAction)).toEqual([
      `${CARRIER_NAMESPACE}#createShipments`,
      `${CARRIER_NAMESPACE}#getLabels`,
    ]);
    expect(fake.upload).toHaveBeenCalledWith("tester-1/label.pdf", expect.any(Uint8Array), { contentType: "application/pdf", upsert: true });
    expect(fake.update).toMatchObject({
      status: "shipped",
      [CARRIER_PERSISTENCE.shipmentDispatchId]: "SHIP-1",
      label_url: "tester-1/label.pdf",
    });
    expect(sendEmail).toHaveBeenCalledWith("tester-1", "shipped", CARRIER_PERSISTENCE.shipmentEmailSource);
  });

  it("treats label/upload and tester update failures as best effort after a real shipment", async () => {
    const fake = shipmentClient({ updateError: "db failed", uploadError: "storage failed" });
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(xmlResponse("<shipmentTrackingNumber>TRK-1</shipmentTrackingNumber>"))
      .mockResolvedValueOnce(xmlResponse("<labelData>cGRm</labelData>"));
    const sendEmail = vi.fn().mockResolvedValue(undefined);
    const action = createCarrierShipmentAction({ client: fake.client, fetchImpl, auth: { username: "u", password: "p", accountNumber: "a" }, nextShipmentDate: () => "2026-08-17", sendEmail });
    await expect(action({ accessToken: "admin-token", testerId: "tester-1", skipStatusChange: false })).resolves.toMatchObject({ trackingNumber: "TRK-1", labelUrl: null, shipmentDispatchId: "TRK-1" });
    expect(sendEmail).toHaveBeenCalled();
  });

  it("makes SOAP faults provider errors before accepting a provider payload", async () => {
    const fake = shipmentClient();
    const action = createCarrierShipmentAction({ client: fake.client, fetchImpl: vi.fn().mockResolvedValue(xmlResponse("<faultstring>bad credentials</faultstring>")), auth: { username: "u", password: "p", accountNumber: "a" } });
    await expect(action({ accessToken: "admin-token", testerId: "tester-1", skipStatusChange: true })).rejects.toBeInstanceOf(FulfillmentProviderError);
  });
});

function shipmentClient(options: { updateError?: string; uploadError?: string } = {}) {
  let update: Record<string, unknown> | null = null;
  const upload = vi.fn().mockResolvedValue({ error: options.uploadError ? { message: options.uploadError } : null });
  const tester = { id: "tester-1", tracking_number: null, street: "Długa 12/4", first_name: "Ada", last_name: "Kot", postal_code: "00-001", city: "Warszawa", country: "Polska", phone: "123", email: "ada@example.test" };
  const client = {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user: { id: "admin-1" } }, error: null }) },
    from(table: string) {
      const query: any = {
        select: () => query,
        eq: () => table === "testers" && update ? Promise.resolve({ error: options.updateError ? { message: options.updateError } : null }) : query,
        maybeSingle: () => Promise.resolve({ data: { id: "admin-1" } }),
        single: () => Promise.resolve({ data: tester, error: null }),
        like: () => Promise.resolve({ data: [] }),
        update: (values: Record<string, unknown>) => { update = values; return query; },
      };
      return query;
    },
    storage: { from: () => ({ upload }) },
  };
  return { client: client as never, upload, get update() { return update; } };
}

function xmlResponse(text: string) { return { ok: true, status: 200, text: async () => text }; }
