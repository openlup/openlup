# ShipBob 3PL (REST API v1.0 / v2025) — Live Qualification Checklist

**Current status:** `offline-protocol-only`

This recipe has passed offline full-mode conformance (`runFulfillmentAdapterConformance(..., { mode: "full" })`) and real-flow mount proof against `@openlup/platform/fulfillment` without live ShipBob merchant credentials. Before enabling `selected: true` and `ready: true` in a production adopter application, complete every item below against a real ShipBob sandbox and production account.

## 1. ShipBob Account, Bearer PAT & Channel Setup

- [ ] Provision a ShipBob Personal Access Token (PAT) or OAuth2 Bearer token with Orders (`orders_read`, `orders_write`) and Inventory (`inventory_read`) scopes in the target environment (`sandbox` or `live`).
- [ ] Store the Bearer token in the adopter's secret manager and inject it via the `token` option (string or lazy `() => string | Promise<string>`) passed to `createShipBobHttpClient`.
- [ ] Identify the numeric ShipBob `shipbob_channel_id` (1–20 ASCII digits) for the storefront channel when operating multi-channel accounts and pass it as `channelId` to `createShipBobHttpClient`.
- [ ] Allowlist egress in host network policy strictly to the pinned HTTPS origins declared in `recipe.json#egressOrigins`:
  - `https://api.shipbob.com` (`live`)
  - `https://sandbox-api.shipbob.com` (`sandbox`)

## 2. Standard Webhooks (Svix) Signing Secret & Ingress

ShipBob delivers webhook notifications using Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature` with `v1,<base64>` HMAC-SHA256 signatures and `whsec_<base64>` signing secrets).

- [ ] Register the OpenLup fulfillment webhook ingress endpoint in the ShipBob Developer / Webhook settings for order and shipment lifecycle topics (`order_shipped`, `order_shipment_delivered`, `order_shipment_onhold`, `order_shipment_exception`, `order_shipment_cancelled`).
- [ ] Store the `whsec_<base64>` signing secret (decoded length >= 16 bytes) in the host secret manager and configure two simultaneous secrets during zero-downtime key rotation (`webhookSigningSecrets: [currentSecret, previousSecret]`).
- [ ] Configure `maxTimestampSkewMs` (for example `300_000` / 5 minutes) to reject stale webhook replays against `webhook-timestamp`.
- [ ] Configure `approveTrackingUrl` on both `createShipBobFulfillmentAdapter` and `verifyAndNormalizeFulfillmentObservation` to allowlist only verified carrier tracking domains.

## 3. Sandbox & Controlled Production Smoke Tests

- [ ] Execute a sandbox `POST /1.0/order` dispatch and verify `GET /1.0/order/{id}` and `GET /1.0/order?ReferenceIds={reference_id}` readback return expected order and shipment transitions cleanly.
- [ ] Verify that an intentionally invalid payload returning HTTP 400 or 422 maps to `not_dispatched` (`mayHaveSucceeded: false`, `submissionAttempted: true`).
- [ ] Verify that a simulated timeout, HTTP 409, HTTP 429, or HTTP 503 after POST returns `unknown` (`mayHaveSucceeded: true`) and does **not** blindly re-POST on retry without readback reconciliation.
- [ ] Deliver signed Standard Webhooks notifications (`order_shipped`, `order_shipment_delivered`, `order_shipment_exception`, `order_shipment_cancelled`) through `verifyAndNormalizeFulfillmentObservation` and verify stock consumption, handover, tracking reference persistence, and idempotent duplicate replay.
- [ ] Run `runFulfillmentReconciliationPage` across 1-based ShipBob order pages (`Page=1`, `Page=2`, ...) and verify empty-page termination and `page_exhausted` at zero I/O on subsequent pages.
- [ ] Run `runFulfillmentStockSyncWorker` with `stockMovements: false` against `GET /1.0/inventory` and verify snapshot-only stock sync records `total_fulfillable_quantity` and emits `movementRefusal: stock_movements_unsupported`.
- [ ] Confirm that customer PII (recipient name, address, phone, email), Bearer PATs, `whsec_` webhook signing secrets, and signed tracking URLs never appear in durable store records, logs, or operator diagnostics.

## 4. Promotion Evidence

Record the sandbox/staging verification date, ShipBob environment/channel ID, and sanitized test order IDs in the adopter's operational readiness ledger before switching `liveQualification.status` to `"dated-sandbox-receipt"` (with ISO-8601 `qualifiedAt` and `qualifiedPlatformVersion` matching `recipes/schema/recipe.schema.json`).
