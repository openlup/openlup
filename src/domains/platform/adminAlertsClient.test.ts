import { describe, expect, it, vi } from "vitest";
import { getAdminAlertsOverview } from "./adminAlertsClient";
import type { AdminAlertsOverviewResponse } from "./adminAlertsContracts";

const OVERVIEW: AdminAlertsOverviewResponse = {
  health: "degraded",
  summary: {
    commercePageableCount: 1,
    commerceTotalCount: 2,
    platformPageableCount: 0,
    snoozedCount: 0,
    maxOpenSeverity: "p1",
  },
  heartbeat: {
    lastSuccessAt: "2026-07-19T11:55:00.000Z",
    staleAfterSeconds: 1800,
    stale: false,
  },
  alerts: [
    {
      id: "alert-1",
      dedupeKey: "checkout_reservation_leak",
      lane: "commerce",
      owner: "commerce/payment",
      severity: "p1",
      status: "open",
      pageable: true,
      title: "Reservation leak",
      message: "Holds are not being released",
      supportCode: "OPS-20260719-LEAK",
      runbookUrl: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
      firstSeenAt: "2026-07-19T11:00:00.000Z",
      lastSeenAt: "2026-07-19T11:50:00.000Z",
      snoozedUntil: null,
    },
  ],
  snoozedAlerts: [],
  generatedAt: "2026-07-19T12:00:00.000Z",
};

function fetcherReturning(data: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    status,
    json: () => Promise.resolve({ ok: status === 200, data }),
  });
}

describe("getAdminAlertsOverview", () => {
  it("reads the admin alerts route with the operator's bearer token", async () => {
    const fetcher = fetcherReturning(OVERVIEW);

    const result = await getAdminAlertsOverview("access-token", { fetcher });

    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/bff/admin/platform/alerts");
    expect(init.method).toBe("GET");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-token");
    expect(result.health).toBe("degraded");
    expect(result.summary.commercePageableCount).toBe(1);
  });

  it("rejects a payload that does not match the contract", async () => {
    const fetcher = fetcherReturning({ ...OVERVIEW, health: "totally-fine" });

    await expect(getAdminAlertsOverview("access-token", { fetcher })).rejects.toThrow();
  });
});
