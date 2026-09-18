import { describe, expect, it, vi } from "vitest";
import { BffClientError } from "@/lib/bff/client";
import { cleanupAdminDhlShipment } from "./adminDhlCleanupClient";

describe("admin DHL cleanup client", () => {
  it("sends cleanup requests with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            dhlDeleted: true,
            dhlError: null,
            labelDeleted: true,
            canProceed: true,
          },
        }),
    });

    await cleanupAdminDhlShipment("admin-token", { trackingNumber: "TRACK-1" }, { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/fulfillment/dhl-cleanup");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
    expect(init.body).toBe(JSON.stringify({ trackingNumber: "TRACK-1" }));
  });

  it("throws typed BFF errors and rejects malformed envelopes", async () => {
    const errorFetcher = vi.fn().mockResolvedValue({
      status: 401,
      json: () =>
        Promise.resolve({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "Admin session required" },
        }),
    });

    await expect(
      cleanupAdminDhlShipment("admin-token", { trackingNumber: "TRACK-1" }, { fetcher: errorFetcher }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    const malformedFetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ ok: true, data: { dhlDeleted: true } }),
    });

    await expect(
      cleanupAdminDhlShipment("admin-token", { trackingNumber: "TRACK-1" }, { fetcher: malformedFetcher }),
    ).rejects.toBeInstanceOf(BffClientError);
  });
});
