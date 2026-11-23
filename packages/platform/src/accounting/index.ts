import { z } from "zod";
import type {
  AccountingCapabilities,
  AccountingEntryKind,
  AccountingExportRecord,
  AccountingExportResult,
  AccountingRefusalReason,
  AccountingUnknownReason,
} from "./contracts/index.js";

export type * from "./contracts/index.js";

export const ACCOUNTING_EXPORT_CONTRACT_VERSION = "accounting.ledger_export.v1" as const;

export const ACCOUNTING_ENTRY_KINDS = [
  "sale",
  "refund",
  "payout",
  "tax_liability",
  "fee",
  "adjustment",
] as const satisfies readonly AccountingEntryKind[];

const ISO_CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const DIAGNOSTIC_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
const PROVIDER_KIND_PATTERN = /^[a-z][a-z0-9_-]{1,47}$/u;
const nonBlank = (max: number) => z.string().max(max).refine((v) => v.trim().length > 0, "must be non-blank");

export const accountingCapabilitiesSchema = z.strictObject({
  contractVersion: z.literal(ACCOUNTING_EXPORT_CONTRACT_VERSION),
  providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
  supportedEntryKinds: z.array(z.enum(ACCOUNTING_ENTRY_KINDS)).min(1),
  supportedCurrencies: z.array(z.string().regex(ISO_CURRENCY_PATTERN)),
  supportsReadback: z.boolean(),
  supportsIdempotencyKey: z.boolean(),
  requiresCredentials: z.boolean(),
});

const refusalReasons = [
  "unbalanced_entry",
  "invalid_record",
  "unsupported_currency",
  "unsupported_entry_kind",
  "missing_account_mapping",
  "authentication_failed",
  "provider_rejected",
] as const satisfies readonly AccountingRefusalReason[];

const unknownReasons = [
  "rate_limited",
  "provider_unavailable",
  "timeout",
  "ambiguous_conflict",
  "transport_error",
] as const satisfies readonly AccountingUnknownReason[];

export const accountingExportResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("exported"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    externalRef: nonBlank(160),
    exportKey: nonBlank(160),
    idempotentReplay: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("refused"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    reason: z.enum(refusalReasons),
    retryable: z.literal(false),
    effectMayHaveSucceeded: z.literal(false),
    diagnosticCode: z.string().regex(DIAGNOSTIC_CODE_PATTERN),
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    reason: z.enum(unknownReasons),
    retryable: z.literal(true),
    effectMayHaveSucceeded: z.literal(true),
    diagnosticCode: z.string().regex(DIAGNOSTIC_CODE_PATTERN),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
  }),
  z.strictObject({
    kind: z.literal("unsupported"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    diagnosticCode: z.string().regex(DIAGNOSTIC_CODE_PATTERN),
  }),
]);

export const accountingReadbackResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("found"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    externalRef: nonBlank(160),
    exportKey: nonBlank(160),
  }),
  z.strictObject({
    kind: z.literal("absent"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    exportKey: nonBlank(160),
  }),
  z.strictObject({
    kind: z.literal("unknown"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    reason: z.enum(unknownReasons),
    retryable: z.literal(true),
    diagnosticCode: z.string().regex(DIAGNOSTIC_CODE_PATTERN),
    retryAfterSeconds: z.number().int().positive().max(86_400).optional(),
  }),
  z.strictObject({
    kind: z.literal("unsupported"),
    providerKind: z.string().regex(PROVIDER_KIND_PATTERN),
    diagnosticCode: z.string().regex(DIAGNOSTIC_CODE_PATTERN),
  }),
]);

function asciiCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function projectAccountingStaticCapabilities(
  capabilities: AccountingCapabilities,
  options?: { readonly redactSupportedCurrencies?: boolean },
): AccountingCapabilities {
  return {
    contractVersion: capabilities.contractVersion,
    providerKind: capabilities.providerKind,
    supportedEntryKinds: [...capabilities.supportedEntryKinds].sort(asciiCompare),
    supportedCurrencies: options?.redactSupportedCurrencies
      ? []
      : [...capabilities.supportedCurrencies].sort(asciiCompare),
    supportsReadback: capabilities.supportsReadback,
    supportsIdempotencyKey: capabilities.supportsIdempotencyKey,
    requiresCredentials: capabilities.requiresCredentials,
  };
}

function refused(
  providerKind: string,
  reason: AccountingRefusalReason,
  diagnosticCode: string,
): Extract<AccountingExportResult, { kind: "refused" }> {
  return {
    kind: "refused",
    providerKind,
    reason,
    retryable: false,
    effectMayHaveSucceeded: false,
    diagnosticCode,
  };
}

function isValidCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d!));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m! - 1 && dt.getUTCDate() === d;
}

/**
 * Pure zero-I/O journal balance and capability validator.
 * Returns a structured non-retryable refusal or null when the record may be exported.
 */
export function validateAccountingExportRecord(
  record: AccountingExportRecord,
  capabilities: AccountingCapabilities,
): Extract<AccountingExportResult, { kind: "refused" }> | null {
  const { providerKind } = capabilities;
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return refused(providerKind, "invalid_record", "INVALID_RECORD");
  }
  if (record.contractVersion !== ACCOUNTING_EXPORT_CONTRACT_VERSION) {
    return refused(providerKind, "invalid_record", "UNSUPPORTED_CONTRACT_VERSION");
  }
  if (typeof record.exportKey !== "string" || record.exportKey.trim().length === 0) {
    return refused(providerKind, "invalid_record", "MISSING_EXPORT_KEY");
  }
  if (typeof record.sourceRef !== "string" || record.sourceRef.trim().length === 0) {
    return refused(providerKind, "invalid_record", "MISSING_SOURCE_REF");
  }
  if (typeof record.entryDate !== "string" || !isValidCalendarDate(record.entryDate)) {
    return refused(providerKind, "invalid_record", "INVALID_ENTRY_DATE");
  }
  if (!capabilities.supportedEntryKinds.includes(record.entryKind)) {
    return refused(providerKind, "unsupported_entry_kind", "UNSUPPORTED_ENTRY_KIND");
  }
  if (typeof record.currency !== "string" || !ISO_CURRENCY_PATTERN.test(record.currency)) {
    return refused(providerKind, "unsupported_currency", "INVALID_CURRENCY");
  }
  if (
    capabilities.supportedCurrencies.length > 0 &&
    !capabilities.supportedCurrencies.includes(record.currency)
  ) {
    return refused(providerKind, "unsupported_currency", "UNSUPPORTED_CURRENCY");
  }
  if (!Array.isArray(record.lines) || record.lines.length < 2) {
    return refused(providerKind, "unbalanced_entry", "INSUFFICIENT_JOURNAL_LINES");
  }

  let debitTotal = 0n;
  let creditTotal = 0n;
  for (const line of record.lines) {
    if (!line || typeof line !== "object" || Array.isArray(line)) {
      return refused(providerKind, "invalid_record", "INVALID_JOURNAL_LINE");
    }
    if (typeof line.accountCode !== "string" || line.accountCode.trim().length === 0) {
      return refused(providerKind, "missing_account_mapping", "MISSING_ACCOUNT_CODE");
    }
    if (line.side !== "debit" && line.side !== "credit") {
      return refused(providerKind, "invalid_record", "INVALID_LINE_SIDE");
    }
    if (typeof line.amountMinor !== "number" || !Number.isSafeInteger(line.amountMinor) || line.amountMinor <= 0) {
      return refused(providerKind, "invalid_record", "INVALID_LINE_AMOUNT");
    }
    if (line.side === "debit") debitTotal += BigInt(line.amountMinor);
    else creditTotal += BigInt(line.amountMinor);
  }
  if (debitTotal === 0n || debitTotal !== creditTotal) {
    return refused(providerKind, "unbalanced_entry", "JOURNAL_OUT_OF_BALANCE");
  }
  return null;
}
