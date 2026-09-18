import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import type { FulfillmentLowStockEvidencePort } from "../../../src/domains/fulfillment/ports.js";
import { createFulfillmentLowStockEvidenceHandler } from "./lowStockEvidenceHandler.js";

describe("fulfillment low-stock evidence handler", () => {
  it("reads low-stock evidence through the fulfillment port with the parsed filter", async () => {
    const port = createPort(response());
    const res = createResponse();

    await createHandler({ port })(request("GET", { statusFilter: "resolved" }), res);

    expect(port.getLowStockEvidence).toHaveBeenCalledWith({ statusFilter: "resolved" });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ ok: true, data: response() });
  });

  it("defaults the status filter to open when omitted", async () => {
    const port = createPort(response());
    await createHandler({ port })(request("GET"), createResponse());
    expect(port.getLowStockEvidence).toHaveBeenCalledWith({ statusFilter: "open" });
  });

  it("rejects unsupported methods, missing admin session, and malformed requests", async () => {
    const method = createResponse();
    await createHandler({ port: createPort(response()) })(request("POST"), method);

    const unauthorized = createResponse();
    await createHandler({ port: createPort(response()), authorized: false })(request("GET"), unauthorized);

    const invalid = createResponse();
    await createHandler({ port: createPort(response()) })(request("GET", { statusFilter: "broken" }), invalid);

    expect(method.status).toHaveBeenCalledWith(405);
    expect(unauthorized.status).toHaveBeenCalledWith(401);
    expect(invalid.status).toHaveBeenCalledWith(400);
  });

  it("maps invalid port responses and upstream failures", async () => {
    const invalid = createResponse();
    await createHandler({ port: createPort({ ...response(), openCount: -1 }) })(request("GET"), invalid);

    const failed = createResponse();
    await createHandler({ port: createPort(new Error("Supabase down")) })(request("GET"), failed);

    expect(invalid.status).toHaveBeenCalledWith(502);
    expect(failed.status).toHaveBeenCalledWith(503);
  });

  it("maps authorization failures to the shared BFF envelope", async () => {
    const res = createResponse();
    await createFulfillmentLowStockEvidenceHandler({
      evidencePort: createPort(response()),
      authorizeAdmin: vi.fn().mockRejectedValue(new Error("auth down")),
    })(request("GET"), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });
});

function createHandler({
  port,
  authorized = true,
}: {
  port: FulfillmentLowStockEvidencePort;
  authorized?: boolean;
}) {
  return createFulfillmentLowStockEvidenceHandler({
    evidencePort: port,
    authorizeAdmin: vi.fn().mockResolvedValue(authorized),
  });
}

function createPort(result: unknown): FulfillmentLowStockEvidencePort {
  return {
    getLowStockEvidence: vi.fn().mockImplementation(async () => {
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
    statusFilter: "open" as const,
    openCount: 2,
    items: [
      {
        id: "ev1",
        sku: "__omnipack_stock_sync__",
        thresholdKind: "stale_sync" as const,
        severity: "warning" as const,
        status: "open" as const,
        providerForSaleQuantity: null,
        localAvailableQuantity: null,
        forecastDays: null,
        firstSeenAt: "2026-06-24T10:00:00.000Z",
        lastSeenAt: "2026-06-24T11:00:00.000Z",
        resolvedAt: null,
      },
      {
        id: "ev2",
        sku: "FOOD-CHICKEN-1KG",
        thresholdKind: "safety_stock" as const,
        severity: "critical" as const,
        status: "open" as const,
        providerForSaleQuantity: 0,
        localAvailableQuantity: 3,
        forecastDays: 5,
        firstSeenAt: "2026-06-24T09:00:00.000Z",
        lastSeenAt: "2026-06-24T11:30:00.000Z",
        resolvedAt: null,
      },
    ],
  };
}
