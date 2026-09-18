import { describe, expect, it, vi } from "vitest";
import { FulfillmentPreflightError, FulfillmentProviderError } from "../../../src/domains/fulfillment/ports.js";
import {
  createDhlCourierPort,
  mapLegacyBookDhlCourierResponse,
  mapLegacyDhlError,
} from "./courierAdapter.js";

describe("DHL courier adapter", () => {
  it("maps legacy courier response into the BFF contract", () => {
    expect(
      mapLegacyBookDhlCourierResponse({
        pickup_date: "2026-06-02",
        pickup_time: "10:00-12:00",
        shipments_count: 2,
        courier_order: "ORDER-1",
      }),
    ).toEqual({
      pickupDate: "2026-06-02",
      pickupTime: "10:00-12:00",
      shipmentsCount: 2,
      courierOrderId: "ORDER-1",
    });
  });

  it("maps missing courier fields to empty defaults", () => {
    expect(mapLegacyBookDhlCourierResponse({})).toEqual({
      pickupDate: "",
      pickupTime: "",
      shipmentsCount: 0,
      courierOrderId: null,
    });
  });

  it("runs the local courier handler runner with the existing snake_case body", async () => {
    const runCourier = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        pickup_date: "2026-06-02",
        pickup_time: "10:00-12:00",
        shipments_count: 2,
        courier_order: "ORDER-1",
      },
    });
    const port = createDhlCourierPort({
      accessToken: "admin-token",
      env: { SUPABASE_URL: "https://example.supabase.co" },
      runCourier,
    });

    await expect(
      port.bookDhlCourier({
        pickupDate: "2026-06-02",
        pickupTimeFrom: "10:00",
        pickupTimeTo: "12:00",
        additionalInfo: "Gate code",
        testerIds: ["tester-1", "tester-2"],
      }),
    ).resolves.toEqual({
      pickupDate: "2026-06-02",
      pickupTime: "10:00-12:00",
      shipmentsCount: 2,
      courierOrderId: "ORDER-1",
    });

    expect(runCourier).toHaveBeenCalledWith(
      {
        accessToken: "admin-token",
        body: {
          pickup_date: "2026-06-02",
          pickup_time_from: "10:00",
          pickup_time_to: "12:00",
          additional_info: "Gate code",
          tester_ids: ["tester-1", "tester-2"],
        },
      },
      { SUPABASE_URL: "https://example.supabase.co" },
    );
  });

  it("throws upstream runner errors", async () => {
    const port = createDhlCourierPort({
      accessToken: "admin-token",
      runCourier: vi.fn().mockResolvedValue({ status: 502, body: { error: "handler down" } }),
    });

    await expect(
      port.bookDhlCourier({
        pickupDate: "2026-06-02",
        pickupTimeFrom: "10:00",
        pickupTimeTo: "12:00",
        additionalInfo: "",
        testerIds: ["tester-1"],
      }),
    ).rejects.toThrow("handler down");
  });

  it("maps preflight legacy errors to FulfillmentPreflightError", () => {
    const error = mapLegacyDhlError("<b>mixed dates</b>", "MIXED_DATES");

    expect(error).toBeInstanceOf(FulfillmentPreflightError);
    expect(error.message).toBe("mixed dates");
  });

  it("maps provider legacy errors to sanitized FulfillmentProviderError", () => {
    const error = mapLegacyDhlError("login=user password=secret <xml>bad</xml>", "DHL_PROVIDER", {
      operator_message: "password=secret already booked",
      retryable: false,
      support_code: "DHL-409",
      reason: "already_booked",
      blocking_shipment_id: "SHIP-1",
    });

    expect(error).toBeInstanceOf(FulfillmentProviderError);
    expect(error.message).toBe("password: [redacted] already booked");
    expect((error as FulfillmentProviderError).provider).toBe("dhl");
    expect((error as FulfillmentProviderError).providerMessage).toBe(
      "login: [redacted] password: [redacted] bad",
    );
    expect((error as FulfillmentProviderError).retryable).toBe(false);
    expect((error as FulfillmentProviderError).supportCode).toBe("DHL-409");
    expect((error as FulfillmentProviderError).details).toEqual({
      reason: "already_booked",
      blockingShipmentId: "SHIP-1",
    });
  });

  it("keeps unrelated DHL port methods unavailable on this route adapter", async () => {
    const port = createDhlCourierPort({ accessToken: "admin-token", runCourier: vi.fn() });

    await expect(port.getDhlLabel({ testerId: "tester-1" })).rejects.toThrow("Use dhl-label route");
    await expect(port.mergeDhlLabels({ testerIds: ["tester-1"] })).rejects.toThrow(
      "Use dhl-merge-labels route",
    );
    await expect(
      port.createDhlShipment({ testerId: "tester-1", skipStatusChange: false }),
    ).rejects.toThrow("Use dhl-create-shipment route");
  });
});
