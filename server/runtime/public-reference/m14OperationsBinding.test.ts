import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseObservabilityEvidencePort as createEvidencePort } from "../../adapters/supabase/platform/observabilityEvidencePort.js";
import { createPublicReferenceServer } from "./serve.js";
import type { AddressInfo } from "node:net";
import { JOB_CATALOG } from "../../../src/domains/platform/jobCatalog.js";
import type { ObservabilitySnapshot, OpenAlert } from "../../../src/domains/platform/observabilityContracts.js";
import type { AlertLedgerPort } from "../../../src/domains/platform/observabilityPorts.js";
import type { PlatformAlertLedgerRow } from "../../../src/domains/platform/adminAlertsView.js";
import type { HttpRequest, HttpResponse } from "../../_lib/types/http.js";
import { createM14OperationsReferenceBinding } from "./m14OperationsBinding.js";

const now = new Date("2026-10-28T10:00:00.000Z");
const canary = "bff-axiom-canary-portable-operations";

describe("portable operations reference default", () => {
  beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("evaluates real domain evidence, captures locally, reads reports, correlates logs and throttles a repeat", async () => {
    const f = await fixture();
    const unchanged = structuredClone(f.snapshot);
    const result = await f.binding.runWatchdog();
    expect(result).toMatchObject({ ok: true, health: "firing", notified: 1, delivery: "captured", heartbeatRecorded: true });
    if (!result.ok) throw new Error("watchdog failed");
    expect(result.captured.map(row => row.dedupeKey)).toEqual(["subscription_cycle_unattempted"]);
    expect(result.decisions.map(row => row.dedupeKey).sort()).toEqual(["job_missed:outbox-dispatch", "subscription_cycle_unattempted"]);
    expect(result.captured).toEqual(expect.arrayContaining([expect.objectContaining({ alertId: expect.any(String), capturedAt: now.toISOString() })]));
    expect(f.notifications).toHaveLength(2);
    expect(f.notifications.filter(row => row.status === "sent")).toEqual([{ channel: "webhook", status: "sent", provider: "local_capture" }]);
    expect(f.snapshot).toEqual(unchanged);

    const alerts = response();
    await f.binding.alerts(request(), alerts.res);
    expect(alerts.body()).toMatchObject({ ok: true, data: {
      health: "down", summary: { commercePageableCount: 1, platformPageableCount: 0 },
      heartbeat: { stale: false, lastSuccessAt: now.toISOString() },
      alerts: expect.arrayContaining([expect.objectContaining({ dedupeKey: "subscription_cycle_unattempted", lane: "commerce" })]),
    } });
    expect(alerts.res.setHeader).toHaveBeenCalledWith("x-request-id", canary);
    const pipeline = response();
    await f.binding.pipeline(request(), pipeline.res);
    expect(pipeline.body()).toMatchObject({ ok: true, data: {
      emailSendCount: 4, emailEvents: [{ event_type: "opened" }],
      testers: [{ id: "cohort-1", status: "packing", email_sequence_step: 2, email_sequence_paused: false }],
    } });
    expect(logs()).toEqual(expect.arrayContaining([
      expect.objectContaining({ request_id: canary, route: "/api/bff/admin/platform/alerts", status: 200 }),
      expect.objectContaining({ request_id: canary, route: "/api/bff/admin/platform/pipeline", status: 200 }),
    ]));
    expect(await f.binding.runWatchdog()).toMatchObject({ notified: 0, throttledNotifications: 2, captured: [] });
    expect(f.notifications).toHaveLength(2);
  });

  it("serves the selected default's existing read routes through the real portable Node host", async () => {
    const f = await fixture();
    await f.binding.runWatchdog();
    const server = createPublicReferenceServer({ operations: f.binding, env: {} });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      for (const name of ["alerts", "pipeline"]) {
        const result = await fetch(`${origin}/api/bff/admin/platform/${name}`, { headers: { "x-request-id": canary } });
        expect(result.status).toBe(200);
        expect(result.headers.get("x-request-id")).toBe(canary);
        expect(await result.json()).toMatchObject({ ok: true });
      }
      f.authorizeAdmin.mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "Admin required" });
      expect((await fetch(`${origin}/api/bff/admin/platform/alerts`)).status).toBe(403);
      expect((await fetch(`${origin}/api/cron/platform-watchdog`)).status).toBe(404);
      expect(logs().filter(row => row.status === 200)).toHaveLength(2);
      expect(() => createPublicReferenceServer({ operations: f.binding, env: { OPENLUP_REFERENCE_PROFILE: "subscription" } })).toThrow("own host composition");
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it("checkOnly evaluates without writes or fabricated liveness; a real healthy tick resolves retained incidents", async () => {
    const f = await fixture();
    expect(await f.binding.runWatchdog({ checkOnly: true })).toMatchObject({ firingCount: 2, notified: 0, captured: [], heartbeatRecorded: false });
    expect(f.writes()).toBe(0);
    expect(f.notifications).toEqual([]);
    expect(f.recordHeartbeat).not.toHaveBeenCalled();
    const missing = response();
    await f.binding.alerts(request(), missing.res);
    expect(missing.body()).toMatchObject({ data: { health: "unknown", heartbeat: { stale: true } } });

    await f.binding.runWatchdog();
    f.snapshot.subscriptions.dueCycleUnattemptedCount = 0;
    f.snapshot.jobControls.forEach(control => { control.lastSuccessAt = now.toISOString(); control.lastStartedAt = now.toISOString(); });
    expect(await f.binding.runWatchdog()).toMatchObject({ health: "healthy", resolved: 2, notified: 0 });
    const healthy = response();
    await f.binding.alerts(request(), healthy.res);
    expect(healthy.body()).toMatchObject({ data: { health: "ok", alerts: [] } });
  });

  it("does not turn missing evidence or failed heartbeat into healthy readback", async () => {
    const f = await fixture();
    f.collectSnapshot.mockRejectedValueOnce(new Error("synthetic private connection detail"));
    expect(await f.binding.runWatchdog()).toEqual({ ok: false, error: "operations_watchdog_unavailable" });
    expect(f.writes()).toBe(0);
    expect(f.recordHeartbeat).not.toHaveBeenCalled();
    f.recordHeartbeat.mockResolvedValueOnce(false);
    expect(await f.binding.runWatchdog()).toMatchObject({ heartbeatRecorded: false, notified: 1 });
    const res = response();
    await f.binding.alerts(request(), res.res);
    expect(res.body()).toMatchObject({ data: { health: "unknown" } });
  });

  it("keeps failed selected delivery visible and retains the kernel's retry backoff", async () => {
    const send = vi.fn(async () => ({ channel: "webhook" as const, status: "failed" as const, error: "captured_transport_refusal" }));
    const f = await fixture({ sinkPort: { send } });
    expect(await f.binding.runWatchdog()).toMatchObject({ delivery: "adapter", notificationFailures: 1, notified: 0, captured: [] });
    expect(await f.binding.runWatchdog()).toMatchObject({ notificationFailures: 0, deliveryBackoffCount: 1, notified: 0, captured: [] });
    expect(send).toHaveBeenCalledTimes(1);
    expect(f.notifications).toHaveLength(2);
    expect(f.notifications.filter(row => row.status === "failed")).toHaveLength(1);
  });

  it("refuses unauthorized reads before ports or query parsing and logs the refusal", async () => {
    const f = await fixture();
    f.authorizeAdmin.mockResolvedValue({ ok: false, code: "FORBIDDEN", message: "Admin required" });
    for (const handler of [f.binding.alerts, f.binding.pipeline]) {
      const res = response();
      await handler(request({ query: { unexpected: "value" } }), res.res);
      expect(res.body()).toMatchObject({ ok: false, error: { code: "FORBIDDEN" }, meta: { requestId: canary } });
    }
    expect(f.readPipeline).not.toHaveBeenCalled();
    expect(f.listLiveAlerts).not.toHaveBeenCalled();
    expect(logs().map(row => row.status)).toEqual([403, 403]);
  });

  it("refuses unsupported methods and malformed report queries without owner reads", async () => {
    const f = await fixture();
    const method = response();
    await f.binding.pipeline(request({ method: "POST" }), method.res);
    expect(method.body()).toMatchObject({ error: { code: "METHOD_NOT_ALLOWED" } });
    expect(f.authorizeAdmin).not.toHaveBeenCalled();
    const query = response();
    await f.binding.pipeline(request({ query: { extra: "value" } }), query.res);
    expect(query.body()).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(f.readPipeline).not.toHaveBeenCalled();
  });

  it("keeps unsafe caller references, request content and upstream prose out of correlated error logs", async () => {
    const f = await fixture();
    const privateText = "synthetic-person@example.invalid private request content";
    f.readPipeline.mockRejectedValueOnce(new Error(privateText));
    const res = response();
    await f.binding.pipeline(request({
      headers: { authorization: `Bearer ${privateText}`, "x-request-id": privateText },
      body: { customer: privateText }, url: `/private?contact=${privateText}`,
    }), res.res);
    const body = res.body() as { meta: { requestId: string }; error: { code: string } };
    expect(body.error.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(body.meta.requestId).toMatch(/^[a-f0-9-]{36}$/);
    expect(logs()).toEqual([expect.objectContaining({ request_id: body.meta.requestId, status: 503, outcome: "error", auth_kind: "bearer" })]);
    expect(JSON.stringify([body, logs()])).not.toContain(privateText);
  });

  it("refuses malformed projections and safely handles throwing authorization", async () => {
    const f = await fixture();
    f.readPipeline.mockResolvedValueOnce({ ...pipelineReport(), emailSendCount: -1 });
    const invalid = response();
    await f.binding.pipeline(request(), invalid.res);
    expect(invalid.body()).toMatchObject({ error: { code: "INVALID_RESPONSE" } });
    f.authorizeAdmin.mockRejectedValueOnce(new Error("synthetic private auth detail"));
    const unavailable = response();
    await f.binding.alerts(request(), unavailable.res);
    expect(unavailable.body()).toMatchObject({ error: { code: "UPSTREAM_UNAVAILABLE" }, meta: { requestId: canary } });
    expect(JSON.stringify([unavailable.body(), logs()])).not.toContain("synthetic private auth detail");
  });
});

async function fixture(overrides: Partial<Parameters<typeof createM14OperationsReferenceBinding>[0]> = {}) {
  const snapshot = await evidence();
  const rows = new Map<string, PlatformAlertLedgerRow & OpenAlert>();
  const notifications: Parameters<AlertLedgerPort["recordNotification"]>[1][] = [];
  let writeCount = 0;
  let heartbeat: { last_success_at: string } | null = null;
  const collectSnapshot = vi.fn(async () => snapshot);
  const authorizeAdmin = vi.fn<Parameters<typeof createM14OperationsReferenceBinding>[0]["authorizeAdmin"]>(async () => ({ ok: true }));
  const readPipeline = vi.fn(async () => pipelineReport());
  const listLiveAlerts = vi.fn(async () => [...rows.values()]);
  const recordHeartbeat = vi.fn(async (at: Date) => { heartbeat = { last_success_at: at.toISOString() }; return true; });
  const ledgerPort: AlertLedgerPort = {
    async listOpenAlerts() { return [...rows.values()]; },
    async upsertOpenAlert(decision, at) {
      writeCount++;
      const previous = rows.get(decision.dedupeKey);
      const row = {
        id: previous?.id ?? `alert-${rows.size + 1}`, dedupeKey: decision.dedupeKey, dedupe_key: decision.dedupeKey,
        severity: decision.severity, status: "open" as const, lastNotifiedAt: previous?.lastNotifiedAt ?? null,
        nextNotificationAttemptAt: previous?.nextNotificationAttemptAt,
        lastNotificationStatus: previous?.lastNotificationStatus, notificationFailureCount: previous?.notificationFailureCount,
        owner: decision.owner, title: decision.title, message: decision.message, support_code: null,
        runbook_url: decision.runbookUrl, first_seen_at: previous?.first_seen_at ?? at.toISOString(), last_seen_at: at.toISOString(), snoozed_until: null,
      };
      rows.set(decision.dedupeKey, row);
      return row;
    },
    async resolveAlert(key) { writeCount++; rows.delete(key); },
    async recordNotification(id, outcome, at, schedule) {
      writeCount++;
      notifications.push(outcome);
      const row = [...rows.values()].find(row => row.id === id)!;
      if (outcome.status === "sent") row.lastNotifiedAt = at.toISOString();
      row.lastNotificationStatus = outcome.status;
      row.nextNotificationAttemptAt = schedule.nextAttemptAt.toISOString();
      row.notificationFailureCount = schedule.failureCount;
    },
  };
  const binding = createM14OperationsReferenceBinding({
    evidencePort: { collectSnapshot }, ledgerPort,
    alertsReadPort: { listLiveAlerts, readWatchdogHeartbeat: async () => heartbeat },
    pipelinePort: { readPipeline }, authorizeAdmin, recordHeartbeat, now: () => now, ...overrides,
  });
  return { binding, snapshot, collectSnapshot, notifications, writes: () => writeCount, recordHeartbeat, authorizeAdmin, readPipeline, listLiveAlerts };
}

function pipelineReport() {
  return { testers: [{ id: "cohort-1", status: "packing", email_sequence_step: 2, email_sequence_paused: false }],
    templates: [{ id: "template-1", name: "Reminder", sequence_order: 2 }], emailSendCount: 4, emailEvents: [{ event_type: "opened" }] };
}

function request(overrides: Partial<HttpRequest> = {}): HttpRequest {
  return { method: "GET", query: {}, headers: { "x-request-id": canary }, ...overrides } as HttpRequest;
}

function response() {
  const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as HttpResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return { res, body: () => vi.mocked(res.json).mock.calls.at(-1)?.[0] };
}

function logs(): Record<string, unknown>[] {
  return vi.mocked(console.log).mock.calls.map(call => JSON.parse(String(call[0])));
}

async function evidence(): Promise<ObservabilitySnapshot> {
  // Obtain the retained contract's empty domain projections from their actual
  // adapter rather than restating provider-owned fields in a portable fixture.
  const query = Object.assign(Promise.resolve({ data: [] as never[], error: null, count: 0 }), {
    select: () => query, eq: () => query, gte: () => query, in: () => query, limit: () => query,
    lte: () => query, not: () => query, order: () => query, range: () => query,
  });
  const snapshot = await createEvidencePort({ from: () => query }, {}).collectSnapshot(now);
  snapshot.runtimeFlags = { COMMERCE_OUTBOX_DISPATCH_ENABLED: true };
  snapshot.recipients = [];
  snapshot.jobControls = JOB_CATALOG.map(job => ({ jobName: job.jobName, enabled: job.jobName === "outbox-dispatch",
    lastSuccessAt: "2026-10-28T07:00:00.000Z", lastStartedAt: "2026-10-28T07:00:00.000Z", lastFinishedAt: "2026-10-28T07:01:00.000Z", lastStatus: "success", leaseUntil: null }));
  snapshot.subscriptions.dueCycleUnattemptedCount = 2;
  return snapshot;
}
