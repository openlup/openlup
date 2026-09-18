import { describe, expect, it, vi } from "vitest";
import { BffClientError } from "@/lib/bff/client";
import {
  bookAdminDhlCourier,
  clearAdminDhlShipmentState,
  createAdminDhlShipment,
  getAdminDhlLabel,
  mergeAdminDhlLabels,
  repairAdminDhlCourierPickup,
} from "./adminDhlShipmentClient";

describe("admin DHL shipment client", () => {
  it("creates shipments and fetches labels with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            trackingNumber: "TRK-1",
            trackingUrl: "https://dhl.example/TRK-1",
            labelUrl: null,
            dhlShipmentId: "SHIP-1",
            dhlShipmentDate: "2026-04-29",
          },
        }),
    });

    await createAdminDhlShipment(
      "admin-token",
      { testerId: "tester-1", skipStatusChange: true },
      { fetcher },
    );

    const [createPath, createInit] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(createPath).toBe("/api/bff/admin/fulfillment/dhl-create-shipment");
    expect(new Headers(createInit.headers).get("Authorization")).toBe("Bearer admin-token");
    expect(JSON.parse(String(createInit.body))).toEqual({
      testerId: "tester-1",
      skipStatusChange: true,
    });

    fetcher.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ ok: true, data: { labelUrl: "https://cdn.example/TRK-1.pdf" } }),
    });
    await getAdminDhlLabel("admin-token", { testerId: "tester-1" }, { fetcher });
    expect(fetcher.mock.calls[1][0]).toBe("/api/bff/admin/fulfillment/dhl-label");

    fetcher.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ ok: true, data: { pdfBase64: "PDFDATA", labelCount: 2 } }),
    });
    await mergeAdminDhlLabels("admin-token", { testerIds: ["tester-1", "tester-2"] }, { fetcher });
    const [mergePath, mergeInit] = fetcher.mock.calls[2] as [string, RequestInit];
    expect(mergePath).toBe("/api/bff/admin/fulfillment/dhl-merge-labels");
    expect(JSON.parse(String(mergeInit.body))).toEqual({ testerIds: ["tester-1", "tester-2"] });

    fetcher.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({
        ok: true,
        data: {
          pickupDate: "2026-04-29",
          pickupTime: "10:00-16:00",
          shipmentsCount: 2,
          courierOrderId: "ORDER-1",
        },
      }),
    });
    await bookAdminDhlCourier(
      "admin-token",
      {
        pickupDate: "2026-04-29",
        pickupTimeFrom: "10:00",
        pickupTimeTo: "16:00",
        testerIds: ["tester-1", "tester-2"],
      },
      { fetcher },
    );
    expect(fetcher.mock.calls[3][0]).toBe("/api/bff/admin/fulfillment/dhl-book-courier");

    fetcher.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({
        ok: true,
        data: {
          mode: "dry_run",
          pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
          pickupStatus: "indeterminate",
          courierOrderId: "877230626WWW",
          recordedShipmentsCount: 38,
          linkedShipmentsCount: 38,
          expectedShipmentsCount: 38,
          canCommit: true,
          committed: false,
          alreadyRepaired: false,
          testerStatuses: [],
          emailDedupPreview: { sendEmails: true, alreadySentCount: 0, requestCount: 38 },
        },
      }),
    });
    await repairAdminDhlCourierPickup(
      "admin-token",
      {
        pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
        mode: "dry_run",
        sendEmails: true,
        expectedCourierOrderId: "877230626WWW",
        expectedShipmentCount: 38,
      },
      { fetcher },
    );
    const [repairPath, repairInit] = fetcher.mock.calls[4] as [string, RequestInit];
    expect(repairPath).toBe("/api/bff/admin/fulfillment/dhl-repair-courier-pickup");
    expect(JSON.parse(String(repairInit.body))).toMatchObject({
      pickupId: "7aa14057-cea4-48f7-b40c-e4c35e2c732b",
      expectedCourierOrderId: "877230626WWW",
      expectedShipmentCount: 38,
    });

    fetcher.mockResolvedValueOnce({
      status: 200,
      json: () => Promise.resolve({ ok: true, data: { testerId: "tester-1", cleared: true } }),
    });
    await clearAdminDhlShipmentState("admin-token", { testerId: "tester-1" }, { fetcher });
    const [clearPath, clearInit] = fetcher.mock.calls[5] as [string, RequestInit];
    expect(clearPath).toBe("/api/bff/admin/fulfillment/dhl-clear-shipment-state");
    expect(JSON.parse(String(clearInit.body))).toEqual({ testerId: "tester-1" });
  });

  it("throws typed BFF errors and rejects malformed envelopes", async () => {
    const errorFetcher = vi.fn().mockResolvedValue({
      status: 503,
      json: () =>
        Promise.resolve({
          ok: false,
          error: { code: "UPSTREAM_UNAVAILABLE", message: "DHL create shipment failed" },
        }),
    });

    await expect(
      createAdminDhlShipment("admin-token", { testerId: "tester-1" }, { fetcher: errorFetcher }),
    ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE", status: 503 });

    const malformedFetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ ok: true, data: { trackingNumber: "TRK-1" } }),
    });
    await expect(
      createAdminDhlShipment("admin-token", { testerId: "tester-1" }, { fetcher: malformedFetcher }),
    ).rejects.toBeInstanceOf(BffClientError);
  });
});
