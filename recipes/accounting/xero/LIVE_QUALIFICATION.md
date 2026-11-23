# Xero (Accounting API 2.0) — Live Qualification Checklist

**Current status:** `offline-protocol-only`

This recipe has passed offline full-mode conformance (`runAccountingAdapterConformance(..., { mode: "full" })`) and real-flow outbox mount proof against `@openlup/platform/accounting` and `@openlup/platform/adapter-kit` without live Xero credentials. Before enabling live ledger exports in a production adopter application, complete every item below against a Xero Demo Company and your production Xero organisation.

## 1. Xero App, OAuth2 Refresh Token & Tenant Setup

- [ ] Provision a Xero OAuth2 app with the `accounting.journals.read` and `accounting.transactions` (or `accounting.settings`) scopes required for `ManualJournals`.
- [ ] Complete the OAuth2 authorization-code exchange (`offline_access` scope) for the target Xero organisation and record its `xero-tenant-id` UUID (36 characters matching `/^[0-9a-fA-F-]{36}$/u`, validated strictly at client construction time).
- [ ] Store `clientId`, `clientSecret`, and the rotating `refreshToken` in the host secret manager and manage Xero's rotating refresh-token lifecycle in the host auth layer; optionally pass `tokenCache` to `createXeroHttpClient` to cache short-lived OAuth2 access tokens (`{ accessToken, expiresAtMs }`) across requests.
- [ ] Allowlist egress in host network policy strictly to the pinned HTTPS origins declared in `recipe.json#egressOrigins`:
  - `https://api.xero.com` (`PUT` / `GET /api.xro/2.0/ManualJournals`)
  - `https://identity.xero.com` (OAuth2 token endpoint `/connect/token`)

## 2. Chart of Accounts & Currency Configuration

- [ ] Map every OpenLup ledger `accountCode` (sales, refunds, payouts, fees, tax liabilities, adjustments) to an active Xero Chart of Accounts `Code` (note Xero `ManualJournals` use `AccountCode`, not internal `AccountID`).
- [ ] Configure `supportedCurrencies` on `createXeroAdapter` to match the Xero organisation's base currency (Xero `ManualJournals` post in the organisation's base currency).
- [ ] Verify `TaxType` values on journal lines (`line.taxCode`) match active Xero tax rates in the organisation when tax reporting is enabled.

## 3. Xero Demo Company & Controlled Production Smoke Tests

- [ ] Execute a balanced `PUT /api.xro/2.0/ManualJournals` with `xero-tenant-id` and `Idempotency-Key: <exportKey>`, confirming positive `LineAmount` values for debits, negative `LineAmount` values for credits, and exact decimal formatting across 2-decimal and 0/3-decimal currencies.
- [ ] Execute `readEntryByKey(exportKey)` (`GET /api.xro/2.0/ManualJournals?where=Narration=="..."`) and verify it resolves `ManualJournalID` when present and returns `absent` when missing.
- [ ] Verify that an intentionally unbalanced journal entry or missing `accountCode` is refused at zero HTTP calls (`validateAccountingExportRecord` preflight).
- [ ] Simulate an expired access token (HTTP 401) and confirm `createXeroHttpClient` invalidates the cached token so the subsequent attempt refreshes cleanly via `https://identity.xero.com/connect/token`.
- [ ] Simulate an ambiguous failure (HTTP 408/409/429/5xx or timeout) and verify the host outbox transitions to `unknown` and reconciles via `readEntryByKey(exportKey)` before re-issuing `PUT /api.xro/2.0/ManualJournals`.
- [ ] Confirm `clientSecret`, `refreshToken`, and OAuth2 `access_token` values never appear in outbox persistence, operator diagnostics, or structured logs.

## 4. Promotion Evidence

Record the Xero Demo Company verification date, `xero-tenant-id`, `ManualJournalID` responses, and sanitized outbox reconciliation logs in the adopter's operational readiness ledger before updating `liveQualification.status` to `"dated-sandbox-receipt"` (with ISO-8601 `qualifiedAt` and `qualifiedPlatformVersion` matching `recipes/schema/recipe.schema.json`).
