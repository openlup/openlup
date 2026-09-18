import {
  accountingInvoiceSummarySchema,
  adminAccountingOrderSummaryResponseSchema,
  type AdminAccountingOrderSummaryRequest,
  type AdminAccountingOrderSummaryResponse,
} from "../../../../src/domains/accounting/invoiceContracts.js";
import {
  AccountingControlPersistenceError,
  type AccountingReadPort,
} from "../../../../src/domains/accounting/ports.js";
import { resolveAccountingDocumentHistory } from "../../../../src/domains/accounting/accountingDocumentHistory.js";

export interface AccountingReadSupabaseClient {
  from(table: string): SupabaseQueryBuilder;
}

interface SupabaseQueryBuilder extends PromiseLike<SupabaseQueryResult> {
  select(columns: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
  eq(column: string, value: unknown): SupabaseQueryBuilder;
  in(column: string, values: unknown[]): SupabaseQueryBuilder;
  order(column: string, options?: Record<string, unknown>): SupabaseQueryBuilder;
}

interface SupabaseQueryResult {
  data: unknown;
  error: { code?: string; message?: string } | null;
}

interface AccountingInvoiceRow extends Record<string, unknown> {
  id: string;
  order_id: string;
  invoice_ref: string;
  status: string;
  document_type: string;
  buyer_kind: string;
  ksef_requirement: string;
  ksef_status: string;
  provider_kind: string | null;
  provider_invoice_id: string | null;
  provider_invoice_number: string | null;
  total_gross_cents: number;
  currency: string;
  blocked_reason: string | null;
  correction_of_invoice_id: string | null;
  correction_status: string;
  document_kind: string | null;
  email_status: string;
  ksef_number: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

interface AccountingOutboxRow {
  status: string;
  attempt_count: number;
  next_attempt_at: string | null;
  last_error: unknown;
  created_at?: string | null;
}

export function createSupabaseAccountingReadPort(
  client: AccountingReadSupabaseClient,
): AccountingReadPort {
  return {
    async getOrderSummary(
      request: AdminAccountingOrderSummaryRequest,
    ): Promise<AdminAccountingOrderSummaryResponse> {
      const invoiceResult = await client
        .from("accounting_invoices")
        .select(
          "id, order_id, invoice_ref, status, document_type, document_kind, buyer_kind, ksef_requirement, ksef_status, ksef_number, provider_kind, provider_invoice_id, provider_invoice_number, total_gross_cents, currency, blocked_reason, correction_of_invoice_id, correction_status, email_status, metadata, created_at, updated_at",
        )
        .eq("order_id", request.orderId)
        .order("created_at", { ascending: false });
      if (invoiceResult.error) {
        throw new AccountingControlPersistenceError("Accounting order summary invoice read failed");
      }

      const invoices = Array.isArray(invoiceResult.data)
        ? invoiceResult.data as AccountingInvoiceRow[]
        : invoiceResult.data
          ? [invoiceResult.data as AccountingInvoiceRow]
          : [];
      if (invoices.length === 0) {
        return adminAccountingOrderSummaryResponseSchema.parse({
          summary: {
            orderId: request.orderId,
            status: "missing",
            invoice: null,
            documents: [],
            recoveryGuidance: "not_requested",
            outbox: null,
          },
        });
      }
      const operationResult = await client
        .from("accounting_invoice_operations")
        .select("invoice_id, operation, provider_ref, payload, created_at")
        .in("invoice_id", invoices.map((row) => row.id))
        .in("operation", ["correction_issued", "provider_email_sent"])
        .order("created_at", { ascending: false });
      if (operationResult.error) {
        throw new AccountingControlPersistenceError("Accounting order summary operation read failed");
      }
      const operations = Array.isArray(operationResult.data) ? operationResult.data as Record<string, unknown>[] : [];
      const history = resolveAccountingDocumentHistory({ invoices, operations });
      const invoice = history.current
        ? invoices.find((row) => row.id === history.current?.invoiceId) ?? null
        : invoices[0] ?? null;
      if (!invoice) throw new AccountingControlPersistenceError("Accounting current invoice resolution failed");

      const outboxResult = await client
        .from("accounting_invoice_issue_outbox")
        .select("status, attempt_count, next_attempt_at, last_error, created_at")
        .eq("invoice_id", invoice.id)
        .order("created_at", { ascending: false });
      if (outboxResult.error) {
        throw new AccountingControlPersistenceError("Accounting order summary outbox read failed");
      }
      const outbox = selectAccountingOutbox(outboxResult.data);
      const summary = {
        orderId: request.orderId,
        status: outbox?.status === "failed" ? "outbox_failed" : invoice.status,
        invoice: accountingInvoiceSummarySchema.parse({
          id: invoice.id,
          orderId: invoice.order_id,
          invoiceRef: invoice.invoice_ref,
          status: invoice.status,
          documentType: invoice.document_type,
          buyerKind: invoice.buyer_kind,
          ksefRequirement: invoice.ksef_requirement,
          ksefStatus: invoice.ksef_status,
          providerKind: invoice.provider_kind,
          providerInvoiceId: invoice.provider_invoice_id,
          providerInvoiceNumber: invoice.provider_invoice_number,
          totalGrossMinor: invoice.total_gross_cents,
          currency: invoice.currency,
          blockedReason: invoice.blocked_reason,
        }),
        documents: history.documents.map((document) => ({
          documentKey: document.documentKey,
          invoiceId: document.invoiceId,
          invoiceRef: document.invoiceRef,
          role: document.role,
          artifact: document.artifact,
          status: document.status,
          providerKind: document.providerKind,
          providerInvoiceNumber: document.providerInvoiceNumber,
          totalGrossMinor: document.totalGrossMinor,
          currency: document.currency,
          emailState: document.emailState,
          isCurrent: document.isCurrent,
          createdAt: document.createdAt,
        })),
        recoveryGuidance: accountingRecoveryGuidance(outbox?.status ?? null, invoice.status),
        outbox: outbox
          ? {
              status: outbox.status,
              attemptCount: outbox.attempt_count,
              nextAttemptAt: outbox.next_attempt_at,
              lastError: sanitizeAccountingLastError(outbox.last_error),
            }
          : null,
      };

      return adminAccountingOrderSummaryResponseSchema.parse({ summary });
    },
  };
}

function selectAccountingOutbox(data: unknown): AccountingOutboxRow | null {
  const rows = Array.isArray(data)
    ? data.filter((row): row is AccountingOutboxRow => isRecord(row) && typeof row.status === "string")
    : [];
  return rows.sort(compareAccountingOutboxRows)[0] ?? null;
}

function compareAccountingOutboxRows(a: AccountingOutboxRow, b: AccountingOutboxRow): number {
  const priority = outboxStatusPriority(a.status) - outboxStatusPriority(b.status);
  if (priority !== 0) return priority;
  const aCreatedAt = timestampOrNull(a.created_at);
  const bCreatedAt = timestampOrNull(b.created_at);
  if (aCreatedAt !== null && bCreatedAt !== null && aCreatedAt !== bCreatedAt) {
    return bCreatedAt - aCreatedAt;
  }
  if (aCreatedAt !== null && bCreatedAt === null) return -1;
  if (aCreatedAt === null && bCreatedAt !== null) return 1;
  return 0;
}

function timestampOrNull(value: string | null | undefined): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function outboxStatusPriority(status: string): number {
  if (status === "failed") return 0;
  if (status === "processing") return 1;
  if (status === "pending" || status === "queued") return 2;
  if (status === "succeeded") return 3;
  if (status === "cancelled") return 4;
  return 5;
}

function accountingRecoveryGuidance(outboxStatus: string | null, invoiceStatus: string | null) {
  if (outboxStatus === "failed") return "review_and_retry";
  if (outboxStatus === "pending" || outboxStatus === "processing" || outboxStatus === "queued") {
    return "wait_for_retry";
  }
  if (invoiceStatus === "rejected") return "review_and_retry";
  if (invoiceStatus === "issued" || invoiceStatus === "accepted" || invoiceStatus === "corrected" || invoiceStatus === "voided") {
    return "none";
  }
  return outboxStatus ? "none" : "not_requested";
}

function sanitizeAccountingLastError(value: unknown) {
  if (!isRecord(value)) return null;
  const code =
    readSafeText(value, "code", 80) ??
    readSafeText(value, "errorCode", 80) ??
    readSafeText(value, "reason", 80) ??
    readSafeText(value, "type", 80);
  const message =
    readSafeText(value, "operatorMessage", 240) ??
    readSafeText(value, "message", 240);
  const retryable = typeof value.retryable === "boolean" ? value.retryable : null;
  if (!code && !message && retryable === null) return null;
  return { code, message, retryable };
}

function readSafeText(record: Record<string, unknown>, key: string, maxLength: number): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const normalized = redactSensitiveText(value.trim().replace(/\s+/g, " "));
  return normalized ? normalized.slice(0, maxLength) : null;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]")
    .replace(/\b(?:bearer|token|secret|api[_-]?key|authorization)\s*[:=]?\s+[A-Za-z0-9._~+/=-]{8,}/gi, "[redacted-secret]");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
