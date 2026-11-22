# ADR-001: Provider Recipes Architecture, Ownership, and Dependency Contract

Status: Accepted (living standard for 1.x; refined via recipe retrospectives)  
Date: 2026-11-22  
Owners: OpenLup Platform Maintainers  
Companion plan: [Provider Recipes & Adapter Ecosystem — Master Plan](../PROVIDER_RECIPES_MASTER_PLAN.md)  
Related canonical policy: [Package placement decision](../ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical) · [Canonical contracts](../CANONICAL_CONTRACTS.md) · [Stability policy](../../../packages/core/docs/guide/reference/stability.md)

---

## Context

OpenLup is a subscription-commerce platform targeting an open, zero-app-tax alternative to closed paid plugin marketplaces (Shopify App Store, WooCommerce paid plugins). To support hundreds or thousands of external providers (payments, fulfillment/3PL, tax, carrier rate quoting, communications, accounting/ERP, sales channels, observability) while delivering 10x better Agent and Developer DX, we must establish one binding architectural convention so neither humans nor coding agents invent incompatible adapter patterns.

Empirical measurements of `@openlup/platform@1.3.0` (`packages/platform/release-gates.json` and `.github/VERSIONING_AND_EOL.md`) constrain where provider integrations may live:
1. `@openlup/platform` already measures **3.79 MB packed / 18.23 MB unpacked / 4,637+ files** against release caps of **4.357 MB / 20.969 MB / 5,330 files** and a +30% tarball growth tripwire.
2. `@openlup/core`, `@openlup/outbox`, and `@openlup/platform` release in lockstep SemVer; breaking vendor API quirks inside `stable` platform subpaths would force platform MAJOR releases.
3. Publishing hundreds of separate `@openlup/*` npm packages is infeasible under OpenLup's manual 2FA bootstrap, OIDC trust setup, and lockstep package catalogue.
4. Our own Agent-DX regression baseline (`docs/platform/plans/agent-dx-regression.md`, task `t3`) proved that isolated passing unit tests do **not** prevent agents from forgetting to mount an adapter into a real store flow.

---

## Decision

### 1. Freeze Tier 2 Vendor Subpaths in `@openlup/platform`
- `@openlup/platform` retains its existing opt-in reference adapters (two payment witnesses, one warehouse fulfillment witness, two communications witnesses, and one experimental tax witness) strictly as living contract witnesses (1–2 per adapter class).
- **No new vendor-specific subpaths** shall be added to `@openlup/platform` or `@openlup/core` without a formal topology trigger under `ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical`.
- Platform investment focuses exclusively on **Tier 1 neutral domain ports**, **shared protocol hardening primitives**, and **tamper-resistant `./*/testing` conformance kits**.

### 2. Incubate Tier 3 Recipes in a Strictly Splittable Top-Level `recipes/` Directory
- All new provider integrations are authored as **Provider Recipes** under `recipes/<domain>/<provider>/` (or `recipes/multi/<provider>/` for multi-domain providers).
- `recipes/` incubates inside the OpenLup monorepo during early ecosystem development for instant contract coherence, but **must remain 100% repo-splittable** into a future standalone public repository (`openlup/recipes`) via a mechanical `git subtree split --prefix=recipes` with zero code rewrites.

### 3. Hard Dependency & Isolation Contract for Every Recipe
Every file under `recipes/` MUST obey all of the following rules:
1. **Public `@openlup/*` Imports Only:** Recipes may import ONLY declared public exports of `@openlup/core`, `@openlup/platform`, and `@openlup/outbox` (plus Node built-ins in `server/` and `tests/`, and relative files inside the recipe itself). Relative imports reaching outside `recipes/` (into `packages/*/src/`, `server/`, `src/`, or `examples/`) are strictly forbidden.
2. **Zero Transitive Vendor SDK Dependencies by Default:** Recipes default to `sdkPolicy: "zero-dep-fetch"` (pure REST/JSON over an injected `fetch` implementation) or `sdkPolicy: "injected-structural-client"` (narrow 3–8 method TypeScript interface supplied by the host). Recipes never pull heavy vendor SDK trees into core/platform or bundle credentials.
3. **Zero Ambient Environment or Network Access:** Recipe `server/` and `browser/` code MUST NEVER read ambient runtime environment variables or call ambient global `fetch`. Configuration, credentials (or per-call credential resolvers), `fetchImpl`/client, and `clock` are explicitly injected.
4. **Inert Cold Import & Default-Off Posture:** Importing a recipe module must perform zero I/O, register zero HTTP routes, install zero schedules/workers, and mutate zero global state.
5. **Transport & Redirect Hardening:** Every outbound mutating HTTP request MUST pass `redirect: "error"`, enforce HTTPS origin pinning, bound response body size, and sanitize provider errors to allowlisted diagnostic codes (`^[A-Z][A-Z0-9_]{0,63}$`).
6. **Strict Redaction & Transient Secrets:** Raw provider payloads, headers, credentials, payer PII, and `TransientSecret` handoffs MUST NEVER appear in logs, `diagnostics`, `persistence`, or thrown `Error.message`.
7. **Strict Server/Browser Split (When UI Exists):** Browser code lives strictly in `browser/`, imports zero Node built-ins or `server/` modules, provides explicit degraded/fallback UI states, loads external scripts lazily, and declares minimal required CSP directives in `<recipe>/browser/csp.json`.
8. **Multi-Domain Isolation:** Multi-domain providers share a private `core/` transport/auth layer while exposing independently selectable domain facets with isolated failure/quarantine boundaries.

### 4. Mandatory Machine-Readable Manifest (`recipe.json`)
- Every recipe MUST contain a `recipe.json` file conforming to `recipes/schema/recipe.schema.json` (and `<recipe>/browser/csp.json` conforming to `recipes/schema/csp.schema.json` whenever `browserSurface.kind === "adapter-component"`).
- `recipe.json` MUST declare: `schemaVersion`, `id`, `domain`, `providerKind`, `displayName`, `openlupPlatformRange`, `contractImports`, `conformanceRunner`, `sdkPolicy`, `egressOrigins`, `webhookAuth`, `browserSurface`, `staticCapabilities`, `liveQualification`, and `files` (including `allFiles` for deterministic copy-into-app tooling).
- Recipe tests MUST mechanically assert that `recipe.json#staticCapabilities` matches the adapter's deterministic serializable static capability projection (omitting non-JSON function fields such as `assessMandate` and modeling host-configured fields via `supportedCurrenciesPolicy`), preventing documentation/manifest drift.

### 5. Mandatory Four-Stage Proof & Anti-Slop Certification Standard
No recipe may be listed as `verified` in `recipes/index.json` unless its test suite passes offline with:
- **Stage 1:** Cold-import zero-I/O check + zero-I/O refusals (`providerRequests === 0`) for unsupported currencies/countries/operations and missing required inputs.
- **Stage 2:** Execution of the official Tier 1 domain conformance runner (`@openlup/platform/*/testing`) including scripted transport faults, replay/idempotency, and webhook safety probes. For payment recipes, fingerprints MUST be 64-char lowercase hex (`/^[0-9a-f]{64}$/`), `providerOccurredAt` MUST be populated from the provider timestamp (never synthesized from receipt time), and async `close()` on providers with `readback: "unsupported"` MUST return `pending` or `unknown` (never fabricate terminal `failed`).
- **Stage 3:** Real-flow **Mount Proof** (`<recipe>/tests/mount-proof.test.ts`) wiring the recipe into real `@openlup/platform` rails using ONLY public `@openlup/*` exports (for payments: `createPaymentProviderRegistry` + `createVerifiedPaymentIngress` + `createPostgresProviderPaymentRail.execute()` redaction proof) **plus a negative control** proving that detaching or misconfiguring the binding causes the proof to fail.
- **Anti-Slop Canaries & Planted-Defect Self-Checks:** Synthetic secret/PII canary assertions scanning `{ execution, persistence, diagnostics, thrownErrors }` (zero occurrences raw or URL-encoded, including transient session tokens) and at least two planted-defect mutation checks proving signature and zero-I/O checks cannot be silently bypassed.
- **Stage 4 Separation:** `LIVE_QUALIFICATION.md` documents test-account activation, webhook signing verification, host HTTP acknowledgement quirks (such as Adyen's `[accepted]` body), and dashboard readback; offline passes never claim live readiness.

### 6. Installed-Version Compatibility & Ownership Model
- Merchants adopt recipes via source ownership (copying the recipe into their repository's `owned/` adapter tree and verifying it against their **installed** `@openlup/platform` version).
- The central catalog (`recipes/index.json`) tracks the exact `@openlup/platform` version each recipe passed conformance against; recipes failing against a newer platform release flip to `unverified-for-<version>` rather than silently claiming compatibility.

### 7. Specification-First Waves, Tiered Execution & Delivery Authority
- Every wave or recipe batch MUST begin from a complete, reviewed Wave/Stage Specification (contracts, protocol/security quirks, refusal taxonomy, fixtures, mount-proof seam, acceptance criteria) before implementation starts.
- Straightforward, well-specified tasks cloning a certified exemplar may be delegated to lighter/faster worker models with lower reasoning effort, provided **zero mechanical verification gates are relaxed** (`tsc --noEmit`, domain conformance, Stage 3 mount proof, canaries, `ast-grep`, `eslint`) and ambiguous/failing cases escalate back to the high-reasoning tier with a mandatory spec update.
- Consistent with `AGENTS.md` and `CONTRIBUTING.md`, this ADR grants no submission, merge, or release authority on its own. When the accountable human grants task and auto-merge authority for a wave, routine within-plan decisions are resolved by the Lead Agent and verified, natively reviewed candidates may be armed for auto-merge within that granted authority; critical out-of-plan decisions (breaking SemVer, new repositories/npm packages, release/pack-cap changes, live releases, or strategic scope shifts) always require explicit human authorization.

---

## Consequences

### Positive
- **Unlimited horizontal scale:** Supports hundreds or thousands of providers with zero impact on `@openlup/platform` bundle size, SemVer cadence, or security-maintenance bus factor.
- **10x Agent/Developer DX:** One uniform anatomy, one JSON schema, one verification model, and sub-10-second offline feedback loops eliminate boilerplate hallucination and unmounted-adapter bugs.
- **Zero app tax & full merchant ownership:** Adopters own, audit, customize, and deploy every line of integration code alongside their store.
- **Clean future extraction:** Splitting `recipes/` into `openlup/recipes` requires zero refactoring of imports, tests, or manifests.

### Trade-Offs & Mitigations
- **Source-owned recipes do not auto-update like hosted SaaS apps:** Mitigated by `recipe.json` provenance + installed-version `openlup recipe verify` + automated upstream API drift PRs in the canonical registry.
- **Early domains without Tier 1 ports (Carrier Rates, Accounting ERP, Telemetry) cannot host certified recipes yet:** Mitigated by building Tier 1 ports + `./*/testing` kits first in Wave 1–2 (see Master Plan §7) rather than bypassing conformance.

---

## Enforcement & Compliance
- **Schema validation:** `recipes/schema/recipe.schema.json` and `recipes/schema/csp.schema.json` validated in recipe verification tests.
- **Strict TypeScript compilation:** Standalone `recipes/tsconfig.json` (`npx --no -- tsc -p recipes/tsconfig.json --noEmit`) must pass with zero errors (Vitest strips types and cannot substitute for `tsc`).
- **Import boundaries:** Root `eslint.config.js` (`packageExports`, `recipeEscapeBoundary`, `recipeServerAllowlist`, `recipeTestAllowlist`, `recipeBrowserAllowlist`) enforces public `@openlup/*` exports only, blocks relative escapes outside `recipes/` at every depth (including a catch-all fallback), bans all third-party vendor SDKs and bare Node built-ins, and blocks `node:*` / `../server` inside `recipes/**/browser/**`.
- **Static guardrails:** `scripts/ast-grep/rules/domain-no-environment-reads.yml` blocks ambient environment reads and `node:process`, and `scripts/ast-grep/rules/recipes-no-ambient-fetch.yml` (`recipes-no-ambient-fetch` + `recipes-no-ambient-fetch-tsx`) blocks ambient global `fetch(` across `recipes/**/server/**`, `recipes/**/core/**`, and `recipes/**/browser/**` (`.ts` and `.tsx`).
- **Living amendments:** Any friction discovered during dogfooding or early recipe creation is captured in the Master Plan's Retro Log and amended into this ADR before mass production begins.
