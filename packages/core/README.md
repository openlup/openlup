# Commerce Core

`@openlup/core` is the kernel of the `@openlup/*` package family: the
framework-independent TypeScript contracts and logic for subscription and
bundle commerce that the other packages and an application's composition read.
Agents start with [AGENTS.md](AGENTS.md). Its "Using this package in an
application" section, which `docs:check` requires, tells an application's agent
not to edit or patch the installed package and to upgrade every `@openlup/*`
package together.

The prepared `0.33.0` set includes Platform's experimental company-identity and
market-pack entries and Node scheduler stop fix. Core's kernel code and exports
are unchanged; generated guidance locations follow the canonical source.
Upgrade all packages together and read [the set notes](CHANGELOG.md#0330);
Core introduces no schema migration. Size comparison uses the published `0.32.0`
tarball; releases before `0.31.0` remain in the source-only
`CHANGELOG-HISTORY.md`. Preparation establishes no npm publication.

The prepared set requires Zod `^4.6.6` for GHSA-mrhx-c7xc-m3w5.
Oversized constrained collections fail before per-element errors accumulate;
bounded valid inputs and public exports are preserved. Both dependency locks
select the fixed runtime. The build uses the existing development-only Node
types for Zod's standard `URL` declaration; Core adds no runtime Node import.

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

The experimental `./outbox`, `./standard-schema` and `./readiness` subpaths
provide infrastructure contracts. `checkReadiness` checks inert contributions,
complete host inventory, actual schedule/route function bindings and a bounded
schema probe. It never migrates, leases or sends. Only `ready` admits a candidate;
`unknown` and `unsatisfied` retain the serving candidate. The host owns immutable
artifact/configuration/schema identity and admission at every work entrance.
Legacy artifacts require one contribution per non-kernel package; selected logical
modules use [module readiness](#module-readiness).

For PostgreSQL catalog inspection, import `buildGroupedPostgresSchemaProbe`,
`decodeGroupedPostgresSchemaRows` and `PostgresSchemaCatalogEntry` from
`@openlup/core/readiness`. The builder accepts the existing `SchemaObject`
identities and returns one SQL statement with bound values. Tables use
`to_regclass` and must be ordinary or partitioned; columns split the final name
component exactly as the scalar builder does and exclude system/dropped
attributes; functions use `to_regprocedure` with the exact signature (omission
means zero arguments). PostgreSQL retains responsibility for name resolution
and invalid-name errors. Duplicate requests retain separate one-based integer
ordinals; an empty request executes a valid empty catalog read.

Rows carry `ordinal`, boolean `present` and `shape`. The decoder requires exactly
one row per input, in ordinal order. Legitimate absence is `false` with SQL
`NULL`; presence requires nonempty JSON text parsing to a nonnull, nonarray object.
Parsed driver objects are refused.
Missing, extra, duplicate, reordered or noninteger ordinals, malformed presence,
inconsistent absence and invalid/nonobject JSON throw a bounded generic error
without catalog bodies. Extra row columns are ignored. JSON.parse property and
nested array order are retained without sorting, canonicalization or rebuilding; input objects and
rows are not mutated. Database/driver errors propagate to the host.

Each shape is `pg_catalog.jsonb_build_object(...)::text`, retaining PostgreSQL
jsonb field ordering as parsed by the consumer. Shape fields are: functions expose `definition`, `owner`,
`acl`, `config`, `securityDefiner`, `volatility`; tables expose `kind`, `owner`,
`acl`, `rls`, `forceRls`, `constraints`, `indexes`, `triggers`, `policies`; columns
expose `type`, `notNull`, `identity`, `generated`, `default`, `acl`. Catalog nulls
are retained. Constraint/index/noninternal-trigger aggregates contain definition
strings ordered by constraint name, index OID cast to regclass text or trigger
name, and remain null when empty. Policies use `pg_catalog.pg_policy`, ordered
by policy name, with `name`, raw role OID array `roles`, command code `cmd`,
boolean `permissive`, and expression strings/nulls `qual`, `check`; the aggregate
remains null when empty. Definitions come from PostgreSQL's `pg_get_*` functions
and column types from `format_type`.

The host executes and decodes the query through its own driver and owns
connection/TLS/role, any `READ ONLY REPEATABLE READ` snapshot, requirements,
independently observed identity and migration ledgers, digest policy,
invalidation and admission. Catalog shapes do not establish SQL behavior,
effective grants, recovery or authorization. The grouped helpers add no I/O,
transaction, retry or deadline and do not change `createSchemaProbe`,
`SchemaObservation` or readiness codes. A host maps decoder/driver failures to
its existing unknown policy. Focused decoder tests extend the existing
standalone readiness suite. Actual installed-tarball SQL and shape-order proof
runs in the existing Outbox disposable PostgreSQL tier in the source repository.

Contributor package verification keeps the existing code/docs class and file
ceilings. Its aggregate budgets in `release-gates.json` follow the measured
decision its `$budgetReason` records; later growth still needs its own
measured budget decision. Passing a local pack does not authorize publication.

`./fulfillment` owns pure status, tracking-progress, current-parcel and canonical fact-parser helpers.

## Package Surface Maturity

Every current export is an internal candidate, experimental kernel, or testing
surface. Its declaration snapshot is a reviewable drift proof, not a public API
promise.

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

`release-gates.json` records four distinct evidence classes:

- `packageSmokeEvidence`: required hermetic build/import/pack/publish-refusal
  proof for this package;
- `conformanceEvidence`: required only when a declared port/adapter seam needs
  a framework-free suite;
- `dogfoodEvidence`: first-party integration seams, not independent adoption;
- `externalConsumerEvidence`: not yet evaluated; a first-party packed consumer
  remains package smoke, not external adoption.

The `./payment` export's `withinSchemeRetryCeiling` helper checks only its local
15-attempt/30-day numeric bound. A passing result does not authorize a retry or
certify compliance; the host/provider must apply actual decline advice and
current applicable rules, including any narrower limits.

## Use in an application

From your application's root, with Node 24 and npm 11.19.0:

```sh
npm install --save-exact @openlup/core@<version>
```

Replace `<version>` with the exact published version selected for your complete
`@openlup/*` package set. This source README does not establish registry
publication.

Read the installed `AGENTS.md`, then compose the [typed wiring example](AGENTS.md#wiring-example)
with your application's own ports and options. Inspect the shipped sources and
declarations for the exact version you installed. A missing seam needs an
upstream proposal under your application's submission authority; the dependency
guide grants no permission to publish an issue or change your application.
Keep every installed `@openlup/*` package on the same exact set version.

The package owns its engine; application handlers, policies, ports, composition
and compatible native adapters remain yours. Use declared public exports, without
autonomous package patching, vendoring, shadowing or copied-engine replacement.
Follow the [using rules](AGENTS.md#using-this-package-in-an-application) for a
missing seam and compatible recovery. First adoption and upgrade compare the
actual npm artifact with current bindings and nominated extensions, preserving
native effects and pending work. The public
[adopter recipe](https://github.com/openlup/openlup/blob/main/docs/platform/adopter-kit/README.md#adopt-or-upgrade-a-package)
is optional source guidance to select at a deliberate revision and compare with
your installed contract; later guide changes do not alter this version or install
application controls. Existing tests and the unchanged wiring example do not
certify a complete module absorption or deployed adoption.

## Agent context lookup

After installing core, run the local executable from the application root:

```sh
./node_modules/.bin/openlup-context search "subscription renewal"
```

This MVP indexes English documentation. Translate Polish or other natural-language
tasks into concise English domain terms, or search an exact public symbol;
freeform Polish queries may miss relevant guidance.

The command searches documentation in the installed OpenLup packages offline and
returns file-and-line citations. Add `--code` for a bounded local application
source scan that may be incomplete; use direct `rg` when needed. Add `--json`
for structured results. It never downloads packages or starts a
service. Its Node-only launcher is isolated from the I/O-free kernel exports and
adds no runtime dependency.

Read a known path or symbol directly. Use the lookup to locate an unfamiliar
package seam, then inspect the cited owner and follow its exports, callers and
tests for cross-package work. A ranked result does not establish complete
contract coverage.

Each package's root `AGENT_CONTEXT.md` contains small excerpts of canonical
repository guidance, with source paths, line ranges and excerpt digests. Read
the package version from its installed `package.json` and check the cited source
before changing a contract; a result locates
evidence, and does not grant application policy or execution authority. The
snapshot and command do not establish a registry release or stable support.

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
The shared repository gate runs this package's API check before expensive
proofs, then `ci:required` retains the mechanical obligations once through
`release:admission`. That mode skips only the absolute live dependency audit;
repository admission checks newly selected vulnerable production dependencies
against the base instead. Unchanged inherited advisories remain alerts.
`release:check`, standalone `ci` and publication packs retain the full audit.
The standalone `ci` command keeps its API check for manual package verification.
In the monorepo, required CI supplies `OPENLUP_PACK_MANIFEST` and
`OPENLUP_PACK_COMMIT` together to the same consumer. It verifies the complete
publishable set and both tarball digests, then uses the named core artifact
without rebuilding or repacking it. A missing or damaged supplied input refuses;
it never falls back to a source-directory install. The consumer still audits the
packed files, imports every public export, checks NodeNext and Bundler types,
and builds with Vite. It installs Zod from a separately packed locked runtime
input and uses explicitly located host TypeScript/Vite tools. The isolated
consumer records the core artifact hashes and rejects package symlinks or
ancestor module-resolution overrides. Without either supplied input, the manual
source command retains its own build and pack.
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
CLI refusal tests in required root `test`. This package's independent proof
belongs to `install-proof`; see [repository testing](https://github.com/openlup/openlup/blob/main/CONTRIBUTING.md#test-scope-and-diagnostics).

Together these interfaces let the repository measure existing findings without
making one package import another package's internals. They provide source
neutrality evidence, not package activation or consumer compatibility evidence.

## Kernel Documentation

- [`docs/SUBSCRIPTION_ENGINE.md`](docs/SUBSCRIPTION_ENGINE.md) — what the
  `./subscription` kernel owns, its deterministic-clock contract, the
  late-payment cycle-shift rule and its monotonic clamp, and how a host
  application consumes it.

### Module readiness

Selected `./readiness` modules retain independent schema requirements.
Dependencies use the same or an earlier layer:
`kernel`, `rail`, `capability`, `implementation`.
See the optional current-source [module contributions, identity, and readiness
guidance](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#contributions-seams-and-readiness)
for selection, bindings, refusals and diagnostics; it is not version-specific
migration guidance. For an installed package, its declarations for the selected
version remain authoritative; the source checkout's `api/readiness.api.md` is a
snapshot reference, and the host owns inventory.

## Package artifact limits

The monorepo's package artifact checker enforces this package's
`release-gates.json` caps and packed content allowlist. Only
`--release-set <version>` checks compressed growth against the last released
baseline, with explanations in the new set's changelog section and release body. See the
[package artifact policy](https://github.com/openlup/openlup/blob/main/.github/VERSIONING_AND_EOL.md#package-artifact-limits)
for measured sizes, current caps, the S1 baseline refresh and refusal remedies.
Artifact checks require a clean package directory; `--manifest-only` supplies no
artifact evidence.

Source contributors record notable changes in package changelog fragments;
release preparation assembles the shipped CHANGELOG. Follow the
[public contribution guide](https://github.com/openlup/openlup/blob/main/CONTRIBUTING.md#development-preview-checks).

## Readiness contract

The `./readiness` export evaluates inert package contributions against a complete
host inventory and bounded schema observation. Its grouped PostgreSQL probe
preserves request ordinals and distinguishes legitimate absence from malformed
or incomplete results. Readiness evaluation calls the host's schema observation
port; `createSchemaProbe` invokes the supplied identity callback and SQL executor.
The grouped query builder and result decoder perform no I/O. The application
retains database access, transaction and admission policy; these helpers do not
run migrations, schedule work or activate a module.

## Bundle contracts

The `./bundle` export defines commerce composition: `Bundle` contains `coreLines`,
`addonLines` and a `CompositionConstraint`. Its `BundleLineRef` identifies a line,
and `CompositionRulesPort` supplies the application's composition rules. These
are commerce bundle contracts. Platform bundle identifiers, descriptors and
readiness composition belong to `./platform-runtime`.

## Commerce data contracts

Product identity, stock position, price decisions and promotion rules have
separate owners. Membership, persistence, checkout composition and final
selection remain host responsibilities.

### Catalog identifiers

The `./catalog` export provides bounded shape validators for product, SKU,
variant and slug identifiers. Those open formats do not determine whether an
identifier exists in a catalogue; the host's catalog read port owns membership
and current product data.

### Inventory availability

The `./inventory` export calculates available-to-promise results from supplied
stock lines, reservations, unavailable quantities, safety stock and lot facts.
It selects a single location when possible and reports review-required or
unsupported results when the request cannot be fulfilled under its declared
no-split policy. It reads or reserves no inventory itself.

### Price resolution and breakdown

The `./pricing` export defines the asynchronous price-resolution port and pure
pricing breakdown builders. The host resolves price-list entries and owns any
fallback choice; the builders emit line and order components whose totals
reconcile to the supplied resolved prices, discounts and shipping amount.

### Promotion evaluation and adjustments

The `./promo` export evaluates time-, region- and cart-eligible candidates with
separate product and shipping lanes, including coupon and stacking rules. Its
adjustment engine selects bounded winners and returns payable amounts and
rejection facts. It performs no persistence or checkout activation.

## Delivery contracts

Delivery facts and shipping-rule results are separate inputs to host order and
fulfillment workflows.

### Fulfillment fact and status contracts

The `./fulfillment` export defines canonical local statuses, normalized fact
parsing, progress presentation and parcel precedence. These helpers normalize
and order supplied evidence; they do not dispatch a shipment or establish that
a parcel reached the customer.

### Shipping rule resolution

The `./shipping` export resolves active rules for the supplied region, currency,
cart mode and time, then snapshots shipping amount and VAT treatment. A missing
rule returns no result for the host to handle. Carrier choice, pickup points,
labels and shipment execution remain outside the kernel.

## Partner and risk contracts

Identity lookup, partner inquiry state and risk assessment are distinct neutral
contracts; host policy supplies authority and decides how to act on each result.

### Company identity lookup contracts

The `./company-identity` export defines lookup request and response shapes,
purpose, per-source outcomes and verification levels. The host selects supported
identifier kinds and decides whether the resulting trust level satisfies the
lookup purpose; the schemas neither query registries nor approve a seller.

### Partner lifecycle contracts

The `./partners` export defines inquiry lifecycle statuses and the update
request/acknowledgement port. Inquiry payloads, contact data and downstream CRM
identifiers remain host-owned; a successful acknowledgement records the port
result, not an independent qualification decision.

### Risk evaluation contracts

The `./risk` export matches supplied signals to deterministic rules and returns
score, severity, reason codes and mode-dependent enforcement facts. The host
supplies signals and selects whether a result is shadowed, reviewed or enforced;
the evaluator does not authorize an order or payment by itself.

## Payment contracts

The `./payment` export defines provider-neutral payment status and money-path
contracts. Host adapters translate provider results and retain authorization,
verification and settlement policy; the kernel performs no provider I/O.

## Marketing contracts

The `./marketing/research` export represents consent-aware research evidence and
its neutral projection contracts. Applications supply collection, retention,
consent and persistence policy; the package does not activate collection.

## Outbox contracts

The `./outbox` export defines the shared event row, handler outcomes, execution
context, inert handler descriptors, abort signal, handler interface and event
vocabulary. Handlers must keep effects idempotent and honor the abort signal.
The separate `@openlup/outbox` rail owns claiming and settlement ports; its host
adapter and worker supply durable storage, transactions and external delivery.

## Platform runtime contracts

The `./platform-runtime` export describes shared host capabilities and runtime
configuration inputs. It does not construct a server or read deployment
configuration; the application binds and admits its own runtime.

## Standard schema contracts

The `./standard-schema` export exposes the framework-neutral schema interface
used by package contracts. It keeps browser-safe consumers independent of a
schema library runtime; validation behavior still belongs to each declared
schema and its consumer.
