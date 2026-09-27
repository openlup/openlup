import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { FulfillmentProviderError } from "../../../../src/domains/fulfillment/ports.js";
import { mapLegacyBookDhlCourierResponse, mapLegacyDhlError } from "../../../adapters/dhl/courierAdapter.js";
import handler from "./dhl-book-courier.js";

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
});

function captureResponse() {
  return {
    statusCode: 200,
    allow: "",
    setHeader(name: string, value: string) { if (name === "Allow") this.allow = value; return this; },
    status(code: number) { this.statusCode = code; return this; },
    json() { return this; },
  };
}
