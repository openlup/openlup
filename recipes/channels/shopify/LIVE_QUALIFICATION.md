# Shopify Storefront Channel (Admin REST & Webhooks) — Stage 4 Live Account Qualification Checklist

> **Important:** Passing offline Stages 1–3 (`conformance.test.ts` and `mount-proof.test.ts`) proves auth-before-parse `X-Shopify-Hmac-Sha256` verification, `channel.order.v1` normalization, B3 `unmapped` quarantine preservation, `Link` `page_info` cursor pagination, `Retry-After` cooldowns, and `createChannelWebhookHandler` wiring — it **does not** certify your Shopify development or production store. Complete every step below in a Shopify **Development Store** before enabling live order ingest.

---

## 1. Store & Admin API Prerequisites (Shopify Partners / Admin)
- [ ] **Shop Domain Pinning:** Configure `shopDomain` as the bare subdomain only (matching `/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/u`) so outbound Admin REST requests pin strictly to `https://{shopDomain}.myshopify.com`.
- [ ] **Admin API Access Token:** Grant `read_orders` scope to your custom app and store the Admin API access token in your host secret manager (never commit or read inside the recipe).
- [ ] **Tax-Inclusive Pricing Alignment:** Confirm whether orders on the Shopify storefront carry `taxes_included: true` so `total_price` matches `itemsGrossMinor - itemsDiscountMinor + shippingGrossMinor - shippingDiscountMinor`. Orders with divergent totals surface loudly as `unmapped` (`money_mismatch`) for operator triage rather than silently dropping or fabricating totals.

---

## 2. Webhook Verification & Quarantine Contract
- [ ] **Raw Body Preservation:** Configure your host webhook endpoint (`createChannelWebhookHandler`) to pass the untouched UTF-8 request body string (`rawBody`) and headers to `orders.normalizeWebhook(...)`.
- [ ] **Auth-Before-Parse (`X-Shopify-Hmac-Sha256`):** HMAC-SHA256 base64 verification runs before `JSON.parse(rawBody)`. Invalid signatures or mismatched `X-Shopify-Shop-Domain` headers fail closed with `{ kind: "rejected", reason: "signature" }` and zero store writes.
- [ ] **B3 Quarantine Preservation:** Unknown topics (e.g., non-`orders/paid` order lifecycle events) and unmapped `financial_status` values return `{ kind: "unmapped", ... }` so `createChannelWebhookHandler` records them in the quarantine drawer instead of dropping deliveries.

---

## 3. End-to-End Development Store Proof
Execute on your disposable Shopify **Development Store** and retain a redacted receipt (no Admin tokens, webhook secrets, or buyer PII):
1. [ ] **Paid Order Webhook Ingest:** Complete a test checkout (`orders/paid`) and verify `createChannelWebhookHandler` validates `X-Shopify-Hmac-Sha256`, settles the order once, and deduplicates redeliveries on `providerEventId`.
2. [ ] **Forged HMAC Refusal:** Deliver a webhook with a tampered body or wrong `X-Shopify-Hmac-Sha256` and verify zero writes (`FORBIDDEN` refusal).
3. [ ] **Pull Reconciliation & `page_info` Pagination:** Run `orders.pullOrders(...)` across multiple pages (`Link` `rel="next"`) and confirm `nextCursor`, `watermarkAt`, and `Retry-After` 429 cooldown behavior.
4. [ ] **Update `recipe.json` (in your store repo):** Record `liveQualification: { status: "dated-sandbox-receipt", checklist: "LIVE_QUALIFICATION.md", qualifiedAt: "<ISO-UTC>", qualifiedPlatformVersion: "<version>" }`.
