# Adyen Checkout (v71) — Stage 4 Live Account Qualification Checklist

> **Important:** Passing offline Stages 1–3 (`conformance.test.ts` and `mount-proof.test.ts`) proves protocol translation, HMAC verification, zero-I/O refusals, and OpenLup rail wiring — it **does not** certify your live or test Adyen merchant account. Complete every step below in an isolated Adyen **Test** merchant account before enabling live settlement.

---

## 1. Account & API Prerequisites (Adyen Customer Area)
- [ ] **Merchant Account:** Confirm exact `merchantAccount` string (case-sensitive; webhooks with mismatched `merchantAccountCode` are rejected).
- [ ] **API Credential:** Create a dedicated Checkout API credential (`ws_...`) with `Checkout Webservice Role` and generate an `X-API-Key`. Store it in your host secret manager (never commit or read inside the recipe).
- [ ] **Live URL Prefix (Live mode only):** Copy your account's exact `liveUrlPrefix` (alphanumeric + hyphen only, e.g., `1797a841fbb37ca7-AdyenDemo`). Test mode pins `https://checkout-test.adyen.com/v71` automatically.
- [ ] **Currencies:** Verify every currency listed in `config.supportedCurrencies` (e.g., `["USD", "EUR"]`) is enabled on the merchant account and matches your OpenLup settlement profile.
- [ ] **Capture Mode Alignment:** Verify your merchant account's **Capture Delay** setting matches `config.captureMode`:
  - `Immediate` capture delay in Adyen → `captureMode: "immediate"` (`AUTHORISATION` settles money).
  - `Manual` or delayed capture in Adyen → `captureMode: "delayed"` (`AUTHORISATION` stays `pending`, `CAPTURE` settles money).
- [ ] **Subscription Tokenization (`ContAuth`):** Enable `Store payment method` / `Subscription` recurring processing model on the merchant account and confirm `AUTHORISATION` webhooks include `additionalData["recurring.recurringDetailReference"]` (enable **Additional Settings → Include Recurring Details** in the webhook configuration).

---

## 2. Webhook Configuration & Host Route Contract
- [ ] **Standard Webhook Endpoint:** Register your host HTTPS endpoint (`POST /api/bff/payment/webhooks/adyen`) in Adyen Customer Area → **Developers → Webhooks → Standard webhook**.
- [ ] **HMAC Key & Transport Authentication:** Generate a 64-character hex HMAC key in Adyen and supply it via `config.hmacKeysHex: [primaryHexKey]` (pass `[newKey, oldKey]` during zero-downtime key rotation). **Security note:** Adyen's canonical HMAC authenticates only the 8 core fields (including `merchantReference`, which this recipe treats as authoritative for `intentRef`); it does **not** sign `additionalData` (`metadata.attemptRef`, `recurring.*`) or `eventDate`. Configure **Basic Auth** or **mTLS** on your host webhook route in Adyen Customer Area to authenticate the full transport envelope before invoking `verifyPort`.
- [ ] **Critical Host HTTP Acknowledgement (`[accepted]`):** Adyen requires HTTP `200` with body `{"notificationResponse":"[accepted]"}` (or plain `"[accepted]"`) within 10 seconds, or it retries for up to 7 days. Because OpenLup's `createVerifiedPaymentIngress` is transport-neutral (`{ status: 200, data }`), your host HTTP route MUST map `result.status === 200` to HTTP `200` with body `{ notificationResponse: "[accepted]" }`.
- [ ] **Raw Body Size Cap:** Preserve untouched raw request bytes up to `MAX_WEBHOOK_BODY_BYTES` (1 MiB) before invoking `verifyPort.verifyAndNormalize(...)`.
- [ ] **Metadata Echo:** Enable **Include Metadata** in Adyen webhook settings so `metadata.attemptRef` returns on notifications (note: `merchantReference` remains the HMAC-authenticated source of truth for `intentRef`; mismatched `metadata.intentRef` is refused as `malformed`).

---

## 3. Browser Drop-in & CSP Verification (If Using `browser/index.ts`)
- [ ] **Client Key & Allowed Origins:** Generate an Adyen `clientKey` and whitelist your exact storefront origin(s) in Adyen Customer Area.
- [ ] **CSP Merge:** Merge the active environment (`test` or `live`) from `browser/csp.json` into your host's `Content-Security-Policy` header inside `NodeSecurityHeaderPolicy.globalHeaders`.
- [ ] **Degraded UX Check:** Verify that blocking `checkoutshopper-test.adyen.com` in DevTools transitions the checkout component cleanly into `status: "loadFailed"` without unhandled promise rejections.

---

## 4. End-to-End Test Account Readback Proof
Execute on your disposable Adyen **Test** account and retain a redacted receipt (no API keys, HMAC keys, PANs, or `sessionData`):
1. [ ] **Interactive Drop-in Checkout:** Complete a test card purchase (Adyen test card) and verify the signed `AUTHORISATION` webhook settles the PostgreSQL order once and replays idempotently on duplicate delivery.
2. [ ] **Stored Method & Unattended Renewal (`ContAuth`):** Confirm `recurring.recurringDetailReference` is captured and a subsequent `purpose: "renewal-unattended"` charge succeeds off-session.
3. [ ] **Declined Charge:** Trigger a test refusal (e.g., Adyen `Refused` test card) and verify neutral refusal classification without settling the order.
4. [ ] **Async Cancellation (`close`):** Call `readbackPort.close(...)` on an authorized payment, verify `kind: "pending"`, and confirm the subsequent `CANCELLATION` webhook transitions the attempt cleanly.
5. [ ] **Refund & Chargeback Webhooks:** Trigger a test refund and test chargeback from Adyen Customer Area and verify `outcome: "refunded"` and `outcome: "disputed"` are recorded without fabricating `originalPaymentMoney`.
6. [ ] **Update `recipe.json` (in your store repo):** Record `liveQualification: { status: "dated-sandbox-receipt", checklist: "LIVE_QUALIFICATION.md", qualifiedAt: "<ISO-UTC>", qualifiedPlatformVersion: "<version>" }`.
