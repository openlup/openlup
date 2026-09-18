import type {
  SubscriptionExceptionSnapshotSummary,
  SubscriptionExceptionTriageContext,
  SubscriptionFulfillmentEligibilityReason,
  SubscriptionFulfillmentRecoveryPosture,
} from "../../../src/domains/platform/observabilityContracts.js";
import type { OutboxEventEvidenceRow } from "./outboxObservabilityEvidence.js";
import type {
  SubscriptionCycleEvidenceRow,
  SubscriptionEvidenceRow,
  SubscriptionOrderEvidenceRow,
  SubscriptionPaymentIntentEvidenceRow,
} from "./subscriptionObservabilityEvidence.js";

export function buildDueCycleTriageContext(subscription: SubscriptionEvidenceRow): SubscriptionExceptionTriageContext {
  return {
    localPaymentStatus: null,
    subscriptionCycleStatus: null,
    orderStatus: null,
    outboxStatus: null,
    outboxAvailableAt: null,
    outboxAttempts: null,
    fulfillmentEligibilityReason: "cycle_order_missing",
    fulfillmentRecoveryPosture: "not_retryable",
    lockedCycleSummary: null,
    futureTemplateSummary: summarizeFutureTemplate(subscription),
  };
}

export function buildPaidFulfillmentTriageContext(input: {
  order: SubscriptionOrderEvidenceRow;
  subscription: SubscriptionEvidenceRow | undefined;
  cycle: SubscriptionCycleEvidenceRow | undefined;
  paymentIntent: SubscriptionPaymentIntentEvidenceRow | undefined;
  outboxEvent: OutboxEventEvidenceRow | undefined;
}): SubscriptionExceptionTriageContext {
  const outboxStatus = cleanStatus(input.outboxEvent?.status) ?? "missing";
  return {
    localPaymentStatus: cleanStatus(input.paymentIntent?.status),
    subscriptionCycleStatus: cleanStatus(input.cycle?.status),
    orderStatus: cleanStatus(input.order.status),
    outboxStatus,
    outboxAvailableAt: isoOrNull(input.outboxEvent?.available_at),
    outboxAttempts: input.outboxEvent ? numberOrNull(input.outboxEvent.attempts) : null,
    fulfillmentEligibilityReason: fulfillmentEligibilityReason(input.outboxEvent),
    fulfillmentRecoveryPosture: fulfillmentRecoveryPosture(input.outboxEvent),
    lockedCycleSummary: input.cycle ? summarizeLockedCycle(input.cycle, input.order) : null,
    futureTemplateSummary: input.subscription ? summarizeFutureTemplate(input.subscription) : null,
  };
}

export function latestBy<T extends { created_at?: string | null; updated_at?: string | null }>(
  rows: T[],
  key: (row: T) => string,
): Map<string, T> {
  const result = new Map<string, T>();
  for (const row of rows) {
    const rowKey = key(row);
    const current = result.get(rowKey);
    if (!current || timestamp(row.updated_at ?? row.created_at) >= timestamp(current.updated_at ?? current.created_at)) {
      result.set(rowKey, row);
    }
  }
  return result;
}

export function isoOrNull(value: string | null | undefined): string | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function fulfillmentEligibilityReason(
  outboxEvent: OutboxEventEvidenceRow | undefined,
): SubscriptionFulfillmentEligibilityReason {
  if (!outboxEvent) return "order_paid_outbox_missing";
  if (["pending", "processing"].includes(outboxEvent.status)) return "order_paid_outbox_pending";
  if (outboxEvent.status === "failed") return "order_paid_outbox_failed_retrying";
  if (outboxEvent.status === "discarded") return "order_paid_outbox_discarded";
  if (outboxEvent.status === "processed") return "order_paid_outbox_processed_without_fulfillment";
  return "paid_cycle_order_without_fulfillment";
}

function fulfillmentRecoveryPosture(
  outboxEvent: OutboxEventEvidenceRow | undefined,
): SubscriptionFulfillmentRecoveryPosture {
  if (!outboxEvent) return "manual_review";
  if (["pending", "processing"].includes(outboxEvent.status)) return "wait_for_outbox";
  if (outboxEvent.status === "failed") return "wait_for_outbox";
  if (outboxEvent.status === "discarded") return "existing_outbox_replay_required";
  return "manual_review";
}

function summarizeLockedCycle(
  cycle: SubscriptionCycleEvidenceRow,
  order: SubscriptionOrderEvidenceRow,
): SubscriptionExceptionSnapshotSummary {
  const payloads = [cycle.template_snapshot, cycle.order_snapshot, order.metadata];
  return {
    status: cleanStatus(cycle.status),
    scheduledAt: isoOrNull(cycle.scheduled_at),
    nextCycleAt: null,
    templateVersion: numberOrNull(cycle.template_version ?? cycle.version),
    lineCount: extractLineCount(payloads),
    totalQuantity: extractTotalQuantity(payloads),
  };
}

function summarizeFutureTemplate(subscription: SubscriptionEvidenceRow): SubscriptionExceptionSnapshotSummary {
  const payloads = [subscription.template_snapshot, subscription.package_template, subscription.metadata];
  return {
    status: cleanStatus(subscription.status) ?? "active",
    scheduledAt: null,
    nextCycleAt: isoOrNull(subscription.next_cycle_at),
    templateVersion: numberOrNull(subscription.template_version ?? subscription.version),
    lineCount: extractLineCount(payloads),
    totalQuantity: extractTotalQuantity(payloads),
  };
}

function cleanStatus(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  return trimmed && /^[a-z0-9_.:-]{1,64}$/.test(trimmed) ? trimmed : null;
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null;
}

function extractLineCount(sources: unknown[]): number | null {
  const lines = firstLineArray(sources);
  return lines ? lines.length : null;
}

function extractTotalQuantity(sources: unknown[]): number | null {
  const lines = firstLineArray(sources);
  if (!lines) return null;
  const total = lines.reduce<number>((sum, line) => sum + numericLineQuantity(line), 0);
  return total > 0 ? total : null;
}

function firstLineArray(sources: unknown[]): unknown[] | null {
  for (const source of sources) {
    const object = objectOrNull(source);
    const lines = object?.lines ?? object?.items ?? object?.products ?? object?.recipes ?? object?.addons;
    if (Array.isArray(lines)) return lines;
  }
  return null;
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numericLineQuantity(value: unknown): number {
  const object = objectOrNull(value);
  const raw = object?.quantity ?? object?.qty ?? object?.count;
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function timestamp(value: string | null | undefined): number {
  const parsed = value ? Date.parse(value) : 0;
  return Number.isFinite(parsed) ? parsed : 0;
}
