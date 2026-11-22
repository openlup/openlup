# Amazon MCF (SP-API v2020-07-01) — Live Qualification Checklist

**Current status:** `offline-protocol-only`

This recipe has passed offline full-mode conformance (`runFulfillmentAdapterConformance(..., { mode: "full" })`) and real-flow mount proof against `@openlup/platform/fulfillment` without live Amazon Seller Central credentials. Before enabling `selected: true` and `ready: true` in a production adopter application, complete every item below against a real Amazon SP-API sandbox and production seller account.

## 1. Seller Central, LWA & IAM / SigV4 Setup

- [ ] Register an SP-API application in Seller Central (or Amazon Developer Central) with **Amazon Fulfillment** (`Fulfillment Outbound` + `FBA Inventory`) roles enabled for the target region (`na`, `eu`, or `fe`).
- [ ] Configure Login with Amazon (LWA) client credentials (`lwaClientId`, `lwaClientSecret`, `lwaRefreshToken`) in the adopter's secret store and wire them through the lazy `credentials` supplier passed to `createAmazonMcfHttpClient`.
- [ ] Configure an AWS IAM role/user authorized for `execute-api:Invoke` on the target SP-API region (`us-east-1` for `na`, `eu-west-1` for `eu`, `us-west-2` for `fe`) and supply short-lived STS credentials (`accessKeyId`, `secretAccessKey`, `sessionToken`) from the host credential provider.
- [ ] Verify the target `marketplaceId` (for example `ATVPDKIKX0DER` for US, `A1F83G8C2ARO7P` for UK, `A1PA6795UKMFR9` for DE) matches the pinned region endpoint (`na` / `eu` / `fe`).
- [ ] Allowlist egress in host network policy strictly to the pinned HTTPS origins declared in `recipe.json#egressOrigins`:
  - `https://api.amazon.com` (LWA OAuth2 token exchange)
  - The selected regional SP-API origin (`https://sellingpartnerapi-{na,eu,fe}.amazon.com` or its `sandbox.` equivalent).

## 2. Bridged `FULFILLMENT_ORDER_STATUS` Notification Ingress

Amazon SP-API delivers `FULFILLMENT_ORDER_STATUS` notifications asynchronously through Amazon SQS or Amazon EventBridge rather than direct HTTP POST callbacks.

- [ ] Subscribe an SQS queue or EventBridge target to SP-API `FULFILLMENT_ORDER_STATUS` notifications for the seller account.
- [ ] Deploy the adopter's thin HTTPS bridge worker that reads raw notification bytes, attaches:
  - `x-mcf-timestamp`: RFC 3339 UTC timestamp at forwarding time
  - `x-mcf-signature`: `sha256=<64-lowercase-hex>` computed as `HMAC-SHA256(key, "${timestamp}." + rawBodyBytes)`
- [ ] Store at least one 32+ hex-character signing secret (256-bit / 64 hex chars recommended) in the host secret manager and support two simultaneous secrets during zero-downtime key rotation (`webhookSigningSecrets: [currentSecret, previousSecret]`).
- [ ] Configure `maxTimestampSkewMs` (for example `300_000` / 5 minutes) and host HTTPS mTLS or VPC ingress restrictions between the bridge and OpenLup ingress.
- [ ] Configure `approveTrackingUrl` on both the adapter and `verifyAndNormalizeFulfillmentObservation` to allowlist only verified carrier tracking domains.

## 3. Sandbox & Controlled Production Smoke Tests

- [ ] Execute a sandbox `createFulfillmentOrder` call and verify `getFulfillmentOrder` readback returns `Received` / `Planning` / `Complete` transitions cleanly.
- [ ] Verify that an intentionally invalid destination address returns SP-API 400 (`InvalidInput`) mapped to `not_dispatched` with `mayHaveSucceeded: false`.
- [ ] Verify that a simulated timeout or HTTP 503 after POST returns `unknown` (`mayHaveSucceeded: true`) and does **not** blindly re-POST on retry without readback reconciliation.
- [ ] Deliver a bridged `FULFILLMENT_ORDER_STATUS` notification (`SHIPPED` and `DELIVERED`) through `verifyAndNormalizeFulfillmentObservation` and verify stock consumption, handover, tracking reference persistence, and idempotent duplicate replay.
- [ ] Run `runFulfillmentReconciliationPage` across multiple `nextToken` pages and verify checkpoint advancement and `page_exhausted` termination.
- [ ] Run `runFulfillmentStockSyncWorker` with `stockMovements: false` against `GET /fba/inventory/v1/summaries` and verify snapshot-only stock sync records `fulfillableQuantity` and emits `movementRefusal: stock_movements_unsupported`.
- [ ] Confirm that customer PII (recipient name, address, phone, email), LWA secrets, AWS keys, and signed tracking URLs never appear in durable store records, logs, or operator diagnostics.

## 4. Promotion Evidence

Record the sandbox/staging verification date, SP-API region, and sanitized test order IDs in the adopter's operational readiness ledger before switching `liveQualification.status` to `live-sandbox-verified` or `live-production-verified`.
