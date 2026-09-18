import type { AlertDecision } from "../src/domains/platform/observabilityContracts.ts";
import {
  ORDER_MONEY_RECONCILIATION_MODES,
  type OrderMoneyReconciliationMode,
  type OrderMoneyReconciliationSnapshot,
} from "../src/domains/platform/orderMoneyReconciliationContracts.ts";
import type { PlatformWatchdogResult } from "../server/domains/platform/platformWatchdogService.ts";
import {
  requireOrderMoneyEvidence,
  type OrderMoneyEvidenceLedgerProbe,
  type OrderMoneyReconciliationEvidenceFixture,
} from "./order-money-reconciliation-local-rehearsal-contracts.ts";

export function assertReconciliationFixture(
  snapshot: OrderMoneyReconciliationSnapshot,
  fixture: OrderMoneyReconciliationEvidenceFixture,
): void {
  requireOrderMoneyEvidence(snapshot.checkedCount === 4, `expected 4 checked orders, got ${snapshot.checkedCount}`);
  requireOrderMoneyEvidence(snapshot.mismatchCount === 1, `expected 1 mismatch, got ${snapshot.mismatchCount}`);
  requireOrderMoneyEvidence(snapshot.providerUnavailableCount === 3, `expected 3 unavailable provider readbacks, got ${snapshot.providerUnavailableCount}`);
  requireOrderMoneyEvidence(snapshot.byMode.one_time.checkedCount === 2, "one_time grouping must contain healthy + unavailable");
  requireOrderMoneyEvidence(snapshot.byMode.subscription_initial.checkedCount === 1, "subscription_initial grouping missing");
  requireOrderMoneyEvidence(snapshot.byMode.subscription_renewal.checkedCount === 1, "subscription_renewal grouping missing");

  const healthy = snapshot.evidence.find((row) => row.orderId === fixture.ids.healthyOrderId);
  requireOrderMoneyEvidence(healthy, "healthy order evidence missing");
  requireOrderMoneyEvidence(healthy.mismatchCodes.length === 0, "healthy order unexpectedly mismatched");
  requireOrderMoneyEvidence(healthy.providerSettlement.state === "matched", "healthy provider settlement must be matched");

  const mismatch = snapshot.evidence.find((row) => row.orderId === fixture.ids.mismatchOrderId);
  requireOrderMoneyEvidence(mismatch, "mismatch order evidence missing");
  requireOrderMoneyEvidence(mismatch.mismatchCodes.includes("intent_amount"), "seeded intent mismatch was not detected");

  for (const mode of ORDER_MONEY_RECONCILIATION_MODES) {
    const row = snapshot.evidence.find((evidence) => evidence.orderId === fixture.ids.unavailableByMode[mode]);
    requireOrderMoneyEvidence(row?.mode === mode, `missing ${mode} fixture evidence`);
    requireOrderMoneyEvidence(row.providerSettlement.state === "unsupported", `${mode} settlement import must be unsupported`);
  }
}

export function assertFirstWatchdogRun(
  result: PlatformWatchdogResult,
  fixture: OrderMoneyReconciliationEvidenceFixture,
): void {
  const expected = expectedDecisionKeys(fixture);
  requireOrderMoneyEvidence(sameStrings(decisionKeys(result), expected), "first run emitted unexpected decision keys");
  requireOrderMoneyEvidence(result.notified === 1, `first run should page one confirmed mismatch, got ${result.notified}`);
  requireOrderMoneyEvidence(result.skippedNotifications === 3, "all three provider-unavailable diagnostics must be skipped");
  requireOrderMoneyEvidence(result.belowThreshold === 3, "all three provider-unavailable diagnostics must stay non-pageable");
  requireOrderMoneyEvidence(decision(result, mismatchKey(fixture)).severity === "p1", "confirmed mismatch must be p1");

  for (const mode of ORDER_MONEY_RECONCILIATION_MODES) {
    const diagnostic = decision(result, unavailableKey(mode));
    requireOrderMoneyEvidence(diagnostic.paging === "never", `${mode} unavailable diagnostic must set paging:never`);
    requireOrderMoneyEvidence(diagnostic.severity === "p3", `${mode} unavailable diagnostic must be p3`);
    requireOrderMoneyEvidence(payloadContainsOrder(diagnostic.payload, fixture.ids.unavailableByMode[mode]), `${mode} diagnostic lost fixture evidence`);
  }
  requireOrderMoneyEvidence(!JSON.stringify(result.decisions).includes(fixture.ids.healthyOrderId), "healthy order must not produce an alert decision");
}

export function assertSecondWatchdogRun(
  first: PlatformWatchdogResult,
  second: PlatformWatchdogResult,
  ledger: OrderMoneyEvidenceLedgerProbe,
  sent: AlertDecision[],
  fixture: OrderMoneyReconciliationEvidenceFixture,
): void {
  const expected = expectedDecisionKeys(fixture);
  requireOrderMoneyEvidence(sameStrings(decisionKeys(first), decisionKeys(second)), "second run changed stable decision keys");
  requireOrderMoneyEvidence(sameStrings(decisionKeys(second), expected), "second run lost expected decisions");
  requireOrderMoneyEvidence(new Set(decisionKeys(second)).size === expected.length, "second run contains duplicate decisions");
  requireOrderMoneyEvidence(second.notified === 0, "second run bypassed notification dedupe/throttle");
  requireOrderMoneyEvidence(second.skippedNotifications === 0, "second run rewrote diagnostic notification evidence");
  requireOrderMoneyEvidence(ledger.alerts.length === expected.length, "second run created duplicate durable alert rows");
  requireOrderMoneyEvidence(sameStrings(ledger.alerts.map((row) => row.dedupeKey), expected), "durable alert keys do not match decisions");
  requireOrderMoneyEvidence(ledger.notifications.length === expected.length, "first run should record one outcome per decision only");
  requireOrderMoneyEvidence(sent.length === 1 && sent[0].dedupeKey === mismatchKey(fixture), "provider-unavailable diagnostic reached paging sink");
  for (const mode of ORDER_MONEY_RECONCILIATION_MODES) {
    const recorded = ledger.notifications.find((row) => row.dedupeKey === unavailableKey(mode));
    requireOrderMoneyEvidence(recorded?.outcome.status === "skipped", `${mode} diagnostic lacks skipped notification evidence`);
    requireOrderMoneyEvidence(recorded.outcome.error === "non_pageable_diagnostic", `${mode} diagnostic used wrong non-pageable outcome`);
  }
}

export function decisionKeys(result: PlatformWatchdogResult): string[] {
  return result.decisions.map((row) => row.dedupeKey).sort();
}

function expectedDecisionKeys(fixture: OrderMoneyReconciliationEvidenceFixture): string[] {
  return [mismatchKey(fixture), ...ORDER_MONEY_RECONCILIATION_MODES.map(unavailableKey)].sort();
}

function mismatchKey(fixture: OrderMoneyReconciliationEvidenceFixture): string {
  return `canonical_order_money_mismatch:${fixture.ids.mismatchOrderId}`;
}

function unavailableKey(mode: OrderMoneyReconciliationMode): string {
  return `canonical_order_money_settlement_unsupported:${mode}`;
}

function decision(result: PlatformWatchdogResult, dedupeKey: string): AlertDecision {
  const found = result.decisions.find((row) => row.dedupeKey === dedupeKey);
  requireOrderMoneyEvidence(found, `missing watchdog decision ${dedupeKey}`);
  return found;
}

function payloadContainsOrder(payload: Record<string, unknown>, orderId: string): boolean {
  const evidence = payload.evidence;
  return Array.isArray(evidence) && evidence.some((row) =>
    typeof row === "object" && row !== null && "orderId" in row && row.orderId === orderId);
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}
