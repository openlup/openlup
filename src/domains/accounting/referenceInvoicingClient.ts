import { getAdminAccountingOrderSummary } from "./accountingClient";
import type { AdminAccountingOrderSummaryResponse } from "./invoiceContracts";

const SAFE_CODES = new Set([
  "faulted", "missing_facts", "legacy_facts_unproved", "retryable", "blocked", "unsupported",
  "unknown", "absent", "host_binding_required", "selection_required", "disabled", "identity_mismatch",
  "parent_mismatch", "money_mismatch", "money_unavailable", "invalid_artifact", "uncertain_delivery",
]);

/** Browser HTTP consumer of the host's authorized invoicing read model. Never
 * imports the server entry at runtime; runbook URLs and mutations stay host-owned. */
export async function getReferenceInvoiceOrderSummary(...args: Parameters<typeof getAdminAccountingOrderSummary>): Promise<AdminAccountingOrderSummaryResponse> {
  const response = await getAdminAccountingOrderSummary(...args);
  const outbox = response.summary.outbox;
  const error = outbox?.lastError;
  return {
    ...response,
    summary: {
      ...response.summary,
      outbox: outbox ? { ...outbox, lastError: error ? {
        code: error.code && SAFE_CODES.has(error.code) ? error.code : "unknown",
        message: null, retryable: error.retryable,
      } : null } : null,
    },
  };
}
