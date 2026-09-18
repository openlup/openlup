import type { OmsAccountingStatus, OmsOrderDetail } from "./omsContracts.js";
import type {
  OmsAccountingInvoiceRow,
  OmsAccountingOutboxRow,
} from "./omsReadModelRows.js";

export type OmsAccountingRecoveryGuidance =
  | "none"
  | "not_requested"
  | "wait_for_retry"
  | "review_and_retry";

export function accountingSummary(
  invoice: OmsAccountingInvoiceRow | null,
  outboxRows: OmsAccountingOutboxRow[],
): OmsOrderDetail["accounting"] {
  if (!invoice) {
    return {
      status: "missing",
      invoiceId: null,
      invoiceRef: null,
      providerKind: null,
      providerInvoiceNumber: null,
      ksefStatus: null,
      outboxStatus: null,
      outboxAttemptCount: null,
      outboxNextAttemptAt: null,
      outboxLastError: null,
      recoveryGuidance: "not_requested",
      updatedAt: null,
    };
  }
  const outbox = selectAccountingOutbox(invoice.id, outboxRows);
  return {
    status: outbox?.status === "failed" ? "outbox_failed" : normalizeAccountingStatus(invoice.status),
    invoiceId: invoice.id,
    invoiceRef: invoice.invoice_ref,
    providerKind: invoice.provider_kind,
    providerInvoiceNumber: invoice.provider_invoice_number,
    ksefStatus: invoice.ksef_status,
    outboxStatus: outbox?.status ?? null,
    outboxAttemptCount: outbox?.attempt_count ?? null,
    outboxNextAttemptAt: outbox?.next_attempt_at ?? null,
    outboxLastError: sanitizeAccountingLastError(outbox?.last_error),
    recoveryGuidance: accountingRecoveryGuidance(outbox?.status ?? null, invoice.status),
    updatedAt: invoice.updated_at,
  };
}

function selectAccountingOutbox(
  invoiceId: string,
  outboxRows: OmsAccountingOutboxRow[],
): OmsAccountingOutboxRow | null {
  return outboxRows
    .filter((row) => row.invoice_id === invoiceId)
    .sort(compareAccountingOutboxRows)[0] ?? null;
}

function compareAccountingOutboxRows(a: OmsAccountingOutboxRow, b: OmsAccountingOutboxRow): number {
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

export function accountingRecoveryGuidance(
  outboxStatus: string | null,
  invoiceStatus: string | null = null,
): OmsAccountingRecoveryGuidance {
  if (outboxStatus === "failed") return "review_and_retry";
  if (outboxStatus === "pending" || outboxStatus === "processing" || outboxStatus === "queued") {
    return "wait_for_retry";
  }
  if (invoiceStatus === "blocked" || invoiceStatus === "rejected") return "review_and_retry";
  if (invoiceStatus === "issued" || invoiceStatus === "accepted" || invoiceStatus === "corrected" || invoiceStatus === "voided") {
    return "none";
  }
  return outboxStatus ? "none" : "not_requested";
}

export function sanitizeAccountingLastError(value: unknown) {
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

function normalizeAccountingStatus(status: string): OmsAccountingStatus {
  const valid: OmsAccountingStatus[] = ["draft", "issue_requested", "blocked", "issued", "ksef_pending", "accepted", "rejected", "correction_requested", "corrected", "voided"];
  return valid.includes(status as OmsAccountingStatus) ? (status as OmsAccountingStatus) : "missing";
}
