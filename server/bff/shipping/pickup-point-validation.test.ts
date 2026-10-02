import { afterEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

const unitComposition = vi.hoisted(() => ({ enabled: true }));
vi.mock("#deployment-route-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#deployment-route-policy")>();
  return {
    ...actual,
    enforceDeploymentRoutePolicy: (...args: Parameters<typeof actual.enforceDeploymentRoutePolicy>) =>
      unitComposition.enabled || actual.enforceDeploymentRoutePolicy(...args),
  };
});

// Deterministic port: no ShipX/InPost network dependency in the route test.
const createPort = vi.hoisted(() => vi.fn(() => ({
  listOptions: async () => [],
  validatePickupPoint: async () => null,
})));
vi.mock("./deliverySelectionFactory.js", () => ({
  createValidatedDeliverySelectionPort: createPort,
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
  it("public default refuses before creating the validation port", async () => {
    unitComposition.enabled = false;
    createPort.mockClear();
    try {
      const { default: handler } = await import("./pickup-point-validation.js");
      const res = createResponse();
      await handler(request("POST", { pointId: "POINT-1", carrierKind: "inpost" }), res as unknown as VercelResponse);
      expect(res.statusCode).toBe(503);
      expect(res.body).toMatchObject({ ok: false, error: { details: { reason: "adopter_policy_required" } } });
      expect(createPort).not.toHaveBeenCalled();
    } finally {
      unitComposition.enabled = true;
    }
  });

});
