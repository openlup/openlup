import { describe, expect, it } from "vitest";
import { adminAlertsOverviewResponseSchema } from "./adminAlertsContracts.js";
import {
  GENERIC_JOB_DEDUPE_PREFIXES,
  WATCHDOG_STALE_AFTER_SECONDS,
  buildAlertsOverview,
  buildHeartbeat,
  classifyLane,
  deriveHealth,
  isPageable,
  isSnoozed,
  summarizeAlerts,
  toAdminAlert,
  type PlatformAlertLedgerRow,
} from "./adminAlertsView.js";

const NOW = new Date("2026-07-19T12:00:00.000Z");

function row(overrides: Partial<PlatformAlertLedgerRow> = {}): PlatformAlertLedgerRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    dedupe_key: "payment_provider_paid_local_unpaid",
    owner: "commerce/payment",
    severity: "p1",
    status: "open",
    title: "Payment mismatch",
    message: "Provider says paid, local says unpaid",
    support_code: "OPS-20260719-PAYMENT",
    runbook_url: "/docs/platform/RUNTIME_AND_SELF_HOSTING.md",
    first_seen_at: "2026-07-19T11:00:00+00:00",
    last_seen_at: "2026-07-19T11:50:00+00:00",
    snoozed_until: null,
    ...overrides,
  };
}

const FRESH_HEARTBEAT = { last_success_at: "2026-07-19T11:55:00+00:00" };

describe("classifyLane", () => {
  it.each([
    "commerce/payment",
    "commerce/payment-accounting",
    "commerce/accounting",
    "commerce/fulfillment",
    "commerce/subscriptions",
    "commerce/subscription-support",
  ])("routes %s to the operator lane", (owner) => {
    expect(classifyLane(owner, "checkout_reservation_leak")).toBe("commerce");
  });

  it("routes commerce/platform to the platform lane despite the prefix", () => {
    expect(classifyLane("commerce/platform", "queue_backlog:outbox")).toBe("platform");
  });

  it.each(["platform/communications", "platform/fulfillment", "platform/ops"])(
    "routes %s to the platform lane",
    (owner) => {
      expect(classifyLane(owner, "email_webhook_gap")).toBe("platform");
    },
  );

  it("keeps an unknown owner out of the operator lane", () => {
    expect(classifyLane("something/new", "whatever")).toBe("platform");
  });

  it.each(GENERIC_JOB_DEDUPE_PREFIXES)(
    "routes %s alerts to platform even when the job is commerce-owned",
    (prefix) => {
      expect(classifyLane("commerce/fulfillment", `${prefix}omnipack-dispatch`)).toBe("platform");
    },
  );
});

describe("isSnoozed", () => {
  it("treats a future snooze as silenced", () => {
    expect(isSnoozed("2026-07-19T13:00:00+00:00", NOW)).toBe(true);
  });

  it("treats an elapsed snooze as live again", () => {
    expect(isSnoozed("2026-07-19T11:00:00+00:00", NOW)).toBe(false);
  });

  it("treats a missing snooze as live", () => {
    expect(isSnoozed(null, NOW)).toBe(false);
  });
});

describe("isPageable", () => {
  it("counts p0", () => {
    expect(isPageable(row({ severity: "p0" }), NOW)).toBe(true);
  });

  it.each(["p1", "p2", "p3"])("does not count %s under the default floor", (severity) => {
    expect(isPageable(row({ severity }), NOW)).toBe(false);
  });

  it("keeps acknowledged alerts pageable — acknowledged is not resolved", () => {
    expect(isPageable(row({ severity: "p0", status: "acknowledged" }), NOW)).toBe(true);
  });

  it("drops resolved alerts", () => {
    expect(isPageable(row({ severity: "p0", status: "resolved" }), NOW)).toBe(false);
  });

  it("drops snoozed alerts", () => {
    expect(
      isPageable(row({ severity: "p0", snoozed_until: "2026-07-19T13:00:00+00:00" }), NOW),
    ).toBe(false);
  });

  it("treats an unrecognised severity as p0 rather than dropping it", () => {
    expect(isPageable(row({ severity: "p9" }), NOW)).toBe(true);
    expect(toAdminAlert(row({ severity: "p9" }), NOW).severity).toBe("p0");
  });
});

describe("summarizeAlerts", () => {
  it("partitions the pageable set so nothing that pages is invisible", () => {
    const alerts = [
      // p0 in the operator lane: the only commerce row that pages under the floor.
      row({ id: "a", owner: "commerce/payment", severity: "p0" }),
      row({ id: "b", owner: "platform/ops", severity: "p0", dedupe_key: "queue_backlog:x" }),
      row({
        id: "c",
        owner: "commerce/fulfillment",
        severity: "p1",
        dedupe_key: "job_failed:omnipack-dispatch",
      }),
      // Live, operator-lane, and p1: visible in the popover, never a page.
      row({ id: "d", owner: "commerce/accounting", severity: "p1" }),
    ].map((r) => toAdminAlert(r, NOW));

    const summary = summarizeAlerts(alerts);
    expect(summary.commercePageableCount).toBe(1);
    expect(summary.platformPageableCount).toBe(1);
    expect(summary.commerceTotalCount).toBe(2);
    expect(summary.maxOpenSeverity).toBe("p0");
    expect(summary.snoozedCount).toBe(0);

    const pageable = alerts.filter((alert) => alert.pageable).length;
    expect(summary.commercePageableCount + summary.platformPageableCount).toBe(pageable);
  });

  it("reports no severity when there is nothing live", () => {
    expect(summarizeAlerts([]).maxOpenSeverity).toBeNull();
  });
});

describe("buildHeartbeat", () => {
  it("marks a recent tick fresh", () => {
    expect(buildHeartbeat(FRESH_HEARTBEAT, NOW).stale).toBe(false);
  });

  it("marks a tick older than the threshold stale", () => {
    // 7h before NOW, past the 6h threshold.
    expect(buildHeartbeat({ last_success_at: "2026-07-19T05:00:00+00:00" }, NOW).stale).toBe(true);
  });

  it("keeps the reference threshold independent from adopter scheduling cadence", () => {
    const insideReferenceWindow = new Date(NOW.getTime() - (WATCHDOG_STALE_AFTER_SECONDS - 60) * 1000).toISOString();
    expect(buildHeartbeat({ last_success_at: insideReferenceWindow }, NOW).stale).toBe(false);
  });

  it("exposes the threshold so the UI need not hardcode the cadence", () => {
    expect(buildHeartbeat(FRESH_HEARTBEAT, NOW).staleAfterSeconds).toBe(WATCHDOG_STALE_AFTER_SECONDS);
  });

  it("marks a missing control row stale — a watchdog that never ran proves nothing", () => {
    const heartbeat = buildHeartbeat(null, NOW);
    expect(heartbeat.stale).toBe(true);
    expect(heartbeat.lastSuccessAt).toBeNull();
  });
});

describe("deriveHealth", () => {
  const fresh = buildHeartbeat(FRESH_HEARTBEAT, NOW);
  const stale = buildHeartbeat(null, NOW);

  it.each([
    ["p0", "down"],
    ["p1", "degraded"],
    ["p2", "ok"],
    ["p3", "ok"],
    [null, "ok"],
  ] as const)("maps worst severity %s to %s when fresh", (severity, expected) => {
    expect(deriveHealth(summaryWith(severity), fresh)).toBe(expected);
  });

  it("lets staleness beat severity — an unreported p0 is unknown, not down", () => {
    expect(deriveHealth(summaryWith("p0"), stale)).toBe("unknown");
  });

  it("never reports ok from a stale heartbeat", () => {
    expect(deriveHealth(summaryWith(null), stale)).toBe("unknown");
  });

  function summaryWith(maxOpenSeverity: "p0" | "p1" | "p2" | "p3" | null) {
    return {
      commercePageableCount: 0,
      commerceTotalCount: 0,
      platformPageableCount: 0,
      snoozedCount: 0,
      maxOpenSeverity,
    };
  }
});

describe("buildAlertsOverview", () => {
  it("returns a contract-valid payload sorted worst-first", () => {
    const overview = buildAlertsOverview(
      [
        row({ id: "low", severity: "p2", last_seen_at: "2026-07-19T11:59:00+00:00" }),
        row({ id: "high", severity: "p0" }),
        row({ id: "resolved", status: "resolved" }),
      ],
      FRESH_HEARTBEAT,
      NOW,
    );

    expect(() => adminAlertsOverviewResponseSchema.parse(overview)).not.toThrow();
    expect(overview.alerts.map((alert) => alert.id)).toEqual(["high", "low"]);
    expect(overview.health).toBe("down");
  });

  it("reports unknown health when the watchdog heartbeat is missing", () => {
    const overview = buildAlertsOverview([row()], null, NOW);
    expect(overview.health).toBe("unknown");
    expect(adminAlertsOverviewResponseSchema.parse(overview).heartbeat.stale).toBe(true);
  });

  it("stays contract-valid with no alerts at all", () => {
    const overview = buildAlertsOverview([], FRESH_HEARTBEAT, NOW);
    expect(() => adminAlertsOverviewResponseSchema.parse(overview)).not.toThrow();
    expect(overview.health).toBe("ok");
    expect(overview.summary.commercePageableCount).toBe(0);
  });

  it("keeps the Lamb and Venison QA exception visible but neutral until Monday", () => {
    const qaNow = new Date("2026-07-26T10:00:00.000Z");
    const mondayRestock = "2026-07-27T09:00:00.000Z";
    const qaRows = [
      row({
        id: "lamb",
        dedupe_key: "omnipack_reservation_coverage:lamb",
        owner: "commerce/fulfillment",
        title: "Lamb reservation coverage",
        snoozed_until: mondayRestock,
      }),
      row({
        id: "venison",
        dedupe_key: "omnipack_reservation_coverage:venison",
        owner: "commerce/fulfillment",
        title: "Venison reservation coverage",
        snoozed_until: mondayRestock,
      }),
    ];

    const qaHeartbeat = { last_success_at: "2026-07-26T09:55:00.000Z" };
    const overview = buildAlertsOverview(qaRows, qaHeartbeat, qaNow);

    expect(overview.health).toBe("ok");
    expect(overview.summary).toMatchObject({
      commercePageableCount: 0,
      platformPageableCount: 0,
      snoozedCount: 2,
      maxOpenSeverity: null,
    });
    expect(overview.alerts).toEqual([]);
    expect(overview.snoozedAlerts.map((alert) => [alert.id, alert.pageable, alert.snoozedUntil])).toEqual([
      ["lamb", false, mondayRestock],
      ["venison", false, mondayRestock],
    ]);

    const afterExpiry = buildAlertsOverview(
      qaRows,
      { last_success_at: "2026-07-27T08:55:00.000Z" },
      new Date("2026-07-27T09:00:01.000Z"),
    );

    // p1 is panel-urgent: the pill goes degraded and the rows come back to the
    // list, but nothing pages under the default floor.
    expect(afterExpiry.health).toBe("degraded");
    expect(afterExpiry.summary).toMatchObject({
      commercePageableCount: 0,
      snoozedCount: 0,
      maxOpenSeverity: "p1",
    });
    expect(afterExpiry.alerts.map((alert) => [alert.id, alert.pageable])).toEqual([
      ["lamb", false],
      ["venison", false],
    ]);
    expect(afterExpiry.snoozedAlerts).toEqual([]);
  });

  it("returns controlled exceptions outside the active alert limit", () => {
    const activeRows = Array.from({ length: 50 }, (_, index) => row({
      id: `active-${index}`,
      severity: "p2",
      last_seen_at: `2026-07-19T11:${String(index).padStart(2, "0")}:00+00:00`,
    }));
    const snoozedLamb = row({
      id: "lamb",
      dedupe_key: "omnipack_reservation_coverage:lamb",
      title: "Lamb reservation coverage",
      snoozed_until: "2026-07-21T09:00:00.000Z",
    });

    const overview = buildAlertsOverview([...activeRows, snoozedLamb], FRESH_HEARTBEAT, NOW);

    expect(overview.alerts).toHaveLength(50);
    expect(overview.snoozedAlerts).toMatchObject([{ id: "lamb", pageable: false }]);
    expect(overview.summary.snoozedCount).toBe(1);
  });
});
