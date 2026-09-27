# Fulfillment adapter evaluation

Status: development-preview guidance for the shipped adapter. This page describes code and offline checks, not verified provider access or an activation instruction.
Audience: contributors evaluating fulfillment configuration and its refusal boundaries.

## Configuration boundary

The server adapter uses Basic Auth from `OMNIPACK_USERNAME` and `OMNIPACK_PASSWORD`. Its declared inputs also include `OMNIPACK_BASE_URL`, `OMNIPACK_ENV` and `OMNIPACK_WEBHOOK_TOKEN`. Supply credentials through the selected server installation; never put values in source, proof output or this page.

The code names `OMNIPACK_STAGE_BASE_URL` for `stage` and `OMNIPACK_PRODUCTION_BASE_URL` for `production`. These are code defaults, not evidence that either endpoint is reachable or that an account is authorized. Even though the readiness reader derives a default URL, activation still requires an explicit `OMNIPACK_BASE_URL` among all five declared inputs.

With missing merchant inputs, stage smoke and live dispatch remain **BLOCKED**. Dispatch additionally requires both `OMNIPACK_PROVIDER_ENABLED=true` and `COMMERCE_OMNIPACK_DISPATCH_ENABLED=true`, plus the production environment for live dispatch. Stock synchronization uses its separate `COMMERCE_OMNIPACK_STOCK_SYNC_ENABLED` flag. Setting configuration is a separate owner decision; this page enables nothing.

`readOmnipackClientConfig` returns null when the adapter is disabled or required inputs are absent. The HTTP client applies Basic Auth and does not retry unsafe POST mutations automatically. Sanitized errors exclude credentials and raw provider payloads. Carrier/service and pickup-point selections come from the installation's merchant dictionary; the outbound mapper refuses missing service or pickup evidence instead of silently substituting another delivery kind.

## Local Evidence Model

`omnipack_dispatch_refs` records local dispatch correlation, `omnipack_stock_snapshots` records stock observations, and `omnipack_low_stock_evidence` records the associated low-stock evidence. Provider evidence is distinct from customer delivery confirmation and local stock consumption.

Label and tracking operations do not consume local reservations. The explicit handoff boundary consumes once; the separate provider-stock-consumed operation handles completed picking. A repeated observation must not create a second tracking identity or consume inventory again. These are invariants to verify through database operations, not permissions implied by this page.

## Offline checks and remaining proof

From the checkout root with the locked dependencies and supported Node version installed, run:

```bash
npx vitest run server/infra
```

These tests use synthetic configuration and injected HTTP transport. They exercise the credential gate, Basic Auth, payload refusals, no unsafe retries and sanitized errors; they contact no provider. The [named CI obligations](plans/public-ci-known-red.md) retain the missing rollback-only database replay/stock/nonmutation probe and native dormant-registration proof. Passing the offline checks does not complete those obligations or prove stage/live readiness.

The implementation owners are the exported `readOmnipackCredentialGate`, `readOmnipackClientConfig`, `createOmnipackClient` and `buildOmnipackOutboundOrderPayload` functions. The named environment URL constants own endpoint spelling; use the selected installation's explicit base URL. Recovery from missing configuration is refusal; provider activation, credentials and live rehearsal need their own authority.

See [canonical contracts](CANONICAL_CONTRACTS.md), [runtime and self-hosting](RUNTIME_AND_SELF_HOSTING.md) and [contributing](../../CONTRIBUTING.md).
