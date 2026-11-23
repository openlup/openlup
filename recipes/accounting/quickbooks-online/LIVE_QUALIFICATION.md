# QuickBooks Online (Accounting REST v3) — Live Qualification Checklist

**Current status:** `offline-protocol-only`

This recipe has passed offline full-mode conformance (`runAccountingAdapterConformance(..., { mode: "full" })`) and real-flow outbox mount proof against `@openlup/platform/accounting` and `@openlup/platform/adapter-kit` without live Intuit QuickBooks Online credentials. Before enabling live ledger exports in a production adopter application, complete every item below against an Intuit Developer Sandbox company and your production Intuit company.

## 1. Intuit App, OAuth2 Refresh Token & Realm Setup

- [ ] Provision an Intuit Developer app with the `com.intuit.quickbooks.accounting` scope in the target environment (`sandbox` or `production`).
- [ ] Complete the OAuth2 authorization-code exchange for the target company and record its numeric `realmId` (1–32 ASCII digits, validated strictly at client construction time).
- [ ] Store `clientId`, `clientSecret`, and the rotating `refreshToken` in the host secret manager and inject them into `createQuickBooksOnlineHttpClient` (with optional `tokenCache` persisted across restarts so refreshed tokens remain durable).
- [ ] Allowlist egress in host network policy strictly to the pinned HTTPS origins declared in `recipe.json#egressOrigins`:
  - `https://quickbooks.api.intuit.com` (`production`)
  - `https://sandbox-quickbooks.api.intuit.com` (`sandbox`)
  - `https://oauth.platform.intuit.com` (OAuth2 token endpoint)

## 2. Chart of Accounts, Multi-Currency & DocNumber Policy

- [ ] Map every OpenLup ledger `accountCode` (sales, refunds, payouts, fees, tax liabilities, adjustments) to an active QuickBooks Online Account `Id` in the target company's Chart of Accounts.
- [ ] Configure `supportedCurrencies` on `createQuickBooksOnlineAdapter` to match the company's home currency and any enabled Intuit Multi-Currency codes (leave `[]` only if the host enforces currency policy upstream).
- [ ] Verify `DocNumber` length constraints (QuickBooks Online enforces a 21-character limit on `JournalEntry.DocNumber` in standard company settings; ensure your outbox `exportKey` generator stays within your Intuit company's `DocNumber` policy if readback by `DocNumber` is used).

## 3. Intuit Sandbox & Controlled Production Smoke Tests

- [ ] Execute a balanced `POST /v3/company/{realmId}/journalentry?minorversion=73` with `Request-Id: <exportKey>` and verify the created `JournalEntry.Id` appears in the Intuit Sandbox company ledger with exact decimal amounts for both 2-decimal (e.g., `USD`/`EUR`) and 0-decimal (e.g., `JPY`) or 3-decimal (e.g., `BHD`) currencies.
- [ ] Execute `readEntryByKey(exportKey)` (`GET /v3/company/{realmId}/query?query=SELECT Id, DocNumber FROM JournalEntry WHERE DocNumber = '...'&minorversion=73`) and confirm it resolves the exact `JournalEntry.Id` when present and returns `absent` when missing.
- [ ] Verify that an intentionally unbalanced journal entry or missing `accountCode` is refused at zero HTTP calls (`validateAccountingExportRecord` preflight).
- [ ] Simulate an expired access token (HTTP 401) and confirm `createQuickBooksOnlineHttpClient` invalidates the cached token so the subsequent attempt refreshes cleanly via `https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer`.
- [ ] Simulate an ambiguous failure (HTTP 408/409/429/5xx or timeout) and verify the host outbox transitions to `unknown` and reconciles via `readEntryByKey(exportKey)` before ever re-posting.
- [ ] Confirm `clientSecret`, `refreshToken`, and OAuth2 `access_token` values never appear in outbox persistence, operator diagnostics, or structured logs.

## 4. Promotion Evidence

Record the Intuit Sandbox verification date, `sandbox` `realmId`, Intuit `minorversion=73` response `JournalEntry.Id`s, and sanitized outbox reconciliation logs in the adopter's operational readiness ledger before updating `liveQualification.status` to `"dated-sandbox-receipt"` (with ISO-8601 `qualifiedAt` and `qualifiedPlatformVersion` matching `recipes/schema/recipe.schema.json`).
