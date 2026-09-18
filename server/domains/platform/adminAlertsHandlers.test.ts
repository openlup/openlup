import { describe, expect, it, vi } from "vitest";
import { createAdminAlertsOverviewHandler, type AdminAlertsReadPort } from "./adminAlertsHandlers.js";
import type { PlatformAlertLedgerRow } from "../../../src/domains/platform/adminAlertsView.js";
import type { AdminAlertsOverviewResponse } from "../../../src/domains/platform/adminAlertsContracts.js";
import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function alertRow(overrides: Partial<PlatformAlertLedgerRow> = {}): PlatformAlertLedgerRow {
  return {
    id: "alert-1",
    dedupe_key: "checkout_reservation_leak",
    owner: "commerce/payment",
    // p0: the paging floor is p0 (alertPagingPolicy.ts), so only a p0 row proves
    // the pageable projection actually ran end to end rather than returning zero.
    severity: "p0",
    status: "open",
    title: "Reservation leak",
    message: "Holds are not being released",
    support_code: "OPS-20260719-LEAK",
    runbook_url: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
    first_seen_at: "2026-07-19T11:00:00+00:00",
    last_seen_at: "2026-07-19T11:50:00+00:00",
    snoozed_until: null,
    ...overrides,
  };
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn(),
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    end: vi.fn(),
  };
  return res as unknown as VercelResponse & {
    statusCode: number;
    body: {
      ok: boolean;
      error?: { code: string; message: string };
      data?: AdminAlertsOverviewResponse;
    };
  };
}

function readPort(overrides: Partial<AdminAlertsReadPort> = {}): AdminAlertsReadPort {
  return {
    listLiveAlerts: async () => [alertRow()],
    readWatchdogHeartbeat: async () => ({ last_success_at: "2026-07-19T11:55:00+00:00" }),
    ...overrides,
  };
}

const GET = { method: "GET" } as unknown as VercelRequest;

type MockRes = ReturnType<typeof mockRes>;

function errorOf(res: MockRes) {
  const error = res.body.error;
  if (!error) throw new Error(`expected an error envelope, got ${JSON.stringify(res.body)}`);
  return error;
}

function dataOf(res: MockRes) {
  const data = res.body.data;
  if (!data) throw new Error(`expected a data envelope, got ${JSON.stringify(res.body)}`);
  return data;
}

describe("admin alerts overview handler", () => {
  it("rejects a caller without an admin session", async () => {
    const res = mockRes();
    await createAdminAlertsOverviewHandler({
      readPort: readPort(),
      authorizeAdmin: async () => ({ ok: false, code: "UNAUTHORIZED", message: "Admin session required" }),
      now: () => NOW,
    })(GET, res);

    expect(res.body.ok).toBe(false);
    expect(errorOf(res).code).toBe("UNAUTHORIZED");
  });

  it("rejects a non-admin role", async () => {
    const res = mockRes();
    await createAdminAlertsOverviewHandler({
      readPort: readPort(),
      authorizeAdmin: async () => ({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
      now: () => NOW,
    })(GET, res);

    expect(errorOf(res).code).toBe("FORBIDDEN");
  });

  it("does not read the ledger before authorization succeeds", async () => {
    const listLiveAlerts = vi.fn(async () => [alertRow()]);
    await createAdminAlertsOverviewHandler({
      readPort: readPort({ listLiveAlerts }),
      authorizeAdmin: async () => ({ ok: false, code: "FORBIDDEN", message: "Admin role required" }),
      now: () => NOW,
    })(GET, mockRes());

    expect(listLiveAlerts).not.toHaveBeenCalled();
  });

  it("rejects non-GET methods", async () => {
    const res = mockRes();
    await createAdminAlertsOverviewHandler({
      readPort: readPort(),
      authorizeAdmin: async () => ({ ok: true, userId: "u1", role: "admin", isMachineActor: false }),
      now: () => NOW,
    })({ method: "POST" } as unknown as VercelRequest, res);

    expect(errorOf(res).code).toBe("METHOD_NOT_ALLOWED");
  });

  it("serves the overview to an admin", async () => {
    const res = mockRes();
    await createAdminAlertsOverviewHandler({
      readPort: readPort(),
      authorizeAdmin: async () => ({ ok: true, userId: "u1", role: "admin", isMachineActor: false }),
      now: () => NOW,
    })(GET, res);

    expect(res.body.ok).toBe(true);
    expect(dataOf(res).health).toBe("down");
    expect(dataOf(res).summary.commercePageableCount).toBe(1);
  });

  it("reports unknown health when the watchdog never reported", async () => {
    const res = mockRes();
    await createAdminAlertsOverviewHandler({
      readPort: readPort({ readWatchdogHeartbeat: async () => null }),
      authorizeAdmin: async () => ({ ok: true, userId: "u1", role: "admin", isMachineActor: false }),
      now: () => NOW,
    })(GET, res);

    expect(dataOf(res).health).toBe("unknown");
  });

  it("fails closed when the ledger read throws", async () => {
    const res = mockRes();
    await createAdminAlertsOverviewHandler({
      readPort: readPort({
        listLiveAlerts: async () => {
          throw new Error("permission denied for table platform_alerts");
        },
      }),
      authorizeAdmin: async () => ({ ok: true, userId: "u1", role: "admin", isMachineActor: false }),
      now: () => NOW,
    })(GET, res);

    expect(res.body.ok).toBe(false);
    expect(errorOf(res).code).toBe("UPSTREAM_UNAVAILABLE");
  });
});
