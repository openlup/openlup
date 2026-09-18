import type {
  ProviderReconciliationStatus,
} from "../../domains/payment/paymentProviderReconciliationWorker.js";
import type {
  PaymentProviderRecoveryProvider,
  ProviderRecoveryAction,
} from "../../domains/payment/checkoutRecoveryPaymentResolver.js";
import type { TpayHttpClient } from "../../infra/tpay/tpayHttpClient.js";
import { refusalCapture, tpayFailureEvidence } from "./tpayFailureEvidence.js";
import { failureEvidencePayload } from "../paymentFailureEvidence.js";
import { parseInstant, wallClockToUtc } from "../../shared/wallClockTime.js";
import { declineCodeReading, type DeclineCodeReading } from "./declineFailureHints.js";
import { attemptDeclineObservation, lastRefusalRow } from "./tpayDeclineEvidence.js";

export function createTpayPaymentReconciliationProvider(
  client: Pick<TpayHttpClient, "getTransaction">,
): PaymentProviderRecoveryProvider {
  return {
    resolvePaymentReference(input) {
      // Tpay's API address is its transactionId. `title`/TR-* is merchant
      // display data, not a readback identifier.
      return input.providerSessionId;
    },
    async readRecoveryPayment(input) {
      const transaction = await client.getTransaction(input.providerPaymentId);
      const status = normalizeTpayTransaction(transaction);
      const identityMatches = tpayIdentityMatches(transaction, input.providerPaymentId);
      const configuredMoneyMatches = tpayConfiguredMoneyMatches(transaction, input.attempt);
      const manualReviewRequired = tpayMoneyMoved(transaction);
      let clientAction: ProviderRecoveryAction | null = null;
      if (identityMatches && !manualReviewRequired && status.status === "pending") {
        const url = validatedTpayPaymentUrl(transaction);
        clientAction = url ? { kind: "redirect", url } : null;
      }
      return { status, identityMatches, configuredMoneyMatches, manualReviewRequired, clientAction };
    },
    async readPayment(input) {
      const transaction = await client.getTransaction(input.providerPaymentId);
      return normalizeTpayTransaction(transaction);
    },
  };
}

function tpayMoneyMoved(transaction: Record<string, unknown>): boolean {
  const status = readStatus(transaction).trim().toLowerCase();
  return status === "chargeback" || status === "refunded";
}

function tpayIdentityMatches(transaction: Record<string, unknown>, providerPaymentId: string): boolean {
  const actual = readOptionalString(transaction, "transactionId") ?? readOptionalString(transaction, "id");
  return actual === providerPaymentId;
}

function tpayConfiguredMoneyMatches(
  transaction: Record<string, unknown>,
  attempt: { amountMinor: number; currency: string },
): boolean {
  return readConfiguredAmountMinor(transaction) === attempt.amountMinor
    && readCurrency(transaction)?.toUpperCase() === attempt.currency.toUpperCase();
}

const TPAY_PAYMENT_HOSTS = new Set(["secure.tpay.com", "secure.sandbox.tpay.com"]);

function validatedTpayPaymentUrl(transaction: Record<string, unknown>): string | null {
  const raw = transaction.transactionPaymentUrl;
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:"
      && parsed.port === ""
      && parsed.username === ""
      && parsed.password === ""
      && TPAY_PAYMENT_HOSTS.has(parsed.hostname.toLowerCase())
      ? parsed.toString()
      : null;
  } catch {
    return null;
  }
}

export function normalizeTpayTransaction(
  transaction: Record<string, unknown>,
): ProviderReconciliationStatus {
  const providerStatus = readStatus(transaction);
  const statusFromField = normalizeTpayStatus(providerStatus);
  // This rail leaves its status field non-terminal when the bank refuses, reporting
  // the reason beside it in TWO carriers instead — per attempt, and in an errors
  // array — so reading only the status field left a refused charge polling forever
  // (what stranded a renewal on 2026-08-12). Attempts win when both carry a code:
  // being the dated carrier, they are the only one that can say which is current.
  const payments = record(transaction.payments);
  const refusal = statusFromField !== "succeeded"
    ? lastRefusal(payments.attempts, "paymentErrorCode") ?? lastRefusal(payments.errors, "errorCode")
    : null;
  const status = refusal ? "failed" as const : statusFromField;
  return {
    status,
    providerStatus,
    occurredAt: refusal?.occurredAt ?? readDate(transaction),
    failureReason: refusal
      ? `tpay_decline_${refusal.code}`
      : status === "failed" ? `tpay_${providerStatus}` : null,
    amountMinor: readAmountMinor(transaction),
    currency: readCurrency(transaction),
    rawPayload: sanitizedTpayTransaction(transaction, providerStatus, refusal),
  };
}

interface AttemptRefusal {
  code: string;
  occurredAt: string | null;
  reading: DeclineCodeReading;
}

/**
 * The last row carrying a refusal code, dated and read. The scan is shared with
 * the execution path, which needs the same "which code does this stand on"
 * answer the instant the provider refuses; only the date and the reading are
 * added. Undated rows yield no instant, so the caller uses the charge's own date.
 */
function lastRefusal(rows: unknown, codeKey: string): AttemptRefusal | null {
  const refusal = lastRefusalRow(rows, codeKey);
  if (!refusal) return null;
  return {
    code: refusal.code,
    occurredAt: parseAttemptDate(refusal.row.date),
    reading: declineCodeReading(refusal.code),
  };
}

/**
 * This rail labels no timestamp with a zone, on either carrier, and both are its
 * own local wall clock. Reading them as UTC moved every instant this adapter
 * produced one or two hours into the future: on 2026-08-15 a decline that landed
 * 14:46Z was recorded as 16:46Z, later than the cron run that wrote it. The zone
 * belongs to the rail, not to the merchant, so it is named here — beside the
 * carriers it explains — and passed to the generic conversion.
 */
const REPORTING_TIME_ZONE = "Europe/Warsaw";

/** Attempt timestamps arrive as `DD.MM.YYYY HH:mm`, which `Date.parse` misreads. */
function parseAttemptDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{2})\.(\d{2})\.(\d{4})[ T](\d{2}):(\d{2})/.exec(value.trim());
  if (!match) return parseDate(value);
  const [, day, month, year, hour, minute] = match;
  return wallClockToUtc(`${year}-${month}-${day}T${hour}:${minute}:00`, REPORTING_TIME_ZONE);
}

function normalizeTpayStatus(status: string): ProviderReconciliationStatus["status"] {
  const normalized = status.trim().toLowerCase();
  if (["correct", "paid", "true", "success", "settled"].includes(normalized)) return "succeeded";
  if ([
    "failed",
    "failure",
    "error",
    "false",
    "declined",
    "rejected",
    "cancelled",
    "canceled",
    "expired",
  ].includes(normalized)) {
    return "failed";
  }
  if ([
    "new",
    "pending",
    "created",
    "processing",
    "in_progress",
    "authorized",
    "requires_action",
    "pending_confirmation",
  ].includes(normalized)) {
    return "pending";
  }
  return "unknown";
}

function readStatus(transaction: Record<string, unknown>): string {
  for (const key of ["status", "tr_status", "transactionStatus", "state"]) {
    const raw = transaction[key];
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    if (typeof raw === "boolean") return raw ? "true" : "false";
  }
  return "unknown";
}

function readDate(transaction: Record<string, unknown>): string | null {
  const nestedDate = record(transaction.date);
  for (const key of ["realization", "creation"]) {
    const parsed = parseDate(nestedDate[key]);
    if (parsed) return parsed;
  }
  for (const key of ["date", "updatedAt", "updated_at", "createdAt", "created_at"]) {
    const parsed = parseDate(transaction[key]);
    if (parsed) return parsed;
  }
  return null;
}

/** The transaction carrier sends `YYYY-MM-DD HH:mm:ss` — zone-less, so read in the rail's zone. */
function parseDate(value: unknown): string | null {
  return parseInstant(value, REPORTING_TIME_ZONE);
}

function readAmountMinor(transaction: Record<string, unknown>): number | null {
  return readAmountMinorFrom(
    transaction,
    ["amountMinor", "paidAmountMinor", "tr_amount_minor", "tr_paid_minor"],
    ["paidAmount", "amount", "tr_paid", "tr_amount"],
  );
}

function readConfiguredAmountMinor(transaction: Record<string, unknown>): number | null {
  return readAmountMinorFrom(transaction, ["amountMinor", "tr_amount_minor"], ["amount", "tr_amount"]);
}

function readAmountMinorFrom(
  transaction: Record<string, unknown>,
  minorKeys: readonly string[],
  majorKeys: readonly string[],
): number | null {
  for (const key of minorKeys) {
    const raw = transaction[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return Math.round(raw);
    if (typeof raw === "string" && /^\d+$/.test(raw.trim())) return Number(raw);
  }
  for (const key of majorKeys) {
    const raw = transaction[key];
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(",", ".")) : NaN;
    if (Number.isFinite(value)) return Math.round(value * 100);
  }
  return null;
}

function readCurrency(transaction: Record<string, unknown>): string | null {
  for (const key of ["currency", "tr_currency"]) {
    const raw = transaction[key];
    if (typeof raw === "string" && raw.trim().length === 3) return raw.trim().toUpperCase();
  }
  return null;
}

/**
 * Classification goes through the shared `classifyDecline` seam, the same one
 * the synchronous path and the card rail use, so there is exactly one place a
 * refusal becomes a class. Only neutral evidence crosses: this provider's code
 * vocabulary is translated here and travels no further. Since PR 2724 the class
 * reaches the case and becomes the payer's cause sentence; it is no cadence input.
 */

function sanitizedTpayTransaction(
  transaction: Record<string, unknown>,
  providerStatus: string,
  refusal: AttemptRefusal | null = null,
): Record<string, unknown> {
  return {
    // Before this, the only record of why a charge failed was discarded on
    // every poll.
    ...(refusal ? refusalCapture(refusal, `tpay_decline_${refusal.code}`) : {}),
    ...failureEvidencePayload(refusal || ["failed", "failure", "error", "false", "declined", "rejected"].includes(providerStatus.trim().toLowerCase()) ? tpayFailureEvidence({
      source: "readback", providerPaymentId: readOptionalString(transaction, "transactionId"),
      refusalVerified: true, flow: null,
      observation: refusal ? { code: refusal.code, disposition: "present" } : attemptDeclineObservation(transaction), reading: refusal?.reading,
    }) : null),
    provider: "tpay",
    transactionId: readOptionalString(transaction, "transactionId") ?? readOptionalString(transaction, "id"),
    title: readOptionalString(transaction, "title") ?? readOptionalString(transaction, "tr_id"),
    status: providerStatus,
    requestIdPresent: Boolean(readOptionalString(transaction, "requestId")),
    amountMinorPresent: readAmountMinor(transaction) !== null,
    currency: readCurrency(transaction),
  };
}

function readOptionalString(value: Record<string, unknown>, key: string): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
