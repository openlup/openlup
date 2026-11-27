# Changelog history

Status: historical record, 2026-11-11.

Releases moved verbatim out of the packed `CHANGELOG.md`, which keeps the current release and the two previous ones.

## [1.1.0]

- Publishable on the npm `latest` dist-tag as `1.1.0`, from tag
  `openlup-core-v1.1.0`.

- docs: document the required owned-file migration from the 0.43.0 starter,
  using target-only snapshot entries and the existing installed upgrade CLI.
  The published 1.0.0 set did not pass exact-set qualification for starter
  upgrades and is superseded by 1.1.0; 1.1.0 qualification is recorded after
  publication. This migration guide changes no runtime or SQL.

Migration: Starter applications from 0.43.0 must add `owned/quote-shipping.ts`,
`owned/renewal-policy.ts` and `owned/catalogue.json` only to the target snapshot,
and migrate the contracts in `owned/store.config.ts`, `owned/quote-copy.ts`,
`owned/subscription-editing.ts` and `owned/catalogue.ts` before applying managed
files. Use the target extraction's bytes for pristine files; preserve local
values when adapting customized files. Follow the starter section in the
1.0.0 upgrade guide shipped with this set. Npm-only applications require no
owned-file migration. Starters targeting 1.1.0 also migrate
`owned/renewal.config.ts` with the required `subscriptionCare.retention`
mapping/default and the existing three-rung retry budget, as described in the
1.1.0 upgrade guide; this also applies when upgrading a 1.0.0 starter.

Align the current source starter and reader guidance with `MAX_CADENCE_DAYS`
(1..3660 whole days), removing the former starter database refusal above 90.
Applications continue to choose their offered cadences.

Migration: apply the matching platform package's complete native catalogue,
including `20261122190000_subscription_cadence_bound.sql`, before using longer
cadences. This change is unreleased. Checkout-command and saga-fallback replay
of stored cadence above 3660 can still quote before replay; that unreleased
development-data case remains a follow-up.

## [1.0.0]

- Preserve the experimental registry readiness code annotation in emitted declarations;
  the seven established readiness codes retain their stable contracts.

- Publishable on the npm `latest` dist-tag as `1.0.0`, from tag
  `openlup-core-v1.0.0`.
- Accept stable MAJOR.MINOR.PATCH package versions in readiness declarations;
  continue to refuse leading zeros and prerelease suffixes.

Label declaration occurrences as unverified public-import leads. Resolve the
selected application's reachable declared OpenLup packages and required Core
through Node's npm node_modules lookup, including workspace hoisting and linked
packages. Check selected versions against the owning npm lockfile and retain
application-only source scans. MCP reads accept only the selected package's
exact returned path and retain bounded ordinary-file and realpath checks.
Refuse Node package self-references instead of labelling checkout source as an
installed dependency.

Migration: no result fields or package exports change. Declaration hits do not
prove public imports; use the installed exports and examples. For hoisted npm
installs, use the installed-manifest executable recipe in the lookup README.

Add browser-safe exact catalogue quantities, canonical units, comparison and declared-unit conversion using decimal strings and BigInt. Inexact canonical values refuse without rounding.

Migration: additive exports on the existing catalog entry. Existing identifier schemas are unchanged. No database, subscription or capability change; target package set 0.44.0.

Add `cataloguePositionNetFromGross` and `allocateCatalogueDiscountedGrossTotals`
to the existing pricing subpath. They preserve the existing position arithmetic:
integer included-VAT net rounding and discount allocation by largest remainder,
with equal remainders resolved by input position.

Migration: These exports are additive and unbound. Existing quote arithmetic,
subscription agreements and independent invoice verification stay unchanged.
Callers explicitly compose the helpers with already validated position money
in one selected currency and preserve the original position order. The net
helper retains native integer-conversion errors; the allocator retains its
existing refusal messages. No data migration or activation is supplied.

- Mark unbound catalogue quantity, money and registry-observation symbols
  `@experimental`; retain the existing consumed quantity contract without the tag.

Migration: no runtime, signature or import change. The added TSDoc tags identify
experimental symbols for compatibility guidance.

Add opt-in catalogue definition/quantity/v1-draft checks, explicit refusal
fixtures and installed recipes with a copied stationery skeleton. Attribute/projection and combination fixtures reuse their owners; taxonomy, tax,
profile and promotion semantics remain explicitly pending.

Migration: Additive tooling for the next package set. Old imports and v1 canonical
bytes remain unchanged. The new Node-only `@openlup/platform/catalog/testing`
subpath and `openlup catalogue check --packs ./owned/catalogue.json --json` require
explicit JSON fixture text; the supplied file is never imported. No database migration, installation,
host wiring, publication or capability activation occurs. Upgrade all packages as
one exact set; an offline PASS is scoped evidence only.

Integrate attribute validation/projection and V2 combination owners into the
offline catalogue checker. Replace executable subjects with JSON text and the
copied executable skeleton with one static JSON fixture. Reference and refusal
observations are checked without invoking caller code; retained identities are
derived from fixture options and prove no persisted bytes or history.

Migration: For the unreleased 0.44.0 set, migrate module-based callers to
`await runCatalogExtensionConformance(JSON.stringify(subjectData))` and CLI files
to `openlup catalogue check --packs ./owned/catalogue.json --json`. Omit
`validateContent`; requested application content validation is unavailable (2).
Replace refusal callbacks with `observedCode` and `zeroEffects` records, reference
ports with resolution rows, and retained identity bytes with options. The single
entry retains report fields, deterministic ordering and the five CLI exits.
No SQL, publication, subscription changes or capability activation occurs.

Add optional inert catalogue registry observations to readiness, including the
`registry_missing_referenced_version` refusal for referenced type versions missing
from code or carrying a different digest.

Migration: additive `ReadinessInput.catalogRegistry` and `CatalogRegistryObservation`
exports on the existing readiness entry. Existing inputs keep their behaviour.
`complete: false` or a NULL installed definition digest yields existing `unknown`
readiness rather than treating hidden references as ready. The application owns observation and database identity; no boot hook, installer,
provider call or runtime activation is added. Target package set 0.44.0.

Document the unbound attribute owner beside the offline catalogue checker and
include its shared issue codes in the generated installed refusal-to-recipe links.
The recipe links include the per-slot UTF-8 text-index refusal
`attribute_projection_text_too_large`.
The checker retains its existing definitions, exact quantity and v1 draft scope;
attribute-value/projection integration remains pending.

Migration: documentation additions only. Existing APIs, strict v1 drafts and
checker exit/refusal behavior are unchanged. Owner availability and recipe links
grant no publication, serving or capability activation authority.

Declare per-subpath stable, experimental and test-support policies for the coherent 1.0.0 package set. Stable APIs follow SemVer with open unions and literal sets; symbols tagged `@experimental` remain outside the stable promise. Consumer evidence is explicitly first-party.

Migration: keep a default branch for unknown union and literal-set values. Check the generated maturity table for experimental and test-support subpaths before upgrading. No runtime behavior or package export changes.
- Allow intentional API snapshot updates with a new or modified package change fragment; retain changed `CHANGELOG.md` as a legacy route. Fragment contents are validated during release preparation.

Export `MAX_CADENCE_DAYS = 3660` from the existing browser-shareable
`@openlup/core/subscription` contract for fresh platform cadence admission.
The ten-year whole-day limit avoids the timestamp and settlement integer
overflows admitted by the former PostgreSQL integer maximum, with lateness margin.
Applications continue to own offered cadences.

Migration: fresh quotes, drafts and editor results above 3660 days now refuse.
Historical transport, stored data and completed receipts keep their integer
representation. Completed editor, native draft and renewal receipts replay before
current limits; replay above 3660 is not guaranteed on checkout-command or
saga-fallback paths that quote before replay. No released data can contain such
values: no published version admitted cadence above 120, and PR4a's widening is
unreleased. Existing SQL and starter guards still refuse above 90 pending a
separate migration.

## [0.43.0]

- Publishable on the npm `latest` dist-tag as `0.43.0`, from tag
  `openlup-core-v0.43.0`.

- Keep the shared fulfillment status facade and generated JSON neutral; provider dictionaries own translation. Canonical `packed` remains preferred and every historical display alias keeps its customer-step result.

Migration: shared status-map JSON no longer carries adapter trace columns. Consumers needing provider translation use adapter-owned dictionaries. Existing status tokens, ranks, effects and customer steps are unchanged.
## [0.42.0]

- Publishable on the npm `latest` dist-tag as `0.42.0`, from tag
  `openlup-core-v0.42.0`.

- Republish unchanged Core runtime, exports and SQL with the complete `0.42.0`
  package set. The reader guide adds the native payments upgrade notes.
## [0.41.0]

- Publishable on the npm `latest` dist-tag as `0.41.0`, from tag
  `openlup-core-v0.41.0`.

- Republish unchanged Core runtime, exports and SQL with the complete `0.41.0`
  package set. The reader guide lists Platform's new `./payments/testing` subpath.
## [0.40.0]

- Publishable on the npm `latest` dist-tag as `0.40.0`, from tag
  `openlup-core-v0.40.0`.

- @openlup/core size growth: The reader guide now ships under `docs/guide/` and is measured by its own `pack.guide` cap; the code and root documentation classes are unchanged.

- Register the platform-owned ecommerce-export and checkout-qualification event vocabulary. This adds no executor or handler and activates no provider; the host selects disjoint claim allowlists explicitly.

- Ship the reader guide under `docs/guide/`; start with `docs/guide/README.md`.
- Search the installed reader guide, package `AGENTS.md`, `README.md`, declarations and exports with `openlup-context` and its MCP tools. Upgrade questions also search `CHANGELOG.md`.
- Stop shipping the package-root `AGENT_CONTEXT.md` corpus. Result and JSON output shapes are unchanged; a hit's optional `owner` field is no longer set.
## [0.39.0]

- Publishable on the npm `latest` dist-tag as `0.39.0`, from tag
  `openlup-core-v0.39.0`.

- Republish unchanged Core runtime, exports and SQL with the complete `0.39.0`
  package set.
## [0.38.0]

- Publishable on the npm `latest` dist-tag as `0.38.0`, from tag
  `openlup-core-v0.38.0`.

Report bounded declaration and opt-in source scan coverage in `openlup-context` JSON, and show a notice when a scan reaches its file budget.

Migration: JSON consumers may receive an additive top-level `scans` array. Its conservative `limitReached` indicates the budget was reached, not that another eligible file exists; filters and other bounds still apply.

- Add opt-in `openlup-context mcp` stdio lookup for installed OpenLup context, with offline search and bounded installed-file reads. No kernel export or runtime dependency changes.

- Declare npm `keywords`, a `homepage` pointing at the package README in the
  source repository, and the issue tracker as `bugs`, so registry search and
  package pages lead to the documentation and to issue reports.

- Export `./package.json`, so tooling and agents can read the installed
  version and metadata with `import.meta.resolve("@openlup/core/package.json")` or
  a JSON import. It adds no code entry point.
## [0.37.0]

- Publishable on the npm `latest` dist-tag as `0.37.0`, from tag
  `openlup-core-v0.37.0`.

- Ship declaration maps that navigate to the packaged TypeScript sources,
  consumer-first installation guidance and release-tagged agent source citations.
- Allow Node `>=24` while
  retaining Node 24 for contributor verification. Pin exact package versions and
  upgrade the OpenLup set together.
- The tool-only installed context lookup accepts release citations only for its
  own package and installed version, and deduplicates shared canonical owners
  across the matching package set without fetching links.

- Recognize `commerce.settlement.settled`, already emitted by the platform settlement rail, in `PLATFORM_EVENT_VOCABULARY`. A known settlement fact without a registered consumer can remain pending without blocking a later paid receipt on the same order aggregate. This adds no handler, acknowledgement, delivery or SQL seed.

Migration:

Hosts using the complete vocabulary for readiness must supply an explicit owned `ignored` or `dormant` exemption for this type when they select no consumer. The claim allowlist still derives from handlers; readiness refusal for an unhandled, unexempted type is unchanged. No schema, grant or package-version change is needed in this source fix.
## [0.36.0]

- Publishable on the npm `latest` dist-tag as `0.36.0`, from tag
  `openlup-core-v0.36.0`.
## [0.35.0]

- Publishable on the npm `latest` dist-tag as `0.35.0`, from tag
  `openlup-core-v0.35.0`.
## [0.34.0]

- Publishable on the npm `latest` dist-tag as `0.34.0`, from tag
  `openlup-core-v0.34.0`.

- Republish with the complete `0.34.0` package set for Platform’s optional
  measurement consent policies. Core runtime, exports and SQL are unchanged.
## [0.33.0]

- Publishable on the npm `latest` dist-tag as `0.33.0`, from tag
  `openlup-core-v0.33.0`.

- Improve installed context results by separating nested Markdown sections,
  suppressing copied excerpts when their installed owner page is also found,
  and adding opt-in `--package-code` source search. The small generated context
  now includes migration, idempotency, provider-adapter and
  subscription/delivery owner routes.
## [0.32.0]

- Publishable on the npm `latest` dist-tag as `0.32.0`, from tag
  `openlup-core-v0.32.0`.

- Clarify that the payment retry-count helper enforces only its local numeric
  bound and does not establish retry permission or compliance; runtime behavior
  is unchanged.
- Add the Node-only `openlup-context` bin for offline lookup across installed
  package documentation. It returns source citations, supports JSON results and
  an optional bounded local code scan, and adds no runtime dependency. A root
  `AGENT_CONTEXT.md` packages excerpts of canonical guidance with source paths,
  line ranges and excerpt digests; check cited source before relying on them.
## [0.31.0]

- Publishable on the npm `latest` dist-tag as `0.31.0`, from tag
  `openlup-core-v0.31.0`.

## [0.30.0]

- Publishable on the npm `latest` dist-tag as `0.30.0`, from tag
  `openlup-core-v0.30.0`.

## [0.29.0]

- Publishable on the npm `latest` dist-tag as `0.29.0`, from tag
  `openlup-core-v0.29.0`.
## [0.28.0]

- Publishable on the npm `latest` dist-tag as `0.28.0`, from tag
  `openlup-core-v0.28.0`.

## [0.27.0]

- Publishable on the npm `latest` dist-tag as `0.27.0`, from tag
  `openlup-core-v0.27.0`.
## [0.26.0]

- Publishable on the npm `latest` dist-tag as `0.26.0`, from tag
  `openlup-core-v0.26.0`.
## [0.25.0]

- Publishable on the npm `latest` dist-tag as `0.25.0`, from tag
  `openlup-core-v0.25.0`.

- Keep active subscriptions unchanged when the retry ladder is exhausted; the compatibility function emits no pause event and retains historical paused-row recovery.

Migration notes: Exhaustion no longer changes an active subscription to paused. Existing paused records are not rewritten; explicit customer lifecycle commands and historical recovery remain separate.
## [0.24.0]

- Publishable on the npm `latest` dist-tag as `0.24.0`, from tag
  `openlup-core-v0.24.0`.

- Require Zod `^4.6.6` to fix GHSA-mrhx-c7xc-m3w5; oversized constrained
  collections fail before element validation accumulates errors. Public exports
  and accepted bounded inputs are unchanged.

- Republish the remaining APIs, runtime behavior and shipped SQL unchanged from `0.23.0`.

Migration: upgrade the complete set together for exact internal peers; core introduces no API or schema migration. The Zod floor above changes validation of oversized constrained collections.

### Known limitations

The fulfillment status map retains localized adopter labels; hosts still need injected labels or internationalization keys.
## [0.23.0]

- Publishable on the npm `latest` dist-tag as `0.23.0`, from tag
  `openlup-core-v0.23.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.22.0` as part of the complete `0.23.0` package set.

Migration: upgrade the complete set together for exact internal peers; core introduces no API or schema migration.

### Known limitations

The fulfillment status map retains localized adopter labels; hosts still need injected labels or internationalization keys.
## [0.22.0]

- Publishable on the npm `latest` dist-tag as `0.22.0`, from tag
  `openlup-core-v0.22.0`.

- Add pure fulfillment status, tracking-progress, current-parcel and canonical
  fact-parser helpers to the existing `./fulfillment` subpath. Generic fact types
  retain their names; narrowed fact aliases use the `Canonical` prefix. New
  fulfillment re-exports carry the same `@beta` annotation as existing facts.

Migration: existing platform fulfillment imports remain compatible re-exports;
no application import or schema migration is required.

### Known limitations

- `FULFILLMENT_STATUS_MAP` carries localized adopter labels. Replace them with host-injected labels or internationalization keys before any stable-framework claim.
## [0.21.0]

- Publishable on the npm `latest` dist-tag as `0.21.0`, from tag
  `openlup-core-v0.21.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.20.0` as part of the complete `0.21.0` package set.

Migration: upgrade the complete set together; core introduces no API or schema migration in this release.

## [0.20.0]

- Publishable on the npm `latest` dist-tag as `0.20.0`, from tag
  `openlup-core-v0.20.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.19.0` as part of the complete `0.20.0` package set.

Migration: upgrade the complete set together; core introduces no API or schema migration in this release.
## [0.19.0]

- Publishable on the npm `latest` dist-tag as `0.19.0`, from tag
  `openlup-core-v0.19.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.18.0` as part of the complete `0.19.0` package set.

Migration: upgrade the complete set together; core introduces no API or schema migration in this release.

## [0.18.0]

- Publishable on the npm `latest` dist-tag as `0.18.0`, from tag
  `openlup-core-v0.18.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL from `0.17.0` as
  part of the complete `0.18.0` package set.

Migration: upgrade the complete set together; core introduces no API or schema
migration in this release.

## [0.17.0]

- Publishable on the npm `latest` dist-tag as `0.17.0`, from tag
  `openlup-core-v0.17.0`.

- Republish unchanged APIs, runtime behavior and shipped SQL as part of the
  complete `0.17.0` package set.

Baseline evidence (2026-10-20): published `0.16.0` tarball 161,232 packed bytes,
SHA256 `48abf4ea8ddc446b8d6e2c610801e2cfcbe5575743bd5a61fbb8b8b50a2b36a3`.
The initial `0.16.0` release-gates baseline is retained under S1 option B.

## [0.16.0]

- Publishable on the npm `latest` dist-tag as `0.16.0`, from tag
  `openlup-core-v0.16.0`.

- Add optional logical module selection, dependency/entry contracts, module-qualified bindings and module diagnostics to experimental `./readiness`. Each selected module retains an independent schema requirement within one artifact.

Migration: additive API; existing manifests and loaded packages that omit module fields keep byte-identical readiness reports and binding keys. To opt an artifact in, observe `LoadedPackage.modules` and supply exactly one manifest `module` per selected id, with its logical kind, provided entries and in-artifact dependencies. Bind ports, triggers and routes as `package/module:id`; keep artifact kind/version and environment keys unchanged. Mixed modes, missing dependencies/entries and duplicate module/event/schedule/route ownership refuse using existing codes. Empty selections need no contributions; disabled modules need no bindings or schema probe. Inspect optional issue `module` when diagnosing module/schema failures. No release, publication or activation is performed by this change.

## [0.15.0]

- Publishable on the npm `latest` dist-tag as `0.15.0`, from tag
  `openlup-core-v0.15.0`.

- Republished unchanged.

## [0.14.0]

- Publishable on the npm `latest` dist-tag as `0.14.0`, from tag
  `openlup-core-v0.14.0`.

- Add experimental `buildGroupedPostgresSchemaProbe`, `decodeGroupedPostgresSchemaRows` and `PostgresSchemaCatalogEntry` on `./readiness` for one ordered, parameterized PostgreSQL catalog read with table, column and exact function-overload shapes. The strict decoder refuses incomplete or malformed rows without exposing catalog bodies.

Migration: additive API; existing scalar probes, observations, readiness codes and deadlines remain unchanged. Catalog rows use jsonb text, definition-string/null aggregates and raw pg_policy values; the decoder accepts text only. Hosts retain connection, snapshot, identity, digest and admission ownership. This preparation targets the 0.14.0 MINOR set; merging it does not publish packages.

## [0.13.1]

- Publishable on the npm `latest` dist-tag as `0.13.1`, from tag
  `openlup-core-v0.13.1`.

- Republish the unchanged core API and implementation with the repaired outbox publication as the complete `0.13.1` package set.

## [0.13.0]

- Publishable on the npm `latest` dist-tag as `0.13.0`, from tag
  `openlup-core-v0.13.0`.

- Add experimental outbox envelope/handler descriptors, structural validation, job lease and candidate readiness contracts.
- Check package inventory, event ownership/coverage, actual bindings and qualified schema observations before admitting a new candidate.

Migration: existing exports remain; compose the selected rail and bind its schema probe before activation. Unknown observations refuse the new candidate and do not stop a serving version.


### Changed

- `AGENTS.md` gains a required "Using this package in an application" section: do not edit or
  patch the installed package, change behaviour through its seams, and upgrade every
  `@openlup/*` package together. `docs:check` refuses a guide without it.

## [0.12.0]

### Removed

- **API REMOVAL: the `./checkout` subpath.** It held only an
  `Idempotency-Key` header-shape helper that no checkout path used.

  Migration: replace

  ```ts
  import { validateCheckoutIdempotencyHeader } from "@openlup/core/checkout";
  ```

  with an application-owned validator, or delete the call if, like the
  reference checkout, your checkout carries its idempotency key in the
  request body.

### Changed

- **BEHAVIOUR CHANGE for the subscription status matrix.** `cancelled` is no
  longer terminal: `cancelled -> active` is now an allowed edge. This is the
  owner win-back that the managed SQL guard
  `public.subscription_guard_status_transition` already admits. Only the new
  `reactivateSubscription` takes that edge. `resumeSubscription` still leaves
  `paused` only and still refuses a cancelled subscription. `completed` stays
  terminal. A caller that treated `cancelled` as final must now expect a
  reactivated subscription to renew again.
- **BEHAVIOUR CHANGE: an exhausted retry ladder now has a modelled outcome.** A
  renewal whose refusals ran past the last rung may pause an active
  subscription through `pauseSubscriptionForExpiredDunning`, which is the
  sanctioned non-payment rule. It is the only engine path that suspends a live
  subscription for a reason the owner did not choose. A ladder cut short by a
  terminating refusal class, or a failure that still has a retry after it, is
  refused as `dunning_not_exhausted` and leaves the subscription active.
  `recordPaymentFailure` is unchanged and still never touches the subscription.
- `SubscriptionEngineErrorCode` gains `missing_payment_method` and
  `dunning_not_exhausted`. An exhaustive `switch` over the union must handle
  both.

- `release-gates.json` sets `packageRelease.versionRule` to `0.N.P`. Below
  1.0 every `@openlup/*` package carries one set version: a minor set for any
  API, behaviour or schema change, a patch set for a fix only.

  Migration: a tool that reads `versionRule` expects the set rule. Before:
  `"versionRule": "0.<n>.0"`. After: `"versionRule": "0.N.P"`.

- Publishable on the npm `latest` dist-tag as `0.12.0`, from tag
  `openlup-core-v0.12.0`.
- Publishable on the npm `preview` dist-tag as `0.11.0`, for source preview
  `openlup-source-preview/11`.
- Publishable on the npm `preview` dist-tag as `0.10.0`, for source preview
  `openlup-source-preview/10`.
- Publishable on the npm `preview` dist-tag as `0.9.0`, for source preview
  `openlup-source-preview/9`.
- Publishable on the npm `preview` dist-tag as `0.7.0`, for source preview
  `openlup-source-preview/7`.
- Publishable on the npm `preview` dist-tag as `0.6.0`, for source preview
  `openlup-source-preview/6`. Directory `npm publish` stays refused.

- **BREAKING for `slugSchema`'s accepted language.** The `./catalog` schema no
  longer trims its input, so a slug with leading or trailing whitespace is now
  rejected rather than normalised and accepted, which is what the published
  `catalogSlugFormat` it tests against always described. A caller that relied on
  that normalisation must trim before validating.
- **BREAKING for the retry ladder's semantics.** `nextRetryAttemptAt` now
  TERMINATES past the end of the ladder instead of capping at its last slot: an
  attempt beyond the configured backoff length answers `null`, which is the pause
  signal, rather than repeating the final interval forever. The stored schedule
  this kernel mirrors has always terminated, so the two rails now agree; the
  previous capping behaviour meant a caller asking for attempt 4 (or 9) was told
  a fourth charge was scheduled when none was. Callers that guarded with
  `attempt <= maxRetryAttempts()` before calling should drop the guard — asking
  for the next slot IS the decision, and a second copy of the budget check is how
  the two rails drifted apart in the first place.

### Added

- `AGENTS.md` ships in the tarball. It states the package's kind and each
  subpath's maturity, gives one wiring example that compiles in CI, points to
  the shipped sources and declarations, and lists the readiness codes the
  package raises (none yet).
- `release-gates.json` schema 5 declares the package kind (`"kind": "kernel"`)
  and splits the pack budget. Code files (dist JavaScript, declarations and
  shipped sources) and root documentation and metadata files each have their
  own caps on packed bytes and files; the tarball total stays as a backstop.

  Migration: a tool that reads `release-gates.json` checks `schemaVersion: 5`.
  Before: `"pack": { "maxPackedBytes": …, "maxFiles": … }`. After: `"pack": {
  "code": { "maxPackedBytes": …, "maxFiles": … }, "docs": { … },
  "maxPackedBytes": …, "maxFiles": … }`.
- Add neutral checkout recovery evidence, method, operation and action contracts
  to the existing payment surface. They describe guidance only and do not change
  payment admission, renewal classification or enabled payment methods.
- Export neutral lookup normalization from `./company-identity` for extensions.

- `SUBSCRIPTION_STATUS_TRANSITIONS`, the frozen status matrix, and
  `canTransitionSubscriptionStatus` on `./subscription`. The matrix mirrors the
  managed SQL guard over the engine's four statuses, and a contract test
  enumerates every ordered pair.
- `reactivateSubscription`, the win-back from `cancelled`. It needs a stored
  payment method and restarts the schedule `RESTART_LEAD_DAYS` (two) days out,
  never earlier than the stored `nextCycleAt`.
- `isDunningLadderExhausted(cycle, cadence?)` on the retry ladder. It holds when
  a cycle is `payment_failed`, has nothing scheduled, and its attempt is past
  `maxRetryAttempts(cadence)`.
- `pauseSubscriptionForExpiredDunning` and
  `resumeSubscriptionFromExpiredDunning`. The resume is the customer's recovery
  from the non-payment pause: it takes an optional replacement method, skips the
  uncollected cycle, and restarts the schedule like a win-back.
- `recordPaymentFailure` takes an optional `cadence`, so a deployment ladder
  reaches the schedule and the exhaustion check alike. Callers that pass none
  keep the shipped ladder.
- `recordPaymentFailure` accepts an optional neutral `failureClass` and passes it
  to the canonical retry-ladder decision. Existing callers remain
  source-compatible. The shipped terminating-class set is exactly
  `["hard_do_not_retry"]`: that refusal gets no later rung, while every other
  class keeps the existing 24h/72h/168h schedule.
- Class-aware retry termination on `./subscription`.
  `CycleRetryCadence` gains an optional `terminatingFailureClasses`, the new
  `ladderTerminatedByClass(failureClass, cadence?)` answers whether the REASON
  for a refusal ends the ladder, and `nextRetryAttemptAt` / `shouldScheduleRetry`
  take an optional trailing `failureClass`. `DEFAULT_CYCLE_RETRY_CADENCE` ships
  only `hard_do_not_retry`. The predicate fails open for an absent or unlisted
  class, for a listed class the taxonomy does not recognise, and for a listed
  class that `failureClassDecision` still permits. Only explicit membership plus
  the taxonomy's existing refusal can end the ladder early.
- Injectable retry cadence on `./subscription`: `CycleRetryCadence` and the
  frozen `DEFAULT_CYCLE_RETRY_CADENCE` (24h/72h/168h). `nextRetryAttemptAt`,
  `shouldScheduleRetry` and `maxRetryAttempts` each take an optional cadence and
  default to the shipped one, so a deployment can publish its own ladder without
  forking the kernel and nothing changes for a caller that passes none.

- Pack budgets raised (packed 98 KiB -> 106 KiB, unpacked 448 KiB -> 480 KiB;
  file count unchanged at 186): the new allocation kernel ships as one source file
  plus its two build artifacts, and its adopter-facing JSDoc — the floor-clamp
  rule, the two-line split rationale and the failure-versus-throw split — is most
  of the added bytes. The docs are the deliverable, so the budget moves rather
  than the docs. Measured, not estimated: clean base packs 98532/446519/183 and
  this change packs 106488/475826/186.
- Experimental bundle target-price allocation on `./pricing`:
  `allocateBundleTargetPrice`, the pure kernel that turns ONE operator-set price
  for a composed bundle into exact per-component money. Largest-remainder
  (Hamilton) split weighted by each component's own reference subtotal, all in
  BigInt, ties broken by component code so output never depends on input order.
  Two rules bound it — a component never allocates below its minimum payable per
  unit (and a component priced under that minimum is held to its own reference
  price, because no floor may lift a component above what it is worth), and never
  above its reference unit price. A quantity whose allocated subtotal does not
  divide evenly emits TWO lines rather than a rounded unit price, so the
  `unitPrice x quantity === lineSubtotal` identity every quote line refines still
  holds. The single asserted invariant is that the emitted lines sum to the target
  exactly. Three refusals stay data rather than exceptions: nothing to weigh
  against, a target above the sum of the parts, and a target that cannot cover
  every minimum payable. No clock, no randomness, no I/O.
- Line-scoped `bundle` component in the pricing breakdown vocabulary, with an
  optional `bundle_allocated_discount_minor` on the line input: positive on the
  way in, emitted as one negative component, absent or zero emits nothing. It is
  line-scoped rather than order-scoped because a bundle prices a subset of the
  cart, and refunding one line must return exactly what that line was charged.
- Pack budgets raised (packed 90 KiB -> 94 KiB, unpacked 416 KiB -> 432 KiB,
  files 180 -> 186): one new kernel module ships as a source file plus its build
  artifacts and their maps, and its adopter-facing JSDoc is most of the added
  bytes. The docs are the deliverable, so the budget moves rather than the docs.
- Experimental payment-method lifecycle vocabulary on `./payment`: the five
  transitions a rail may report about a method it holds on file
  (`method_registered`, `method_updated`, `method_revoked`, `method_expired`,
  `method_suspended`), the neutral event an adapter translates its own event
  names into, and the three published facts (`schemeLabel`, `lastDigits`,
  `expiresAt`) a transition may carry — never the instrument number. Plus two
  pure helpers: `endsStoredMethodUsability`, the single place that answers
  whether a transition means the method can no longer back a charge (a rotation
  is not a death), and `expiryInstantFromMonthYear`, which pins the convention
  that a month-and-year validity runs to the LAST instant of that month in UTC.
  No rail is named and no clock, network or storage is read.
- Pack budgets raised (packed 88 KiB -> 90 KiB, unpacked 400 KiB -> 416 KiB): the provider-capability contracts
  add ~0.9 KiB of shipped declarations and their adopter-facing JSDoc; the
  docs are the deliverable, so the budget moves rather than the docs.
- (formatting) the block-reason alias is declared single-line so the
  generated declaration snapshot carries no trailing whitespace.
- Experimental payment-provider capability contracts on `./payment`: a
  descriptor an adapter publishes so renewal and dunning can decide from
  CAPABILITIES — whether stored consent evidence must be read and whether it
  is chargeable unattended, which provider flow an unattended charge uses,
  what payer context the request needs, and what a stored method must satisfy
  before a charge — plus a registry contract keyed by provider kind. Types
  only, with no provider named and no runtime consumer yet; branching on
  provider identity is unchanged.
- Experimental payment-failure taxonomy on `./payment`: a pure classifier that
  resolves a refusal into one of seven neutral classes from optional evidence
  (scheme retry advice, adopter-asserted neutral hints, an opaque decline code
  read through an adopter-supplied hint table, and the internal reason key),
  with a documented precedence order, a frozen per-class retry decision record,
  and a scheme retry ceiling helper pinned at 15 attempts per 30 days. The
  kernel embeds no acquirer code tables and has no runtime consumer yet; retry
  scheduling is unchanged.
- Experimental provider-neutral payment-decline evidence on `./payment`, with
  a provider code (never free-form prose) and retryability hint that lets
  adopters classify synchronous PSP refusals without persisting customer data.
  Extended with optional `declineCode` and `adviceCode`, so a refusal keeps the
  finer bank reason and the provider's retry recommendation — both codes, never
  messages — for a later classification policy to read. Extended again with
  optional `neutralReasonHints`, so an adapter can carry its OWN reading of a
  refusal — already translated out of its code vocabulary — and a classifier
  never has to learn which adapter refused.
- `PAYMENT_FAILURE_CLASSIFICATION_SOURCES` on `./payment`: the classification
  sources published as a value as well as a type, so a boundary schema can
  validate `decidedBy` against the kernel's own vocabulary instead of restating
  it. The type is unchanged and still derives from the same four members.
- Additive `evaluatePromotionAdjustmentsV2` API in the existing candidate
  `./promo` subpath. It chooses one best product and shipping adjustment,
  interprets product percentages as target-effective basis points against a
  trusted reference subtotal, and requires an adopter-defined product floor.
  The legacy evaluator and DB-shaped types remain unchanged for compatibility;
  downstream applications can adopt the package boundary before any separately
  flagged runtime cutover.
- Experimental `./fulfillment` normalized-fact contract with explicit schema,
  strict N/N-1 parsing, adopter-supplied canonical-status validation,
  discriminated provenance, application-minted evidence references, comparable
  provider ordinals, deterministic fingerprint/dedupe, and self-contained
  transition-conflict diagnostics with strict stream/decision validation.
- The then-current package identity and extracted-root governance evidence;
  this is historical evidence, not authorization for a separate repository or
  release channel.
- Package-local documentation and governance material for the portability
  boundary.
- Candidate and experimental maturity metadata for the package surface.

### Changed

- Marked candidate/experimental declarations `@beta` and testing-only
  declarations `@internal`, without changing package exports or runtime shapes.
  Removed the private `./testing` neutrality matcher after moving all packaged
  leak classes into the packed-artifact audit.
- Reclassified all declaration snapshots as private package-surface drift proof;
  this changes no exports, runtime behavior, dependencies, or publish refusal.
- Raised the reviewed packed/unpacked artifact ceilings by 4/16 KiB to admit
  the additive promo v2 declarations and implementation.
- Replaced public-surface and freeze language with the private package-surface
  inventory: 16 current exports have package smoke evidence but no public
  stability claim.

### Removed

- Removed the unused `./external-effects` API, implementation, snapshot, and
  self-conformance fixture before any public release. The application
  one-writer cleanup left no runtime consumer, so external-effect retry
  semantics stay adopter-owned instead of becoming a fourth core concern.

### Security

- Recorded the private vulnerability-reporting contact for this proof package.

## Release Status

Versions up to `0.11.0` were published on the npm `preview` dist-tag without
sections of their own, so the `0.12.0` section also lists the changes they
carried. A release-preparation pull request turns the Unreleased section into
the next version's section; its release tag and npm record when it is
published. No version establishes a stable package API or supported upgrade
channel.
