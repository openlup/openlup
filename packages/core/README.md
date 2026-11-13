# Commerce Core

`@openlup/core` provides framework-independent TypeScript contracts and pure logic
for subscription and bundle commerce. An application binds its ports and owns
composition. This is a development preview: pin an exact version and upgrade all
`@openlup/*` packages together after reading their changelogs.

```sh
npm install --save-exact @openlup/core
```

```ts
import { platformEnvSchema } from "@openlup/core/platform-runtime";

const env = platformEnvSchema.parse({ APP_BASE_URL: "https://shop.example" });
```

Node 24 or newer is required. Read [AGENTS.md](AGENTS.md) for the compiled wiring
example and application ownership rules.

## Package Surface Maturity

| Export | Role | Maturity | Package smoke |
| --- | --- | --- | --- |
| `./bundle` | kernel | candidate | `smoke/subscriptionBundleStandalone.test.ts` |
| `./catalog` | kernel | candidate | `smoke/catalogStandalone.test.ts` |
| `./company-identity` | kernel | experimental | `smoke/companyIdentityStandalone.test.ts` |
| `./fulfillment` | kernel | experimental | `smoke/fulfillmentStandalone.test.ts`<br>`test/fulfillmentStatusMap.test.ts`<br>`test/fulfillmentTrackingProgress.test.ts`<br>`test/fulfillmentCurrentParcel.test.ts`<br>`test/fulfillmentNormalizedFacts.test.ts` |
| `./inventory` | kernel | candidate | `smoke/inventoryStandalone.test.ts` |
| `./marketing/research` | kernel | experimental | `smoke/marketingResearchStandalone.test.ts` |
| `./partners` | kernel | experimental | `smoke/partnersStandalone.test.ts` |
| `./payment` | kernel | experimental | `smoke/paymentStandalone.test.ts` |
| `./platform-runtime` | kernel | experimental | `smoke/platformRuntimeStandalone.test.ts` |
| `./pricing` | kernel | candidate | `smoke/pricingStandalone.test.ts` |
| `./promo` | kernel | candidate | `smoke/promoStandalone.test.ts` |
| `./risk` | kernel | candidate | `smoke/riskStandalone.test.ts` |
| `./shipping` | kernel | candidate | `smoke/shippingStandalone.test.ts` |
| `./subscription` | kernel | candidate | `smoke/subscriptionBundleStandalone.test.ts` |
| `./outbox` | kernel | experimental | `smoke/outboxStandalone.test.ts` |
| `./readiness` | kernel | experimental | `smoke/readinessStandalone.test.ts` |
| `./standard-schema` | kernel | experimental | `smoke/standardSchemaStandalone.test.ts` |
| `./testing` | testing | testing | `smoke/testingStandalone.test.ts` |

## Channel and stability

[Versioning and stability](docs/guide/reference/stability.md) and [the changelog](CHANGELOG.md).

## Use in an application

[Start](docs/guide/start/README.md), [adopt from npm](docs/guide/start/adopt-from-npm.md),
[the tutorial](docs/guide/start/tutorial.md) and [upgrade an application](docs/guide/upgrade/README.md).
Use the [glossary](docs/guide/glossary.md) for shared terms.

## Kernel Documentation

[Subscription engine](docs/guide/concepts/subscription-engine.md).

### Module readiness

[Architecture and ownership](docs/guide/concepts/architecture-and-ownership.md#packages-and-dependencies) and [check readiness](docs/guide/upgrade/README.md#check-readiness).

## Readiness contract

[Check readiness](docs/guide/upgrade/README.md#check-readiness); [grouped PostgreSQL observations](docs/guide/how-to/build/outbox.md#observe-the-selected-schema).

## Bundle contracts

[Compose native bundle writes](docs/guide/how-to/build/bundles.md).

## Commerce data contracts

[Read prices for a quote](docs/guide/how-to/build/quote-prices.md) and [add OpenLup to an existing application](docs/guide/how-to/build/own-stack.md).

### Catalog identifiers

The identity schemas are in the shipped `src/catalog/`; [catalog draft composition](docs/guide/how-to/build/own-stack.md#choose-the-imports-and-ports) keeps product definitions in the application.

### Inventory availability

Read the `./inventory` declarations and shipped `src/inventory/` for the available-to-promise contract.

### Price resolution and breakdown

[Read prices for a quote](docs/guide/how-to/build/quote-prices.md).

### Promotion evaluation and adjustments

[Read prices for a quote](docs/guide/how-to/build/quote-prices.md).

## Delivery contracts

[Compose native fulfillment](docs/guide/how-to/build/fulfillment.md).

### Fulfillment fact and status contracts

[Canonical status](docs/guide/concepts/payments.md#canonical-status) and [compose native fulfillment](docs/guide/how-to/build/fulfillment.md).

### Shipping rule resolution

[Read prices for a quote](docs/guide/how-to/build/quote-prices.md).

## Partner and risk contracts

[Architecture and ownership](docs/guide/concepts/architecture-and-ownership.md).

### Company identity lookup contracts

[Identity](docs/guide/concepts/identity.md); lookup schemas are in the shipped `src/company-identity/`.

### Partner lifecycle contracts

[Compose marketing handlers](docs/guide/how-to/build/marketing.md); inquiry contracts are in the shipped `src/partners/`.

### Risk evaluation contracts

Read the `./risk` declarations and shipped `src/risk/` for evaluation inputs and enforcement facts.

## Payment contracts

[Payments](docs/guide/concepts/payments.md).

The `./payment` export's `withinSchemeRetryCeiling` helper checks only its local
15-attempt/30-day numeric bound. A passing result does not authorize a retry or
certify compliance; the host/provider must apply actual decline advice and
current applicable rules, including any narrower limits.

## Marketing contracts

[Marketing sync](docs/guide/concepts/marketing-sync.md) and [compose marketing handlers](docs/guide/how-to/build/marketing.md).

## Outbox contracts

[Deliver events with the outbox](docs/guide/how-to/build/outbox.md) and [idempotency](docs/guide/concepts/idempotency.md#handler-effects-across-retries).

## Platform runtime contracts

[Run OpenLup on your own host](docs/guide/how-to/operate/self-host.md).

## Standard schema contracts

[Compose a provider adapter](docs/guide/how-to/extend/provider-adapters.md); the shared schema interface is in the shipped `src/standard-schema/`.

## Agent context lookup

Run the installed tool from the application root:

```sh
./node_modules/.bin/openlup-context search "subscription renewal"
```

Search concise English terms or an exact public symbol, then read the cited
owner. `--code` and `--package-code` opt into bounded application and installed
source scans; `--json` includes scan summaries. A ranked hit or an empty result
does not establish complete coverage. Read a known path directly.

## Agent context over MCP

Run `./node_modules/.bin/openlup-context mcp` as your client's stdio command,
with the application root as its working directory. Use
`search_openlup_context`, then `read_openlup_file` on a returned installed path.
`includeApplicationCode` and `includePackageCode` opt into source scans.
Read accepts inclusive `startLine`/`endLine` beginning at 1 and ordinary installed
files up to 200,000 bytes; it refuses URLs, traversal and paths escaping the
resolved package root. Symlinked package roots are supported. These checks apply
at read time, not against concurrent rewrites of installed dependencies.
Search tasks are limited to 1,000 characters and message lines to 1 MiB;
oversized lines are discarded through the next newline. End stdin to stop.
Application source hits require your client's own file tool.

Both lookup modes read installed files offline. Repository-only citations refer
to the installed `AGENT_CONTEXT.md` excerpts; check the installed package version
and cited owner before changing a contract. Lookup grants no application or
external-write authority. For the full protocol and bounds, inspect the shipped
`src/agent-context-cli.ts` and `src/agent-context-mcp.ts`.

## Local verification from source

See [the contribution guide](CONTRIBUTING.md) for source checks; the npm tarball
omits development scripts and tests.

## Package artifact limits

See the [package artifact policy](https://github.com/openlup/openlup/blob/main/.github/VERSIONING_AND_EOL.md#package-artifact-limits).

## Release notes

Read [the changelog](CHANGELOG.md#0390) before upgrading the package set.
The following preparation details are retained because they are not recorded
in this package's shipped changelog:

Core introduces no schema migration.
Size comparison uses the published `0.38.0` tarball. Preparation establishes no
npm publication.

The set requires Zod `^4.6.6` for GHSA-mrhx-c7xc-m3w5.
Oversized constrained collections fail before per-element errors accumulate;
bounded valid inputs and public exports are preserved. Both dependency locks
select the fixed runtime. The build uses the existing development-only Node
types for Zod's standard `URL` declaration; Core adds no runtime Node import.
