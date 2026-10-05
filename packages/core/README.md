# Commerce Core

`@openlup/core` is the kernel of the `@openlup/*` package family: the
framework-independent TypeScript contracts and logic for subscription and
bundle commerce that the other packages and an application's composition read.
Agents start with [AGENTS.md](AGENTS.md). Its "Using this package in an
application" section, which `docs:check` requires, tells an application's agent
not to edit or patch the installed package and to upgrade every `@openlup/*`
package together.

## Channel and stability

- **Channel:** npm, on the `latest` dist-tag. Each version is published with
  provenance from its release tag `openlup-core-v<version>` after a protected
  release approval. Versions up to `0.11.0` were published on the `preview`
  dist-tag only. `npm publish` from this directory is refused.
- **Versions:** below 1.0 every `@openlup/*` package shares one set version
  `0.N.P`: a minor set for any API, behaviour or schema change, a patch set for
  a fix only.
- **Stability:** development preview. Any version may change an export, and
  each change is recorded in [the changelog](CHANGELOG.md). Pin an exact
  version and read the changelog when you upgrade.

The experimental `./outbox`, `./standard-schema` and `./readiness` subpaths provide shared infrastructure contracts. `checkReadiness` evaluates inert contribution descriptors, the complete host-observed package set, actual host bindings (schedule/route function identity must match the contribution) and a bounded schema probe. It never migrates, leases or sends. Only `ready` admits a new candidate; `unknown` and `unsatisfied` leave the serving candidate in place. The host owns inventory completeness, immutable artifact/configuration/schema identity and admission at every work entrance. Catalog existence does not prove SQL bodies, permissions or provider recovery.

## Package Surface Maturity

Every current export is an internal candidate, experimental kernel, or testing
surface. Its declaration snapshot is a reviewable drift proof, not a public API
promise.

| Export | Role | Maturity | Package smoke |
| --- | --- | --- | --- |
| `./bundle` | kernel | candidate | `smoke/subscriptionBundleStandalone.test.ts` |
| `./catalog` | kernel | candidate | `smoke/catalogStandalone.test.ts` |
| `./company-identity` | kernel | experimental | `smoke/companyIdentityStandalone.test.ts` |
| `./fulfillment` | kernel | experimental | `smoke/fulfillmentStandalone.test.ts` |
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

`release-gates.json` records four distinct evidence classes:

- `packageSmokeEvidence`: required hermetic build/import/pack/publish-refusal
  proof for this package;
- `conformanceEvidence`: required only when a declared port/adapter seam needs
  a framework-free suite;
- `dogfoodEvidence`: first-party integration seams, not independent adoption;
- `externalConsumerEvidence`: not yet evaluated; a first-party packed consumer
  remains package smoke, not external adoption.

## Use in an application

From your application's root, with Node 24 and npm 11.19.0:

```sh
npm install --save-exact @openlup/core@0.12.0
```

Read the installed `AGENTS.md`, then compose the [typed wiring example](AGENTS.md#wiring-example)
with your application's own ports and options. Inspect the shipped sources and
declarations for the exact version you installed. A missing seam needs an
upstream proposal under your application's submission authority; the dependency
guide grants no permission to publish an issue or change your application.
Keep every installed `@openlup/*` package on the same exact set version.

## Local verification from source

The following developer commands require a source checkout of this package;
the npm tarball omits its development scripts and tests. From the source package
directory:

```sh
npm ci
npm run ci
```

Focused proofs are `npm run api:check`, `npm run release:check`, and
`npm run test:consumer`. The root test script skips this suite.
`npm run docs:check` requires relative links in shipped Markdown to resolve to
files actually packed in the tarball; a target present only in source refuses.
Ambiguous destinations refuse explicitly: use literal punctuation or
percent-encoded filenames, with ASCII whitespace before an optional title.
Raw ampersands, angle characters and Unicode whitespace in local destinations
require a canonical rewrite rather than passing an incomplete link check.

The [repository neutrality checks](https://github.com/openlup/openlup/blob/openlup-core-v0.12.0/CONTRIBUTING.md#development-preview-checks)
reuse the source scanner through `./scripts/neutrality-tree-counts.ts` relative
to this source package. This process interface reads JSON containing source paths,
contents and a policy
from standard input, then emits finding counts for each path. Shell sources
retain the scanner's existing shell handling. The interface adds no package
export and changes no matcher or kernel behavior.

Repository lint keeps this package's production source independent of configured
provider SDKs and explicit industry contract names. Adopter adapters compose
providers; generic ports can forward opaque extension data. See the
[syntax scope and exceptions](https://github.com/openlup/openlup/blob/openlup-core-v0.12.0/CONTRIBUTING.md#development-preview-checks).

The repository checker also calls the UI neutrality counting process with
`--counts-json` to count its existing patterns over the supplied sources. Running that checker without
arguments still scans the UI source directory and refuses any forbidden hit.
Published Tree CI runs the repository ratchet in required `self-check` and its
CLI refusal tests separately in required `test`; unrestricted root diagnostics
do not replace either gate. The independent core CI step retains this package's
complete verification when root diagnostics are red.

Together these interfaces let the repository measure existing findings without
making one package import another package's internals. They provide source
neutrality evidence, not package activation or consumer compatibility evidence.

## Kernel Documentation

- [`docs/SUBSCRIPTION_ENGINE.md`](docs/SUBSCRIPTION_ENGINE.md) — what the
  `./subscription` kernel owns, its deterministic-clock contract, the
  late-payment cycle-shift rule and its monotonic clamp, and how a host
  application consumes it.
