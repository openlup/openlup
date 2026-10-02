import { describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { FulfillmentProviderError } from "../../../../src/domains/fulfillment/ports.js";
import { mapLegacyBookDhlCourierResponse, mapLegacyDhlError } from "../../../adapters/dhl/courierAdapter.js";
import handler from "./dhl-book-courier.js";

const unitComposition = vi.hoisted(() => ({ enabled: true }));
vi.mock("#deployment-route-policy", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#deployment-route-policy")>();
  return {
    ...actual,
    enforceDeploymentRoutePolicy: (...args: Parameters<typeof actual.enforceDeploymentRoutePolicy>) =>
      unitComposition.enabled || actual.enforceDeploymentRoutePolicy(...args),
  };
});

describe("admin DHL book courier BFF route adapters", () => {
  it("refuses before constructing a standalone DHL port", async () => {
    const source = await readFile(new URL("./dhl-book-courier.ts", import.meta.url), "utf8");
    expect(source).toContain("refuseRetiredDirectDhlAction");
    expect(source).not.toContain("createDhlCourierPort");
  });

  it("keeps the POST-only route guard without resolving provider dependencies", async () => {
    const response = captureResponse();
    await handler({ method: "GET", headers: {}, query: {} } as never, response as never);
    expect(response.statusCode).toBe(405);
    expect(response.allow).toBe("POST");
  });

  it("maps legacy book courier response into the BFF contract", () => {
    expect(
      mapLegacyBookDhlCourierResponse({
        pickup_date: "2026-04-29",
        pickup_time: "10:00-16:00",
        shipments_count: 2,
        courier_order: "ORDER-1",
      }),
    ).toEqual({
      pickupDate: "2026-04-29",
      pickupTime: "10:00-16:00",
      shipmentsCount: 2,
      courierOrderId: "ORDER-1",
    });
  });

  it("preserves sanitized DHL provider details from legacy Edge responses", () => {
    const error = mapLegacyDhlError("DHL: pickup invalid", "DHL_PROVIDER", {
      provider: "dhl",
      operator_message: "DHL: pickup invalid",
      retryable: false,
      support_code: "DHL-20260601222250-ABC123",
      reason: "already_booked",
      blocking_shipment_id: "30701335502",
    });

    expect(error).toBeInstanceOf(FulfillmentProviderError);
    expect(error).toMatchObject({
      operatorMessage: "DHL: pickup invalid",
      retryable: false,
      supportCode: "DHL-20260601222250-ABC123",
      details: {
        reason: "already_booked",
        blockingShipmentId: "30701335502",
      },
    });
  });
  it("public default refuses before touching request data", async () => {
    unitComposition.enabled = false;
    const touched = vi.fn(() => { throw new Error("body read"); });
    const req = { method: "POST", headers: {}, query: {} };
    Object.defineProperty(req, "body", { get: touched });
    const response = captureResponse();
    try {
      await handler(req as never, response as never);
      expect(response.statusCode).toBe(503);
      expect(response.payload).toMatchObject({ ok: false, error: { details: { reason: "adopter_policy_required" } } });
      expect(touched).not.toHaveBeenCalled();
    } finally {
      unitComposition.enabled = true;
    }
  });

});

function captureResponse() {
  return {
    statusCode: 200,
    allow: "",
    payload: undefined as unknown,
    setHeader(name: string, value: string) { if (name === "Allow") this.allow = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json(value: unknown) { this.payload = value; return this; },
  };
}
