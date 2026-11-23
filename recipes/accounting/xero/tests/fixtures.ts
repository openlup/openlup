import { ACCOUNTING_EXPORT_CONTRACT_VERSION } from "@openlup/platform/accounting";
import type { AccountingExportRecord } from "@openlup/platform/accounting/contracts";

export const FIXTURE_TENANT_ID = "a1b2c3d4-e5f6-47a8-9b0c-1234567890ab";

export const FIXTURE_SENSITIVE_CANARIES = Object.freeze({
  marker: "xero-canary-marker/alpha+01",
  clientId: "xero-canary-client-id/01",
  clientSecret: "xero-canary-client-secret/01",
  refreshToken: "xero-canary-refresh/01",
  accessToken: "xero-canary-access/01",
  rotatedAccessToken: "xero-canary-access/02",
});

export function buildXeroExportRecord(
  overrides?: Partial<AccountingExportRecord>,
): AccountingExportRecord {
  return {
    contractVersion: ACCOUNTING_EXPORT_CONTRACT_VERSION,
    exportKey: "ord-2001-sale",
    entryKind: "sale",
    entryDate: "2000-01-15",
    currency: "GBP",
    sourceRef: "ord-2001",
    memo: "Storefront order ord-2001",
    lines: [
      { accountCode: "120", side: "debit", amountMinor: 4215, memo: "Clearing receivable" },
      { accountCode: "200", side: "credit", amountMinor: 3500, memo: "Sales revenue" },
      { accountCode: "820", side: "credit", amountMinor: 715, taxCode: "OUTPUT2", memo: "VAT" },
    ],
    ...overrides,
  };
}
