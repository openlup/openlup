# USPS Domestic Prices (API v3) — Live Qualification Checklist

**Current status:** `offline-protocol-only`

This recipe has passed the full-mode `@openlup/platform/shipping/testing` conformance runner (`runShippingRateAdapterConformance(..., { mode: "full" })`) and Stage 3 real-flow mount proofs without live USPS Developer Portal credentials. Complete every checklist item below against the USPS Developer Portal Testing Environment for Mailers (`apis-tem.usps.com`) and Production (`apis.usps.com`) before promoting to production.

## 1. USPS Developer Portal & OAuth2 Setup

- [ ] Register an application in the USPS Developer Portal (`developer.usps.com`) and subscribe it to the **Domestic Prices v3** (`prices/v3`) and **OAuth 2.0** (`oauth2/v3`) products.
- [ ] Provision separate TEM (`apis-tem.usps.com`) and Production (`apis.usps.com`) OAuth2 client credentials (`clientId`, `clientSecret`) in the adopting application's secret manager and inject them explicitly into `createUspsOAuth2TokenManager` (never read ambient environment variables inside the recipe).
- [ ] Allowlist outbound HTTPS egress strictly to the pinned origins declared in `recipe.json#egressOrigins`:
  - `https://apis-tem.usps.com` (TEM sandbox)
  - `https://apis.usps.com` (Production)
- [ ] Verify the adopter's `priceType` (`"RETAIL"`, `"COMMERCIAL"`, `"CONTRACT"`, or `"NSA"`), `processingCategory`, and `destinationEntryFacilityType` match the merchant's USPS account/permit profile.

## 2. TEM (`apis-tem.usps.com`) Smoke Tests

- [ ] Request an OAuth2 token from `POST https://apis-tem.usps.com/oauth2/v3/token` (`grant_type: "client_credentials"`) and verify concurrent `getAccessToken()` calls deduplicate to a single outbound request and refresh proactively within `refreshSkewSeconds`.
- [ ] Execute `POST https://apis-tem.usps.com/prices/v3/base-rates/search` via `createUspsCarrierRateAdapter` for a valid US 5-digit origin/destination ZIP pair with parcel weight and dimensions in metric units (`weightGrams`, `lengthMm`, `widthMm`, `heightMm`) and confirm `quoted` rates sort ascending by `amountMinor` in `USD`.
- [ ] Verify `serviceFilter` narrows returned `CarrierRateOption` entries to the requested `mailClass` codes and returns `no_rates` when no service matches.
- [ ] Verify invalid US postal codes, non-`US` origin/destination countries, missing parcel dimensions, multi-parcel requests, and non-`USD` currencies refuse at `0` HTTP calls.
- [ ] Simulate an expired or revoked Bearer token (`401`) and confirm `createUspsHttpClient` calls `tokenManager.invalidate()` so the subsequent quote fetches a fresh OAuth2 token without leaking credentials or raw error bodies.
- [ ] Confirm `429` responses preserve `Retry-After` as `retryAfterSeconds` with `retryable: true` and `5xx` / timeout faults return structured `provider_unavailable` / `timeout` refusals without throwing.

## 3. Production (`apis.usps.com`) Cutover & Promotion Evidence

- [ ] Repeat the live base-rate quote check against `https://apis.usps.com/prices/v3/base-rates/search` using production OAuth2 credentials for at least one `USPS_GROUND_ADVANTAGE` and one `PRIORITY_MAIL` parcel.
- [ ] Confirm `clientId`, `clientSecret`, Bearer access tokens, and raw USPS error payloads never appear in logs, quote snapshots, or operator diagnostics.
- [ ] Record the TEM and Production qualification dates and sanitized rate-quote correlation IDs in the adopter's operational readiness ledger before switching `liveQualification.status` to `"dated-sandbox-receipt"` (with ISO-8601 `qualifiedAt` and `qualifiedPlatformVersion` matching `recipes/schema/recipe.schema.json`).
