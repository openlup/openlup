# Avalara AvaTax (REST v2) — Live Qualification Checklist

**Current status:** `offline-protocol-only`

This recipe has passed the full 16-case offline `@openlup/platform/tax` conformance runner (`runTaxAdapterConformance`) and Stage 3 real-flow mount proofs without live Avalara AvaTax credentials. Because `@openlup/platform/tax` is currently `experimental` in `1.3.0`, complete every checklist item below against a real Avalara AvaTax Sandbox account before promoting to production.

## 1. Avalara Account, Company & Nexus Setup

- [ ] Provision an Avalara AvaTax Sandbox account (`mode: "test"` -> `https://sandbox-rest.avatax.com`) and production account (`mode: "live"` -> `https://rest.avatax.com`).
- [ ] Store `accountId` and `licenseKey` in the adopting application's secret manager and inject them lazily via the `credentials` callback passed to `createAvalaraHttpClient` (never read ambient environment variables inside the recipe).
- [ ] Configure the target `companyCode` and verify nexus jurisdictions and effective registration intervals in Avalara match the host's `TaxCoverageV1` declarations.
- [ ] Configure the Avalara certification header (`X-Avalara-Client`, format `"{appName}; {appVersion}; OpenLup; 1.3.0; {machineName}"`) via `clientHeader`.
- [ ] Allowlist outbound HTTPS egress strictly to the pinned origins declared in `recipe.json#egressOrigins`:
  - `https://sandbox-rest.avatax.com`
  - `https://rest.avatax.com`

## 2. Tax Codes, Ship-From Origins & Retail Delivery Fees

- [ ] Map every host `taxClass` used on merchandise and delivery buckets to an official Avalara AvaTax `taxCode` (for example `P0000000` for tangible personal property, `FR020100` for freight/shipping) in `marketPack.taxCodes`.
- [ ] Configure verified physical `shipFrom` origin addresses keyed by `shipFromRef` in `marketPack.shipFromOrigins`.
- [ ] For jurisdictions assessing retail delivery fees (for example Colorado / Minnesota RDF), configure explicit `marketPack.feeBindings` linking the AvaTax `taxType`/`taxSubTypeId` to the required fee cell and `refundRule`.

## 3. Sandbox & Controlled Production Smoke Tests

- [ ] Execute a `SalesOrder` quote (`commit: false`) against `https://sandbox-rest.avatax.com/api/v2/transactions/create` for a multi-jurisdiction US address and verify `verifyTaxQuoteResult(request, result) === undefined`.
- [ ] Execute a multi-step discount quote and confirm tax monotonically decreases or stays equal across discount stages.
- [ ] Verify `readFiscalValidity` returns `tax_fiscal_validity_unavailable` (`effect: "none"`) with zero HTTP calls, and run a renewal recalculation probe via `compareTaxRecalculationProbe`.
- [ ] Call `closeCalculation` on an unused quote and verify zero HTTP calls (`POST .../void` is never called for local close).
- [ ] Commit a verified quote (`type: "SalesInvoice"`, `commit: true`) and confirm duplicate `commit` replays idempotently while conflicting `captureEvidenceRef` refuses `tax_reference_conflict`.
- [ ] Execute a partial reversal (`mode: "lines"` -> `ReturnInvoice`), a remainder reversal (`mode: "full"`, `fromMinor > 0` -> `ReturnInvoice`), and a clean full reversal (`mode: "full"`, `fromMinor === 0`, `toMinor === payableMinor` -> `POST /api/v2/companies/{companyCode}/transactions/{transactionCode}/void` with `{ code: "DocVoided" }`).
- [ ] Execute `intent: "recover"` after a simulated 503/timeout on commit or reversal and verify readback via `GET /api/v2/companies/{companyCode}/transactions/{transactionCode}` resolves the existing committed document without duplicate posting.
- [ ] Verify that `accountId`, `licenseKey`, `Basic` auth tokens, and customer destination addresses never appear in durable evidence, logs, or error diagnostics.

## 4. Promotion Evidence

Record the sandbox verification date, Avalara environment, and sanitized document codes in the adopter's operational readiness ledger before switching `liveQualification.status` to `"dated-sandbox-receipt"` (with ISO-8601 `qualifiedAt` and `qualifiedPlatformVersion` matching `recipes/schema/recipe.schema.json`).
