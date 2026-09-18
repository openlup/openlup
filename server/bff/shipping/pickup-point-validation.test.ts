import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

// Deterministic port: no ShipX/InPost network dependency in the route test.
vi.mock("./deliverySelectionFactory.js", () => ({
  createValidatedDeliverySelectionPort: () => ({
    listOptions: async () => [],
    validatePickupPoint: async () => null,
  }),
}));

function request(method: string, body: unknown): VercelRequest {
  return { method, query: {}, body, headers: {} } as unknown as VercelRequest;
}

function createResponse() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn(),
    status: vi.fn((code: number) => {
      res.statusCode = code;
      return res as unknown as VercelResponse;
    }),
    json: vi.fn((body: unknown) => {
      res.body = body;
      return res as unknown as VercelResponse;
    }),
    end: vi.fn(() => res as unknown as VercelResponse),
  };
  return res;
}

describe("pickup-point-validation route", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("returns the validation contract on a valid POST (unknown point => valid:false)", async () => {
    const { default: handler } = await import("./pickup-point-validation.js");
    const res = createResponse();

    await handler(request("POST", { pointId: "KRA010", carrierKind: "inpost" }), res as unknown as VercelResponse);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, data: { valid: false, pickupPoint: null } });
  });

  it("rejects a non-POST method with 405", async () => {
    const { default: handler } = await import("./pickup-point-validation.js");
    const res = createResponse();

    await handler(request("GET", {}), res as unknown as VercelResponse);

    expect(res.statusCode).toBe(405);
  });
});
