export type AccountingExportContractVersion = "accounting.ledger_export.v1";

export type AccountingEntryKind =
  | "sale"
  | "refund"
  | "payout"
  | "tax_liability"
  | "fee"
  | "adjustment";

export type AccountingLineSide = "debit" | "credit";

export interface AccountingJournalLine {
  readonly accountCode: string;
  readonly side: AccountingLineSide;
  readonly amountMinor: number;
  readonly taxCode?: string;
  readonly memo?: string;
  readonly entityRef?: string;
}

export interface AccountingExportRecord {
  readonly contractVersion: AccountingExportContractVersion;
  readonly exportKey: string;
  readonly entryKind: AccountingEntryKind;
  readonly entryDate: string;
  readonly currency: string;
  readonly sourceRef: string;
  readonly lines: readonly AccountingJournalLine[];
  readonly memo?: string;
}

export type AccountingRefusalReason =
  | "unbalanced_entry"
  | "invalid_record"
  | "unsupported_currency"
  | "unsupported_entry_kind"
  | "missing_account_mapping"
  | "authentication_failed"
  | "provider_rejected";

export type AccountingUnknownReason =
  | "rate_limited"
  | "provider_unavailable"
  | "timeout"
  | "ambiguous_conflict"
  | "transport_error";

export type AccountingExportResult =
  | {
      readonly kind: "exported";
      readonly providerKind: string;
      readonly externalRef: string;
      readonly exportKey: string;
      readonly idempotentReplay?: boolean;
    }
  | {
      readonly kind: "refused";
      readonly providerKind: string;
      readonly reason: AccountingRefusalReason;
      readonly retryable: false;
      readonly effectMayHaveSucceeded: false;
      readonly diagnosticCode: string;
    }
  | {
      readonly kind: "unknown";
      readonly providerKind: string;
      readonly reason: AccountingUnknownReason;
      readonly retryable: true;
      readonly effectMayHaveSucceeded: true;
      readonly diagnosticCode: string;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly kind: "unsupported";
      readonly providerKind: string;
      readonly diagnosticCode: string;
    };

export type AccountingReadbackResult =
  | {
      readonly kind: "found";
      readonly providerKind: string;
      readonly externalRef: string;
      readonly exportKey: string;
    }
  | {
      readonly kind: "absent";
      readonly providerKind: string;
      readonly exportKey: string;
    }
  | {
      readonly kind: "unknown";
      readonly providerKind: string;
      readonly reason: AccountingUnknownReason;
      readonly retryable: true;
      readonly diagnosticCode: string;
      readonly retryAfterSeconds?: number;
    }
  | {
      readonly kind: "unsupported";
      readonly providerKind: string;
      readonly diagnosticCode: string;
    };

export interface AccountingCapabilities {
  readonly contractVersion: AccountingExportContractVersion;
  readonly providerKind: string;
  readonly supportedEntryKinds: readonly AccountingEntryKind[];
  readonly supportedCurrencies: readonly string[];
  readonly supportsReadback: boolean;
  readonly supportsIdempotencyKey: boolean;
  readonly requiresCredentials: boolean;
}

export interface AccountingLedgerExportPort {
  readonly capabilities: AccountingCapabilities;
  exportEntry(record: AccountingExportRecord, signal?: AbortSignal): Promise<AccountingExportResult>;
  readEntryByKey?(exportKey: string, signal?: AbortSignal): Promise<AccountingReadbackResult>;
}
