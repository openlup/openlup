import type { AlertDecision } from "./observabilityContracts.js";
import {
  ORDER_MONEY_RECONCILIATION_MODES,
  type OrderMoneyReconciliationSnapshot,
} from "./orderMoneyReconciliationContracts.js";
import { matchCanonicalMoneyLegacyException } from "./orderMoneyLegacyExceptions.js";

const RUNBOOK = "/docs/platform/RUNTIME_AND_SELF_HOSTING.md";

export function collectOrderMoneyReconciliationAlerts(
  decisions: AlertDecision[],
  snapshot: OrderMoneyReconciliationSnapshot | undefined,
  legacyMatcher: typeof matchCanonicalMoneyLegacyException = matchCanonicalMoneyLegacyException,
): void {
  if (!snapshot) return;

  for (const evidence of snapshot.evidence.filter((row) => row.mismatchCodes.length > 0)) {
    if (evidence.disposition === "accounting_missing_invoice_owner") continue;
    const confirmedMismatchCodes = evidence.mismatchCodes.filter((code) => code !== "provider_settlement_status");
    if (confirmedMismatchCodes.length === 0) continue;
    const legacyException = legacyMatcher(evidence);
    if (evidence.disposition === "accepted_legacy_exception" && legacyException) {
      decisions.push({
        dedupeKey: `canonical_order_money_legacy_exception:${evidence.orderId}`,
        severity: "p3",
        paging: "never",
        owner: "commerce/payment-accounting",
        runbookUrl: RUNBOOK,
        title: "Accepted legacy canonical money exception",
        message: `${evidence.orderRef ?? evidence.orderId} matches the audited ${legacyException.reason} exception.`,
        channels: ["webhook"],
        payload: { ...evidence, legacyExceptionReason: legacyException.reason },
      });
      continue;
    }
    decisions.push({
      dedupeKey: `canonical_order_money_mismatch:${evidence.orderId}`,
      severity: "p1",
      owner: "commerce/payment-accounting",
      runbookUrl: RUNBOOK,
      title: "Canonical order money ledger mismatch",
      message: `${evidence.orderRef ?? evidence.orderId} has ${confirmedMismatchCodes.length} confirmed cross-ledger money mismatch(es).`,
      channels: ["webhook"],
      payload: evidence,
    });
  }

  for (const evidence of snapshot.unmatchedPromotionMoneyEvidence ?? []) {
    decisions.push({
      dedupeKey: `canonical_order_money_mismatch:${evidence.orderId}`,
      severity: "p1",
      owner: "commerce/payment-accounting",
      runbookUrl: RUNBOOK,
      title: "Canonical order money promotion mismatch",
      message: `${evidence.orderId} has persisted promotion money mismatch evidence outside the current CODM row snapshot.`,
      channels: ["webhook"],
      payload: { ...evidence, evidenceState: "promotion_only" },
    });
  }
  if ((snapshot.promotionMoneyMismatchCount ?? 0) > (snapshot.promotionMoneyEvidenceCount ?? 0)) {
    decisions.push({
      dedupeKey: "canonical_order_money_promotion_mismatch_overflow",
      severity: "p1",
      owner: "commerce/payment-accounting",
      runbookUrl: RUNBOOK,
      title: "Canonical promotion money evidence exceeds bounded sample",
      message: `${snapshot.promotionMoneyMismatchCount} persisted v2 promotion money mismatch(es) exist; ${snapshot.promotionMoneyEvidenceCount ?? 0} are in the bounded per-order sample.`,
      channels: ["webhook"],
      payload: {
        mismatchCount: snapshot.promotionMoneyMismatchCount,
        sampledCount: snapshot.promotionMoneyEvidenceCount ?? 0,
      },
    });
  }

  for (const mode of ORDER_MONEY_RECONCILIATION_MODES) {
    const unsupported = snapshot.evidence.filter((row) =>
      row.mode === mode && row.providerSettlement.state === "unsupported");
    if (unsupported.length > 0) {
      decisions.push({
        dedupeKey: `canonical_order_money_settlement_unsupported:${mode}`,
        severity: "p3",
        paging: "never",
        owner: "commerce/payment-accounting",
        runbookUrl: RUNBOOK,
        title: "Provider settlement import unsupported",
        message: `${unsupported.length} ${mode} order(s) use a provider without an agreed settlement import; this is not a confirmed payment error.`,
        channels: ["webhook"],
        payload: {
          mode,
          count: unsupported.length,
          evidence: unsupported.slice(0, 25),
        },
      });
    }

    const overdue = snapshot.evidence.filter((row) =>
      row.mode === mode && row.providerSettlement.state === "overdue");
    if (overdue.length > 0) decisions.push({
      dedupeKey: `canonical_order_money_settlement_overdue:${mode}`,
      severity: "p2",
      paging: "never",
      owner: "commerce/payment-accounting",
      runbookUrl: RUNBOOK,
      title: "Provider settlement import overdue",
      message: `${overdue.length} ${mode} order(s) still lack settled payout evidence after the 14-day diagnostic deadline.`,
      channels: ["webhook"],
      payload: { mode, count: overdue.length, evidence: overdue.slice(0, 25) },
    });

    const statusReview = snapshot.evidence.filter((row) => row.mode === mode &&
      row.mismatchCodes.length === 1 && row.mismatchCodes[0] === "provider_settlement_status");
    if (statusReview.length > 0) decisions.push({
      dedupeKey: `canonical_order_money_settlement_status_review:${mode}`,
      severity: "p2",
      paging: "never",
      owner: "commerce/payment-accounting",
      runbookUrl: RUNBOOK,
      title: "Provider settlement status needs review",
      message: `${statusReview.length} ${mode} order(s) have a non-final settlement item status without a proved money/reference difference.`,
      channels: ["webhook"],
      payload: { mode, count: statusReview.length, evidence: statusReview.slice(0, 25) },
    });

    const eventUnavailable = snapshot.evidence.filter((row) =>
      row.mode === mode && row.providerEvent?.state === "unavailable");
    if (eventUnavailable.length > 0) decisions.push({
      dedupeKey: `canonical_order_money_provider_event_unavailable:${mode}`,
      severity: "p2",
      paging: "never",
      owner: "commerce/payment-accounting",
      runbookUrl: RUNBOOK,
      title: "Provider payment event money unavailable",
      message: `${eventUnavailable.length} ${mode} order(s) have a trusted success event without comparable amount/currency; no equality is inferred.`,
      channels: ["webhook"],
      payload: { mode, count: eventUnavailable.length, evidence: eventUnavailable.slice(0, 25) },
    });
  }
}
