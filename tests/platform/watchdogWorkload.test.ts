import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlertDecision, AlertSeverity, ObservabilitySnapshot, OpenAlert } from "../../src/domains/platform/observabilityContracts.js";
import type { AlertLedgerPort, AlertSinkPort } from "../../src/domains/platform/observabilityPorts.js";
import type { OrderMoneyReconciliationEvidence, OrderMoneyReconciliationModeSummary } from "../../src/domains/platform/orderMoneyReconciliationContracts.js";
import { DEFAULT_PAGING_MIN_SEVERITY } from "../../src/domains/platform/alertPagingPolicy.js";
import { evaluateObservability } from "../../src/domains/platform/observabilityEvaluator.js";
import { runPlatformWatchdog } from "../../server/domains/platform/platformWatchdogService.js";
import { createStagingSyntheticMoneyDecisionNormalizer } from "../../server/ops/promotionWatchdogReadiness.js";

const NOW = new Date("2026-09-07T12:00:00.000Z");
const P0_KEY = "subscription_cycle_unattempted";
const P1_KEY = "subscription_pending_activation_overdue";
const DIAGNOSTICS = 1156;
const STALE_ALERTS = 100;
const normalizeDecision = createStagingSyntheticMoneyDecisionNormalizer("staging");
// Frozen synthetic I/O model from the approved plan, not measured provider latency.
const IO = { evidence: 8000, list: 20, upsert: 40, record: 40, resolve: 20, send: 150 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("persisting watchdog workload", () => {
  it.each([
    { name: "cold", diagnostics: DIAGNOSTICS, warm: false, ceilingMs: 35000 },
    { name: "warm", diagnostics: DIAGNOSTICS, warm: true, ceilingMs: 25000 },
    { name: "double diagnostics warm", diagnostics: DIAGNOSTICS * 2, warm: true, ceilingMs: 40000 },
  ])("accounts for the complete $name workload within its frozen virtual budget", async ({ name, diagnostics, warm, ceilingMs }) => {
    const snapshot = workloadSnapshot(diagnostics);
    const raw = evaluateObservability(snapshot, [], NOW);
    const decisions = raw.map(normalizeDecision);
    const count = diagnostics + 2;
    expect(DEFAULT_PAGING_MIN_SEVERITY).toBe("p0");
    expect(raw).toHaveLength(count);
    expect(raw.at(-1)?.dedupeKey).toBe(P1_KEY);
    expect(raw[0].dedupeKey).toBe(P0_KEY);
    expect(new Set(decisions.map(({ dedupeKey }) => dedupeKey)).size).toBe(count);
    expect(decisions.filter(({ severity, paging }) => severity === "p3" && paging === "never")).toHaveLength(diagnostics);

    const harness = workloadPorts(decisions, warm);
    const started = Date.now();
    const pending = runPlatformWatchdog({
      ...harness.ports, evidencePort: { collectSnapshot: async () => {
        await harness.delay(IO.evidence);
        return snapshot;
      } }, catalog: [], now: NOW, checkOnly: false, normalizeDecision,
    });
    await vi.runAllTimersAsync();
    const result = await pending;
    const elapsedMs = Date.now() - started;
    const p1AdmissionIndex = harness.admitted.indexOf(P1_KEY);
    console.info("watchdog_workload", JSON.stringify({
      profile: name, count, elapsedMs, ceilingMs, p1AdmissionIndex,
      peakChains: harness.metrics.peakChains, peakSink: harness.metrics.peakSink,
      upserts: harness.admitted.length, attempts: harness.attempts.size, resolved: harness.resolved.size,
    }));

    expect(result.decisions).toEqual(decisions);
    expect(result).toMatchObject({
      ok: true, health: "firing", alertCount: count, firingCount: 2, maxSeverity: "p0",
      actionableCriticalCount: 2, suppressedCriticalCount: 0, actionablePageableCount: 1,
      notified: warm ? 0 : 1, notificationFailures: 0, deliveryBackoffCount: 0,
      skippedNotifications: warm ? 0 : count - 1, belowThreshold: warm ? 0 : count - 1,
      throttledNotifications: warm ? count : 0, suppressed: 0, muted: 0, resolved: STALE_ALERTS,
    });
    expect(harness.admitted).toHaveLength(count);
    expect(new Set(harness.admitted)).toEqual(new Set(decisions.map(({ dedupeKey }) => dedupeKey)));
    expect(harness.recorded).toEqual(new Map(decisions.map((decision) => [decision.dedupeKey, decision])));
    expect(harness.attempts.size).toBe(warm ? 0 : count);
    expect(harness.sent).toEqual(warm ? [] : [P0_KEY]);
    expect(harness.resolved).toEqual(new Set(Array.from({ length: STALE_ALERTS }, (_, index) => `stale:${index}`)));
    expect(harness.metrics.chains).toBe(0);
    expect(harness.metrics.sink).toBe(0);
    expect(harness.metrics.pendingIO).toBe(0);
    expect(harness.metrics.peakChains).toBeLessThanOrEqual(4);
    expect(harness.metrics.peakSink).toBeLessThanOrEqual(1);
    expect(vi.getTimerCount()).toBe(0);
    if (!warm) {
      expect(harness.attempts.get(P0_KEY)).toBe("sent");
      expect(harness.attempts.get(P1_KEY)).toBe("below_paging_severity");
      for (const decision of decisions.filter(({ paging }) => paging === "never")) {
        expect(harness.attempts.get(decision.dedupeKey)).toBe("non_pageable_diagnostic");
        expect(harness.rows.get(decision.dedupeKey)?.lastNotifiedAt).toBeNull();
        expect(harness.rows.get(decision.dedupeKey)?.nextNotificationAttemptAt).toBeTruthy();
      }
    }
    // Soft assertions retain both falsifiers in the first serial-baseline output.
    expect.soft(elapsedMs).toBeLessThan(ceilingMs);
    expect.soft(harness.admitted.slice(0, 2)).toEqual([P0_KEY, P1_KEY]);
  });

  it("keeps the same high-volume evaluation read-only in checkOnly mode", async () => {
    const snapshot = workloadSnapshot(DIAGNOSTICS);
    const decisions = evaluateObservability(snapshot, [], NOW).map(normalizeDecision);
    const harness = workloadPorts(decisions, false);
    const pending = runPlatformWatchdog({
      ...harness.ports, evidencePort: { collectSnapshot: async () => {
        await harness.delay(IO.evidence);
        return snapshot;
      } }, catalog: [], now: NOW, checkOnly: true, normalizeDecision,
    });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({
      ok: true, checkOnly: true, decisions, alertCount: 1158, firingCount: 2,
      actionableCriticalCount: 2, actionablePageableCount: 1, notified: 0, resolved: 0,
    });
    expect(harness.admitted).toEqual([]);
    expect(harness.attempts.size).toBe(0);
    expect(harness.sent).toEqual([]);
    expect(harness.resolved.size).toBe(0);
    expect(harness.metrics.pendingIO).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("sends real p1 only with a lowered floor and keeps sink admission serial", async () => {
    const snapshot = workloadSnapshot(0);
    const decisions = evaluateObservability(snapshot, [], NOW).map(normalizeDecision);
    const harness = workloadPorts(decisions, false);
    const pending = runPlatformWatchdog({
      ...harness.ports, evidencePort: { collectSnapshot: async () => snapshot },
      catalog: [], now: NOW, checkOnly: false, normalizeDecision, pagingMinSeverity: "p1",
    });
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ notified: 2, actionablePageableCount: 2, belowThreshold: 0 });
    expect(harness.sent).toEqual([P0_KEY, P1_KEY]);
    expect(harness.metrics.peakSink).toBe(1);
    expect(harness.metrics.pendingIO).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

function workloadPorts(decisions: AlertDecision[], warm: boolean) {
  const rows = new Map<string, OpenAlert>();
  const byId = new Map<string, string>();
  const admitted: string[] = [];
  const recorded = new Map<string, AlertDecision>();
  const attempts = new Map<string, string>();
  const resolved = new Set<string>();
  const sent: string[] = [];
  const metrics = { chains: 0, peakChains: 0, sink: 0, peakSink: 0, pendingIO: 0 };
  const delay = async (ms: number) => {
    metrics.pendingIO += 1;
    try { await new Promise<void>((resolve) => setTimeout(resolve, ms)); }
    finally { metrics.pendingIO -= 1; }
  };
  const enterChain = () => {
    metrics.chains += 1;
    metrics.peakChains = Math.max(metrics.peakChains, metrics.chains);
  };
  const seed = (key: string, severity: AlertSeverity, cadence = false) => {
    const row: OpenAlert = {
      id: `alert:${key}`, dedupeKey: key, status: "open", severity, lastNotifiedAt: null,
      ...(cadence ? {
        lastNotifiedAt: key === P0_KEY ? "2026-09-07T11:59:00.000Z" : null,
        lastNotificationStatus: key === P0_KEY ? "sent" as const : "skipped" as const,
        lastNotificationAttemptAt: "2026-09-07T11:59:00.000Z",
        nextNotificationAttemptAt: "2026-09-07T13:00:00.000Z", notificationFailureCount: 0,
      } : {}),
    };
    rows.set(key, row);
    byId.set(row.id, key);
    return row;
  };
  if (warm) for (const decision of decisions) seed(decision.dedupeKey, decision.severity, true);
  for (let index = 0; index < STALE_ALERTS; index++) seed(`stale:${index}`, "p2");
  const ledgerPort: AlertLedgerPort = {
    async listOpenAlerts() {
      await delay(IO.list);
      return [...rows.values()].map((row) => ({ ...row }));
    },
    async upsertOpenAlert(decision) {
      enterChain();
      admitted.push(decision.dedupeKey);
      await delay(IO.upsert);
      const row = rows.get(decision.dedupeKey) ?? seed(decision.dedupeKey, decision.severity);
      row.severity = decision.severity;
      recorded.set(decision.dedupeKey, decision);
      if (warm) metrics.chains -= 1;
      return { ...row };
    },
    async recordNotification(id, outcome, now, schedule) {
      const key = byId.get(id);
      if (!key || !rows.has(key)) throw new Error(`Unknown alert id ${id}`);
      if (attempts.has(key)) throw new Error(`Duplicate attempt for ${key}`);
      await delay(IO.record);
      attempts.set(key, outcome.status === "sent" ? "sent" : outcome.error ?? outcome.status);
      const row = rows.get(key)!;
      if (outcome.status === "sent") row.lastNotifiedAt = now.toISOString();
      row.lastNotificationStatus = outcome.status;
      row.nextNotificationAttemptAt = schedule.nextAttemptAt.toISOString();
      row.notificationFailureCount = schedule.failureCount;
      row.lastNotificationAttemptAt = now.toISOString();
      metrics.chains -= 1;
    },
    async resolveAlert(key) {
      // Resolution must start only after every expected decision's chain has persisted.
      expect(recorded.size).toBe(decisions.length);
      expect(attempts.size).toBe(warm ? 0 : decisions.length);
      expect(key.startsWith("stale:")).toBe(true);
      enterChain();
      await delay(IO.resolve);
      rows.delete(key);
      resolved.add(key);
      metrics.chains -= 1;
    },
  };
  const sinkPort: AlertSinkPort = {
    async send(decision, alert) {
      expect(byId.get(alert.id)).toBe(decision.dedupeKey);
      metrics.sink += 1;
      metrics.peakSink = Math.max(metrics.peakSink, metrics.sink);
      sent.push(decision.dedupeKey);
      await delay(IO.send);
      metrics.sink -= 1;
      return { channel: "webhook", status: "sent", provider: "webhook" };
    },
  };
  return { ports: { ledgerPort, sinkPort }, delay, rows, admitted, recorded, attempts, resolved, sent, metrics };
}

function workloadSnapshot(diagnostics: number): ObservabilitySnapshot {
  const emptyMode: OrderMoneyReconciliationModeSummary = {
    checkedCount: 0, mismatchCount: 0, providerUnavailableCount: 0, providerUnsupportedCount: 0,
    providerPendingCount: 0, providerOverdueCount: 0, providerEventMoneyUnavailableCount: 0,
  };
  return {
    checkedAt: NOW.toISOString(), runtimeFlags: {}, jobControls: [], recentJobRuns: [], queues: [], recipients: [],
    dunning: {
      overdueRetryCount: 0, expiredWithoutCustomerNoticeCount: 0, failureWithoutAdminAlertCount: 0,
      failedAdminNotificationCount: 0, skippedAdminNotificationCount: 0, expiredCount24h: 0, recoveredCount24h: 0,
    },
    subscriptions: {
      dueCycleWithoutOrderCount: 0, upcomingDeliveryReminderMissingCount: 0,
      dueCycleUnattemptedCount: 1, pendingActivationOverdueCount: 1,
    },
    emails: {
      criticalFailedCount: 0, failedBySource: {}, customerTimelineFailedCount: 0,
      customerTimelineMissedCount: 0, customerTimelineOverdueCount: 0, failedByPurpose: {},
      auditIncompleteCount: 0, previewProductionDomainLinkCount: 0, webhookGapCount: 0, communicationOutboxFailedCount: 0,
    },
    payments: {
      providerPaidLocalUnpaidCount: 0, localPaidProviderUnpaidCount: 0, webhookMissingCount: 0,
      stuckProcessingCount: 0, amountCurrencyMismatchCount: 0, signatureFailureCount: 0,
      recoveryRequiredWithoutLinkCount: 0, evidence: [],
    },
    accounting: {
      shippedWithoutInvoiceCount: 0, missingInvoiceHandoffs: [], pendingOutboxCount: 0,
      failedOutboxCount: 0, failedCorrectionOutboxCount: 0, ksefPendingTooLongCount: 0,
      ksefRejectedCount: 0, correctionKsefPendingTooLongCount: 0, correctionKsefRejectedCount: 0, b2cEmailFailedCount: 0,
    },
    omnipack: {
      dispatchFailureCount: 0, staleStockSyncCount: 0, actionableShortageEvidenceCount: 0,
      providerLowerMismatchCount: 0, providerHigherMismatchCount: 0, recentQuarantinedInboundCount: 0,
      latestStatusEvidenceAt: null, latestStockSyncAt: null,
    },
    orderMoneyReconciliation: {
      ...emptyMode, checkedCount: diagnostics, mismatchCount: diagnostics,
      byMode: {
        one_time: { ...emptyMode, checkedCount: diagnostics, mismatchCount: diagnostics },
        subscription_initial: { ...emptyMode }, subscription_renewal: { ...emptyMode },
      },
      evidence: Array.from({ length: diagnostics }, (_, index) => moneyEvidence(index)),
    },
  };
}

function moneyEvidence(index: number): OrderMoneyReconciliationEvidence {
  const orderId = `fixture-${String(index).padStart(4, "0")}`;
  return {
    orderId, orderRef: `HP-${orderId}`, mode: "one_time", paymentProvider: null, subscriptionCycleId: null,
    mismatchCodes: ["trusted_provider_event_missing"],
    order: {
      id: orderId, amountCents: 1000, currency: "PLN", subtotalCents: 1000, discountCents: 0,
      shippingCents: 0, shippingDiscountCents: 0, taxCents: 0, netCents: 1000,
    },
    intent: null, attempt: null, providerEvent: null, invoice: null,
    localSettlement: { state: "not_applicable", reason: "fixture" },
    providerSettlement: { state: "not_applicable", reason: "fixture" },
    fulfillment: { fulfillmentOrderIds: [], statuses: [], handedOverAt: null },
    invoiceExpectation: { issueTrigger: "handoff", state: "not_due", anchorAt: null, dueAt: null },
    invoiceLineageIds: { rootInvoiceIds: [], invoiceIds: [], documentKeys: [], currentInvoiceId: null },
    disposition: "mismatch",
    relatedIds: {
      chargeIntentIds: [], succeededAttemptIds: [], trustedProviderEventIds: [], trustedProviderReconciliationIds: [],
      localSettlementIds: [], trustedProviderSettlementIds: [], baseInvoiceIds: [],
    },
    observedAt: NOW.toISOString(),
  };
}
