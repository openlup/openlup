# OpenLup Provider Recipes Catalog

Status: active incubation catalog (strictly repo-splittable per [ADR-001](../docs/platform/adr/ADR-001-provider-recipes-architecture.md)).  
Master plan: [OpenLup Provider Recipes & Adapter Ecosystem — Master Plan](../docs/platform/PROVIDER_RECIPES_MASTER_PLAN.md).

Provider Recipes are lightweight, code-owned, zero-SDK (or structurally injected) integrations that implement OpenLup's neutral Tier 1 domain ports and run directly inside a merchant's store repository — with **0% app tax**, **zero third-party hosting**, and **full offline conformance + real-flow mount proofs**.

## Architecture & Isolation Rules (ADR-001 Summary)

Every directory under `recipes/<domain>/<provider>/` MUST be completely self-contained so `recipes/` can be split mechanically into a standalone `openlup/recipes` repository via `git subtree split --prefix=recipes`:

1. **Imports:** Import ONLY declared public exports of `@openlup/core`, `@openlup/platform`, and `@openlup/outbox`, Node built-ins (in `server/` and `tests/` only), and relative files inside the recipe. Never import `../../packages/*/src/**`, `../../server/**`, `../../src/**`, or `../../examples/**`.
2. **Zero SDK / Zero Ambient Environment / Zero Ambient `fetch`:** Inject `fetchImpl` (or a narrow structural client), credentials, and `clock`. Pass `redirect: "error"` on outbound requests.
3. **Manifest Parity:** Ship `recipe.json` validated against [schema/recipe.schema.json](schema/recipe.schema.json) and mechanically cross-checked against runtime static capabilities (`staticCapabilities`).
4. **4-Stage Proof Standard:**
   - **Stage 1:** Cold-import zero-I/O check + zero-I/O refusal checks.
   - **Stage 2:** Official Tier 1 domain conformance runner (`@openlup/platform/*/testing`) + secret/PII canaries + planted-defect negative controls.
   - **Stage 3:** Real-flow Mount Proof (`<recipe>/tests/mount-proof.test.ts`) wiring the adapter into real `@openlup/platform` rails + negative control proving unmounting fails.
   - **Stage 4:** Explicit test-account checklist in `LIVE_QUALIFICATION.md` (offline proofs never claim live account readiness).

## Verify Recipes Locally (<1s)

```bash
# 1. Strict TypeScript check (standalone, repo-splittable)
npx --no -- tsc -p recipes/tsconfig.json --noEmit

# 2. Offline Stages 1–3 tests (conformance + canaries + negative controls + mount proof)
npx vitest run recipes/payments/adyen/tests/ recipes/fulfillment/amazon-mcf/tests/

# 3. Static ADR-001 guardrails (zero ambient env reads, zero ambient fetch, import isolation)
npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression
npx --no -- eslint recipes/
```

## Available Recipes

See [index.json](index.json) for the machine-readable catalog:

- [`payments/adyen`](payments/adyen/recipe.json) — **Exemplar** zero-SDK Adyen Checkout v71 recipe (Drop-in sessions + `recipes/payments/adyen/browser/csp.json`, bank redirect, unattended `ContAuth` recurring, async cancels, canonical HMAC-SHA256 webhook verification).
- [`fulfillment/amazon-mcf`](fulfillment/amazon-mcf/recipe.json) — **Exemplar** zero-SDK Amazon Multi-Channel Fulfillment recipe (SP-API Outbound v2020-07-01 & FBA Inventory v1, pure `node:crypto` AWS SigV4 signing, single-flight LWA OAuth2, bridged HMAC-SHA256 notifications, `nextToken` reconciliation paging, snapshot-only stock sync).
