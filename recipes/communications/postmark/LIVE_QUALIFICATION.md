# Postmark Transactional Email (REST API) — Live Qualification Checklist

**Current status:** `offline-protocol-only`

This recipe has passed offline full-mode conformance (`runCommunicationsAdapterConformance(..., { mode: "full" })`) and real-flow mount proof against `@openlup/platform/communications` without live Postmark credentials. Before enabling live production traffic in an adopter application, complete every item below against a real Postmark Server (Sandbox / Test Mode and Production).

## 1. Postmark Server Token, Sender Signature & Egress Setup

- [ ] Provision a Postmark Server (use a dedicated Sandbox/Test Postmark Server for non-production and a Production Server for live traffic) and copy its Server API Token (`X-Postmark-Server-Token`).
- [ ] Verify the sender domain (DKIM & Return-Path DNS records) or confirmed Sender Signature matching `EmailMessage.from`.
- [ ] Store the Server API Token in the adopter's secret manager and pass it through the host `EmailEgressPolicy` (`context.credential`), never via ambient runtime environment reads inside recipe modules or source fixtures.
- [ ] Configure the target `MessageStream` (typically `"outbound"` for transactional mail) on `createPostmarkHttpClient` or `createPostmarkEmailTransport`.
- [ ] Allowlist outbound HTTPS egress in host network policy strictly to the pinned origin declared in `recipe.json#egressOrigins`:
  - `https://api.postmarkapp.com`

## 2. Webhook Basic Auth & Event Subscriptions

Postmark authenticates webhook requests using HTTP Basic Auth embedded in the registered HTTPS webhook URL (`https://<username>:<password>@<your-host>/...`).

- [ ] Generate a high-entropy webhook username and password, store them in the host secret manager, and pass them to `createPostmarkWebhookHandler`.
- [ ] Register the HTTPS webhook URL in the Postmark Server **Webhooks** settings and enable the normalized events declared in `recipe.json#staticCapabilities.supportsObservationEvents`:
  - `Delivery` (`email.delivered`)
  - `Bounce` (`email.bounced`)
  - `SpamComplaint` (`email.complained`)
  - `Open` (`email.opened`)
  - `Click` (`email.clicked`)
  - `SubscriptionChange` (`email.suppressed`)
- [ ] Verify that your reverse proxy / HTTP server passes the raw `Authorization` header and untouched raw request body bytes (subject to the `256 KiB` cap) to `createPostmarkWebhookHandler`.

## 3. Sandbox & Controlled Production Smoke Tests

- [ ] Execute a `sandbox_sink` send through `guardEmailTransport(createPostmarkEmailTransport(...))` and verify `To` routes to the sink mailbox, `Metadata` records `[environmentTagName]: "non_production"` and `original_recipient`, and `Headers` carries `X-Original-Recipient`.
- [ ] Verify that an accepted `POST /email` send populates `outcome.resendId` (`emailTransportMessageId(outcome)`) with Postmark's `MessageID` and projects `timelineStatus: "sent"` via `classifyEmailSendOutcome`.
- [ ] Verify fault mapping against Postmark test/error inputs:
  - Invalid Server Token (`401`) maps to `ok: false, httpStatus: 401, providerErrorCode: "auth_failed"`.
  - Unprocessable payload / inactive recipient (`422` or HTTP `200` with non-zero `ErrorCode`) maps to `ok: false` without throwing.
  - Rate-limited response (`429`) parses `Retry-After` and maps to `ok: false, httpStatus: 429, providerErrorCode: "rate_limited"`.
  - Aborted/timed-out request maps to `ok: false, httpStatus: 0, aborted: true` (`timelineStatus: "delivery_delayed"`).
- [ ] Deliver real Postmark `Delivery` and `Bounce` webhook payloads using the configured Basic Auth credentials and confirm `processEmailObservation` advances the corresponding send record while unauthenticated requests return `401` with `0` port mutations.
- [ ] Confirm that Server API Tokens, webhook Basic Auth passwords, and recipient email addresses never appear in durable store records, `providerResponse`, or operator error logs.

## 4. Promotion Evidence

Record the sandbox/staging verification date, Postmark Server ID (non-secret identifier), `MessageStream`, and sanitized test `MessageID`s in the adopter's operational readiness ledger before updating `liveQualification.status` to `"dated-sandbox-receipt"` (with ISO-8601 `qualifiedAt` and `qualifiedPlatformVersion` matching `recipes/schema/recipe.schema.json`).
