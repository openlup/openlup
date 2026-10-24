import { resolveInvoiceDocumentHistory } from "@openlup/platform/invoicing";

export type AccountingDocumentRole = "original" | "correction" | "replacement";
export type AccountingDocumentArtifact = "invoice" | "correction";
export type AccountingDocumentEmailState = "not_requested" | "pending" | "provider_accepted" | "failed";

export type AccountingDocumentHistoryRow = Record<string, unknown>;

export interface AccountingDocumentHistoryEntry {
  documentKey: string;
  invoiceId: string;
  orderId: string;
  invoiceRef: string;
  role: AccountingDocumentRole;
  artifact: AccountingDocumentArtifact;
  status: string;
  blockedReason: string | null;
  documentKind: string | null;
  providerKind: string | null;
  providerInvoiceId: string | null;
  providerInvoiceNumber: string | null;
  ksefNumber: string | null;
  ksefStatus: string;
  totalGrossMinor: number | null;
  /**
   * The currency the document was **issued in**, copied from
   * `accounting_invoices.currency` (`NOT NULL CHECK (char_length = 3)`).
   *
   * It travels with the amount rather than being resolved by whoever renders it. An
   * issued invoice is the most historical money the platform holds: it is a document
   * of record whose denomination was fixed the day it was written, and a reader that
   * asked the current settlement profile instead would re-label the customer's own
   * accounting the first time a deployment changed what it sells in.
   */
  currency: string;
  issuedAt: string | null;
  createdAt: string;
  isCurrent: boolean;
  downloadAvailable: boolean;
  emailState: AccountingDocumentEmailState;
}

export interface AccountingDocumentHistory {
  current: AccountingDocumentHistoryEntry | null;
  documents: AccountingDocumentHistoryEntry[];
}

interface ResolveAccountingDocumentHistoryInput {
  invoices: AccountingDocumentHistoryRow[];
  operations?: AccountingDocumentHistoryRow[];
  deliveryOutboxes?: AccountingDocumentHistoryRow[];
  providerArtifactEligible?: (providerKind: string) => boolean;
}

export function resolveAccountingDocumentHistory(input: ResolveAccountingDocumentHistoryInput): AccountingDocumentHistory {
  const project = (row: AccountingDocumentHistoryRow) => ({
    ...row,
    provider_document_ref: row.provider_invoice_id,
    provider_document_number: row.provider_invoice_number,
    clearance_reference: row.ksef_number,
    clearance_state: row.ksef_status,
    total_gross_minor: row.total_gross_cents,
    metadata: {
      ...record(row.metadata),
      correctionProviderDocumentRef: record(row.metadata).correctionProviderInvoiceId,
      correctionProviderDocumentNumber: record(row.metadata).correctionProviderInvoiceNumber,
      providerDocumentRef: record(row.metadata).providerInvoiceId,
    },
    payload: { ...record(row.payload), providerDocumentRef: record(row.payload).providerInvoiceId },
  });
  const history = resolveInvoiceDocumentHistory({
    ...input,
    invoices: input.invoices.map(project),
    operations: input.operations?.map(project),
    deliveryOutboxes: input.deliveryOutboxes?.map(project),
  });
  const documents = history.documents.map(({ providerDocumentRef, providerDocumentNumber, clearanceReference, clearanceState, parentDocumentRef: _parent, ...document }) => ({
    ...document, providerInvoiceId: providerDocumentRef, providerInvoiceNumber: providerDocumentNumber,
    ksefNumber: clearanceReference, ksefStatus: clearanceState,
  }));
  return { current: documents.find(document => document.isCurrent) ?? null, documents };
}
function record(value: unknown): AccountingDocumentHistoryRow {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AccountingDocumentHistoryRow : {};
}
