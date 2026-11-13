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

Node 24 or newer is required; the source adoption recipe uses npm 11.19.0. Declaration maps connect `dist/` declarations to
shipped `src/`; JavaScript source maps are not shipped. Read [AGENTS.md](AGENTS.md) for the compiled wiring
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

Every current code export is an internal candidate, experimental kernel, or
testing surface; the `./package.json` export is the manifest itself. Its declaration snapshot is a reviewable drift proof, not a public API
promise.

`release-gates.json` records four distinct evidence classes:

- `packageSmokeEvidence`: required hermetic build/import/pack/publish-refusal
  proof for this package;
- `conformanceEvidence`: required only when a declared port/adapter seam needs
  a framework-free suite;
- `dogfoodEvidence`: first-party integration seams, not independent adoption;
- `externalConsumerEvidence`: not yet evaluated; a first-party packed consumer
  remains package smoke, not external adoption.

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

## Use in an application

[Start](docs/guide/start/README.md), [adopt from npm](docs/guide/start/adopt-from-npm.md),
[the tutorial](docs/guide/start/tutorial.md) and [upgrade an application](docs/guide/upgrade/README.md).
Use the [glossary](docs/guide/glossary.md) for shared terms.

## Kernel Documentation
Moved to [Subscription engine](docs/guide/concepts/subscription-engine.md).

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
Moved to [Compose native bundle writes](docs/guide/how-to/build/bundles.md).

## Commerce data contracts
Moved to [Read prices for a quote](docs/guide/how-to/build/quote-prices.md) and [add OpenLup to an existing application](docs/guide/how-to/build/own-stack.md).

### Catalog identifiers
Moved to [Pure contract limits](docs/guide/reference/limits.md#pure-contract-limits).

### Inventory availability
Moved to [Pure contract limits](docs/guide/reference/limits.md#pure-contract-limits).

### Price resolution and breakdown
Moved to [Read prices for a quote](docs/guide/how-to/build/quote-prices.md).

### Promotion evaluation and adjustments
Moved to [Read prices for a quote](docs/guide/how-to/build/quote-prices.md).

## Delivery contracts
Moved to [Compose native fulfillment](docs/guide/how-to/build/fulfillment.md).

### Fulfillment fact and status contracts
Moved to [Canonical status](docs/guide/concepts/payments.md#canonical-status) and [compose native fulfillment](docs/guide/how-to/build/fulfillment.md).

### Shipping rule resolution
Moved to [Select shipping rules](docs/guide/how-to/build/fulfillment.md#select-shipping-rules).

## Partner and risk contracts
Moved to [Architecture and ownership](docs/guide/concepts/architecture-and-ownership.md).

### Company identity lookup contracts
Moved to [Pure contract limits](docs/guide/reference/limits.md#pure-contract-limits).

### Partner lifecycle contracts

[Compose marketing handlers](docs/guide/how-to/build/marketing.md); inquiry contracts are in the shipped `src/partners/`.

### Risk evaluation contracts
Moved to [Pure contract limits](docs/guide/reference/limits.md#pure-contract-limits).

## Payment contracts
Moved to [Payments](docs/guide/concepts/payments.md).

The `./payment` export's `withinSchemeRetryCeiling` helper checks only its local
15-attempt/30-day numeric bound. A passing result does not authorize a retry or
certify compliance; the host/provider must apply actual decline advice and
current applicable rules, including any narrower limits.

## Marketing contracts
Moved to [Marketing sync](docs/guide/concepts/marketing-sync.md) and [compose marketing handlers](docs/guide/how-to/build/marketing.md).

## Outbox contracts
Moved to [Deliver events with the outbox](docs/guide/how-to/build/outbox.md).

## Platform runtime contracts
Moved to [Run OpenLup on your own host](docs/guide/how-to/operate/self-host.md).

## Standard schema contracts
Moved to [Pure contract limits](docs/guide/reference/limits.md#pure-contract-limits).

## Agent context lookup

```sh
./node_modules/.bin/openlup-context search "subscription renewal"
```

The command searches documentation in the installed OpenLup packages offline,
including core's reader guide under `docs/guide/`, and returns file-and-line
citations. Add `--code` for a bounded local application source scan, or
`--package-code` to inspect the installed packages' `src/` files.
Both scans are opt-in and may be incomplete; use direct `rg` when a path or
symbol is known. Add `--json` for structured results, including a `scans` array
for executed declaration, application and package-source scans. Each summary
reports its scope, package when applicable, budget-consuming `scannedFiles`,
`fileLimit` and conservative `limitReached` flag. The flag is true even when
the count exactly equals the limit; it does not prove another file exists.
A false flag does not prove exhaustive coverage: filters and other bounds still
apply. An exact package-source path consumes budget even when its contents are
not read. Text output notices reached limits, including when there are no hits.
The top-eight result cap is separate from these scan limits. It never downloads
packages or starts a service. Its Node-only launcher is isolated from the
I/O-free kernel exports and adds no runtime dependency.

Nested Markdown headings return separate spans; copied excerpts of an already
indexed installed page do not take another result slot. Each package's root
`AGENT_CONTEXT.md` contains small excerpts of canonical
repository guidance, with shipped local sources or repository links at
`openlup-core-v<version>`, line ranges and excerpt digests. Repository paths and
aliases inside excerpts belong to that checkout, not the application.
Repository citations must name that package's own release tag at its installed
version; another package, version, branch or host is refused. The same canonical
owner and heading take one result slot across package release tags. No link is
fetched. Read the package version from its installed `package.json` and check the cited source
before changing a contract; a result locates
evidence, and does not grant application policy or execution authority. The
snapshot and command do not establish a registry release or stable support.

## Agent context over MCP

Connect an MCP client to the installed context tool over stdio. Set the working
directory to your application root (the directory containing `node_modules`):

```json
{
  "mcpServers": {
    "openlup-context": {
      "command": "npx",
      "args": ["openlup-context", "mcp"],
      "cwd": "/path/to/your-application"
    }
  }
}
```

The example assumes core is already installed; use the local executable
`./node_modules/.bin/openlup-context mcp` directly if your client must never let
`npx` fetch a missing command. Configure the working directory in your client's
settings if it does not accept `cwd`.

Use `search_openlup_context` when the owner or extension seam is unclear, then
`read_openlup_file` with the returned application-relative path and optional
inclusive `startLine`/`endLine` (starting at 1). Search also returns structured
results; `includeApplicationCode` and `includePackageCode` opt into the same
bounded scans as the CLI flags. Read accepts only ordinary installed
`node_modules/@openlup/<name>/` files up to 200,000 bytes. Symlinked package roots
are supported; file realpaths must stay inside the resolved package root. Read
refuses traversal and never fetches release-tag source URLs. These checks guard
against wrong paths and links present when the file is read; they do not defend
against a process that rewrites `node_modules` during the read, which can already
change the code the application runs. For a repository-only
source, read its installed context excerpt; application source hits require your
client's own file tool. Search tasks are limited to 1,000 characters, and each
incoming message line to 1 MiB. Oversized messages receive one error and are
discarded through the next newline; the server continues serving. End stdin to
stop the process.

## Local verification from source

See [the contribution guide](CONTRIBUTING.md) for source checks; the npm tarball
omits development scripts and tests.

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
packed files, imports every public code export, checks NodeNext and Bundler types,
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
It also type-checks TypeScript examples in `README.md` and `AGENTS.md` against
the built package, holds `AGENTS.md` to a size cap, and checks the reader guide
under `docs/guide/` if it exists; a guide without a detected source repository
root refuses. `npm run docs:check -- --write` refreshes generated regions in
`README.md`, `AGENTS.md` and the guide.

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

## Package artifact limits

The monorepo's package artifact checker enforces this package's
`release-gates.json` caps and packed content allowlist. Only
`--release-set <version>` checks compressed growth against the last released
baseline, with explanations in the new set's changelog section and release body. See the
[package artifact policy](https://github.com/openlup/openlup/blob/main/.github/VERSIONING_AND_EOL.md#package-artifact-limits)
for measured sizes, current caps, the S1 baseline refresh and refusal remedies.
Artifact checks require a clean package directory; `--manifest-only` supplies no
artifact evidence.

## Release notes

Read [the changelog](CHANGELOG.md#0390) before upgrading the package set.
