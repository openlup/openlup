import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { FulfillmentDhlShipmentPort } from "../../../src/domains/fulfillment/ports.js";
import { createFulfillmentDhlRepairCourierPickupHandler } from "./dhlShipmentHandler.js";

describe("fulfillment DHL repair courier pickup handler", () => {
  it("reads a courier pickup diagnosis through the fulfillment port", async () => {
    const port = createPort();
    const res = createResponse();

    await createFulfillmentDhlRepairCourierPickupHandler({
      shipmentPort: port,
      authorizeAdmin: vi.fn().mockResolvedValue(true),
    })(request("POST", {
      pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
      mode: "dry_run",
      sendEmails: false,
      expectedCourierOrderId: "877230626WWW",
      expectedShipmentCount: 38,
    }), res);

    expect(port.repairDhlCourierPickup).toHaveBeenCalledWith({
      pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
      mode: "dry_run",
      sendEmails: false,
      expectedCourierOrderId: "877230626WWW",
      expectedShipmentCount: 38,
    });
    expect(res.jsonPayload).toEqual({
      ok: true,
      data: {
        mode: "dry_run",
        pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
        pickupStatus: "indeterminate",
        courierOrderId: "877230626WWW",
        recordedShipmentsCount: 38,
        linkedShipmentsCount: 38,
        expectedShipmentsCount: 38,
        canCommit: false,
        committed: false,
        alreadyRepaired: false,
        testerStatuses: [],
        emailDedupPreview: { sendEmails: false, alreadySentCount: 0, requestCount: 0 },
      },
    });
  });

  it.each([
    { mode: "commit", sendEmails: false },
    { mode: "dry_run", sendEmails: true },
    { mode: "dry_run" },
  ])("rejects retired mutation %# before authorization or port IO", async (body) => {
    const port = createPort();
    const authorizeAdmin = vi.fn().mockResolvedValue(true);
    const res = createResponse();
    await createFulfillmentDhlRepairCourierPickupHandler({ shipmentPort: port, authorizeAdmin })(
      request("POST", body), res,
    );
    expect(res.statusCode).toBe(404);
    expect(authorizeAdmin).not.toHaveBeenCalled();
    expect(port.repairDhlCourierPickup).not.toHaveBeenCalled();
  });
});

function createPort(): FulfillmentDhlShipmentPort {
  return {
    createDhlShipment: vi.fn().mockResolvedValue({}),
    getDhlLabel: vi.fn().mockResolvedValue({}),
    mergeDhlLabels: vi.fn().mockResolvedValue({}),
    bookDhlCourier: vi.fn().mockResolvedValue({}),
    repairDhlCourierPickup: vi.fn().mockResolvedValue({
      mode: "dry_run",
      pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
      pickupStatus: "indeterminate",
      courierOrderId: "877230626WWW",
      recordedShipmentsCount: 38,
      linkedShipmentsCount: 38,
      expectedShipmentsCount: 38,
      canCommit: false,
      committed: false,
      alreadyRepaired: false,
      testerStatuses: [],
      emailDedupPreview: { sendEmails: false, alreadySentCount: 0, requestCount: 0 },
    }),
    clearDhlShipmentState: vi.fn().mockResolvedValue({}),
  };
}

function request(method: string, body: unknown = {}): VercelRequest {
  return { method, body } as unknown as VercelRequest;
}

function createResponse(): VercelResponse & { statusCode: number; jsonPayload: unknown } {
  const res = {
    statusCode: 200,
    jsonPayload: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.jsonPayload = payload;
      return res;
    },
    setHeader: vi.fn(),
    end: vi.fn(),
  } as unknown as VercelResponse & { statusCode: number; jsonPayload: unknown };

  return res;
}
