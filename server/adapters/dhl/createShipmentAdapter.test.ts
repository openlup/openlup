import { describe, expect, it, vi } from "vitest";
import {
  createDhlCreateShipmentPort,
  mapLegacyCreateDhlShipmentResponse,
} from "./createShipmentAdapter.js";

describe("DHL create shipment adapter", () => {
  it("maps legacy Edge Function fields to the typed fulfillment contract", () => {
    expect(
      mapLegacyCreateDhlShipmentResponse({
        tracking_number: "TRK-1",
        tracking_url: "https://dhl.example/TRK-1",
        label_url: null,
        dhl_shipment_id: "SHIP-1",
        dhl_shipment_date: "2026-04-29",
      }),
    ).toEqual({
      trackingNumber: "TRK-1",
      trackingUrl: "https://dhl.example/TRK-1",
      labelUrl: null,
      dhlShipmentId: "SHIP-1",
      dhlShipmentDate: "2026-04-29",
    });
  });

  it("maps missing optional legacy fields to nulls and an empty tracking number", () => {
    expect(mapLegacyCreateDhlShipmentResponse({})).toEqual({
      trackingNumber: "",
      trackingUrl: null,
      labelUrl: null,
      dhlShipmentId: null,
      dhlShipmentDate: null,
    });
  });

  it("runs the local create-shipment handler runner with the existing request contract", async () => {
    const runCreateShipment = vi.fn().mockResolvedValue({
      status: 200,
      body: {
        tracking_number: "TRK-2",
        tracking_url: "https://dhl.example/TRK-2",
        label_url: "https://labels.example/TRK-2.pdf",
        dhl_shipment_id: "SHIP-2",
        dhl_shipment_date: "2026-06-02",
      },
    });

    const port = createDhlCreateShipmentPort({
      accessToken: "admin-token",
      env: { SUPABASE_URL: "https://example.supabase.co" },
      runCreateShipment,
    });

    await expect(
      port.createDhlShipment({ testerId: "tester-1", skipStatusChange: true }),
    ).resolves.toEqual({
      trackingNumber: "TRK-2",
      trackingUrl: "https://dhl.example/TRK-2",
      labelUrl: "https://labels.example/TRK-2.pdf",
      dhlShipmentId: "SHIP-2",
      dhlShipmentDate: "2026-06-02",
    });

    expect(runCreateShipment).toHaveBeenCalledWith(
      { accessToken: "admin-token", testerId: "tester-1", skipStatusChange: true },
      { SUPABASE_URL: "https://example.supabase.co" },
    );
  });

  it("throws upstream runner errors", async () => {
    const port = createDhlCreateShipmentPort({
      accessToken: "admin-token",
      runCreateShipment: vi.fn().mockResolvedValue({
        status: 502,
        body: { error: "handler unavailable" },
      }),
    });

    await expect(
      port.createDhlShipment({ testerId: "tester-1", skipStatusChange: false }),
    ).rejects.toThrow("handler unavailable");
  });

  it("throws legacy data.error responses", async () => {
    const port = createDhlCreateShipmentPort({
      accessToken: "admin-token",
      runCreateShipment: vi.fn().mockResolvedValue({ status: 200, body: { error: "DHL rejected" } }),
    });

    await expect(
      port.createDhlShipment({ testerId: "tester-1", skipStatusChange: false }),
    ).rejects.toThrow("DHL rejected");
  });

  it("keeps unrelated DHL port methods unavailable on this route adapter", async () => {
    const port = createDhlCreateShipmentPort({ accessToken: "admin-token", runCreateShipment: vi.fn() });

    await expect(port.getDhlLabel({ testerId: "tester-1" })).rejects.toThrow("Use dhl-label route");
    await expect(port.mergeDhlLabels({ testerIds: ["tester-1"] })).rejects.toThrow(
      "Use dhl-merge-labels route",
    );
    await expect(
      port.bookDhlCourier({
        pickupDate: "2026-06-02",
        pickupTimeFrom: "10:00",
        pickupTimeTo: "12:00",
        additionalInfo: "",
        testerIds: ["tester-1"],
      }),
    ).rejects.toThrow("Use dhl-book-courier route");
  });
});
