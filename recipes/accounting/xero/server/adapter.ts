import {
  ACCOUNTING_ENTRY_KINDS,
  ACCOUNTING_EXPORT_CONTRACT_VERSION,
  projectAccountingStaticCapabilities,
  validateAccountingExportRecord,
} from "@openlup/platform/accounting";
import type {
  AccountingCapabilities,
  AccountingEntryKind,
  AccountingExportRecord,
  AccountingExportResult,
  AccountingLedgerExportPort,
  AccountingReadbackResult,
  AccountingRefusalReason,
  AccountingUnknownReason,
} from "@openlup/platform/accounting/contracts";
import {
  HardenedFetchError,
  OAuth2TokenError,
  sanitizeDiagnosticCode,
} from "@openlup/platform/adapter-kit";
import {
  assertSafeXeroExportKey,
  XeroClientError,
  type XeroClient,
  type XeroCreateManualJournalPayload,
} from "./client-contract.js";

export const XERO_PROVIDER_KIND = "xero" as const;

const EXPONENT_LOOKUP_LOCALE = "en-US";

export const xeroDefaultCapabilities: AccountingCapabilities = Object.freeze({
  contractVersion: ACCOUNTING_EXPORT_CONTRACT_VERSION,
  providerKind: XERO_PROVIDER_KIND,
  supportedEntryKinds: Object.freeze([...ACCOUNTING_ENTRY_KINDS]),
  supportedCurrencies: Object.freeze([]),
  supportsReadback: true,
  supportsIdempotencyKey: true,
  requiresCredentials: true,
});

export function projectXeroStaticCapabilities(): AccountingCapabilities {
  return projectAccountingStaticCapabilities(xeroDefaultCapabilities, {
    redactSupportedCurrencies: true,
  });
}

/**
 * Resolves the ISO-4217 minor-unit exponent from ICU via `Intl.NumberFormat` without
 * maintaining a hardcoded currency table.
 */
export function getCurrencyExponent(currency: string): number {
  const { minimumFractionDigits } = new Intl.NumberFormat(EXPONENT_LOOKUP_LOCALE, {
    style: "currency",
    currency,
  }).resolvedOptions();
  if (
    typeof minimumFractionDigits !== "number" ||
    !Number.isInteger(minimumFractionDigits) ||
    minimumFractionDigits < 0
  ) {
    throw new RangeError(`Unresolvable currency exponent for ${currency}`);
  }
  return minimumFractionDigits;
}

/**
 * Converts an exact integer minor-unit amount to a major decimal string using
 * `Intl.NumberFormat` currency exponent and `BigInt` arithmetic (zero IEEE-754 float math).
 */
export function minorUnitsToMajorDecimalString(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor)) {
    throw new RangeError("amountMinor must be a safe integer");
  }
  const exponent = getCurrencyExponent(currency);
  const minor = BigInt(amountMinor);
  if (exponent === 0) {
    return minor.toString();
  }
  const factor = 10n ** BigInt(exponent);
  const negative = minor < 0n;
  const absMinor = negative ? -minor : minor;
  const whole = absMinor / factor;
  const frac = (absMinor % factor).toString().padStart(exponent, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${frac}`;
}

export interface CreateXeroAdapterOptions {
  readonly client: XeroClient;
  readonly supportedCurrencies?: readonly string[];
  readonly supportedEntryKinds?: readonly AccountingEntryKind[];
}

function refusedResult(
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
    diagnosticCode: sanitizeDiagnosticCode(diagnosticCode, "XERO_REFUSED"),
  };
}

function unknownResult(
  providerKind: string,
  reason: AccountingUnknownReason,
  diagnosticCode: string,
  retryAfterSeconds?: number,
): Extract<AccountingExportResult, { kind: "unknown" }> {
  return {
    kind: "unknown",
    providerKind,
    reason,
    retryable: true,
    effectMayHaveSucceeded: true,
    diagnosticCode: sanitizeDiagnosticCode(diagnosticCode, "XERO_UNKNOWN"),
    ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
  };
}

function mapExportError(providerKind: string, error: unknown): AccountingExportResult {
  if (error instanceof XeroClientError) {
    switch (error.kind) {
      case "invalid_request":
        return refusedResult(providerKind, "invalid_record", error.diagnosticCode);
      case "auth_failed":
      case "config_error":
        return refusedResult(providerKind, "authentication_failed", error.diagnosticCode);
      case "provider_rejected":
        return refusedResult(providerKind, "provider_rejected", error.diagnosticCode);
      case "ambiguous_conflict":
        return unknownResult(providerKind, "ambiguous_conflict", error.diagnosticCode);
      case "rate_limited":
        return unknownResult(
          providerKind,
          "rate_limited",
          error.diagnosticCode,
          error.retryAfterSeconds,
        );
      case "provider_unavailable":
        return unknownResult(providerKind, "provider_unavailable", error.diagnosticCode);
      case "timeout":
        return unknownResult(providerKind, "timeout", error.diagnosticCode);
      case "transport_error":
        return unknownResult(providerKind, "transport_error", error.diagnosticCode);
    }
  }
  if (error instanceof OAuth2TokenError) {
    if (error.kind === "auth_failed" || error.kind === "config_error") {
      return refusedResult(providerKind, "authentication_failed", "XERO_OAUTH_AUTH_FAILED");
    }
    if (error.kind === "rate_limited") {
      return unknownResult(
        providerKind,
        "rate_limited",
        "XERO_OAUTH_RATE_LIMITED",
        error.retryAfterSeconds,
      );
    }
    if (error.kind === "timeout") {
      return unknownResult(providerKind, "timeout", "XERO_OAUTH_TIMEOUT");
    }
    return unknownResult(providerKind, "provider_unavailable", "XERO_OAUTH_UNAVAILABLE");
  }
  if (error instanceof HardenedFetchError) {
    if (error.kind === "timeout") {
      return unknownResult(providerKind, "timeout", "XERO_TIMEOUT");
    }
    if (error.kind === "network_error") {
      return unknownResult(providerKind, "transport_error", "XERO_TRANSPORT_ERROR");
    }
    if (error.kind === "http_error") {
      if (error.status === 401 || error.status === 403) {
        return refusedResult(providerKind, "authentication_failed", "XERO_AUTH_FAILED");
      }
      if (error.status === 408 || error.status === 409) {
        return unknownResult(providerKind, "ambiguous_conflict", "XERO_AMBIGUOUS_CONFLICT");
      }
      if (error.status === 429) {
        return unknownResult(
          providerKind,
          "rate_limited",
          "XERO_RATE_LIMITED",
          error.retryAfterSeconds,
        );
      }
      if (error.status !== undefined && error.status >= 500) {
        return unknownResult(providerKind, "provider_unavailable", "XERO_PROVIDER_UNAVAILABLE");
      }
      return refusedResult(providerKind, "provider_rejected", "XERO_PROVIDER_REJECTED");
    }
    return unknownResult(providerKind, "provider_unavailable", "XERO_PROVIDER_UNAVAILABLE");
  }
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return unknownResult(providerKind, "timeout", "XERO_TIMEOUT");
  }
  return unknownResult(providerKind, "transport_error", "XERO_TRANSPORT_ERROR");
}

function mapReadbackError(providerKind: string, error: unknown): AccountingReadbackResult {
  const mapped = mapExportError(providerKind, error);
  if (mapped.kind === "unknown") {
    return {
      kind: "unknown",
      providerKind,
      reason: mapped.reason,
      retryable: true,
      diagnosticCode: mapped.diagnosticCode,
      ...(mapped.retryAfterSeconds !== undefined
        ? { retryAfterSeconds: mapped.retryAfterSeconds }
        : {}),
    };
  }
  if (mapped.kind === "refused") {
    return {
      kind: "unknown",
      providerKind,
      reason: "provider_unavailable",
      retryable: true,
      diagnosticCode: mapped.diagnosticCode,
    };
  }
  return {
    kind: "unknown",
    providerKind,
    reason: "transport_error",
    retryable: true,
    diagnosticCode: "XERO_READBACK_UNAVAILABLE",
  };
}

function buildXeroManualJournalPayload(record: AccountingExportRecord): XeroCreateManualJournalPayload {
  return {
    Narration: record.exportKey,
    Date: record.entryDate,
    Status: "POSTED",
    JournalLines: record.lines.map((line) => {
      const signedMinor = line.side === "credit" ? -line.amountMinor : line.amountMinor;
      const description = line.memo ?? record.memo;
      return {
        LineAmount: minorUnitsToMajorDecimalString(signedMinor, record.currency),
        AccountCode: line.accountCode.trim(),
        ...(description ? { Description: description } : {}),
        ...(line.taxCode ? { TaxType: line.taxCode.trim() } : {}),
      };
    }),
  };
}

/**
 * Creates a Xero `AccountingLedgerExportPort` adapter backed by a narrow `XeroClient`
 * with zero-I/O balance preflight, exact signed BigInt currency formatting, structured
 * fault classification, and `ManualJournals` readback support.
 */
export function createXeroAdapter(
  options: CreateXeroAdapterOptions,
): AccountingLedgerExportPort {
  const capabilities: AccountingCapabilities = Object.freeze({
    contractVersion: ACCOUNTING_EXPORT_CONTRACT_VERSION,
    providerKind: XERO_PROVIDER_KIND,
    supportedEntryKinds: Object.freeze(
      options.supportedEntryKinds && options.supportedEntryKinds.length > 0
        ? [...options.supportedEntryKinds]
        : [...ACCOUNTING_ENTRY_KINDS],
    ),
    supportedCurrencies: Object.freeze(
      options.supportedCurrencies ? [...options.supportedCurrencies] : [],
    ),
    supportsReadback: true,
    supportsIdempotencyKey: true,
    requiresCredentials: true,
  });

  return Object.freeze({
    capabilities,

    async exportEntry(
      record: AccountingExportRecord,
      signal?: AbortSignal,
    ): Promise<AccountingExportResult> {
      const refusal = validateAccountingExportRecord(record, capabilities);
      if (refusal) {
        return refusal;
      }

      try {
        assertSafeXeroExportKey(record.exportKey);
      } catch {
        return refusedResult(XERO_PROVIDER_KIND, "invalid_record", "XERO_INVALID_EXPORT_KEY");
      }

      let payload: XeroCreateManualJournalPayload;
      try {
        payload = buildXeroManualJournalPayload(record);
      } catch {
        return refusedResult(XERO_PROVIDER_KIND, "unsupported_currency", "UNSUPPORTED_CURRENCY");
      }

      try {
        const created = await options.client.createManualJournal(
          record.exportKey,
          payload,
          signal,
        );
        return {
          kind: "exported",
          providerKind: XERO_PROVIDER_KIND,
          externalRef: created.id,
          exportKey: record.exportKey,
        };
      } catch (error) {
        return mapExportError(XERO_PROVIDER_KIND, error);
      }
    },

    async readEntryByKey(
      exportKey: string,
      signal?: AbortSignal,
    ): Promise<AccountingReadbackResult> {
      let safeKey: string;
      try {
        safeKey = assertSafeXeroExportKey(exportKey);
      } catch {
        return {
          kind: "unknown",
          providerKind: XERO_PROVIDER_KIND,
          reason: "transport_error",
          retryable: true,
          diagnosticCode: "XERO_INVALID_EXPORT_KEY",
        };
      }

      try {
        const found = await options.client.findManualJournalByKey(safeKey, signal);
        if (!found) {
          return {
            kind: "absent",
            providerKind: XERO_PROVIDER_KIND,
            exportKey: safeKey,
          };
        }
        return {
          kind: "found",
          providerKind: XERO_PROVIDER_KIND,
          externalRef: found.id,
          exportKey: safeKey,
        };
      } catch (error) {
        return mapReadbackError(XERO_PROVIDER_KIND, error);
      }
    },
  });
}
