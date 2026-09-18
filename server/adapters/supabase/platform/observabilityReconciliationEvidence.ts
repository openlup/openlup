import type { PaymentReconciliationEvidenceRow } from "../../../domains/platform/paymentObservabilityEvidence.js";
import {
  selectRows,
  type SupabaseObservabilityClient,
} from "./observabilityEvidenceQueries.js";

export function selectRecentPaymentReconciliationRuns(
  client: SupabaseObservabilityClient,
  since: string,
): Promise<PaymentReconciliationEvidenceRow[]> {
  return selectRows<PaymentReconciliationEvidenceRow>(
    client.from<PaymentReconciliationEvidenceRow>("commerce_payment_reconciliation_runs")
      .select("payment_attempt_id,payment_intent_id,provider,provider_payment_id,correction_status,checked_at,payload")
      .gte("checked_at", since)
      .order("checked_at", { ascending: false })
      .limit(2000),
    "commerce_payment_reconciliation_runs",
  );
}

export function latestSuccessfulOmnipackStateConflictCount(
  rows: Array<{ job_name: string; status: string; metadata?: Record<string, unknown> | null }>,
): number {
  const row = rows.find((candidate) =>
    candidate.job_name === "omnipack-reconciliation" && candidate.status === "success"
  );
  const value = row?.metadata?.stateConflicts;
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}
