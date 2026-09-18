import { describe, expect, it, vi } from "vitest";
import { getAdminClientsSummary } from "./adminSummaryClient";

describe("getAdminClientsSummary", () => {
  it("passes the admin bearer token through the typed BFF client", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          data: {
            contractVersion: "clients.customer_360.v2",
            summary: {
              totalSubjects: 1,
              byLifecycleStage: { lead: 0, waitlist: 0, tester: 0, customer: 1, inactive: 0 },
              openDunningCases: 0,
              recoverableCases: 0,
              lastActivityAt: null,
            },
          },
        }),
    });

    await getAdminClientsSummary("access-token", { fetcher });

    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer access-token");
  });
});
