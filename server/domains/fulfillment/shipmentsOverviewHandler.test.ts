import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { FulfillmentShipmentsOverviewPort } from "../../../src/domains/fulfillment/ports.js";
import { createFulfillmentShipmentsOverviewHandler } from "./shipmentsOverviewHandler.js";

describe("fulfillment shipments overview handler", () => {
  it("reads the shipments overview through the fulfillment port", async () => {
    const port = createPort(response());
    const res = createResponse();

    await createHandler({ port })(
      request("GET", { shippedFilter: "30d" }),
      res,
    );

    expect(port.getShipmentsOverview).toHaveBeenCalledWith({ shippedFilter: "30d" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: response() });
  });

  it("rejects unsupported methods, missing admin session, and malformed requests", async () => {
    const method = createResponse();
    await createHandler({ port: createPort(response()) })(request("POST"), method);

    const unauthorized = createResponse();
    await createHandler({ port: createPort(response()), authorized: false })(
      request("GET"),
      unauthorized,
    );

    const invalid = createResponse();
    await createHandler({ port: createPort(response()) })(
      request("GET", { shippedFilter: "later" }),
      invalid,
    );

    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it("maps invalid port responses and upstream failures", async () => {
    const invalid = createResponse();
    await createHandler({ port: createPort({ ...response(), shippedToday: -1 }) })(
      request("GET"),
      invalid,
    );

    const failed = createResponse();
    await createHandler({ port: createPort(new Error("Supabase down")) })(
      request("GET"),
      failed,
    );

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });

  it("maps authorization failures to the shared BFF envelope", async () => {
    const res = createResponse();

    await createFulfillmentShipmentsOverviewHandler({
      overviewPort: createPort(response()),
      authorizeAdmin: vi.fn().mockRejectedValue(new Error("auth down")),
    })(request("GET"), res);

    expect(res.status).toHaveBeenCalledWith(503);
  });
});

function createHandler({
  port,
  authorized = true,
}: {
  port: FulfillmentShipmentsOverviewPort;
  authorized?: boolean;
}) {
  return createFulfillmentShipmentsOverviewHandler({
    overviewPort: port,
    authorizeAdmin: vi.fn().mockResolvedValue(authorized),
  });
}

function createPort(result: unknown): FulfillmentShipmentsOverviewPort {
  return {
    getShipmentsOverview: vi.fn().mockImplementation(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  };
}

function request(method: string, query: Record<string, string> = {}): VercelRequest {
  return { method, query } as unknown as VercelRequest;
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

function response() {
  return {
    approved: [{
      id: "a1",
      first_name: "Jan",
      last_name: "Kowalski",
      city: "Warszawa",
      postal_code: "00-001",
      dog_weight_kg: 12,
      cat_weight_kg: null,
      pet_type: "dog",
    }],
    packing: [],
    shippedToday: 1,
    shipped: [],
  };
}
