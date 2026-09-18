import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { FulfillmentDhlCleanupPort } from "../../../src/domains/fulfillment/ports.js";
import { createFulfillmentDhlCleanupHandler } from "./dhlCleanupHandler.js";

describe("fulfillment DHL cleanup handler", () => {
  it("keeps cleanup available for an existing standalone DHL shipment", async () => {
    const cleanupDhlShipment = vi.fn().mockResolvedValue({
      dhlDeleted: true,
      dhlError: null,
      labelDeleted: true,
      canProceed: true,
    });
    const response = createResponse();
    await createFulfillmentDhlCleanupHandler({
      cleanupPort: { cleanupDhlShipment },
      authorizeAdmin: vi.fn().mockResolvedValue(true),
    })({ method: "POST", body: { trackingNumber: "TRACK-1" } } as VercelRequest, response);

    expect(response.status).toHaveBeenCalledWith(200);
    expect(cleanupDhlShipment).toHaveBeenCalledWith({ trackingNumber: "TRACK-1" });
  });

  it("still keeps the admin authorization boundary", async () => {
    const response = createResponse();
    await createFulfillmentDhlCleanupHandler({
      cleanupPort: { cleanupDhlShipment: vi.fn() },
      authorizeAdmin: vi.fn().mockResolvedValue(false),
    })({ method: "POST", body: { trackingNumber: "TRACK-1" } } as VercelRequest, response);

    expect(response.status).toHaveBeenCalledWith(401);
  });

  it("rejects unsupported methods and malformed recovery requests", async () => {
    const method = createResponse();
    await createHandler(createPortResult({}))(request("GET"), method);

    const invalid = createResponse();
    await createHandler(createPortResult({}))(request("POST", { trackingNumber: "" }), invalid);

    expect(method.status).toHaveBeenCalledWith(405);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it("maps invalid recovery-port responses and provider failures", async () => {
    const invalid = createResponse();
    await createHandler(createPortResult({ dhlDeleted: true }))(
      request("POST", { trackingNumber: "TRACK-1" }),
      invalid,
    );

    const failed = createResponse();
    await createHandler(createPortResult(new Error("DHL down")))(
      request("POST", { trackingNumber: "TRACK-1" }),
      failed,
    );

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });

  it("maps authorization failures to the shared BFF envelope", async () => {
    const response = createResponse();
    await createFulfillmentDhlCleanupHandler({
      cleanupPort: createPortResult({}),
      authorizeAdmin: vi.fn().mockRejectedValue(new Error("Supabase unavailable")),
    })(request("POST", { trackingNumber: "TRACK-1" }), response);

    expect(response.status).toHaveBeenCalledWith(503);
  });
});

function createHandler(cleanupPort: FulfillmentDhlCleanupPort) {
  return createFulfillmentDhlCleanupHandler({
    cleanupPort,
    authorizeAdmin: vi.fn().mockResolvedValue(true),
  });
}

function request(method: string, body: unknown = {}): VercelRequest {
  return { method, body } as unknown as VercelRequest;
}

function createPortResult(result: unknown): FulfillmentDhlCleanupPort {
  return {
    cleanupDhlShipment: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function createResponse(): VercelResponse {
  const response = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as VercelResponse;
  vi.mocked(response.status).mockReturnValue(response);
  vi.mocked(response.json).mockReturnValue(response);
  return response;
}
