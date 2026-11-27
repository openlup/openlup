# @openlup/core

Framework-independent TypeScript contracts and pure domain engines for headless subscription, bundle, pricing, promotion, and fulfillment commerce. Zero infrastructure lock-in: `zod` is the only runtime dependency, kernel exports perform no I/O, and your application owns composition and ports.

[![Node >=24](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178C6)](https://www.typescriptlang.org)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/LICENSE)
[![npm provenance](https://img.shields.io/badge/npm-provenance-CB3837)](https://www.npmjs.com/package/@openlup/core)

[Reader Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/README.md) ·
[Changelog](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/CHANGELOG.md) ·
[Upgrade Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/upgrade/README.md) ·
[Stability Policy](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/reference/stability.md#public-api) ·
[Agent Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/AGENTS.md)

## Which `@openlup/*` package do I need?

| Package | Role | Install when you need |
| --- | --- | --- |
| [`@openlup/core`](https://www.npmjs.com/package/@openlup/core) | Pure TypeScript kernels & contracts | I/O-free subscription, bundle, pricing, promo, fulfillment, readiness, and outbox contracts (required peer of all other `@openlup/*` packages) |
| [`@openlup/outbox`](https://www.npmjs.com/package/@openlup/outbox) | Transactional PostgreSQL outbox rail | Transactional PostgreSQL event enqueue, at-least-once dispatch, lease-bound schedules, and handler composition |
| [`@openlup/platform`](https://www.npmjs.com/package/@openlup/platform) | Full Node.js & PostgreSQL commerce runtime | Headless checkout, payments, subscriptions, fulfillment, invoicing, promotions, catalog, identity, migrations, and HTTP/BFF server runtime |

## Install & Quickstart

Pin exact versions and upgrade all `@openlup/*` packages together. Node 24 or newer is required.

```sh
npm install --save-exact @openlup/core
```

```ts
import { platformEnvSchema } from "@openlup/core/platform-runtime";

const env = platformEnvSchema.parse({ APP_BASE_URL: "https://shop.example" });
```

Declaration maps connect `dist/` declarations to shipped `src/`; JavaScript source maps are not shipped. Read the [Agent Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/AGENTS.md) for the compiled wiring example and application ownership boundaries, or start with the [Adoption Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/start/adopt-from-npm.md) and [Tutorial](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/start/tutorial.md).

## Package Surface Maturity

| Export | Role | Maturity | Package smoke |
| --- | --- | --- | --- |
| `./bundle` | kernel | stable | `smoke/subscriptionBundleStandalone.test.ts` |
| `./catalog` | kernel | stable | `smoke/catalogStandalone.test.ts` |
| `./company-identity` | kernel | experimental | `smoke/companyIdentityStandalone.test.ts` |
| `./fulfillment` | kernel | stable | `smoke/fulfillmentStandalone.test.ts`<br>`test/fulfillmentStatusMap.test.ts`<br>`test/fulfillmentTrackingProgress.test.ts`<br>`test/fulfillmentCurrentParcel.test.ts`<br>`test/fulfillmentNormalizedFacts.test.ts` |
| `./inventory` | kernel | stable | `smoke/inventoryStandalone.test.ts` |
| `./marketing/research` | kernel | experimental | `smoke/marketingResearchStandalone.test.ts` |
| `./partners` | kernel | stable | `smoke/partnersStandalone.test.ts` |
| `./payment` | kernel | stable | `smoke/paymentStandalone.test.ts` |
| `./platform-runtime` | kernel | stable | `smoke/platformRuntimeStandalone.test.ts` |
| `./pricing` | kernel | stable | `smoke/pricingStandalone.test.ts` |
| `./promo` | kernel | stable | `smoke/promoStandalone.test.ts` |
| `./risk` | kernel | stable | `smoke/riskStandalone.test.ts` |
| `./shipping` | kernel | stable | `smoke/shippingStandalone.test.ts` |
| `./subscription` | kernel | stable | `smoke/subscriptionBundleStandalone.test.ts` |
| `./outbox` | kernel | stable | `smoke/outboxStandalone.test.ts` |
| `./readiness` | kernel | stable | `smoke/readinessStandalone.test.ts` |
| `./standard-schema` | kernel | experimental | `smoke/standardSchemaStandalone.test.ts` |
| `./testing` | testing | testing | `smoke/testingStandalone.test.ts` |

The table follows `release-gates.json`: stable exports follow SemVer from `1.0.0`; experimental and testing exports are excluded; `./package.json` exports the manifest itself. See the [release evidence boundary](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/reference/stability.md#release-evidence) and [glossary](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/glossary.md).

## Key Domain Contracts

- **Subscriptions & bundles (`./subscription`, `./bundle`):** Pure renewal cycle math, monotonic late-delivery clamping, bundle composition rules, and cadence contracts.
- **Pricing, promotions & catalog (`./pricing`, `./promo`, `./catalog`, `./inventory`):** Integer minor-unit pricing, offer quotes, promotion eligibility, and catalogue contract validation.
- **Payments, fulfillment & shipping (`./payment`, `./fulfillment`, `./shipping`, `./risk`):** Status mapping, tracking progress, current-parcel projection, canonical fact parsers, and bounded scheme-retry helpers (`withinSchemeRetryCeiling` checks only its local 15-attempt/30-day numeric bound; the host and provider enforce actual decline advice and scheme rules).
- **Partners & marketing (`./partners`, `./marketing/research`):** Inquiry and research contracts; see [Compose marketing handlers](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/build/marketing.md) and [offline catalogue extension recipes](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/how-to/extend/catalogue-extension.md).
- **Infrastructure contracts (`./outbox`, `./readiness`, `./standard-schema`, `./platform-runtime`):** Pure ports and readiness admission contracts consumed by `@openlup/outbox` and `@openlup/platform`.

## Readiness contract

`./readiness` evaluates inert package contributions against a complete host inventory and bounded schema observation (`checkReadiness`). Only `ready` admits a candidate; `unknown` and `unsatisfied` retain the serving candidate. Readiness helpers never run migrations, lease jobs, or activate modules — the host owns database access, transactions, and admission policy.

- **Catalog registry checks:** Optional `ReadinessInput.catalogRegistry` verifies live product-type references and installed definition digests; missing versions or mismatched digests report `registry_missing_referenced_version`, while incomplete or malformed observations report `unknown`.
- **Grouped PostgreSQL catalog probes:** `buildGroupedPostgresSchemaProbe` and `decodeGroupedPostgresSchemaRows` inspect PostgreSQL table, column, and function shapes in one bound query without performing I/O. See the [grouped PostgreSQL schema probe reference](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/PLATFORM_PACKAGE_REFERENCE.md#core-grouped-postgresql-schema-probe) for shape fields and decoder invariants.

### Module readiness

Selected `./readiness` modules retain independent schema requirements across ordered layers (`kernel`, `rail`, `capability`, `implementation`). See [module contributions, identity, and readiness](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#contributions-seams-and-readiness) for selection, bindings, and diagnostics.

## For AI Coding Agents

`@openlup/core` ships the offline reader guide (`docs/guide/`), `AGENTS.md`, TypeScript sources (`src/`), and the `openlup-context` CLI + MCP server directly inside the npm tarball — no network access required.

### Agent context lookup

Search installed OpenLup documentation, declarations, exports, and changelogs offline from your application root:

```sh
./node_modules/.bin/openlup-context search "subscription renewal"
```

Connect an MCP client over stdio (`search_openlup_context` and `read_openlup_file`):

```json
{
  "mcpServers": {
    "openlup-context": {
      "command": "./node_modules/.bin/openlup-context",
      "args": ["mcp"],
      "cwd": "/path/to/your-application"
    }
  }
}
```

Add `--json` for structured hits (including per-symbol `maturity`), `--code` for a bounded application source scan, or `--package-code` to scan installed `@openlup/*` `src/` files. See [Core agent context internals](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/DEVELOPMENT_AND_RELEASE.md#core-agent-context-internals) for workspace hoisting, scan limits, and MCP framing rules.

## Upgrading & Compatibility

- **Release channel & provenance:** Published to npm on the `latest` dist-tag with OIDC provenance from annotated release tags (`openlup-core-v<version>`).
- **SemVer & open unions:** Stable subpaths follow the [stable API contract](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/reference/stability.md#public-api). Unions and literal sets are open — additions are minor, so consumers must keep a default branch for unknown values.
- **Upgrade the set together:** Pin exact versions and read [CHANGELOG.md](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/CHANGELOG.md) and the [Upgrade Guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/upgrade/README.md) before upgrading.
- **Contributing from source:** See [CONTRIBUTING.md](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/CONTRIBUTING.md) and [Core local verification from source](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/DEVELOPMENT_AND_RELEASE.md#core-local-verification-from-source) for monorepo checks, neutrality scans, and tarball budgets.
