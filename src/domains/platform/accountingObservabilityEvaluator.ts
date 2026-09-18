import type { AlertDecision, ObservabilitySnapshot } from "./observabilityContracts.js";

const RUNBOOK_URL = "/docs/platform/RUNTIME_AND_SELF_HOSTING.md";
const MISSING_INVOICE_RECOVERY_ACTION = "replay_accounting_invoice_issue_request_from_handoff";

export function collectAccountingAlerts(decisions: AlertDecision[], snapshot: ObservabilitySnapshot) {
  // Flag-independent (docs/platform/RUNTIME_AND_SELF_HOSTING.md Wave 7): once a provider
  // invoice exists, the customer is owed the document — a stalled delivery is
  // a promise-to-customer problem regardless of which observability gate is
  // on. Counts only issued invoices, so environments where accounting never
  // issues stay silently at zero.
  pushAccountingCountAlert(
    decisions,
    snapshot.accounting.issuedWithoutCustomerDeliveryCount ?? 0,
    "invoice_issued_without_customer_delivery",
    "Issued invoice not delivered to the customer",
    "p1",
  );

  if (snapshot.runtimeFlags.COMMERCE_ACCOUNTING_OBSERVABILITY_ENABLED !== true) return;
  pushAccountingCountAlert(
    decisions,
    snapshot.accounting.shippedWithoutInvoiceCount,
    "accounting_shipped_without_invoice",
    "Shipped order missing invoice request",
    "p1",
    {
      recoveryAction: MISSING_INVOICE_RECOVERY_ACTION,
      missingInvoiceHandoffs: snapshot.accounting.missingInvoiceHandoffs.slice(0, 10),
    },
  );
  pushAccountingCountAlert(decisions, snapshot.accounting.pendingOutboxCount, "accounting_invoice_outbox_stale", "Accounting invoice outbox stale", "p1");
  pushAccountingCountAlert(decisions, snapshot.accounting.failedOutboxCount, "accounting_invoice_outbox_failed", "Accounting invoice outbox failed", "p1");
  pushAccountingCountAlert(decisions, snapshot.accounting.failedCorrectionOutboxCount, "accounting_correction_outbox_failed", "Accounting correction outbox failed", "p1");
  pushAccountingCountAlert(decisions, snapshot.accounting.deliveryPendingCount ?? 0, "accounting_invoice_delivery_pending", "Accounting invoice delivery pending", "p2");
  pushAccountingCountAlert(decisions, snapshot.accounting.deliveryFailedCount ?? 0, "accounting_invoice_delivery_failed", "Accounting invoice delivery failed", "p1");
  pushAccountingCountAlert(decisions, snapshot.accounting.b2bWaitingKsefCount ?? 0, "accounting_b2b_waiting_ksef", "B2B invoice email waiting for KSeF acceptance", "p2");
  pushAccountingCountAlert(decisions, snapshot.accounting.ksefPendingTooLongCount, "accounting_ksef_pending_stale", "KSeF status pending too long", "p1");
  pushAccountingCountAlert(decisions, snapshot.accounting.ksefRejectedCount, "accounting_ksef_rejected", "KSeF invoice rejected", "p1");
  pushAccountingCountAlert(decisions, snapshot.accounting.correctionKsefPendingTooLongCount, "accounting_correction_ksef_pending_stale", "KSeF correction pending too long", "p1");
  pushAccountingCountAlert(decisions, snapshot.accounting.correctionKsefRejectedCount, "accounting_correction_ksef_rejected", "KSeF correction rejected", "p1");
  pushAccountingCountAlert(decisions, snapshot.accounting.b2cEmailFailedCount, "accounting_b2c_email_failed", "B2C invoice email failed", "p2");
  pushAccountingCountAlert(decisions, snapshot.accounting.blockedInvoiceCount ?? 0, "accounting_invoice_blocked", "Accounting invoice blocked", "p2");
  pushAccountingCountAlert(decisions, snapshot.accounting.invalidTaxIdBlockedCount ?? 0, "accounting_invoice_invalid_tax_id", "Accounting invoice blocked by invalid tax ID", "p2");
}

function pushAccountingCountAlert(
  decisions: AlertDecision[],
  count: number,
  dedupeKey: string,
  title: string,
  severity: "p1" | "p2",
  extraPayload: Record<string, unknown> = {},
) {
  if (count <= 0) return;
  decisions.push({
    dedupeKey,
    severity,
    owner: "commerce/accounting",
    runbookUrl: RUNBOOK_URL,
    title,
    message: `${title}: accounting support action required.`,
    channels: ["webhook"],
    payload: { count, ...extraPayload },
  });
}
