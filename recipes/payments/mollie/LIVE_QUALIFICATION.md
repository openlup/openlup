# Mollie Payments (API v2) — Stage 4 Live Account Qualification Checklist

> **Important:** Passing offline Stages 1–3 (`conformance.test.ts` and `mount-proof.test.ts`) proves protocol translation, readback-authenticated webhook verification, zero-I/O refusals, and OpenLup rail wiring — it **does not** certify your live or test Mollie organization profile. Complete every step below in an isolated Mollie **Test** profile before enabling live settlement.

---

## 1. Account & API Prerequisites (Mollie Dashboard)
- [ ] **Website Profile & Payment Methods:** Verify your Mollie profile has every payment method family enabled that your checkout exposes (Cards, Wallets such as Apple Pay / PayPal, and Bank Redirect methods such as iDEAL / Bancontact).
- [ ] **API Key & Mode Parity:** Create a dedicated profile API key (`test_...` for test mode, `live_...` for live mode) and store it in your host secret manager (never commit or read inside the recipe). The client enforces strict `mode` ↔ key-prefix parity before any network dispatch.
- [ ] **Currencies:** Verify every ISO-4217 currency listed in `config.supportedCurrencies` (e.g., `["EUR", "USD"]`) is enabled on your Mollie profile and matches your OpenLup settlement profile.
- [ ] **Customers & Mandates (`sequenceType: "first"` / `"recurring"`):** Confirm recurring payments are activated on your Mollie profile so first payments with `saveForFutureUse: true` produce a `mandateId` when paid, enabling subsequent `purpose: "renewal-unattended"` charges.

---

## 2. Readback-Authenticated Webhook Contract
- [ ] **Form-Urlencoded Endpoint:** Configure your host HTTPS webhook route (`POST /api/bff/payment/webhooks/mollie`) to preserve untouched raw request bytes (up to `MAX_WEBHOOK_BODY_BYTES`, 1 MiB) and forward them directly to `verifyPort.verifyAndNormalize(...)`.
- [ ] **No Webhook Signature — Readback Authentication:** Mollie sends `application/x-www-form-urlencoded` (`id=tr_...`) with **no** HMAC signature. Authenticity is established solely by verifying the `tr_...` identifier via `GET https://api.mollie.com/v2/payments/{id}` over TLS with `redirect: "error"` and checking `payment.id === id` and `payment.mode === config.mode`.
- [ ] **HTTP 200 Acknowledgement & 400 Refusal:** Map `result.status === 200` from `createVerifiedPaymentIngress` to HTTP `200` so Mollie stops retrying; forged or non-existent IDs (`404`/`401`/`403`) return `{ kind: "refusal", reason: "signature" }` → HTTP `400` with zero ledger writes.
- [ ] **Metadata Preservation:** Keep `metadata.intentRef` and `metadata.attemptRef` attached at payment creation so readback-verified webhooks correlate back to the exact OpenLup intent and attempt.

---

## 3. End-to-End Test Profile Readback Proof
Execute on your disposable Mollie **Test** profile and retain a redacted receipt (no API keys or customer emails/names):
1. [ ] **Interactive Hosted Checkout:** Complete a test payment via `_links.checkout.href`, confirm `verifyPort` reads `status: "paid"` from `GET /v2/payments/{id}`, settles the PostgreSQL intent once, and replays idempotently on duplicate delivery.
2. [ ] **Mandate Capture & Unattended Renewal:** Complete a `saveForFutureUse: true` (`sequenceType: "first"`) payment, confirm `mandateId` is stored from the `"paid"` readback, and verify a subsequent `purpose: "renewal-unattended"` (`sequenceType: "recurring"`) charge succeeds off-session.
3. [ ] **Declined / Expired Payment:** Trigger a failed or expired test payment and verify neutral failure classification without settling the order.
4. [ ] **Synchronous Readback & Cancel (`readPayment` / `close`):** Call `readbackPort.readPayment(...)` on an open and a paid payment, and call `readbackPort.close(...)` (`DELETE /v2/payments/{id}`) on a cancelable open payment, verifying honest `failed` (`canceled`) readback.
5. [ ] **Partial Refund & Chargeback Observation:** Trigger a partial refund and a test chargeback in Mollie Dashboard and verify `outcome: "refunded"` (`cumulative-snapshot`) and `outcome: "disputed"` are recorded without fabricating totals.
6. [ ] **Update `recipe.json` (in your store repo):** Record `liveQualification: { status: "dated-sandbox-receipt", checklist: "LIVE_QUALIFICATION.md", qualifiedAt: "<ISO-UTC>", qualifiedPlatformVersion: "<version>" }`.
