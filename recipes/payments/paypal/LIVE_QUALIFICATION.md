# PayPal Checkout (Orders API v2) — Stage 4 Live Account Qualification Checklist

> **Important:** Passing offline Stages 1–3 (`conformance.test.ts` and `mount-proof.test.ts`) proves protocol translation, OAuth2 `client_credentials` token caching, readback-authenticated webhook verification, zero-I/O refusals, and OpenLup rail wiring — it **does not** certify your live or sandbox PayPal REST app. Complete every step below in an isolated PayPal **Sandbox** app before enabling live settlement.

---

## 1. Account & API Prerequisites (PayPal Developer Dashboard)
- [ ] **REST App & OAuth2 Credentials:** Create separate Sandbox (`https://api-m.sandbox.paypal.com`) and Live (`https://api-m.paypal.com`) REST applications and store `clientId` / `clientSecret` in your host secret manager (never commit or read inside the recipe).
- [ ] **Currencies:** Verify every ISO-4217 currency listed in `config.supportedCurrencies` (e.g., `["EUR", "USD"]`) is enabled on your PayPal merchant account and matches your OpenLup settlement profile.
- [ ] **Return & Cancel URLs:** Configure valid HTTPS `returnUrl` and `cancelUrl` routes. When the payer returns after `approve`, call `client.captureOrder(orderId, { idempotencyKey })` before treating an `APPROVED` order as captured.

---

## 2. Readback-Authenticated Webhook Contract
- [ ] **Webhook Endpoint:** Configure your host HTTPS webhook route to preserve untouched raw request bytes (up to `MAX_WEBHOOK_BODY_BYTES`, 1 MiB) and forward them directly to `verifyPort.verifyAndNormalize(...)`.
- [ ] **Readback Authentication:** The verifier extracts the PayPal order identifier from `resource.supplementary_data.related_ids.order_id`, `resource.order_id`, or `resource.id` and verifies authoritative order state directly via `GET /v2/checkout/orders/{id}` against the pinned PayPal API origin with `redirect: "error"`.
- [ ] **HTTP 200 Acknowledgement & 400 Refusal:** Map `result.status === 200` from `createVerifiedPaymentIngress` to HTTP `200`; forged or non-existent order IDs (`404`/`401`/`403`) return `{ kind: "refusal", reason: "signature" }` → HTTP `400` with zero ledger writes.
- [ ] **Correlation Fields:** Keep `purchase_units[0].custom_id` (`intentRef`) and `purchase_units[0].reference_id` (`attemptRef`) attached at order creation so readback-verified webhooks correlate back to the exact OpenLup intent and attempt.

---

## 3. End-to-End Sandbox Qualification Proof
Execute against your disposable PayPal **Sandbox** app and retain a redacted receipt (no OAuth tokens, client secrets, or buyer PII):
1. [ ] **Interactive Hosted Checkout:** Create an order (`intent: "CAPTURE"`), complete approval via the `approve` HATEOAS redirect, capture via `POST /v2/checkout/orders/{id}/capture`, and verify `verifyPort` settles the PostgreSQL intent once and replays idempotently on duplicate delivery.
2. [ ] **Declined / Voided Order:** Trigger a capture decline or voided order and verify neutral failure classification without settling the order.
3. [ ] **Synchronous Readback (`readPayment`):** Call `readbackPort.readPayment(...)` on a `CREATED`/`APPROVED` order and a `COMPLETED` order, verifying exact money and `capturedAmountBasis: "provider_capture_v1"`.
4. [ ] **Partial Refund & Dispute Observation:** Trigger a partial refund and a sandbox dispute (`CUSTOMER.DISPUTE.CREATED`) and verify `outcome: "refunded"` (`cumulative-snapshot`) and `outcome: "disputed"` are recorded without fabricating totals.
5. [ ] **Update `recipe.json` (in your store repo):** Record `liveQualification: { status: "dated-sandbox-receipt", checklist: "LIVE_QUALIFICATION.md", qualifiedAt: "<ISO-UTC>", qualifiedPlatformVersion: "<version>" }`.
