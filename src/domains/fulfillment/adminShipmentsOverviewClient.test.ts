import { describe, expect, it, vi } from "vitest";
import { BffClientError } from "@/lib/bff/client";
import { getAdminShipmentsOverview } from "./adminShipmentsOverviewClient";

describe("admin shipments overview client", () => {
  it("reads shipments overview with the admin bearer token", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: { approved: [], packing: [], shippedToday: 0, shipped: [] },
        }),
    });

    await getAdminShipmentsOverview("admin-token", { shippedFilter: "7d" }, { fetcher });

    const [path, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/bff/admin/fulfillment/shipments-overview?shippedFilter=7d");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer admin-token");
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
      getAdminShipmentsOverview("admin-token", { shippedFilter: "7d" }, { fetcher: errorFetcher }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });

    const malformedFetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ ok: true, data: { approved: [] } }),
    });

    await expect(
      getAdminShipmentsOverview("admin-token", { shippedFilter: "7d" }, { fetcher: malformedFetcher }),
    ).rejects.toBeInstanceOf(BffClientError);
  });
});
