# Axiom (Ingest API v1) — Live Qualification Checklist

**Current status:** `offline-protocol-only`

This recipe has passed offline full-mode conformance (`runTelemetryAdapterConformance(..., { mode: "full" })`) and Stage 3 real-flow mount proof against `@openlup/platform/observability` and `@openlup/platform/pricing` without live Axiom credentials. Before enabling live telemetry shipping in a production adopter application, complete every item below against a real Axiom dataset.

## 1. Axiom Dataset & API Token Setup

- [ ] Provision a dedicated Axiom dataset (matching `/^[A-Za-z0-9._-]{1,128}$/u`, e.g., `openlup-prod-telemetry`) in the target Axiom organization.
- [ ] Provision an Axiom API token with **Ingest** scope restricted strictly to the target dataset.
- [ ] Store the API token in the adopter's secret manager and inject it via the `apiToken` option passed to `createAxiomHttpClient` (never read ambient runtime environment variables inside domain/adapter code).
- [ ] Allowlist egress in host network policy strictly to the pinned HTTPS origin declared in `recipe.json#egressOrigins`:
  - `https://api.axiom.co`

## 2. Ingress Scrubbing, Batching & Fail-Open Verification

- [ ] Execute a staging smoke flush containing `span`, `metric`, `log`, and `error` events to `POST https://api.axiom.co/v1/datasets/{dataset}/ingest` and confirm HTTP `200` with `{ ingested: N, failed: 0 }`.
- [ ] Inspect ingested Axiom events in the Axiom query UI to verify `_time`, `kind`, `service`, and scrubbed `attributes` arrive cleanly and contain zero customer emails, Bearer/Basic authorization strings, API keys, or payment secrets.
- [ ] Verify `401`/`403` invalid token responses map to `{ kind: "failed", retryable: false, diagnosticCode: "AXIOM_AUTH_FAILED" }` without throwing into checkout, quote, or webhook flows.
- [ ] Verify `429` rate-limit and `503`/timeout responses map to `{ kind: "failed", retryable: true, ... }` and never stall request deadlines.
- [ ] Verify `enabled: false` (or `createNoopTelemetryPort()`) emits zero outbound requests.

## 3. Promotion Evidence

Record the staging verification date, Axiom organization/dataset identifier (never tokens), and sanitized smoke check output in the adopter's operational readiness ledger before updating `liveQualification.status` to `"dated-sandbox-receipt"` (with ISO-8601 `qualifiedAt` and `qualifiedPlatformVersion` matching `recipes/schema/recipe.schema.json`).
