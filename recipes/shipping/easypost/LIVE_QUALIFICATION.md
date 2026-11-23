# EasyPost Multi-Carrier Rates (REST v2) — Live Qualification Checklist

**Current status:** `offline-protocol-only`

This recipe has passed offline full-mode conformance (`runShippingRateAdapterConformance(..., { mode: "full" })`) and real-flow mount proof against `@openlup/platform/shipping`, `@openlup/platform/pricing`, and `@openlup/platform/promotions` without live EasyPost account credentials. Offline protocol certification does **not** prove live carrier account readiness, active carrier contracts, or production rating availability. Before switching to live traffic in an adopter application, complete every item below against a real EasyPost test and production account.

## 1. EasyPost Test & Production API Key Setup

- [ ] Create an EasyPost account and obtain a **Test API Key** (`EZTK...` prefix) from the EasyPost Dashboard for sandbox verification, and a separate **Production API Key** (`EZAK...` prefix) for live quoting.
- [ ] Store the API key in the adopter's secret manager (never hardcode keys in source, fixtures, or client bundles) and inject it explicitly into `createEasyPostHttpClient({ apiKey, fetchImpl })` using HTTP Basic Auth (`Authorization: Basic <base64(apiKey + ":")>`).
- [ ] Configure the adopter's supported carrier accounts inside the EasyPost Dashboard (for example USPS, UPS, FedEx) and verify the billing/postage wallet is active for the target corridors.
- [ ] Allowlist outbound egress in host network policy strictly to the pinned HTTPS origin declared in `recipe.json#egressOrigins`:
  - `https://api.easypost.com`

## 2. Host Capability & Currency Configuration

- [ ] Configure `supportedCurrencies`, `supportedOriginCountries`, and `supportedDestinationCountries` explicitly on `createEasyPostCarrierRateAdapter` to match the merchant's active checkout markets so unsupported corridors refuse at zero carrier I/O.
- [ ] Verify parcel weight (`weightGrams`) and optional dimensions (`lengthMm`, `widthMm`, `heightMm`) are converted accurately to ounces (`gramsToOunces`) and inches (`mmToInches`) for the merchant's packaging catalog.

## 3. Sandbox & Controlled Smoke Verification

- [ ] Issue a sandbox `POST https://api.easypost.com/v2/shipments` rate quote using an `EZTK...` Test API key and verify live shipment rate readback returns expected carrier/service codes, minor-unit integer amounts, and `providerShipmentRef`.
- [ ] Verify that currency filtering and optional `serviceFilter` (`service` or `carrier:service`) match the configured EasyPost carrier accounts cleanly and return `no_rates` when no eligible rate remains.
- [ ] Verify that invalid credentials return HTTP `401`/`403` and map to `authentication_failed` (`retryable: false`) without leaking the `EZTK...`/`EZAK...` API key or raw upstream response bodies.
- [ ] Verify that simulated rate-limiting (`429` with `Retry-After`) preserves `retryAfterSeconds`, and timeouts/`5xx` responses return retryable refusals (`timeout` / `provider_unavailable`).

## 4. Promotion Evidence

Record the sandbox verification date, carrier account test IDs, and sanitized `shp_...` test shipment readback reference in the adopter's operational readiness ledger before updating `liveQualification.status` to `"dated-sandbox-receipt"` (with ISO-8601 `qualifiedAt` and `qualifiedPlatformVersion` matching `recipes/schema/recipe.schema.json`).
