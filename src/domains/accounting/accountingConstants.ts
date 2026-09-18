export const ACCOUNTING_INVOICE_STATUSES = [
  "draft",
  "issue_requested",
  "blocked",
  "issued",
  "ksef_pending",
  "accepted",
  "rejected",
  "correction_requested",
  "corrected",
  "voided",
] as const;
export type AccountingInvoiceStatus = (typeof ACCOUNTING_INVOICE_STATUSES)[number];

export const KSEF_STATUSES = [
  "not_submitted",
  "pending",
  "accepted",
  "rejected",
  "not_required",
] as const;
export type KsefStatus = (typeof KSEF_STATUSES)[number];

export const ACCOUNTING_DOCUMENT_KINDS = ["b2b_vat", "b2c_named"] as const;
export type AccountingDocumentKind = (typeof ACCOUNTING_DOCUMENT_KINDS)[number];

export const ACCOUNTING_DOCUMENT_TYPES = [
  "fiscal_receipt",
  "b2c_invoice",
  "b2b_invoice",
  "correction_invoice",
] as const;
export type AccountingDocumentType = (typeof ACCOUNTING_DOCUMENT_TYPES)[number];

export const ACCOUNTING_BUYER_KINDS = ["consumer", "business"] as const;
export type AccountingBuyerKind = (typeof ACCOUNTING_BUYER_KINDS)[number];

export const KSEF_REQUIREMENTS = ["required", "optional", "not_applicable"] as const;
export type KsefRequirement = (typeof KSEF_REQUIREMENTS)[number];

export const ACCOUNTING_EMAIL_STATUSES = [
  "not_required",
  "pending",
  "sent",
  "failed",
] as const;
export type AccountingEmailStatus = (typeof ACCOUNTING_EMAIL_STATUSES)[number];

export const ACCOUNTING_PROVIDER_SYNC_EVENT_TYPES = [
  "invoice.created",
  "invoice.updated",
  "invoice.pdf_ready",
  "invoice.xml_ready",
  "ksef.pending",
  "ksef.accepted",
  "ksef.rejected",
  "correction.requested",
  "correction.issued",
  "correction.accepted",
  "provider.mismatch",
] as const;
export type AccountingProviderSyncEventType =
  (typeof ACCOUNTING_PROVIDER_SYNC_EVENT_TYPES)[number];

export const PAYMENT_SETTLEMENT_ITEM_STATUSES = [
  "matched",
  "unmatched",
  "mismatch",
  "bank_pending",
] as const;
export type PaymentSettlementItemStatus =
  (typeof PAYMENT_SETTLEMENT_ITEM_STATUSES)[number];

export const ACCOUNTING_ACTIVATION_GATE_CASES = [
  "fiscal_policy_approved",
  "invoice_issue_after_paid_order",
  "ksef_submit_status_sync",
  "correction_flow",
  "refund_dispute_accounting",
  "settlement_import_reconciliation",
  "provider_split_brain_quarantine",
] as const;
export type AccountingActivationGateCase =
  (typeof ACCOUNTING_ACTIVATION_GATE_CASES)[number];

export const INVOICE_DATA_LOOKUP_STATUSES = [
  "found",
  "not_found",
  "ambiguous",
  "provider_unavailable",
] as const;
export type InvoiceDataLookupStatus = (typeof INVOICE_DATA_LOOKUP_STATUSES)[number];

export const INVOICE_DATA_LOOKUP_VAT_STATUSES = [
  "active",
  "exempt",
  "not_registered",
  "unknown",
] as const;
export type InvoiceDataLookupVatStatus =
  (typeof INVOICE_DATA_LOOKUP_VAT_STATUSES)[number];
