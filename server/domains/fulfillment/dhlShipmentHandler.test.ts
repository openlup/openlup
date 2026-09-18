import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { FulfillmentDhlShipmentPort } from "../../../src/domains/fulfillment/ports.js";
import {
  createFulfillmentDhlBookCourierHandler,
  createFulfillmentDhlClearShipmentStateHandler,
  createFulfillmentDhlCreateShipmentHandler,
  createFulfillmentDhlLabelHandler,
  createFulfillmentDhlMergeLabelsHandler,
} from "./dhlShipmentHandler.js";

describe("fulfillment DHL shipment handlers", () => {
  it("fails closed before a new standalone DHL obligation can leave the process", async () => {
    const port = createPort();
    const handlers = [
      createFulfillmentDhlCreateShipmentHandler,
      createFulfillmentDhlBookCourierHandler,
    ];

    for (const factory of handlers) {
      const response = createResponse();
      await factory({ shipmentPort: port, authorizeAdmin: vi.fn().mockResolvedValue(true) })(
        { method: "POST", body: { testerId: "tester-1", trackingNumber: "TRACK-1" } } as VercelRequest,
        response,
      );
      expect(response.status).toHaveBeenCalledWith(404);
      expect(response.json).toHaveBeenCalledWith(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: "NOT_FOUND" }),
      }));
    }

    expect(port.createDhlShipment).not.toHaveBeenCalled();
    expect(port.bookDhlCourier).not.toHaveBeenCalled();
  });

  it("keeps historical label recovery available", async () => {
    const port = createPort();
    vi.mocked(port.getDhlLabel).mockResolvedValue({ labelUrl: "https://labels.example/TRACK-1.pdf" });
    const response = createResponse();
    await createFulfillmentDhlLabelHandler({
      shipmentPort: port,
      authorizeAdmin: vi.fn().mockResolvedValue(true),
    })({ method: "POST", body: { testerId: "tester-1" } } as VercelRequest, response);

    expect(port.getDhlLabel).toHaveBeenCalledWith({ testerId: "tester-1" });
    expect(response.status).toHaveBeenCalledWith(200);
  });

  it("keeps historical label merge and local-state clearing available", async () => {
    const port = createPort();
    vi.mocked(port.mergeDhlLabels).mockResolvedValue({ pdfBase64: "PDFDATA", labelCount: 2 });
    vi.mocked(port.clearDhlShipmentState).mockResolvedValue({ testerId: "tester-1", cleared: true });

    const mergeResponse = createResponse();
    await createFulfillmentDhlMergeLabelsHandler({
      shipmentPort: port,
      authorizeAdmin: vi.fn().mockResolvedValue(true),
    })({ method: "POST", body: { testerIds: ["tester-1", "tester-2"] } } as VercelRequest, mergeResponse);

    expect(port.mergeDhlLabels).toHaveBeenCalledWith({ testerIds: ["tester-1", "tester-2"] });
    expect(mergeResponse.status).toHaveBeenCalledWith(200);

    const clearResponse = createResponse();
    await createFulfillmentDhlClearShipmentStateHandler({
      shipmentPort: port,
      authorizeAdmin: vi.fn().mockResolvedValue(true),
    })({ method: "POST", body: { testerId: " tester-1 " } } as VercelRequest, clearResponse);

    expect(port.clearDhlShipmentState).toHaveBeenCalledWith({ testerId: "tester-1" });
    expect(clearResponse.status).toHaveBeenCalledWith(200);
  });

  it("still rejects unauthorized requests before revealing retirement", async () => {
    const response = createResponse();
    await createFulfillmentDhlCreateShipmentHandler({
      shipmentPort: createPort(),
      authorizeAdmin: vi.fn().mockResolvedValue(false),
    })({ method: "POST", body: { testerId: "tester-1" } } as VercelRequest, response);

    expect(response.status).toHaveBeenCalledWith(401);
  });

  it("preserves method, validation, authorization-failure, and invalid-response errors on recovery seams", async () => {
    const port = createPort();
    const methodResponse = createResponse();
    await createFulfillmentDhlLabelHandler({
      shipmentPort: port,
      authorizeAdmin: vi.fn().mockResolvedValue(true),
    })({ method: "GET", body: {} } as VercelRequest, methodResponse);
    expect(methodResponse.status).toHaveBeenCalledWith(405);

    const invalidRequestResponse = createResponse();
    await createFulfillmentDhlLabelHandler({
      shipmentPort: port,
      authorizeAdmin: vi.fn().mockResolvedValue(true),
    })({ method: "POST", body: {} } as VercelRequest, invalidRequestResponse);
    expect(invalidRequestResponse.status).toHaveBeenCalledWith(400);

    const invalidPortResponse = createResponse();
    vi.mocked(port.mergeDhlLabels).mockResolvedValue({ pdfBase64: "", labelCount: 0 });
    await createFulfillmentDhlMergeLabelsHandler({
      shipmentPort: port,
      authorizeAdmin: vi.fn().mockResolvedValue(true),
    })({ method: "POST", body: { testerIds: ["tester-1"] } } as VercelRequest, invalidPortResponse);
    expect(invalidPortResponse.status).toHaveBeenCalledWith(502);

    const authFailureResponse = createResponse();
    await createFulfillmentDhlLabelHandler({
      shipmentPort: port,
      authorizeAdmin: vi.fn().mockRejectedValue(new Error("auth down")),
    })({ method: "POST", body: { testerId: "tester-1" } } as VercelRequest, authFailureResponse);
    expect(authFailureResponse.status).toHaveBeenCalledWith(503);
  });
});

function createPort(): FulfillmentDhlShipmentPort {
  return {
    createDhlShipment: vi.fn(),
    getDhlLabel: vi.fn(),
    mergeDhlLabels: vi.fn(),
    bookDhlCourier: vi.fn(),
    repairDhlCourierPickup: vi.fn(),
    clearDhlShipmentState: vi.fn(),
  };
}

function createResponse(): VercelResponse {
  const response = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(response.status).mockReturnValue(response);
  vi.mocked(response.json).mockReturnValue(response);
  return response;
}
