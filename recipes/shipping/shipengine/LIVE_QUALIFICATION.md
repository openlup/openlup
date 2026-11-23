# ShipEngine Multi-Carrier Rates (REST v1) — Stage 4 Live Account Qualification Checklist

> **Important:** Passing offline Stages 1–3 (`conformance.test.ts` and `mount-proof.test.ts`) proves protocol translation, zero-I/O capability validation, `BigInt`/`Intl` money normalization, HTTP 429 `retryAfterSeconds` preservation, and commerce quote wiring — it **does not** certify your ShipEngine account or connected carriers. Complete every step below in a ShipEngine **Sandbox** account before enabling live rate shopping.

---

## 1. Account & Carrier Prerequisites (ShipEngine Dashboard)
- [ ] **API Key:** Generate a Sandbox API key (`TEST_...`) in your ShipEngine dashboard and store it in your host secret manager (never commit or read inside the recipe).
- [ ] **Carrier IDs:** Connect at least one carrier in ShipEngine and record its `carrier_id` (e.g., `se-...`) for `ShipEngineRateAdapterConfig.carrierIds`.
- [ ] **Currencies:** Confirm `config.supportedCurrencies` matches the settlement currency of your connected carrier accounts and your OpenLup store profile.

---

## 2. Egress & Transport Contract
- [ ] **Pinned Origin:** Outbound rate requests target `https://api.shipengine.com/v1/rates` only (`redirect: "error"`), authenticated via `API-Key`.
- [ ] **Rate Limits (`429`):** Confirm your host handles `result.kind === "refused"` with `reason: "rate_limited"` and honors `result.retryAfterSeconds`.
- [ ] **Address Validation Mode:** Choose `"no_validation"`, `"validate_only"`, or `"validate_and_clean"` on `ShipEngineRateAdapterConfig.validateAddress` according to your carrier requirements.

---

## 3. End-to-End Sandbox Proof
Execute against your ShipEngine **Sandbox** API key and retain a redacted receipt (no API key or customer street addresses):
1. [ ] **Happy Multi-Carrier Quote:** Request rates for a standard parcel and confirm sorted `CarrierRateOption[]` amounts in integer minor units match ShipEngine's `shipping_amount` (+ optional surcharges).
2. [ ] **No-Rates Handling:** Request a route/service filter with zero eligible rates and verify `kind: "no_rates"` is returned cleanly without throwing.
3. [ ] **Commerce Quote Integration:** Wire `selectCheapestCarrierRate(result.rates)` into your commerce quote shipping policy and verify free-shipping threshold / promo evaluation never falls back to free shipping when `result.kind === "refused"`.
4. [ ] **Update `recipe.json` (in your store repo):** Record `liveQualification: { status: "dated-sandbox-receipt", checklist: "LIVE_QUALIFICATION.md", qualifiedAt: "<ISO-UTC>", qualifiedPlatformVersion: "<version>" }`.
