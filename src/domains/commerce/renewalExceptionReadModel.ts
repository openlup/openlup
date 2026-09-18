import { COMMERCE_CONTRACT_VERSION } from "./types.js";
import { renewalExceptionTriageContextSchema } from "./renewalExceptionContracts.js";
import type {
  AdminCommerceRenewalExceptionEvidenceSnapshot,
  AdminCommerceRenewalExceptionRow,
  AdminCommerceRenewalExceptionsRequest,
  AdminCommerceRenewalExceptionsResponse,
  RenewalExceptionDueCycleEvidence,
  RenewalExceptionFulfillmentEvidence,
  RenewalExceptionPaymentEvidence,
  RenewalExceptionTriageContext,
} from "./renewalExceptionContracts.js";

const SEVERITY_ORDER = { p0: 0, p1: 1, p2: 2, p3: 3 } as const;

export function buildAdminCommerceRenewalExceptionsResponse(
  snapshot: AdminCommerceRenewalExceptionEvidenceSnapshot,
  // Only the paging half of the request: the window governs the baseline read
  // that already happened upstream, and this projection must not appear to
  // consume a parameter it cannot act on.
  request: Pick<AdminCommerceRenewalExceptionsRequest, "page" | "pageSize">,
): AdminCommerceRenewalExceptionsResponse {
  const rows = sortRows(dedupeRows([
    ...(snapshot.dueCycleEvidence ?? []).map((row) => mapDueCycleWithoutOrder(row, snapshot.checkedAt)),
    ...snapshot.paymentEvidence
      .filter(isPreparedWithoutProviderAck)
      .map((row) => mapPreparedWithoutProviderAck(row, snapshot.checkedAt)),
    ...snapshot.fulfillmentEvidence.map((row) => mapPaidRenewalWithoutFulfillment(row)),
  ]));
  const page = request.page;
  const pageSize = request.pageSize;
  const offset = (page - 1) * pageSize;

  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    checkedAt: snapshot.checkedAt,
    exceptions: rows.slice(offset, offset + pageSize),
    summarySignals: buildSummarySignals(snapshot),
    summaryCounts: {
      totalRows: rows.length,
      preparedWithoutProviderAck: rows.filter((row) => row.kind === "prepared_without_provider_ack").length,
      paidRenewalWithoutFulfillment: rows.filter((row) => row.kind === "paid_renewal_without_fulfillment").length,
      dueCycleWithoutOrder: rows.filter((row) => row.kind === "due_cycle_without_order").length,
      paymentRows: rows.filter((row) => row.owner === "commerce/payment").length,
      fulfillmentRows: rows.filter((row) => row.owner === "commerce/fulfillment").length,
      p0: rows.filter((row) => row.severity === "p0").length,
      p1: rows.filter((row) => row.severity === "p1").length,
      p2: rows.filter((row) => row.severity === "p2").length,
      p3: rows.filter((row) => row.severity === "p3").length,
    },
    totalCount: rows.length,
    page,
    pageSize,
    // Spread rather than `?? null`: the response schema declares this optional,
    // not nullable, so "not computed" is an absent key. Emitting an explicit
    // null would make every response that never asked for a baseline carry a
    // field asserting one was attempted.
    ...(snapshot.dunningRecovery ? { dunningRecovery: snapshot.dunningRecovery } : {}),
  };
}

function mapDueCycleWithoutOrder(
  row: RenewalExceptionDueCycleEvidence,
  checkedAt: string,
): AdminCommerceRenewalExceptionRow {
  return {
    dedupeKey: [
      "renewal-exception",
      "due_cycle_without_order",
      cleanDedupePart(row.subscriptionId, "no-subscription"),
      cleanDedupePart(row.nextCycleAt, "no-next-cycle"),
    ].join(":"),
    kind: "due_cycle_without_order",
    severity: "p1",
    owner: "commerce/subscription-support",
    customerSafeStatus: "operator_review_required",
    operatorNextAction: "inspect_subscription_scheduler",
    reason: "active_subscription_due_without_order_evidence",
    subscriptionId: cleanLocalId(row.subscriptionId),
    subscriptionCycleId: null,
    orderId: null,
    paymentIntentId: null,
    paymentAttemptId: null,
    provider: null,
    ageSeconds: safeAge(row.ageSeconds),
    observedAt: row.observedAt || checkedAt,
    orderDetailPath: null,
    triageContext: cleanTriageContext(row.triageContext, {
      localPaymentStatus: null,
      subscriptionCycleStatus: null,
      orderStatus: null,
      outboxStatus: null,
      outboxAvailableAt: null,
      outboxAttempts: null,
      fulfillmentEligibilityReason: "cycle_order_missing",
      fulfillmentRecoveryPosture: "not_retryable",
      lockedCycleSummary: null,
      futureTemplateSummary: null,
    }),
  };
}

function mapPreparedWithoutProviderAck(
  row: RenewalExceptionPaymentEvidence,
  checkedAt: string,
): AdminCommerceRenewalExceptionRow {
  return {
    dedupeKey: [
      "renewal-exception",
      "prepared_without_provider_ack",
      cleanDedupePart(row.subscriptionId, "no-subscription"),
      cleanDedupePart(row.subscriptionCycleId, "no-cycle"),
      cleanDedupePart(row.paymentIntentId, "no-intent"),
      cleanDedupePart(row.paymentAttemptId, "no-attempt"),
    ].join(":"),
    kind: "prepared_without_provider_ack",
    severity: "p1",
    owner: "commerce/payment",
    customerSafeStatus: "operator_review_required",
    operatorNextAction: "inspect_provider_before_retry",
    reason: "prepared_subscription_attempt_without_provider_ack",
    subscriptionId: cleanLocalId(row.subscriptionId),
    subscriptionCycleId: cleanLocalId(row.subscriptionCycleId),
    orderId: cleanLocalId(row.orderId),
    paymentIntentId: cleanLocalId(row.paymentIntentId),
    paymentAttemptId: cleanLocalId(row.paymentAttemptId),
    provider: cleanProvider(row.provider),
    ageSeconds: safeAge(row.ageSeconds),
    observedAt: row.observedAt || checkedAt,
    orderDetailPath: orderDetailPath(row.orderId),
    triageContext: cleanTriageContext(row.triageContext, {
      localPaymentStatus: "processing",
      subscriptionCycleStatus: null,
      orderStatus: null,
      outboxStatus: null,
      outboxAvailableAt: null,
      outboxAttempts: null,
      fulfillmentEligibilityReason: "payment_provider_ack_missing",
      fulfillmentRecoveryPosture: "not_retryable",
      lockedCycleSummary: null,
      futureTemplateSummary: null,
    }),
  };
}

function mapPaidRenewalWithoutFulfillment(
  row: RenewalExceptionFulfillmentEvidence,
): AdminCommerceRenewalExceptionRow {
  return {
    dedupeKey: [
      "renewal-exception",
      "paid_renewal_without_fulfillment",
      cleanDedupePart(row.orderId, "no-order"),
      cleanDedupePart(row.subscriptionCycleId, "no-cycle"),
    ].join(":"),
    kind: "paid_renewal_without_fulfillment",
    severity: "p1",
    owner: "commerce/fulfillment",
    customerSafeStatus: "paid_fulfillment_pending",
    operatorNextAction: "inspect_fulfillment_dispatch",
    reason: "paid_subscription_cycle_order_without_fulfillment_order",
    subscriptionId: cleanLocalId(row.subscriptionId),
    subscriptionCycleId: cleanLocalId(row.subscriptionCycleId),
    orderId: cleanLocalId(row.orderId),
    paymentIntentId: null,
    paymentAttemptId: null,
    provider: null,
    ageSeconds: safeAge(row.ageSeconds),
    observedAt: row.observedAt,
    orderDetailPath: orderDetailPath(row.orderId),
    triageContext: cleanTriageContext(row.triageContext, {
      localPaymentStatus: "succeeded",
      subscriptionCycleStatus: "paid",
      orderStatus: "paid",
      outboxStatus: null,
      outboxAvailableAt: null,
      outboxAttempts: null,
      fulfillmentEligibilityReason: "paid_cycle_order_without_fulfillment",
      fulfillmentRecoveryPosture: "manual_review",
      lockedCycleSummary: null,
      futureTemplateSummary: null,
    }),
  };
}

function isPreparedWithoutProviderAck(row: RenewalExceptionPaymentEvidence): boolean {
  return row.kind === "prepared_without_provider_ack";
}

function buildSummarySignals(snapshot: AdminCommerceRenewalExceptionEvidenceSnapshot) {
  const due = snapshot.dueCycleWithoutOrderCount;
  if (due <= 0) return [];
  return [{
    kind: "due_cycle_without_order" as const,
    count: due,
    severity: "p1" as const,
    owner: "commerce/subscription-support" as const,
    customerSafeStatus: "operator_review_required" as const,
    operatorNextAction: "inspect_subscription_scheduler" as const,
    reason: "active_subscription_due_without_order_evidence",
  }];
}

function dedupeRows(rows: AdminCommerceRenewalExceptionRow[]): AdminCommerceRenewalExceptionRow[] {
  const byKey = new Map<string, AdminCommerceRenewalExceptionRow>();
  for (const row of rows) {
    const current = byKey.get(row.dedupeKey);
    if (!current || row.ageSeconds > current.ageSeconds) byKey.set(row.dedupeKey, row);
  }
  return [...byKey.values()];
}

function sortRows(rows: AdminCommerceRenewalExceptionRow[]): AdminCommerceRenewalExceptionRow[] {
  return [...rows].sort((a, b) =>
    SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
    b.ageSeconds - a.ageSeconds ||
    a.kind.localeCompare(b.kind) ||
    a.dedupeKey.localeCompare(b.dedupeKey),
  );
}

function orderDetailPath(orderId: string | null | undefined): string | null {
  return orderId ? `/api/bff/admin/commerce/orders/detail?orderId=${encodeURIComponent(orderId)}` : null;
}

function cleanLocalId(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, 128) : null;
}

function cleanDedupePart(value: string | null | undefined, fallback: string): string {
  return cleanLocalId(value) ?? fallback;
}

function cleanProvider(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toLowerCase();
  if (!trimmed || !/^[a-z0-9_-]{1,32}$/.test(trimmed)) return null;
  return trimmed;
}

function safeAge(value: number | null | undefined): number {
  return Number.isFinite(value) && value && value > 0 ? Math.floor(value) : 0;
}

function cleanTriageContext(
  value: RenewalExceptionTriageContext | null | undefined,
  fallback: RenewalExceptionTriageContext,
): RenewalExceptionTriageContext {
  const parsed = renewalExceptionTriageContextSchema.safeParse(value);
  return parsed.success ? parsed.data : fallback;
}
