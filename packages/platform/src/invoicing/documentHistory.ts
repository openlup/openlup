type InvoiceDocumentRole = "original" | "correction" | "replacement";
type InvoiceDocumentArtifact = "invoice" | "correction";
type InvoiceDocumentEmailState = "not_requested" | "pending" | "provider_accepted" | "failed";

type InvoiceDocumentHistoryRow = Record<string, unknown>;

interface InvoiceDocumentHistoryEntry {
  documentKey: string;
  invoiceId: string;
  parentDocumentRef: string | null;
  orderId: string;
  invoiceRef: string;
  role: InvoiceDocumentRole;
  artifact: InvoiceDocumentArtifact;
  status: string;
  blockedReason: string | null;
  documentKind: string | null;
  providerKind: string | null;
  providerDocumentRef: string | null;
  providerDocumentNumber: string | null;
  clearanceReference: string | null;
  clearanceState: string;
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
  emailState: InvoiceDocumentEmailState;
}

interface InvoiceDocumentHistory {
  current: InvoiceDocumentHistoryEntry | null;
  documents: InvoiceDocumentHistoryEntry[];
}

interface ResolveInvoiceDocumentHistoryInput {
  invoices: InvoiceDocumentHistoryRow[];
  operations?: InvoiceDocumentHistoryRow[];
  deliveryOutboxes?: InvoiceDocumentHistoryRow[];
  providerArtifactEligible?: (providerKind: string) => boolean;
}

const CURRENT_STATUSES = new Set(["issued", "accepted"]);
const HISTORICAL_INVOICE_STATUSES = new Set(["issued", "accepted", "corrected"]);

export function resolveInvoiceDocumentHistory({
  invoices,
  operations = [],
  deliveryOutboxes = [],
  providerArtifactEligible = () => true,
}: ResolveInvoiceDocumentHistoryInput): InvoiceDocumentHistory {
  const orderedInvoices = [...invoices].sort(compareRowsChronologically);
  const correctionOperations = operations.filter((row) => text(row.operation) === "correction_issued");
  const activeInvoice = [...orderedInvoices]
    .filter((row) => currentInvoiceEligible(row, providerArtifactEligible))
    .sort(compareRowsNewestFirst)[0] ?? null;
  const activeInvoiceId = activeInvoice ? text(activeInvoice.id) : null;
  const documents: InvoiceDocumentHistoryEntry[] = [];

  for (const invoice of orderedInvoices) {
    const invoiceId = text(invoice.id);
    const replacement = nullableText(invoice.correction_of_invoice_id) !== null;
    const providerDocumentRef = nullableText(invoice.provider_document_ref);
    documents.push({
      documentKey: `invoice:${invoiceId}`,
      invoiceId,
      parentDocumentRef: replacement ? `invoice:${nullableText(invoice.correction_of_invoice_id)}` : null,
      orderId: text(invoice.order_id),
      invoiceRef: text(invoice.invoice_ref),
      role: replacement ? "replacement" : "original",
      artifact: "invoice",
      status: text(invoice.status),
      blockedReason: nullableText(invoice.blocked_reason),
      documentKind: nullableText(invoice.document_kind),
      providerKind: nullableText(invoice.provider_kind),
      providerDocumentRef,
      providerDocumentNumber: nullableText(invoice.provider_document_number),
      clearanceReference: nullableText(invoice.clearance_reference),
      clearanceState: text(invoice.clearance_state),
      totalGrossMinor: nonnegativeNumber(invoice.total_gross_minor),
      currency: text(invoice.currency),
      issuedAt: nullableText(invoice.created_at),
      createdAt: text(invoice.created_at),
      isCurrent: invoiceId === activeInvoiceId,
      downloadAvailable: historicalInvoiceDownloadEligible(invoice, providerArtifactEligible),
      emailState: resolveEmailState({
        invoice,
        providerDocumentRef,
        operations,
        deliveryOutboxes,
        preferInvoiceFallback: !correctionProviderDocumentRef(invoice),
      }),
    });

    const correctionProviderId = correctionProviderDocumentRef(invoice);
    if (!correctionProviderId) continue;
    const correctionOperation = correctionOperations
      .filter((row) => text(row.invoice_id) === invoiceId)
      .sort(compareRowsNewestFirst)[0] ?? null;
    const correctionNumber = correctionProviderDocumentNumber(invoice);
    const correctionCreatedAt = nullableText(correctionOperation?.created_at)
      ?? laterTimestamp(text(invoice.updated_at), text(invoice.created_at));
    const providerKind = nullableText(invoice.provider_kind);
    const persistedCorrectionStatus = normalize(invoice.correction_status);
    const correctionStatus = ["issued", "accepted"].includes(persistedCorrectionStatus)
      ? persistedCorrectionStatus
      : "not_ready";
    documents.push({
      documentKey: `correction:${invoiceId}`,
      invoiceId,
      parentDocumentRef: `invoice:${invoiceId}`,
      orderId: text(invoice.order_id),
      invoiceRef: correctionNumber ?? `correction-${text(invoice.invoice_ref)}`.slice(0, 160),
      role: "correction",
      artifact: "correction",
      status: correctionStatus,
      blockedReason: nullableText(invoice.blocked_reason),
      documentKind: "correction",
      providerKind,
      providerDocumentRef: correctionProviderId,
      providerDocumentNumber: correctionNumber,
      clearanceReference: null,
      clearanceState: "not_required",
      totalGrossMinor: null,
      // A correction has no total of its own on this row, but it is a document of the
      // same invoice and therefore of the same currency. Stating it keeps the field
      // total, so a consumer never has to ask "which document has a currency?".
      currency: text(invoice.currency),
      issuedAt: correctionCreatedAt || null,
      createdAt: correctionCreatedAt,
      isCurrent: false,
      downloadAvailable: Boolean(
        providerKind
        && providerArtifactEligible(providerKind)
        && nullableText(invoice.blocked_reason) === null
        && ["issued", "accepted"].includes(correctionStatus),
      ),
      emailState: resolveEmailState({
        invoice,
        providerDocumentRef: correctionProviderId,
        operations,
        deliveryOutboxes,
        preferInvoiceFallback: true,
      }),
    });
  }

  documents.sort(compareDocumentsChronologically);
  return {
    current: documents.find((document) => document.isCurrent) ?? null,
    documents,
  };
}

function currentInvoiceEligible(
  row: InvoiceDocumentHistoryRow,
  providerArtifactEligible: (providerKind: string) => boolean,
): boolean {
  const providerKind = nullableText(row.provider_kind);
  return Boolean(
    providerKind
    && providerArtifactEligible(providerKind)
    && nullableText(row.provider_document_ref)
    && nullableText(row.blocked_reason) === null
    && CURRENT_STATUSES.has(normalize(row.status)),
  );
}

function historicalInvoiceDownloadEligible(
  row: InvoiceDocumentHistoryRow,
  providerArtifactEligible: (providerKind: string) => boolean,
): boolean {
  const providerKind = nullableText(row.provider_kind);
  return Boolean(
    providerKind
    && providerArtifactEligible(providerKind)
    && nullableText(row.provider_document_ref)
    && nullableText(row.blocked_reason) === null
    && HISTORICAL_INVOICE_STATUSES.has(normalize(row.status)),
  );
}

function resolveEmailState({
  invoice,
  providerDocumentRef,
  operations,
  deliveryOutboxes,
  preferInvoiceFallback,
}: {
  invoice: InvoiceDocumentHistoryRow;
  providerDocumentRef: string | null;
  operations: InvoiceDocumentHistoryRow[];
  deliveryOutboxes: InvoiceDocumentHistoryRow[];
  preferInvoiceFallback: boolean;
}): InvoiceDocumentEmailState {
  if (!providerDocumentRef) return "not_requested";
  const invoiceId = text(invoice.id);
  const accepted = operations.some((row) => {
    if (text(row.invoice_id) !== invoiceId || text(row.operation) !== "provider_email_sent") return false;
    const payloadProviderId = nullableText(record(row.payload).providerDocumentRef);
    return (payloadProviderId ?? nullableText(row.provider_ref)) === providerDocumentRef;
  });
  if (accepted) return "provider_accepted";

  const outbox = deliveryOutboxes
    .filter((row) => text(row.invoice_id) === invoiceId)
    .filter((row) => {
      const targetProviderId = nullableText(record(row.metadata).providerDocumentRef);
      return targetProviderId ? targetProviderId === providerDocumentRef : preferInvoiceFallback;
    })
    .sort(compareRowsNewestFirst)[0];
  const outboxStatus = normalize(outbox?.status);
  if (["failed", "uncertain", "cancelled"].includes(outboxStatus)) return "failed";
  if (["pending", "processing", "queued"].includes(outboxStatus)) return "pending";
  if (outboxStatus === "succeeded") return "provider_accepted";

  if (preferInvoiceFallback) {
    const emailStatus = normalize(invoice.email_status);
    if (emailStatus === "failed") return "failed";
    if (emailStatus === "pending") return "pending";
    if (emailStatus === "sent") return "provider_accepted";
  }
  return "not_requested";
}

function correctionProviderDocumentRef(row: InvoiceDocumentHistoryRow): string | null {
  return nullableText(record(row.metadata).correctionProviderDocumentRef);
}

function correctionProviderDocumentNumber(row: InvoiceDocumentHistoryRow): string | null {
  return nullableText(record(row.metadata).correctionProviderDocumentNumber);
}

function compareRowsChronologically(a: InvoiceDocumentHistoryRow, b: InvoiceDocumentHistoryRow): number {
  return compareTimestamps(a.created_at, b.created_at) || text(a.id).localeCompare(text(b.id));
}

function compareRowsNewestFirst(a: InvoiceDocumentHistoryRow, b: InvoiceDocumentHistoryRow): number {
  return compareTimestamps(b.created_at ?? b.updated_at, a.created_at ?? a.updated_at) || text(b.id).localeCompare(text(a.id));
}

function compareDocumentsChronologically(a: InvoiceDocumentHistoryEntry, b: InvoiceDocumentHistoryEntry): number {
  return compareTimestamps(a.createdAt, b.createdAt)
    || documentRolePriority(a.role) - documentRolePriority(b.role)
    || a.documentKey.localeCompare(b.documentKey);
}

function documentRolePriority(role: InvoiceDocumentRole): number {
  if (role === "original") return 0;
  if (role === "correction") return 1;
  return 2;
}

function laterTimestamp(a: string, b: string): string {
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (Number.isFinite(aTime) && Number.isFinite(bTime)) return aTime >= bTime ? a : b;
  return a || b;
}

function compareTimestamps(a: unknown, b: unknown): number {
  const aTime = Date.parse(text(a));
  const bTime = Date.parse(text(b));
  if (Number.isFinite(aTime) && Number.isFinite(bTime) && aTime !== bTime) return aTime - bTime;
  if (Number.isFinite(aTime) && !Number.isFinite(bTime)) return -1;
  if (!Number.isFinite(aTime) && Number.isFinite(bTime)) return 1;
  return 0;
}

function nonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function record(value: unknown): InvoiceDocumentHistoryRow {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as InvoiceDocumentHistoryRow
    : {};
}

function normalize(value: unknown): string {
  return text(value).trim().toLowerCase();
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
