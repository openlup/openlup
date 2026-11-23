import { ACCOUNTING_EXPORT_CONTRACT_VERSION } from "@openlup/platform/accounting";
import type { AccountingExportRecord } from "@openlup/platform/accounting/contracts";

export const FIXTURE_REALM_ID = "4620816365012345678";

export const FIXTURE_SENSITIVE_CANARIES = Object.freeze({
  marker: "qbo-canary-marker/alpha+01",
  clientId: "qbo-canary-client-id/01",
  clientSecret: "qbo-canary-client-secret/01",
  refreshToken: "qbo-canary-refresh/01",
  accessToken: "qbo-canary-access/01",
  rotatedAccessToken: "qbo-canary-access/02",
});

export function buildQuickBooksExportRecord(
  overrides?: Partial<AccountingExportRecord>,
): AccountingExportRecord {
  return {
    contractVersion: ACCOUNTING_EXPORT_CONTRACT_VERSION,
    exportKey: "ord-1001-sale",
    entryKind: "sale",
    entryDate: "2000-01-15",
    currency: "USD",
    sourceRef: "ord-1001",
    memo: "Storefront order ord-1001",
    lines: [
      { accountCode: "1100", side: "debit", amountMinor: 2505, memo: "Receivable" },
      { accountCode: "4000", side: "credit", amountMinor: 2000, memo: "Product revenue" },
      { accountCode: "2200", side: "credit", amountMinor: 505, taxCode: "TAX", memo: "Sales tax" },
    ],
    ...overrides,
  };
}
