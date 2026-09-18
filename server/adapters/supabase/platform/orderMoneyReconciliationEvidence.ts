import type { ObservabilityEvidencePort } from "../../../../src/domains/platform/observabilityPorts.js";
import type { AccountingInvoiceIssueTrigger } from "../../../../src/domains/platform/orderMoneyReconciliationContracts.js";
import { summarizeOrderMoneyReconciliation } from "../../../domains/platform/orderMoneyReconciliationEvidence.js";
import { readOrderMoneyReconciliationRows } from "./orderMoneyReconciliationRows.js";
import type { SupabaseObservabilityClient } from "./observabilityEvidenceQueries.js";

export function withOrderMoneyReconciliationEvidence(
  base: ObservabilityEvidencePort,
  client: SupabaseObservabilityClient,
  options: { issueTrigger: AccountingInvoiceIssueTrigger },
): ObservabilityEvidencePort {
  return {
    async collectSnapshot(now) {
      const [snapshot, rows] = await Promise.all([
        base.collectSnapshot(now),
        readOrderMoneyReconciliationRows(client),
      ]);
      return {
        ...snapshot,
        orderMoneyReconciliation: summarizeOrderMoneyReconciliation(rows, now, options),
      };
    },
  };
}
