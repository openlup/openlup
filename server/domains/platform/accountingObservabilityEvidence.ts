import type { AccountingMissingInvoiceHandoffEvidence } from "../../../src/domains/platform/observabilityContracts.js";

export type AccountingInvoiceEvidenceRow = Record<string, unknown> & {
  id: string;
  order_id: string;
  created_at: string;
  provider_invoice_id?: string | null;
  document_kind?: string | null;
  ksef_required?: boolean;
  ksef_status: string;
  ksef_updated_at?: string | null;
  email_status?: string | null;
  correction_status?: string | null;
  status?: string | null;
  blocked_reason?: string | null;
};

export type AccountingInvoiceOutboxEvidenceRow = Record<string, unknown> & {
  id: string;
  created_at: string;
  status: string;
  next_attempt_at?: string | null;
};

export type AccountingCorrectionOutboxEvidenceRow = Record<string, unknown> & {
  id: string;
  created_at: string;
  status: string;
  next_attempt_at?: string | null;
};

export type AccountingDeliveryOutboxEvidenceRow = Record<string, unknown> & {
  id: string;
  created_at: string;
  status: string;
  next_attempt_at?: string | null;
};

export type FulfillmentOrderEvidenceRow = Record<string, unknown> & {
  id: string;
  order_id: string;
  status: string;
  provider_kind?: string | null;
  handed_over_at?: string | null;
};

const ACCOUNTING_RECOVERY_ACTION = "replay_accounting_invoice_issue_request_from_handoff" as const;
const MISSING_INVOICE_GRACE_SECONDS = 60 * 60;

export function summarizeAccountingEvidence(
  invoices: AccountingInvoiceEvidenceRow[],
  outbox: AccountingInvoiceOutboxEvidenceRow[],
  correctionOutbox: AccountingCorrectionOutboxEvidenceRow[],
  deliveryOutbox: AccountingDeliveryOutboxEvidenceRow[],
  fulfillmentOrders: FulfillmentOrderEvidenceRow[],
  now: Date,
) {
  const invoiceOrderIds = new Set(invoices.map((row) => row.order_id));
  const staleOutboxCutoff = now.getTime() - 60 * 60 * 1000;
  const staleKsefCutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const customerDeliveryCutoff = now.getTime() - 24 * 60 * 60 * 1000;
  const missingInvoiceHandoffs = collectMissingInvoiceHandoffs(fulfillmentOrders, invoiceOrderIds, now);
  return {
    shippedWithoutInvoiceCount: missingInvoiceHandoffs.length,
    missingInvoiceHandoffs,
    issueRequestedCount: invoices.filter((row) => row.status === "issue_requested").length,
    providerCreatedCount: invoices.filter((row) => Boolean(row.provider_invoice_id)).length,
    pendingOutboxCount: outbox.filter((row) =>
      row.status === "pending" &&
      new Date(row.next_attempt_at ?? row.created_at).getTime() <= staleOutboxCutoff,
    ).length,
    failedOutboxCount: outbox.filter((row) => row.status === "failed").length,
    failedCorrectionOutboxCount: correctionOutbox.filter((row) => row.status === "failed").length,
    deliveryPendingCount: deliveryOutbox.filter((row) =>
      row.status === "pending" &&
      new Date(row.next_attempt_at ?? row.created_at).getTime() <= staleOutboxCutoff,
    ).length,
    deliveryFailedCount: deliveryOutbox.filter((row) => ["failed", "uncertain"].includes(row.status)).length,
    b2bWaitingKsefCount: invoices.filter((row) =>
      row.document_kind === "b2b_vat" &&
      row.ksef_required === true &&
      !["accepted", "not_required"].includes(row.ksef_status) &&
      row.email_status !== "sent",
    ).length,
    ksefPendingTooLongCount: invoices.filter((row) =>
      row.ksef_required === true &&
      row.ksef_status === "pending" &&
      new Date(row.ksef_updated_at ?? row.created_at).getTime() <= staleKsefCutoff,
    ).length,
    ksefRejectedCount: invoices.filter((row) => row.ksef_status === "rejected").length,
    correctionKsefPendingTooLongCount: invoices.filter((row) =>
      row.correction_status === "issued" &&
      row.ksef_required === true &&
      row.ksef_status === "pending" &&
      new Date(row.ksef_updated_at ?? row.created_at).getTime() <= staleKsefCutoff,
    ).length,
    correctionKsefRejectedCount: invoices.filter((row) =>
      row.correction_status === "issued" && row.ksef_status === "rejected",
    ).length,
    b2cEmailFailedCount: invoices.filter((row) =>
      row.document_kind === "b2c_named" && row.email_status === "failed",
    ).length,
    blockedInvoiceCount: invoices.filter((row) => row.status === "blocked" || row.blocked_reason).length,
    invalidTaxIdBlockedCount: invoices.filter((row) =>
      row.status === "blocked" && row.blocked_reason === "invalid_tax_id",
    ).length,
    // Customer-receipt boundary (docs/platform/RUNTIME_AND_SELF_HOSTING.md Wave 7): a
    // provider invoice EXISTS but the customer email is still not `sent` a
    // full day later — regardless of WHICH stage stalled (delivery outbox,
    // KSeF wait, provider email). Per-stage detectors explain the why; this
    // one guarantees the what. Blocked invoices are excluded (they have their
    // own alert and a deliberate operator gate).
    issuedWithoutCustomerDeliveryCount: invoices.filter((row) =>
      Boolean(row.provider_invoice_id) &&
      row.email_status !== "sent" &&
      row.status !== "blocked" &&
      new Date(row.created_at).getTime() <= customerDeliveryCutoff,
    ).length,
  };
}

function collectMissingInvoiceHandoffs(
  fulfillmentOrders: FulfillmentOrderEvidenceRow[],
  invoiceOrderIds: Set<string>,
  now: Date,
): AccountingMissingInvoiceHandoffEvidence[] {
  return fulfillmentOrders
    .filter((row) =>
      Boolean(row.handed_over_at) &&
      !invoiceOrderIds.has(row.order_id),
    )
    .map((row) => ({
      kind: "handoff_missing_invoice_request" as const,
      fulfillmentOrderId: row.id,
      orderId: row.order_id,
      status: row.status,
      handedOverAt: row.handed_over_at ?? "",
      ageSeconds: secondsSince(row.handed_over_at ?? "", now),
      reason: "no_accounting_invoice_for_fulfillment_handoff" as const,
      recoveryAction: ACCOUNTING_RECOVERY_ACTION,
      observedAt: now.toISOString(),
    }))
    .filter((row) => row.ageSeconds >= MISSING_INVOICE_GRACE_SECONDS)
    .sort((a, b) => b.ageSeconds - a.ageSeconds || a.fulfillmentOrderId.localeCompare(b.fulfillmentOrderId));
}

function secondsSince(timestamp: string, now: Date): number {
  const value = new Date(timestamp).getTime();
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor((now.getTime() - value) / 1000));
}
