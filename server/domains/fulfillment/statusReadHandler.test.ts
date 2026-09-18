import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  FulfillmentNotFoundError,
  type FulfillmentReadPort,
} from "../../../src/domains/fulfillment/ports.js";
import { createFulfillmentStatusReadHandler } from "./statusReadHandler.js";

describe("fulfillment BFF status-read handler", () => {
  it("reads shipment status through the fulfillment port", async () => {
    const readPort = createPort({
      shipment: {
        id: "legacy:testers:tester-1:shipment",
        provider: "dhl",
        status: "in_transit",
        trackingNumber: "TRK-1",
        trackingUrl: "https://www.dhl.com/pl-pl/home/tracking/tracking-parcel.html?tracking-id=TRK-1",
        statusUpdatedAt: "2026-05-29T10:00:00.000Z",
        deliveredAt: null,
      },
    });
    const res = createResponse();

    await createHandler({ readPort })(
      request("GET", { trackingNumber: "TRK-1" }),
      res,
    );

    expect(readPort.getShipmentStatus).toHaveBeenCalledWith({ trackingNumber: "TRK-1" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        shipment: expect.objectContaining({
          provider: "dhl",
          status: "in_transit",
          trackingNumber: "TRK-1",
        }),
      },
    });
  });

  it("does not reject shipment status reads with Supabase UTC offset timestamps", async () => {
    const result = {
      shipment: {
        id: "legacy:testers:tester-1:shipment",
        provider: "dhl" as const,
        status: "delivered" as const,
        trackingNumber: "TRK-1",
        trackingUrl: "https://www.dhl.com/pl-pl/home/tracking/tracking-parcel.html?tracking-id=TRK-1",
        statusUpdatedAt: "2026-05-29T10:00:00+00:00",
        deliveredAt: "2026-05-30T10:00:00+00:00",
      },
    };
    const res = createResponse();

    await createHandler({ readPort: createPort(result) })(
      request("GET", { trackingNumber: "TRK-1" }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: result });
    expect(res.json).not.toHaveBeenCalledWith({
      ok: false,
      error: expect.objectContaining({ code: "INVALID_RESPONSE" }),
    });
  });

  it("rejects non-read methods and malformed queries", async () => {
    const method = createResponse();
    await createHandler({ readPort: createPort({}) })(
      request("POST", {}),
      method,
    );

    const invalid = createResponse();
    await createHandler({ readPort: createPort({}) })(
      request("GET", {}),
      invalid,
    );

    expect(method.setHeader).toHaveBeenCalledWith("Allow", "GET");
    expect(method.status).toHaveBeenCalledWith(405);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it("requires admin authorization", async () => {
    const readPort = createPort({});
    const res = createResponse();

    await createHandler({ readPort, authorized: false })(
      request("GET", { trackingNumber: "TRK-1" }),
      res,
    );

    expect(readPort.getShipmentStatus).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it("maps not found and upstream failures to BFF errors", async () => {
    const missing = createResponse();
    await createHandler({ readPort: createPort(new FulfillmentNotFoundError("missing")) })(
      request("GET", { trackingNumber: "TRK-1" }),
      missing,
    );

    const failed = createResponse();
    await createHandler({ readPort: createPort(new Error("DHL unavailable")) })(
      request("GET", { trackingNumber: "TRK-1" }),
      failed,
    );

    expect(missing.status).toHaveBeenCalledWith(404);
    expect(failed.status).toHaveBeenCalledWith(503);
  });
});

function createHandler({
  readPort,
  authorized = true,
}: {
  readPort: FulfillmentReadPort;
  authorized?: boolean;
}) {
  return createFulfillmentStatusReadHandler({
    readPort,
    authorizeAdmin: vi.fn().mockResolvedValue(authorized),
  });
}

function request(
  method: string,
  query: Record<string, string | string[] | undefined>,
): VercelRequest {
  return { method, query } as unknown as VercelRequest;
}

function createPort(result: unknown): FulfillmentReadPort {
  return {
    getShipmentStatus: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;

  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}
