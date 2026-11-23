# OpenTelemetry OTLP/HTTP (JSON) — Live Qualification Checklist

**Current status:** `offline-protocol-only`

This recipe has passed offline full-mode conformance (`runTelemetryAdapterConformance(..., { mode: "full" })`) and Stage 3 real-flow mount proof against `@openlup/platform/observability` and `@openlup/platform/pricing` without a live OTLP Collector endpoint. Before enabling live telemetry shipping in a production adopter application, complete every item below against your target OpenTelemetry Collector or vendor OTLP/HTTP endpoint.

## 1. Collector Origin & Authentication Setup

- [ ] Provision an HTTPS OTLP/HTTP JSON collector endpoint (`https://{collectorHost}`) exposing `/v1/traces`, `/v1/metrics`, and `/v1/logs` (zero path prefix, query string, userinfo, or plaintext `http://`).
- [ ] Pass `collectorOrigin` into `createOtelOtlpHttpClient` and allowlist that exact HTTPS origin in host network egress policy (matching `recipe.json#egressOrigins` `"https://{collectorHost}"`).
- [ ] If your collector requires authentication, inject `authorization` (e.g., Bearer token) or custom headers via `headers` from the adopter's secret manager at the composition root (never read ambient runtime environment variables inside domain/adapter code).

## 2. Signal Routing, Scrubbing & Fail-Open Verification

- [ ] Execute a staging smoke flush containing `span`, `metric`, `log`, and `error` events and verify the collector receives:
  - `POST {collectorOrigin}/v1/traces` (`resourceSpans`)
  - `POST {collectorOrigin}/v1/metrics` (`resourceMetrics`)
  - `POST {collectorOrigin}/v1/logs` (`resourceLogs`)
- [ ] Inspect received collector records to confirm `service.name`, trace/span IDs, nanosecond timestamps, and scrubbed attributes contain zero customer emails, Bearer/Basic authorization headers, API keys, or payment secrets.
- [ ] Verify `401`/`403` authentication failures map to `{ kind: "failed", retryable: false, diagnosticCode: "OTEL_OTLP_AUTH_FAILED" }` without throwing into quote, checkout, or webhook flows.
- [ ] Verify `429` rate-limit and `503`/timeout outages map to `{ kind: "failed", retryable: true, ... }` and never break request deadlines.
- [ ] Verify `enabled: false` (or `createNoopTelemetryPort()`) performs zero outbound requests.

## 3. Promotion Evidence

Record the staging verification date, sanitized collector hostname (never auth tokens or secret headers), and smoke test result in the adopter's operational readiness ledger before updating `liveQualification.status` to `"dated-sandbox-receipt"` (with ISO-8601 `qualifiedAt` and `qualifiedPlatformVersion` matching `recipes/schema/recipe.schema.json`).
