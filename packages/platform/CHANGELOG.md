# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Stable APIs follow SemVer from 1.0.0; experimental symbols and test-support
subpaths retain their declared limits. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [1.4.0]

- Publishable on the npm `latest` dist-tag as `1.4.0`, from tag
  `openlup-platform-v1.4.0`.

- @openlup/platform size growth: The native PostgreSQL catalogue adds migration forwards, and the package adds runtime and declarations for catalogue lifecycle, commerce destinations and new adapter subpaths.

Eleven acquisition and partner acquisition definer functions now pin `pg_temp` last on their search path.

Added `@openlup/platform/adapter-kit` (`experimental` rail) exporting shared zero-dependency provider adapter primitives: `createHardenedFetch`, `createOAuth2TokenManager`, `parseRetryAfter`, `createRetryAfterCooldown`, `verifyHmacSha256`, `verifyHardenedStandardWebhook`, and `verifyEd25519Signature`.

- Managed renewal reporting can classify prepared, acknowledged and settled payment attempts independently of the legacy cycle result.
- Managed operator support can opt into up to three attempts for rolled-back subscription actions and recovery commands on returned PostgreSQL `40P01`.
- Watchdog ledger adapters can batch up to four already-admitted alert observations over their existing store transition.

Adds partial indexes for active `public.outbox_events`
rows and consolidates `recordLabel` (`createPostgresFulfillmentShipmentSpinePort`)
and `upsertAddress` (`createPostgresCustomerSavedAddressPort`) into single-round-trip
atomic PostgreSQL RPCs (`public.fulfillment_record_label_atomic` and
`public.customer_saved_address_upsert_atomic`).

Migration: apply the two additive native forwards
`20261124100000_outbox_active_partial_indexes.sql` and
`20261124110000_shipment_label_and_address_upsert_atomic.sql` before deploying
the updated `@openlup/platform` package. Historical per-step idempotency keys are
preserved, and failed `upsertAddress` or `recordLabel` calls now roll back
atomically instead of leaving partial commits.

- Added the experimental `readPostgresCatalogActivationReadiness` catalogue export. It reads activation readiness for published SKUs after any in-flight publication; SQL decides price readiness and installed rules add other reasons afterwards.
- Apply the complete catalogue through `20261124140000_catalog_publication_readiness.sql` before calling the reader.

The governed offer membership reader adds a private `admission_issue` mode that returns authenticated issue evidence for one offer. Earlier modes, grants and the TypeScript reader are unchanged.

Native PostgreSQL installations retain and validate owner-stamped catalogue drafts and their companion rows. Connected-store restore refuses captures containing stamped drafts or their marked draft-created events. Governed checkout writes remain closed.

- Add opt-in native catalogue drafts v4 and governed publication readback v3. Withdrawal closes both fresh-sale channels while retaining SKU facts and offer memberships. A parent-only restore leaves its SKUs unavailable for fresh sales.
- Select governed drafts at genesis. A predecessor without certified lifecycle state needs explicit adoption. Archive is refused until the commerce barrier is available.

Migration: Install the complete native migration catalogue before composing the
v4 draft handler and store. Keep existing v3 compositions for previously
issued lineages. Consumers of the experimental publication result can branch on
`schemaVersion` to recover original v2 or governed v3 receipts.
Hosts should stop sending the removed experimental `CatalogPublicationEvidence.lifecycle.skus[].demandPolicyRef` field.

Use the experimental `catalogInternalGtin` export from `@openlup/platform/catalog`
to assign a store-local trade identifier to a SKU without a globally assigned GTIN.
Product JSON-LD omits 13-digit restricted-circulation numbers with prefixes
`02`, `04` and `20`–`29` from `gtin13`.

Native base and promoted legacy drafts take the same catalogue locks.
`public.catalog_admission_check_legacy_draft` ignores its last argument, so a
direct call with `false` or `NULL` now takes write-transaction row locks and
refuses in a read-only transaction with `25006`. A fresh promoted draft now
takes these locks before validating its money. Its `SHARE` lock waits while a
publication holds the catalogue fence. A wait that exceeds the caller's
`lock_timeout` returns `55P03`. After a completed wait at `READ COMMITTED`, a
draft whose demand the publication made governed returns `55000` before money
validation. At `REPEATABLE READ`, the stale product-row guard returns `40001`.
Only the publisher uses `NOWAIT`, and its fence returns `55P03` while a fresh
draft holds the lock. Exact replay and uncontended results are unchanged.

Migration: Apply the native forward
`20261125120000_catalog_legacy_draft_fixed_locks.sql`. It changes no grant,
table or TypeScript caller. Retry a `40001` draft in a new transaction.

### Readiness with verified native orders

Price Setup and Publish can evaluate readiness with verified native one-time orders, including undiscounted orders with free shipping, and activated initial subscription orders with standalone acquisition terms under offer policy v2. Both require direct sandbox capture and matching checkout evidence. A claim-bearing refusal can clear when you complete an eligible pending activation or restore a valid, unambiguous acquisition schedule with the same source definition. Other hard refusals clear only after the blocking order ages past the inclusive 24-hour window.

Migration: Apply the native forward `20261128010000_catalog_order_checkout_protection.sql`.

Native publication applies fresh basis-aware price edits atomically with issuance. Advisory assessment and dormant locked readback share the owner-only decision. Prepare wiring, its read-only snapshot, and runtime grants follow in a later change.

Issuance and locked readback require `READ COMMITTED READ WRITE`. A SKU gaining an effective selling mode or its first admitted offer requires a fresh edit.

The recorder checks receipts against the approved settlement context and locked price history. If a receipt's current entry changed or expired, reload the effective price and submit a fresh edit.

- Fresh native gross base-price edits require an inclusive price list. Use an effective inclusive list for v1 and replay previously completed edits with their original command keys. There is no application or configuration migration for existing gross lists.

- Added forward migration `20261124170000_catalog_publication_commit_perf.sql` building on `20261124160000_catalog_canonical_ascii_order.sql`: inlines leaf scalars, empty containers, and one level of flat pure-ASCII child objects in `public.catalog_publication_canonical(jsonb,integer)` while confining the numeric-overflow subtransaction to the number branch, and adds a single-pass fast path with `jsonb_path_query` fallback to `public.catalog_publication_carriers_valid(jsonb,uuid)`. Preserves canonical wire output, depth and prototype guards, carrier validation, and `search_path = pg_catalog, public, pg_temp`.
- Apply the platform migration catalog through `20261124170000_catalog_publication_commit_perf.sql`; no API or caller changes are required.

- Publish retains its readiness and dependency refusal codes. Known failures now include the readiness class as the subject, the `pricing.readiness` path and a fixed message with a repair and recheck. The starter HTTP response adds an issue and includes the class as `reason` for `publication_price_readiness`. Watchdog refusals can include approved failed-job names in the issue when matching run evidence is available. The documented fix text for `catalog_publication_price_readiness` now says to repair the reported issue and retry the same approved request while its draft and head still match, and the fix text for `publication_authority_unavailable` now asks the publication owner to verify the required authority and evidence before retrying.

- Added the experimental `readPostgresCatalogMembershipPage` catalogue export. It reads governed offer memberships and their sealed evidence using one caller-owned statement.
- Apply the complete catalogue through `20261124120000_catalog_publication_reads.sql` before calling the reader.

- Add the experimental `validateTypedSkuAmounts` contract and exact count,
  volume and independent gross diagnostics for a later typed publication path.
  Existing installation and publication continue on the gram path.

### Preserve accepted catalogue identity through commerce and transfer

Native owner transactions can retain accepted SKU references on orders, edits
and subscription templates. Renewals retain those references beside their
existing pricing snapshots. The archive census reports outstanding obligations
and incomplete evidence while archive remains unavailable.

Migration: connected-store restore admits only the target's current inventory.
An earlier capture or a source whose column was dropped or retyped is refused
with `schema_conflict`. The remedy is
`capture the source and restore it with the same OpenLup version on a pristine target of the same profile; upgrade the source within its installed profile first if it is older`.
If no such target can be provisioned, connected-store restore is unavailable for that pair.

### Add a bounded owner lock hook to the native admission fence

The catalogue testing fence accepts an optional `prelock` callback for owner
locks before receipt and catalogue acquisition. Read and authenticate replay
after the visibility probe. Confirmed contention, visibility changes and budget
expiry direct callers to retry with the same key. Infrastructure failures
direct callers to the native binding, connection, privileges and migrations.

On fence expiry the writer is discarded. The fence key is released within the
fence budget plus 50 ms plus two writer round trips. Writer latency delays
delivery of the timeout settings and the lock request. In the no-injected-latency
witness the bound is budget plus 50 ms.

When upgrading a call without a hook, pass an integer budget of 1 to
2147483647 milliseconds covering the whole pre-read phase. The fence snapshots
its input and options at entry. Update fake drivers and trace assertions for
guarded writer queries, timeout capture and restoration, and the probe's
remaining allowance. Handle the existing same-key retry and checklist hints
and the `40001` visibility refusal.

### Guard selected catalogue reads during checkout

The private native checkout fence holds catalogue, price and exact-client guards
through the transaction. Fresh governed purchases remain unavailable.

Native migration admission recognizes a later guarded checkout-owner EXECUTE grant for three issued catalogue routines. Both qualified PostgreSQL installers validate the host login and project its routine grants after the guarded unit commits.

Adds `openlup catalogue project --trusted-packs` for explicitly trusted local
catalogue modules. It projects deterministic JSON to an external scratch file and
runs one offline check with the registered content validators. Draft schemas
through v3 check supplied draft data and operation and price shape.
Finding pointers for v1 dimensions now resolve in the saved subject.

Migration: Existing `catalogue check --packs` invocations still read inert JSON.
Use the reported replay command to inspect the scratch subject without loading
application code. Installed rules, price execution and publication require
separate evidence.

### Handle typed catalogue definition install refusals

`installCatalogDefinitions` and `withCatalogPublicationRules` now report named
domain refusals as `CatalogDefinitionInstallError` from the experimental
`@openlup/platform/catalog` entry. Check the class and use its `code`, `path`,
`observed`, `causeText`, `fix` and `recheck` fields. Migrate catches that inspect
SQLSTATE, driver messages, DETAIL, the former SQL `issue` or publication
diagnostics. The operational isolation error propagates with its original
driver shape. Success signatures and the SQL install authority stay the same.

The installer checks the declaration and manifest before rules verification.
A declaration refusal now always includes the typed `issue` on
`invalid_catalog_pack`, including former bare install-only refusals. Call
`catalogPackInstallIssues` on a bound pack for these findings before writing.

- Catalogue conformance findings show the observed fixture value and report definition issues alongside fixture issues for valid types. Five new advisory codes flag publication and listing limitations without changing the report state or exit code.

Native migration admission recognizes one exact ledger-guarded `EXECUTE` grant for the subscription profile identity lookup. The definition and its `PUBLIC` revoke must already be issued in a hash-pinned native-store forward.

The catalogue publication refusal for non-mass net content now directs authors
to enter the net mass in whole grams and use a quantity variant option for a
labelled volume or count.

The offline catalogue checker names the Prepare codes in its advisories for
missing unit identifiers, legacy draft versions, and non-mass net content.

Catalogue conformance redacts path-like strings and keys in Observed previews.
A pack with findings in its own definition skips fixture evaluation and
trusted validation. If the pack supplies fixtures, the checker reports one
skip advisory. A cross-pack duplicate identity alone still allows fixtures and
trusted validators to run. Fix the local definition findings, then rerun the
same check.

- Qualified-v2 installations can use the catalogue publication login to read governed offer memberships and activation readiness. Apply the complete catalogue through `20261124180000_catalogue_read_grant.sql`. Where provisioned, `service_role` remains supported.

### Add native catalogue purchase admission

The native base and promoted draft owners refuse fresh governed demand with
`catalog_admission_quote_authority_required`. Existing legacy purchase and
authenticated draft replay stay available. Install the complete native
catalogue for the matching runtime. The experimental catalogue assertion
and `quoteDigest` helper check owner evidence. No governed purchase entry
is enabled.

- With `buildCatalogReleaseDraftV3`, publish release, price SKUs, then activate.

- Use `openlup catalogue schema --json` to inspect the installed catalogue authoring schemas, units, limits, caps and refusal fixes. The formatVersion 1 report supports additive changes.

- Added experimental `readPostgresCatalogStorefrontPage` to `@openlup/platform/catalog` for displaying published offer SKUs with current prices. Checkout continues to resolve its own prices.

Declare each variant option once with the experimental `catalogVariantOptions`
helper in `@openlup/platform/catalog`. The offline checker reports the actual
fixture locations for combination issues and advises on unmatched variant
attributes and Platform version ranges.

Migration: Check pack definitions before upgrading. Definition admission,
including registry construction and definition digest calculation, now refuses
axes with mismatched declarations or repeated attribute assignments. This
includes declarations with overlapping choice IDs or units. For example, an
axis with `[a,b]` on its dimension and `[a,c]` on its attribute previously
accepted `a` as an individual option. This release cannot register an installed
type version with either issue. There is no in-place migration. A corrected
new version still leaves the upgrade blocked while the affected version stays
composed. If your pack is affected, stay on the previous release.

### Let the runtime evaluate the checkout abandonment predicate

A forward adds `public.commerce_checkout_abandonment_safe_runtime(uuid)`, which
returns the unchanged `public.commerce_initial_checkout_abandonment_safe(uuid)`
predicate and is executable by `service_role` where that role exists. A
qualified runtime login can then check whether an unpaid initial checkout is
safe to cancel before it asks for the cancellation. The predicate itself keeps
its definition and ACL; PUBLIC, `anon` and `authenticated` cannot execute
either function. Apply the forward with the rest of the catalogue; it needs no
operator action.

- The checkout-attempt migration provides private PostgreSQL admission storage. Native connected-store transfer and the experimental `/portability` utility can preserve the attempt digests and timestamps.

Qualified PostgreSQL installations can record an issued checkout-owner grant while the login is absent. The experimental `applyPlatformCheckoutOwnerGrant` operation lets the definition owner apply it later. Verified checkout permissions are local to the database and leave its canonical inventory unchanged for connected-store restore.

Migration: Ordinary qualified upgrades need no checkout login. Use the [database upgrade handoff](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/DATA_AND_MIGRATIONS.md#closed-native-store-forwards) to prepare the role, preserve TEMP access and verify the grants on a supported opt-in installation.

### Opt in to native quote composition

The experimental commerce server quote port binds an owned destination, a resolved pricing plan, installed payment limits and the host's native privacy registry. A physical delivery can return `destination_contact_incomplete` at `/destination/contact`. Collect the recipient name and phone, then issue a new destination snapshot. Exclusive recovery verifies the owned destination and its cutoff before reading pinned coverage history. Existing installations can continue using their current quote binding.

- Add experimental native PostgreSQL payment limits with owner installation, revisioned rollback and a restricted active reader.
- Discover `commerce.money_limits.v2` offline. Connected show requires an owner inspection binding and returns `money_limits_reader_unbound` when that binding is absent.

Migration: Apply the native PostgreSQL forward during the normal upgrade. Existing checkout requires no settings changes. To opt in to installed limits, install terms for a qualified rail and bind owner inspection in the settings app.

Published `@openlup/platform/communications/testing` with `runCommunicationsAdapterConformance` (`mode: "full"` egress-admission, canary scanning, and authenticated scripted transport fault certification), `createScriptedCommunicationsFake`, `ScriptedCommunicationsTransportError`, and `createInMemoryEmailTransport`, while keeping `@openlup/platform/communications` backwards-compatible.

Migration: No adopter action is required. `@openlup/platform/communications` continues to export `runCommunicationsAdapterConformance` with backwards-compatible runtime and type signatures (additive optional options and fields); only the internal declaration file relocated from `dist/communications/testing/adapterConformance.d.ts` to `dist/communications/adapterConformance.d.ts`.

- Quote acceptance verifies bounded, canonical v1 envelopes. Existing issuers
  retain their signing bytes and key rotation behavior. Refresh a quote to
  replace a malformed acceptance token.

Conformance finding paths now encode a dotted SKU id as a single escaped token; earlier releases split it at dots.

Seventeen channel and customer self-service definer functions now pin `pg_temp` last on their search path.

Adds JSDoc `@deprecated` notices to legacy 1.x
surfaces scheduled for removal or simplification in 2.0.0: the 11 experimental
payment reference-support exports under provider payment subpaths, the
7-generic `RenewalCyclePolicy` interface, `createFulfillmentCommandLedger`, and
the legacy hosted-bundle default in `DEFAULT_PLATFORM_BUNDLE`.

Migration: no runtime or type changes in 1.x. Existing 1.x replacements
(`PaymentAdapter` / `PaymentProviderRegistry` from `@openlup/platform/payments/contracts`,
`createPaymentProviderRegistry` from `@openlup/platform/payments`,
`createDefaultRenewalCyclePolicy`, `createPostgresFulfillmentDispatchStore`,
and explicit `PLATFORM_BUNDLE`) are already available in 1.x.

Subscriptions bought at a derived price keep their price-list context after
the base price is replaced.

Migration: Apply the derived-subscription-price retired-base forward through
the selected native migration catalogue.

- Preserve the price-list context for purchases that use the derived subscription pricing policy. Subscription editing and starter-offer graduation can use the context after checkout and renewal.

### Validate checkout destination addresses with a host policy

- Use the experimental checkout schema and address policy to admit subdivision,
  normalize postal codes and classify destinations. Discover native issuance
  readiness with `destinationV2Capabilities` and find the host binding through
  the read-only `shipping.addressPolicy` setting. Managed v2 issuance and v2
  saved addresses report unsupported. Existing v1 checkout commands retain
  their address contract.

### Store native checkout destination snapshots

Native installations can retain and verify scoped checkout snapshots with a
24-hour database cutoff. The new experimental identity factories compose
private document and receipt export and erasure with the existing privacy
registry. Connected-store transfer carries the snapshots and current
selections. Checkout issuance remains dormant.

### Experimental native destination port

Native hosts can use `createPostgresDestinationPortV2` on the destinations
server subpath with their own executor. It supports retained reads, exact replay,
rechecks and order binding while preserving the native owner's decisions.
Fresh issuance remains disabled in the host and starter.

### Retain native order destination evidence

Native order and shipment reads use the original verified destination binding.
Privacy erasure clears sealed checkout pins. Checkout issuance remains dormant.

Migration: Apply `20261125130000_commerce_destination_v2_order_bindings.sql`.

### Preserve destination receipt replay and privacy

The native migration adds private destination receipts with a scoped replay key
and an audit record. The native privacy contributor exports subject evidence
and erases its payload while retaining the replay tombstone. Connected-store
capture and restore carry both dispositions. Fresh destination issuance remains
unavailable until its owner is installed.

### Handle native destination snapshot and read refusals

- Check for `outcome: "refused"` in the returned JSON before handling success.
  Roll back any caller-owned snapshot transaction before returning a refusal.
  Direct receipt routines retain their SQL diagnostics.

### Native tax evaluation privacy

Native stores can transfer evaluation rows and compose their privacy obligations.
PostgreSQL refuses a new erasure receipt that lacks `tax-calculations` with
the message `PRIVACY_CONTRIBUTOR_MISSING` and SQLSTATE `55000`. If a guarded
native handler reaches this insert refusal, it returns HTTP 503 with
`PRIVACY_ASSESSMENT_UNAVAILABLE` and the native prerequisite facts.

Migration: Apply the native catalogue that declares `tax-calculations`. Add
`createTaxCalculationPrivacyContributor()` from `@openlup/platform/identity`
to every serving native privacy registry as described in **Export and erasure**
in the **Personal data** guide. Retry the original erasure request after rollout.

Add the experimental `@openlup/platform/tax/stripe` adapter for exclusive tax
quotes and qualified fee-free reporting. Applications supply an account-bound
client, a versioned market pack and read-only callbacks for reporting evidence.
Use `tax.adapter` and `tax.classMap` to discover composition and class mapping.
The tax port also adds a recalculation-probe capability and a comparison helper.

Use `makeStripeTaxRequestDigest` with `StripeTaxRequestBinding` and
`StripeTaxCaptureBinding` to bind the reservation before dispatch. Commit requires
the accepted evidence's `providerLines`, including merchandise lines without tax
assessments. The experimental verifiers check integrity first and give a fixed
remedy and a JSON Pointer for each refusal.

Adds experimental tax calculation contracts, strict document decoding, quote
request preparation and merchant coverage reconciliation.

On the native rail, `public.fulfillment_advance_shipment`
acquires the parent `public.subscriptions` row lock before locking
`public.fulfillment_shipments`, matching the canonical delivery-alignment lock
order (`subscriptions` -> `fulfillment_shipments` -> `subscription_delivery_alignment_cases`)
and preventing `40P01` deadlocks against concurrent renewal admission.

Migration: apply the additive native forward
`20261124090000_fulfillment_advance_shipment_lock_order.sql`. No data rewrite,
privilege change, or TypeScript caller change is required.

### Fence legacy dispatch for destination v2

On native installations, legacy provider-command polling skips parcels bound to destination v2.
Fresh enqueue and submission for those parcels return `destination_adapter_unsupported`.
Use the qualified native dispatch workflow for the original order.
Existing command replay and reconciliation remain available. Upgrades require no operator action.

Installer-owned `public` functions that pin a search path now list `pg_temp` last on every profile. Only the search path changes.

- Install and inspect append-only tax coverage on qualified native PostgreSQL.
  Use the migration-owner installer to record a revision and bind the runtime
  settings reader to the intended installation and account. Connected owner
  transfer preserves the full revision history.

- `readInvoicePaymentEvidence` reports a payment identity refusal from `@openlup/platform/payments/stripe`, `@openlup/platform/payments/tpay`, or a custom reader throwing `PaymentReadbackIdentityMismatch` as `providerStatus: "unknown"` with `providerEvidence.unavailableReason: "provider_payment_identity_mismatch"`.
- If your invoice flow can issue during a provider outage, block issuance on `provider_payment_identity_mismatch`. Outages still report `provider_read_failed`.

Native PostgreSQL job finishes return `false` when the submitted run is no
longer current. The finish marks its own running row `skipped` with
`job_lease_lost` and empty result metadata. Duplicate finishes preserve the
first terminal result.

Migration: Apply the pending forward through the selected native catalogue or
through the existing application migration chain that consumes
`JOB_RUN_LEDGER_MIGRATIONS`. Pre-upgrade checkpoints remain historical records
eligible for selection. The resume guarantee applies to checkpoints written
under the fence.

- Updated `OMS_OPERATIONAL_LADDER` `missing_shipping_address` `sqlPredicate` to `shipping_address_id IS NULL` to match the optimized managed `commerce_oms_admin_list_queue` forward migration.
  If you mirror or byte-seal the `missing_shipping_address` predicate, refresh your copy to `shipping_address_id IS NULL` when you apply the matching managed `commerce_oms_admin_list_queue` forward.

Eliminated a redundant full-catalog SQL read and SHA-256 hash pass in `platformRunner` (`readMigrations` + `readManifest`) and removed redundant re-locking and double `LEDGER_IDENTITY` probes on forward units already holding `SHARE ROW EXCLUSIVE` in `postgresRunner`.

Migration: PUBLIC loses EXECUTE on the base activation entry and commit. Run activation with the qualified runtime login (inherits `service_role`) or the owner login. Custom roles are unsupported because the runner pins function ACLs and qualified installs refuse outside grants. See [operator guidance](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/docs/platform/DATA_AND_MIGRATIONS.md#native-activation-execute-grants).

- Native acquisition checkout now checks the nested starter marker's second-delivery discount against the selected acquisition terms.

- Native checkout now accepts a subscription quote whose derived price matches
  the effective catalogue base and policy. Generate a fresh server quote and
  retry if the pricing evidence changed.
- This fix adds no refusal code, export or setting. Quotes without
  derived-policy evidence keep the existing price lookup.

Migration: Apply `20261128000000_native_derived_subscription_price.sql` through
the selected native migration catalogue.

### Retry failed fulfillment polling pages

When an item fails, native fulfillment polling keeps the page for the next
acquired polling tick. After three consecutive failures on the same page,
polling advances and records the operator remedy in the failed job run.

### Native erasure receipt coverage

Native erasure retries verify required coverage before returning the original
receipt. An uncovered receipt returns HTTP 503 (`UPSTREAM_UNAVAILABLE`) with
`PRIVACY_RECEIPT_COVERAGE_INCOMPLETE` in `error.details.privacyCode` and these
facts in `error.details`. Here `<owners>` lists the required contributor IDs
with missing coverage, separated by commas.

- `observed` — A prior erasure is missing recorded coverage for the required owners (`<owners>`).
- `cause` — The original receipt and verified owner approvals do not establish their local disposition.
- `fix` — Ask the data privacy owner and contributor owners to reconcile the missing coverage against the original receipt.
- `recheck` — Retry the original erasure request after reconciliation.

Migration: Forward `findErasureReplay` on the held transaction in native store
wrappers, returning the original receipt and its covered contributor IDs.
Update strict clients to accept the coverage refusal and its four facts. Run
`reconcilePostgresPrivacyErasure` in an owner session for each missing contributor
with verified approval for the original receipt, as described in **Reconcile
coverage of a native erasure receipt** in the **Personal data** guide. Retry the
original subject and idempotency key once coverage is complete. Follow
**Rehearse native privacy cutover for each store** before reopening native
privacy traffic.

### Native privacy contributor declaration

Native export and erasure check the installed declaration before processing the
subject. The handler returns HTTP 503 (`UPSTREAM_UNAVAILABLE`) with the refusal
code in `error.details.privacyCode` and four facts in `error.details`.

For `PRIVACY_CONTRIBUTOR_MISSING`, `<owners>` is the comma-separated list of
missing installed contributor IDs.

- `observed` — Required installed owners are absent (`<owners>`).
- `cause` — The installed declaration requires those owners.
- `fix` — Register their working owner ports in the serving composition.
- `recheck` — Retry the original request after rollout.

An unavailable or invalid declaration returns `PRIVACY_ASSESSMENT_UNAVAILABLE`.

- `observed` — Native privacy prerequisites could not be verified.
- `cause` — The native store or its installed declaration or receipt evidence is unavailable or invalid.
- `fix` — Check the native handler and store binding, driver, connection and
  TLS, and CONNECT, schema USAGE and EXECUTE privileges. Ask the installation
  owner to recover the exact declared catalogue and its approved migration
  history or the original verified receipt evidence, as applicable.
- `recheck` — Retry the original request.

Migration: Apply the complete native catalogue for the installation profile.
Declare each new required contributor ID in the ordered migration for its
owner feature. Register every installed contributor in the serving registry.
Forward `readRequiredContributorIds` on the held transaction in native store
wrappers. Update strict clients to accept both codes and all four facts. Follow
**Upgrade native privacy operations** in the **Personal data** guide for
handler binding and cutover.

Adds an optional 3-rung `p_cadence` parameter
(`{"backoffHours":[h1,h2,h3]}`) to `public.payment_provider_result_apply`
(forward `20261124150000_native_provider_retry_cadence.sql`) and optional
`retryCadence?: { readonly backoffHours: readonly number[] }` to
`PostgresPaymentTruthOptions` (`createPostgresProviderPaymentControlPort`),
bringing provider-recorded renewal failure timing into parity with
`subscription_retry_apply_failure` while preserving default `[24, 72, 168]`
timing, immutable receipt replay, and the 3-rung (`retry_attempt >= 4`)
exhaustion invariant.

Migration: Apply `20261124150000_native_provider_retry_cadence.sql` before
passing `retryCadence` to `createPostgresProviderPaymentControlPort`. Existing
callers that omit `retryCadence` continue invoking the 11-argument overload with
default `[24, 72, 168]` hours.

Adds an optional bounded `concurrency` option
(default `1`, max `16`) to `runRenewalBatchRows` and
`createNativeSubscriptionBinding` in `@openlup/platform/subscriptions` so hosts
can overlap provider RTT across normal due renewals within a batch while
preserving deterministic result ordering, per-row error isolation, `55P03`
busy omission, and monotonic cycle advancement.

Migration: No action required. Existing callers keep sequential `concurrency: 1`
execution by default. Passing `concurrency > 1` to
`createNativeSubscriptionBinding` requires a pool-backed executor and fails
closed with `subscription_renewal_concurrency_requires_pool` if given a single
`PoolClient`.

Settings-only reviewed forwards may pin search paths of `acquisition_private` functions and `auth.uid()` installed by OpenLup.
The remaining OpenLup-installed functions now pin `pg_temp` last in `search_path`.

### Plan and validate commerce quote money offline

- Use the experimental pricing functions to rank resolved promotion and delivery
  alternatives, compose the winning money with tax evidence and check a v2
  quote's digests and totals. Shared quote and order types are available from
  the pricing and commerce contracts entries.

Add the experimental `openlup recipe scaffold --domain <domain> --provider <slug> [--dest <dir>] [--force] [--verify] [--json]` subcommand to `@openlup/platform`'s `openlup` CLI for generating schema-valid, recipe-contract-isolated starter provider recipes across all eight supported adapter domains.

Added the experimental Agent-DX `openlup recipe list|show|add|verify` CLI subcommands to the `openlup` bin (`packages/platform/src/lifecycle/openlup.mjs` and `packages/platform/src/lifecycle/recipeCli.mjs`) for discovering, inspecting, copying into `owned/adapters/<domain>/<provider>` with provenance tracking, and offline-verifying (manifest parity, recipe-contract static isolation, `@openlup/platform` SemVer compatibility, and Stages 1–3 Vitest conformance/mount-proof suites) provider recipes.

Migration: Additive CLI subcommand under the existing `openlup` binary; no breaking changes for existing `openlup upgrade`, `verify`, `catalogue`, or `settings` invocations.

### Parcel contact privacy coverage

The `fulfillment-parcel-contacts` contributor advances from `fulfillment.parcel-contacts.v2` to `fulfillment.parcel-contacts.v3`. Its export coverage now explicitly includes parcel contacts projected from retained destination bindings. The existing export shape and contact erasure also cover those parcels.

Native migration admission allows one exact slot that adds a nullable receipt reference and widens the subscription quote preview acceptance CHECK to allow receipt-backed no-ops. The admission requires the issued CHECK preimage and keeps both existing acceptance states valid.

- Added the reserved nullable `price_lists.amount_basis` column with the `price_lists_basis_check` constraint (`tax_inclusive` or `tax_exclusive`). `NULL` keeps the legacy gross basis; no released path reads or writes the column yet.

On the native rail, closed-from-open provenance can
only be set by a guarded close or a native restore.

Migration: apply the additive native forward with the matching connected-store
restore implementation. Existing readers can continue to verify stored policy
tuples. No data rewrite is needed. Use the updated restore implementation for
targets that have applied the forward. An earlier restore implementation
refuses the new INSERT trigger.

Migration: `CATALOG_MIGRATIONS` gains `20261123192000_subscription_price_policy_close_provenance` as its last entry. Code that pins the registry's length or index positions must stop doing so.

Managed divergence design: a managed twin could add the same INSERT guard to
the policy revision table and use a transaction-keyed capability table with
RLS. A trusted restore role could hold the narrow table grants and policies
needed to restore and clear the capability in one transaction. Ordinary
writers would have no capability privileges. The managed rail does not supply
this feature.

`@openlup/platform/pricing/browser` also exports `acquisitionTermsSchema` and `deriveSubscriptionUnitPrice`, the same objects as on `@openlup/platform/pricing`. Browser code should import them from the browser entry. `deriveSubscriptionUnitPrice` is a display estimate; the quote is the amount charged. The module that defines it sets zod to `jitless`, as the server entry does. Tree-shaken production bundles that import only the entry's earlier symbols do not contain that call. Evaluating the whole entry applies the setting, which changes no parse result; that covers dev pre-bundling, unbundled ESM and Node.

- Added experimental `projectPublishedCatalogOfferPage` and `PublishedCatalogOfferPage` to `@openlup/platform/catalog`. The projection carries public presentation, filters attributes against exact installed definition evidence and flags primary identifiers for local use. The raw storefront read distinguishes an unpublished offer with a typed issue.

Native migration admission allows one exact grant of the two catalogue read entry points to the qualified-v2 catalogue publication login when the local migration ledger records the applied authority migration.

Native migration admission allows one exact ledger-guarded `SELECT (amount_basis)` grant on `public.price_lists` to the qualified-v2 catalogue publication login in a dedicated grant-only slot. The column and any basis CHECK must first be issued in an earlier hash-pinned native-store forward.

Native migration admission allows one exact guarded `EXECUTE` grant to the qualified-v2 catalogue publication login for the two price setup wrappers. Both definitions must already be issued in earlier native slots with matching file and definition hashes.

### Bind acceptance to a final v2 quote

- Use experimental server helpers to issue and verify quote acceptance tokens
  bound to a final quote and its all-in presentation, including applicable fees.

The `openlup recipe` messages now name the provider recipe contract instead of an internal decision-record number; the rules are unchanged. The contract is documented in the platform architecture documentation, and the reader guide's provider recipe page summarizes it.

Migration: None; only message wording changed.

- The native schema adds an owner-only renewal destination writer and classifier. The writer has no production caller. Retained order and shipment reads verify renewal documents at their issued scope and use the order's preparation to verify the binding and service.
  Use `documentPurpose` to narrow `DestinationVerifiedReadV2`. Subscription documents return `"subscription"` with null expiry. Checkout documents keep their timestamp, including when inherited by a renewal.
  When retained renewal coordinates differ, recover the original binding from the order's preparation through the authorized order workflow.

Add `memoizeCommerceQuoteCatalogReads` to share one catalog authority read across an offer projection and its quotes.

Migration: Existing callers can retain their current composition. To opt in, create one wrapper per request and pass it to the projection and its quote ports.

Breaking change from Platform 1.3.0. When `cron` is supplied on a `node-cron`
bundle, `createNodeHost().serveNode` defaults to `lockMode: "cluster"`.
Cluster mode refuses with `OPENLUP_E_SCHEDULER_CLUSTER_LOCK_REQUIRED`
before registering timers unless the resolved `AdvisoryLock` declares
`durability: "cluster"`.
Direct `createNodeScheduler` calls default to `lockMode: "process"`.

Migration: Supply a session-affine `AdvisoryLock` declaring `durability: "cluster"` as `advisoryLock`, or set `lockMode: "process"` for an intentional single-instance host whose scheduler profile permits it.

Adds experimental stock-wait reads for operators, operational evidence, and
owned customer accounts. Operators can page through cases, see complete shortage
totals, and distinguish recorded payments from missing intent evidence. The
health check uses current shortage, check time, and persisted notice progress.

Migration: No database changes are required. Bind the server-side reader to
the native or managed subscription graph with a request-authorized executor
that opens one read-only repeatable-read transaction per invocation.

### Compare selected catalogue quotes under the checkout fence

The comparator verifies the issue evidence. Fresh governed purchases remain unavailable.

### Add callback entries and single-row installed policy readers

Added eight `callback` entries (`checkout.offerAdmission`, `shipping.rateResolver`,
`subscriptions.afterRenewal`, `subscriptions.editTermsAdmission`,
`subscriptions.lifecycleCommandAdmission`, `pricing.acquisitionFinancialPolicy`,
`subscriptions.sizedPortionProposal`, `bundles.compositionRules`) and three
`installed` policy entries (`subscription_minimum_base_units`,
`subscription_sized_intro_phase`, `shipping_flat_minor`) to the packaged settings
catalogue, with built-in SQL readers wired in `openlup settings`.

### Point settings catalogue cap and invariant entries to domain guides

Replaced all 47 self-referencing `settings-catalogue.md` links on `cap` and
`invariant` entries with direct links to their owning reader-guide pages.

### Include configuration error details in settings check

When app loading or startup validation fails, `settings check` appends
the error's nonempty, single-line string cause in parentheses when it has at
most 300 characters and contains no control characters. This lets startup
assertions identify which field to edit.

### Improve settings CLI and MCP diagnostics and live-edit reloading

`openlup settings mcp` now runs each tool invocation in a fresh child process
with stdout/console redirected to stderr so on-disk application configuration
edits take effect immediately without restarting the MCP server. Added per-command
`--help` (including `check`, `preview`, and `mcp`), optional `appBindingWarning`
and `partialMatch` fields on `list`, rule `messages` on invalid `check` rows,
distinct remediation when no connected reader is registered, `Default: none`
text formatting, full `preview` input validation before app-key `unsupported`
refusals, and `checkout` search synonyms.

### Clarify `commerce.manualHoldReasons` fixed vocabulary

Updated the `commerce.manualHoldReasons` catalogue entry to state that native
order controls enforce a fixed six-reason hold vocabulary (`payment_not_succeeded`,
`inventory_review`, `risk_review`, `address_review`, `fulfillment_exception`,
`manual_support`) rather than a single manual hold reason.

### Discover fiscal profile inputs in the settings catalogue

Use `show market.fiscalProfile --json` with the starter's settings script to
find the existing fiscal country, tax category, VAT rate, and legal basis
inputs, including how blank values fall back and which inputs the reader refuses.

### Add packaged code settings and multi-row installed readers

Added five packaged `code` settings to the settings catalogue
(`checkout.resumeWindowMinutes`, `inventory.offerLowStockThreshold`,
`catalog.bundleAvailabilityPolicy`, `market.settlementProfile`,
`communications.terminalPayloadRetentionDays`) along with runtime numeric
validation for `resumeWindowMinutes` and `lowStockThreshold` options. Added
multi-row `installed` entries (`pricing.subscriptionPricePolicy`,
`communications.nativeDeliveryControls`) with aggregate SQL readers in
`openlup settings`.

- Settings preview recognizes application settings declared by the selected app and points to `show` and `check` when a preview is unavailable. This refusal is also returned by the settings MCP tool.
- When a settings goal matches no entries, text output suggests changing or omitting the goal.

### Install method expiry warning and promotion claim hold policies

Added `installed` policy entries `payment_method_expiry_warning_days` (default
`30` days, `1..365`) and `promotion_claim_hold_hours` (default `24` hours,
`1..720`) to the packaged settings catalogue, wired their SQL readers in
`openlup settings`, and exported experimental SQL-parity validation, install,
and read helpers from `@openlup/platform/payments` and
`@openlup/platform/promotions`.

Migration: Platform SQL migration
`20261126010000_settings_wave1_method_expiry_and_claim_hold.sql` installs strict
JSONB validators and fail-closed `commerce_settings` readers for both policies,
and updates `public.subscription_method_health_read(uuid)` and
`public.commerce_create_promoted_order_draft_with_outbox(text,jsonb,jsonb,uuid)`
to read the installed thresholds with unchanged 30-day and 24-hour absence
fallbacks and fail-closed `22023` refusals on malformed rows.

### Install subscription retry schedule and payment decline notice timing policies

Promoted `subscriptions.retrySchedule` (`subscription_retry_schedule`, default
`[24, 72, 168]` hours, strictly 3 positive integers `1..2147483647`) and
`payments.declineNoticeTiming` (`payment_decline_notice_timing`, default
`delayMinutes: 3` (`0..1440`) and `linkLifetimeHours: 24` (`1..168`)) from `cap`
to `installed` in the packaged settings catalogue, wired their SQL readers in
`openlup settings`, and exported experimental SQL-parity validation, install,
and read helpers from `@openlup/platform/subscriptions` and
`@openlup/platform/payments`.

Migration: Platform SQL migration
`20261126020000_settings_wave2_retry_schedule_and_decline_timing.sql` installs
strict JSONB validators and fail-closed `commerce_settings` readers for both
policies, updates 3-argument `public.subscription_retry_apply_failure(uuid,text,jsonb)`
to forward `public.subscription_retry_schedule_read()`, and updates 12-argument
`public.payment_provider_result_apply(text,uuid,uuid,text,timestamptz,text,text,text,text,text,text,jsonb)`
to fall back to `public.subscription_retry_schedule_read()` when `p_cadence` is
`NULL` (while preserving explicit `p_cadence` precedence) and to read
`public.payment_decline_notice_timing_read()` for one-time recoverable decline
notices and recovery link expiration.

### Install operator slide max days and edit quote TTL policies

Promoted `account_support_operator_slide_max_days` (default `60` days, integer
`3..365`) and `subscription_edit_quote_ttl_minutes` (default `15` minutes,
integer `1..1440`) as `installed` entries in the packaged settings catalogue,
wired their SQL readers in `openlup settings`, added optional `quoteTtlMinutes`
(default `15`, validated integer `1..1440`) to `PackageEditorOptions` and
`SizedEditorOptions`, and exported experimental SQL-parity validation, install,
and read helpers from `@openlup/platform/account-support` and
`@openlup/platform/subscriptions`.

Migration: Platform SQL migration
`20261126030000_settings_wave3a_operator_slide_and_quote_ttl.sql` installs
strict JSONB validators and fail-closed `commerce_settings` readers for both
policies, updates
`public.customer_support_apply_subscription_action_v1(uuid,uuid,text,jsonb,integer,text,timestamptz)`
to read `public.account_support_operator_slide_max_days_read()`, updates
`public.customer_subscription_preview_bundle_as_actor(uuid,text,jsonb,jsonb,jsonb,integer,integer)`
and
`public.subscription_command_preview(uuid,uuid,text,uuid,text,jsonb,timestamptz)`
to read `public.subscription_edit_quote_ttl_minutes_read()` consistently for
both `quote_hash` and `expires_at` while failing closed on malformed policy rows,
and revokes public execution while granting `EXECUTE` on the helper functions to
`service_role`.

### Install return reasons and payment method preference policies

Promoted `commerce.returnReasons` and `shipping.paymentMethodPreferences` from `cap` to `installed`, added `returnReasonsPolicy` and `paymentMethodPreferencesPolicy` helpers, and extended `CustomerPreferencePolicy` for custom codes.

Migration: Platform SQL migration replaces closed enum `CHECK` constraints with anchored format checks (`^[a-z][a-z0-9_]{1,63}$`), installs `*_validate`/`_read` helpers (`SET search_path = pg_catalog, pg_temp`), and enforces active lists in `commerce_return_request_create_owned` and `customer_preference_save` while preserving historical reads.

### Install subscription reschedule time zone policy

Promoted `subscriptions.rescheduleTimeZone` (`subscription_reschedule_timezone`, default `"UTC"`) from `cap` to `installed`, added `rescheduleTimeZonePolicy` helpers and `postgresCommandStore` time-zone support.

Migration: Platform SQL migration updates the four reschedule functions (`SET search_path = pg_catalog, pg_temp`) and installs `subscription_reschedule_timezone_validate`/`_read`.

Added the provider-neutral `CarrierRateQuotePort` contract and helpers to `@openlup/platform/shipping` and `@openlup/platform/shipping/contracts` (type-only), along with the offline `@openlup/platform/shipping/testing` conformance runner (`runShippingRateAdapterConformance`) and authenticated scripted transport fake (`createScriptedShippingRateFake`).

- Opt into immutable native subscription profile installation with `subscriptionProfileDefinitions`. Manifests and offline checks use Core's declaration validator. The owner can read the exact installed profile and policy pins with `readInstalledCatalogSubscriptionProfile`.
- Connected-store capture refuses stores with profile receipts until connected-store restore supports them (RS-1).

Migration: Handle `subscription_profile_receipts_unsupported` in exhaustive
switches over `PostgresTransferFailure`.

### Select a fixed-day subscription cadence

The pure selector intersects the declared choices from the store, SKU, offer,
command and optional profile. Supply profile and policy identity pins from your
binding. The selector reports declaration remedies and preserves the native
prepaid refusal for unprofiled requests.

- Native catalogue Prepare reports missing or ineffective price lists at each affected draft operation's `priceListId` field. Publish still checks the list when issuing the publication.

- Add the experimental `createPostgresCatalogPublicationReads` factory on `./catalog` for current heads, exact version 2 pages, authorized receipt recovery and history.
- Qualified-v2 installations gain a dedicated restricted catalogue publication login. Native publication failures can report the rejected price-list ID as `subject`.

`@openlup/platform/storefront` also exports `recoverAmbiguousSubmit` and its result type `AmbiguousSubmitRecovery`, which replay a failed submit at most once, with the same request, only when the host's failure classifier reports a timeout or a transport failure, and send nothing after an in-flight refusal or an unrecognized failure.

`@openlup/platform/storefront` also exports `getOrCreateContinuationId`, `readContinuationRecord`, `advanceAttempt` and `clearContinuationRecord`, which keep the continuation record's reuse rule and payment-attempt sequence through the host's storage and identifier bindings. `getOrCreateContinuationId` returns `null`, so nothing may be sent, when its storage does not keep a new identity, unless the caller passes the deprecated `storageFailure: "continue_unpersisted"`.

- `SubmitOutcomeClass` in `@openlup/platform/storefront` gains `declined`, a definitive decline of the payment attempt that leaves the purchase payable, and `closed`, the server's statement that the purchase under the key is terminal and no payment under it can still settle; a classifier written earlier never returns either.

`@openlup/platform/storefront` also exports the experimental `checkPendingResume`, `decidePendingResume`, `applyPendingResume` and `PendingResumeDecision`, which decide what a pending provider action means from the host's status read, clock and provider facts, never drop the marker on an unreadable status, block a switch to another provider only before the open attempt was sent to its provider and only when that attempt admits no new one, and run exactly one effect per decision.

- `@openlup/platform/storefront/testing` adds `createPostgresStorefrontObserver`, a storefront observer that reads each run subject's ledger, and with `exclusive` the database's payable orders, from the platform's own PostgreSQL tables through an injected SQL executor.

- `@openlup/platform/storefront` adds the experimental `createPurchaseContinuation`, `PurchaseContinuation` and `PurchaseContinuationSnapshot`: one controller a store's UI renders a purchase from, composing the continuation-record, ambiguous-submit and pending-resume functions through host bindings; `ClientEventReporter` gains the event `stored_continuation_rejected`.

- `@openlup/platform/storefront/testing` adds `runStorefrontScenario`, which runs a storefront proof scenario clean and under its control, checks its own harness and returns a format-1 verdict, and `storefrontScenarios` with `lost_response_reload` and `duplicate_submit`.

- `@openlup/platform/storefront/testing`: four more scenarios; `runStorefrontScenario` gains an outcome driver, the `omit_action` and `other_policy` controls, declared auto-progress and `stopAt`.

Migration: the result is now a union on `kind`; narrow before reading `verdict`.

```ts
const result = await runStorefrontScenario(options);
if (result.kind !== "verdict") throw new Error(result.kind);
const { verdict } = result;
```

- `getOrCreateContinuationId` in `@openlup/platform/storefront` takes an optional per-call `storageFailure` policy and returns `ContinuationId | null`. By default it reads a newly minted record back once and returns `null`, so nothing may be sent, unless the record names the identity and fingerprint it just wrote; reuse and a write that throws read nothing back. `createPurchaseContinuation` keeps its statuses and still sends nothing when storage does not keep the record.

Migration: Hosts built from `main` that call `getOrCreateContinuationId` directly
now receive `ContinuationId | null`. Handle `null` by sending nothing and letting
the buyer try again once storage is available. To keep the earlier behaviour, which
continues with an identity its storage did not keep and can create a second order,
pass the deprecated `storageFailure: "continue_unpersisted"` and still narrow the
result, which includes `null` under every policy.

Added `@openlup/platform/storefront` (`experimental` capability): browser-safe types for a storefront's purchase continuation (identity roles, the continuation record, host bindings and declarations), the identity constructors `toContinuationId`, `toCommandKey` and `toAttemptNumber`, which return their argument unchanged, and the `storefrontAnchor` constant of `data-openlup-*` markup anchor names. As in any experimental entry, only the export names are fixed once a release carries them; their shapes may still change in a minor release, and the changes that add their first readers follow this one.

- New `@openlup/platform/storefront/testing` (maturity `testing`, Node only): the storefront scenario, adapter, observer and page-handle contracts, `createPageHandle` over a Playwright page, and `serializeStorefrontVerdict`.

The lifecycle entry adds the storefront verdict and proof-file contracts (format version 1) with their parsers and JSON Schemas, and `digestStorefrontFiles`, the one client-build digest. Format version 1 may still be amended without a version bump until the first release that carries the storefront runner; afterwards fields are only added, and a removed field or changed meaning raises `formatVersion`.

- The experimental native destination port reads and rechecks an authorized subscription's sealed destination. Read with a null binding for current coordinates, or supply the exact binding for the retained document. Use a writable read-committed transaction.
- Recovery through direct address selection requires a qualified edit rail.

- Store experimental future subscription destination selections on native PostgreSQL.
  The edit is available to the migration owner. Existing runtime callers can keep
  using the current subscription and checkout entries after upgrade.

Add a private read-only lookup for the frozen renewal agreement by operation and commercial generation.

Native hosts can opt into the experimental `createPostgresSubscriptionSaveOfferAcceptor` from `@openlup/platform/subscriptions`. Bind a trusted actor, lifecycle timing and offer policy, ordinary command admission, and a transaction callback that commits or rolls back on one READ COMMITTED connection.

Batch owned IDs with `readPresentations`. A returned null means the offer is unavailable for that subscription. To accept a `SubscriptionSaveOfferPresentation`, echo its generation, kind and the displayed reschedule target or chosen pause terms. Use a fresh action key for a new acceptance and recover a lost reply with the original key and input. Refresh the presentation after a stale or unavailable refusal. A consumed refusal means the kind was already accepted for that renewal occurrence.

Presentation and fresh acceptance require the retained renewal date and request time to fall in UTC calendar years 1970–9999. The reschedule offset, slide bounds, pause days and subscription cadence have a ceiling of 36,500 days. The pause month count has a ceiling of 1,200 months and the edit window has a ceiling of 876,000 hours. Exact retries and consumed occurrences retain their existing results.

### Native tax evaluation claims

Native tax evaluations can now claim and seal an owned destination and replay a verified outcome. The 300-second lease governs qualified recovery. Definitive service unavailability directs the caller to request a new quote when service returns. The experimental tax store wrappers require a restricted transaction lane. Existing quote hosts require no setup changes.

### Quote composition evidence in native tax evaluations

The native tax evaluation store can retain the original quote composition and verify its binding to a sealed outcome. Existing evaluations remain replayable and exportable. Existing hosts require no setup changes.

### Quote composition on experimental tax evaluations

The experimental `./tax` wrapper accepts the projected composition on claim and returns it with the claim. On success, it includes the supplied composition digest in the sealed fiscal or verified adapter evidence. The wrapper checks the exact projected pricing variants before an initial claim.

A legacy seal whose kind differs from the pinned kind now returns `tax_invalid_input` at `/seal`. Submit the kind from the original claim.

### Experimental tax evaluation validation order

A legacy claim pin with both an unsupported kind and a wrong destination schema version reports `tax_invalid_input` at `/pin/kind` first. Correct the kind and review the remaining input before retrying.

Add the experimental local rate-table adapter, offline tax adapter conformance, and settings catalogue descriptors for application tax composition.

Tax verifiers report oversized canonical JSON as `tax_invalid_input` with a
size remedy at the document's JSON Pointer. Missing and explicitly undefined
required calculation evidence both point to `/evidenceDigest`.

Native PostgreSQL stock writes report a typed refusal when a replay changes the
stock inputs. Reminder schedule installation reports a typed refusal when open
orders block a schedule change.

Migration: Apply the ordered native migration catalogue through
`20261125150000_checkout_recovery_reminder_install_outcome.sql`. Match
`FulfillmentStockReplayConflictError` or
`CheckoutRecoveryScheduleChangeBlockedError` using `instanceof`. The reminder
error exposes `blockingOrders` as a decimal string, and both errors retain the
driver error in `cause`. Checkout treats raw stock `23505` as an operational
failure.

### Report upgrade conflicts once and name the repair

- `openlup upgrade plan` and `openlup upgrade apply` report one top-level JSON
  `conflicts` array, including on completion, replay and errors after successful
  argument parsing. Schema-range and managed-file refusals include named
  findings with repair and recheck instructions.
- The neutral starter refuses a missing or misbound `StoreConfig` before
  creating a pool. `openlup verify --app` includes the exact public
  `OPENLUP_E_STARTER_STORE_CONFIG_REQUIRED` diagnostic in the assembly failure's
  cause when recognized.

Migration:

- Upgrade tooling should read top-level `conflicts` instead of `plan.conflicts`
  and update strict report and text assertions to expect the named findings.
  The first-party adopter featured in the repository README uses neither upgrade
  command, so its CLI migration cost is zero.
- Starter observers should pass the selected `StoreConfig` third and the optional
  keyring fourth to `composeNativeBindings`. Update exact verify-output assertions
  for the allowlisted case. The first-party adopter has zero cost for package
  adoption. Its use of custom observers or copied starter source is unknown.

- New managed files created by `openlup upgrade apply` are readable by the app user (`0644` subject to the process umask). Replaced files keep their existing mode.

Images built from the working copy where you ran `openlup upgrade apply` may
contain files with mode `0600`. The 1.0.0→1.1.0 upgrade created `shared/policy.ts`
and `test/policy.test.ts`. The 1.1.0→1.2.0 upgrade created `owned/market.config.ts`,
`shared/copy-keys.ts`, `shared/locale-copy.ts`, `shared/locales.ts`,
`test/checkout-recovery-stage.test.ts`, `test/locales.test.ts`, and
`test/subscription-creation.test.ts`. The 1.2.0→1.3.0 upgrade created
`owned/settings-host.ts` when absent. Run `chmod a+r` on those files or rebuild
from a fresh checkout with the default umask `022`. Git applies the process
umask on checkout.

- Verified webhook intake supports an optional delivery effect for an observation with no incoming tracking references. The effect runs after handoff, before accounting and receipt completion. A confirmed delivery readback is reported separately from tracking counts.
- Native intake can record a historical arrival using its retained verified webhook and existing, unambiguous provider-bound parcel reference.

Migration: Apply the selected platform migration chain before enabling the updated native webhook intake.

Export `brandTransientSecret`, `PaymentWebhookControlPort` (and companion verified-ingress webhook types), `PaymentProviderExecutor`, and provider-neutral browser form contracts (`PaymentFormCopy`, `PaymentFormSettlement`, `RecoveryPaymentSetupFormCopy`) from `@openlup/platform/payments` and `@openlup/platform/payments/contracts`, and align `runPaymentAdapterConformance` transport-fault status checks with canonical `PAYMENT_EXECUTION_ATTEMPT_STATUSES` (`sent_to_provider`).

Added Wave 2 Tier 1 contracts and offline conformance kits: `@openlup/platform/accounting` (`/contracts`, `/testing`), `@openlup/platform/observability` (`/contracts`, `/testing`), and `@openlup/platform/channels/testing`.

### Known issues

- Legacy or custom renewal claims that skip the locked snapshot recheck may
  charge the amount from before an accepted subscription edit.
- Native bundle edits refuse SKUs that have only a derived subscription price.
  Install an active stored price and preview again with a new command key.
- The payment attempt recorder can enqueue a request after intent or subscription
  cancellation. Check eligibility before recording and treat confirmed spurious
  requests as ineligible for retry.

[Known issues and mitigations in the upgrade guide](https://github.com/openlup/openlup/blob/openlup-core-v1.4.0/packages/core/docs/guide/upgrade/v1-4-0.md#known-issues)

## [1.3.0]

- Publishable on the npm `latest` dist-tag as `1.3.0`, from tag
  `openlup-platform-v1.3.0`.

- Keep lower-maturity declarations referenced by stable `@openlup/platform` APIs in the stable snapshots so maintainers can detect type narrowing. The snapshot tool also checks that every reachable declaration appears in a report and that entrypoint directories have a single owner.

  Migration: No adopter action is required. Installed exports and runtime behavior are unchanged.

- Scope `@openlup/platform` `.api.md` declaration snapshots by subpath.

  Migration: Snapshot scoping does not alter runtime or type exports. Snapshots omit import-only declarations owned by equally or more mature sibling subpaths unless another retained edge includes them.

- Prepare catalogue candidates through one ordered evaluator with actionable preparation and pricing diagnostics. Product rule builds attach to the existing definition installation. Published product content carries neutral facts and a document reference.
- Migration: Existing candidate-service construction and v1 references and digests remain supported. For definition installation, attach the rules build to the pack and compose the host registry from the same pack types. Run your rule tests and install the updated product type through the existing install flow.

Native installations can preserve product publication and revision history when transferring a store.
Migration: Apply the complete native database update before transferring a store that already has publication history. The managed rail does not supply this feature. Publication read refusals keep their released reasons and now carry an optional `message` that names the fix, which callers can display; an invalid history cursor or publication head returns `candidate_invalid`.
Migration: In 1.3.0, `CATALOG_MIGRATIONS` grows from 14 to 16 entries with `20261123190000_catalog_publication` and `20261123191000_catalog_publication_commands`. Update code that pins the tuple length.

### Explain invalid catalogue attribute definitions

- The `definition_attribute_invalid` remedy directs readers to the reported field, explains the attribute key length, character rules and reserved names with `recycled_cover` as a valid example, and retains guidance on kind, cardinality and bounds.

Apply the reminder episode pin migration before using the updated producers.
A pinned episode retains its starting timing. A changed schedule supplies
timing for episodes whose first wave is created after the change.

Older episodes with preexisting waves and no pin read the live schedule
and can block changes with `checkout_recovery_schedule_change_blocked_open_episodes`.
See **Install reminder stages and hours** for the blocker conditions and
when to retry. Use
`READ COMMITTED` for changes and producers to avoid
`checkout_recovery_schedule_isolation_unsupported`.

If your legacy cart reminder job runs under its own database role, grant that
role EXECUTE on `public.commerce_enqueue_abandoned_cart_reminder_episodes(integer)`
once after applying the migration. If the grant is missing, the job reports
`checkout_recovery_cart_runtime_grant_required` with the exact command to run.
The built-in runtime role already has the grant.

- Create each reminder stage at most once per order. Pinned episodes keep
  their timing and are exempt from the schedule-change guard. An older pending
  checkout order with a wave and no pin blocks a change regardless of age
  with `checkout_recovery_schedule_change_blocked_open_episodes`. The same
  refusal applies to unpinned pending abandoned carts with a wave, a valid
  draft receipt and no settlement intent. Changed installs and producers at
  `REPEATABLE READ` or `SERIALIZABLE` refuse with
  `checkout_recovery_schedule_isolation_unsupported`.
  With an installed schedule, a compacted checkout wave consumes both stages
  and the later stage is skipped. With no schedule installed, the historical
  hour rule applies.

- `resolveCustomerSessionBinding` reuses one PostgreSQL challenge store on the `store`, `pool` and default shared-store paths. `createStore` keeps its per-operation lifecycle. The env-free `createPostgresCustomerSessionBinding` accepts a borrowed `store`, a borrowed `pool` or an owned `connectionString`.
- Downgrade the challenge-table lock in `createPostgresCustomerChallengeStore` (`issue` and `redeem`) from `EXCLUSIVE MODE` to `ROW EXCLUSIVE MODE` so concurrent customer logins do not serialize globally while retaining mutual exclusion with `EXCLUSIVE MODE` privacy erasures.

- Add additive default policy factories (`createDefaultRenewalFailurePolicy`, `createDefaultRenewalPreflightPolicy`, `createDefaultRenewalCyclePolicy`) to `@openlup/platform/subscriptions` with overridable canonical renewal key dialects and refusal defaults.
- Unify internal capability contribution construction across `@openlup/platform/composition` factories without changing any exported contract or runtime behavior.

- Add optional `prepareCandidate` on `FulfillmentStorePort` (wired in `createPostgresFulfillmentDispatchStore` and native fulfillment preparation) so dispatch workers run one advisory-locked prepare+candidate transaction instead of two while retaining `readCandidate` for `contact_stale` remaps.
- Batch candidate hydration in `createPostgresFulfillmentDispatchComposition().listCandidates` using a single `unnest ... WITH ORDINALITY` query with per-row `22023` refusal isolation fallback.
- Add optional `readLocalState` on `reconcileFulfillmentObservations` (wired in native provider intake) to collapse repeated `fulfillment_intake_read_state` reads to one per row while invalidating `latestOccurredAt` after `recordStatusEvidence` and clearing cached state before `applyFulfillmentObservationEffects`.

- Read native stock availability for a batch of SKUs using the installed
  renewal protection horizon through `createPostgresStockAvailability(...).readInstalled(skus)`.
  The read uses one PostgreSQL statement for stock and the installed horizon.

Migration: Apply the complete native catalogue through
`20261123142000_inventory_renewal_protection_validation.sql`. The existing
horizon reader calls the extracted validator with its existing privileges.
The explicit-horizon TypeScript port and the 14-day fallback keep their
established behavior.

- Managed checkout uses the verified account when a submitted e-mail belongs to
  a linked profile. A first guest checkout can still use an unlinked e-mail.
  Apply the managed ownership migration before installing the updated reference
  adapter. The receipt reader uses the current account link on replays.

- Add the opt-in PostgreSQL catalogue commands binding for approving, revoking, publishing and replaying a receipted v3 draft. Enable the approval seal on candidate preparation and apply the complete native migration chain before binding the owner transaction.
- Publication refusals identify the affected field when available and explain how to correct the draft or recover a sealed publication. Adopter rule refusals name the rule, its code and the field. The released refusal contract adds an optional path. `catalog-contracts.api.md`
- In 1.3.0, `CATALOG_MIGRATIONS` grows from 14 to 16 entries with `20261123190000_catalog_publication` and `20261123191000_catalog_publication_commands`.

Added additive PostgreSQL host ports for native checkout (`createPostgresNativeCheckoutHostPort` on `@openlup/platform/commerce/server/native-checkout`, optional `readExpiry` on `PostgresCheckoutRecoveryTokenPort` in `@openlup/platform/commerce/server`, and `createPostgresNativeCheckoutSubscriptionPort` on `@openlup/platform/subscriptions`) and migrated `examples/neutral-store/host/` checkout modules onto those ports without raw internal-table SQL.

Migration: Apply the full selected 1.3.0 PostgreSQL catalogue, including `20261123149000_native_durable_capture_evidence.sql`, with the upgraded payment runtime.

- On successful custom reconciliation readbacks, return provider-collected `amountMinor` and `currency` with `capturedAmountBasis: "provider_capture_v1"`.
- On successful custom native renewal observations, return the collected money in `observedMoney`, the same basis and the actual provider occurrence time when available.
- For custom native webhook adapters, set `capturedAmountBasis: "provider_capture_v1"` outside the event fingerprint on verified success evidence backed by the provider-collected amount.
- For successful invoice readbacks missing captured money with only a configured-amount mismatch against the claim, handle `providerEvidence.unavailableReason` as `provider_configured_amount_mismatch` and `providerStatus` as `unknown`.
- Find recorded native capture reviews via `captureReviewRequired` or `readCaptureReview` and confirm and resolve the transaction with the provider before charging again.

- Fresh cycles and expired claims both get space in a normal Native PostgreSQL
  renewal batch when both have eligible work.

Migration: Apply the ordered Native PostgreSQL catalogue through
`20261123150000_subscription_renewal_due_fairness.sql`.

- Recover `createEnvAdvisoryLock` after transient connect errors or idle client disconnects when zero locks are held while preserving fail-closed session-affinity refusals on active locks, and report lock acquisition/release errors to `onError` in `withAdvisoryLock`.
- Add optional `readbackMaxPages` (default `1`) to the warehouse fulfillment adapter so hosts can opt into bounded multi-page whole-collection readback verification beyond 100 fulfilments.
- Honor `dispatch.maxAttempts` in `createPostgresLifecycleMessages` source queries instead of a hardcoded limit of 6, and add an optional non-throwing `onError` callback for per-notice delivery failures.

- Harden payment adapter webhook normalization, OAuth token handling, detached JWS verification, readback status translation, and verified ingress projection without changing 1.x public exports:
  - Restrict dispute webhook normalization to active dispute events (`charge.dispute.created`, `charge.dispute.funds_withdrawn`) so closed or reinstated dispute events are acknowledged as unsupported rather than recorded as new disputes, and remove the over-broad `status === "requires_action"` fallback on unrecognized event types.
  - Eliminate per-call reconciliation provider allocation in payment adapter `readbackPort.readPayment`.
  - Thread the injected `now()` clock into HTTP client deadline checks, deduplicate concurrent OAuth token requests (single-flight), and invalidate stale bearer tokens on HTTP `401` (retrying idempotent `GET` requests once without silently double-dispatching `POST /transactions`).
  - Enforce strict 3-part detached JWS format (`parts.length === 3 && parts[1] === ""`), canonical `new URL(...)` `x5u` certificate URL validation, and bounded `X509Certificate` parse caching during webhook signature verification.
  - Avoid projecting verified webhook evidence twice in `createVerifiedPaymentIngress` when attaching a host-resolved reusable method owner.

- Export canonical payment failure evidence helpers (`evidenceToken`, `evidenceRecord`, `serializeFailureEvidence`, `failureEvidencePayload`), attempt silence-window and reconciliation evidence helpers, prepared-absence reopen helper, `DEFAULT_STALE_AFTER_SECONDS`, `paymentVerifyRequestSchema`, `hasCommittedCaptureReview`, `sameCanonicalAttempt`, `toClaimedAttemptShape`, payment method lifecycle snapshot helpers, and webhook refusal handoff types from `@openlup/platform/payments`.
- Export payment execution and durable-event conformance contract types (`ExecutionCapability`, `ExecutionSubject`, `ExecutionProviderIdentity`, `ExecutionEvidence`, `DurableEventCounts`, `DurableEventAggregate`, `DurableEventFixtureCardinality`, `DurableEventWriteCardinality`, `DurableEventCardinalityExpectations`, `DurableEventSnapshot`, `EventReceipt`, `DurableEventCapability`, `DurableEventEvidence`) from `@openlup/platform/payments/contracts`.

- Accept all `v1` signatures in a webhook signature header during signing secret rotation instead of retaining only the last `v1` entry, while failing closed on conflicting timestamps or stale payloads.

- Attach a non-throwing `'error'` listener once per lazily created PostgreSQL `Pool` or dedicated advisory-lock `Client` across data, marketing acquisition, migrations and scheduler adapters, preventing idle disconnects from terminating the host process.
- Add optional `onPoolError` and `onClientError` callbacks to `PostgresDataGatewayOptions`, marketing Postgres adapter options, migration runner options and `EnvAdvisoryLockOptions` (`createEnvAdvisoryLock`).

Review successful `@openlup/platform/payments/tpay` readbacks flagged `provider_amount_mismatch` before retrying or issuing an invoice.

Review a verified `@openlup/platform/payments/stripe` success webhook answered with HTTP 409 and reason `provider_amount_mismatch` before settling.

- Add `PaymentProviderRegistry`, `createPaymentProviderRegistry`, `toCoreCaptureHandoff`, `fromCoreCaptureHandoff`, and `toCorePaymentProviderCapability` to `@openlup/platform/payments` and `@openlup/platform/payments/contracts` as a single source of truth over composed payment adapters.
- Add named `FulfillmentProviderAdapter`, `FulfillmentProviderRegistry`, and `createFulfillmentProviderRegistry` to `@openlup/platform/fulfillment` and `@openlup/platform/fulfillment/contracts`, re-export `FULFILLMENT_STATUS_EFFECTS`, and derive `observationStatusPolicy` directly from `FULFILLMENT_STATUS_EFFECTS`.

### Discover application-defined settings

- Declare an application setting in the settings binding with its file, symbol, goal and effect. The experimental settings command can list, show, explain and check those declarations when the app is supplied. Check uses the app's Zod schema when provided and reports the original value.

### Slim capability and invariant descriptors

- Capability gaps and invariants now have one reason and a reference. Read their `runtime.reason` for the explanation.

### Discover starter-owned settings

- The starter's settings binding declares the free-shipping threshold,
  subscription discount, delivery intervals, edit window, checkout reservation
  duration and lifecycle notice retry budget. Use the starter's settings script
  to discover them alongside the packaged platform catalogue.
- The currency and date entries describe starter display fixes. The stock-wait
  entry identifies the fixed 15-minute native hold lifetime during stock-wait
  recovery.

### Check loaded settings after editing owned configuration

- The experimental `openlup settings check --app <module>` command checks reported file values offline. It reports the app's startup assertion separately from the per-key catalogue schema checks. Connected drift remains a startup check.

### Experimental settings command

- The package binary now provides the experimental settings command for discovery and read-only preview. For preview, pass JSON with `--value` or read it from stdin with `--value -`.

### Connected settings require an explicit PostgreSQL target

- For connected `openlup settings show` and `preview`, supply a canonical PostgreSQL URL with one TCP host, a username and one non-empty database path segment. For the exact URL rules, see the reader guide, Configure settings, section “Read the effective behavior”.
- The URL alone sets the host, port, username, password, database and TLS mode. An omitted `sslmode` selects plaintext. `PG`-prefixed environment variables and password files cannot change those settings. Other driver variables still apply. Both commands refuse when the driver loads the native client. Unset `NODE_PG_FORCE_NATIVE` to use the JavaScript client.
- The experimental settings host's `bind` input now carries the admitted connection options in `database`, replacing the raw `databaseUrl` string.

- Discover platform settings, capability gaps and invariants from the installed catalogue
  and refusal vocabulary. The read-only settings API and the domain discovery
  exports are experimental.

Migration: Existing operations and installed-policy APIs keep their current
behavior. To opt into connected settings discovery, inject a reader for each
installed key you want to inspect. The reader reports row presence separately
from its value.

### Settings goal search

- Match goal words at the start of catalogue words, including acronyms in camelCase keys. A nonblank goal with no letters or decimal digits returns an empty list. The command still refuses blank goals with exit code 64. When no setting matches every word, the list shows up to ten partial matches ranked by the number of matching words.

### Settings MCP launch and required inputs

- Pass `mcp` to the starter's settings script to launch the read-only settings
  server from the application root. If the application module cannot load,
  launch stops and reports the reason on stderr.
- Provide `key` to `settings_show`, `keyOrCode` to `settings_explain`, and both
  `key` and the proposed JSON `value` to `settings_preview`. The JSON-RPC
  argument error names a missing field when that omission is the only issue.

### Settings over MCP

- Use the experimental `openlup settings mcp` command to connect a read-only stdio client. The Configure settings guide shows the extracted starter client configuration.
- The server uses the existing settings commands. The unreleased experimental `settingsReadTools`, `listSettings`, `showSetting`, `explainSetting`, `previewSetting`, `invalidSettingsCommand` and `refuseSettingsPreview` exports have been removed from `@openlup/platform/operations/server`.

### Read-only preview for renewal stock protection

- The experimental settings preview command and `settings_preview` tool report one validation outcome, the
  current installed policy, current availability by SKU, and an estimate of
  proposed availability at the same instant and in the same snapshot. Existing
  reservations keep their quantities and expiry times. Apply
  `20261123152000_inventory_new_purchase_stock_preview.sql` for the proposed
  estimate in CLI JSON, MCP, and library results.
- The explicit-horizon reader still requires a horizon that matches the
  installed value.

- Add optional batch persistence methods (`recordStockSnapshotBatch`, `recordProviderStockCurrentBatch`, `recordLowStockEvidenceBatch`, `resolveLowStockEvidenceBatch`) to `FulfillmentStockSyncPort` and `createPostgresFulfillmentStockSyncPort`, and use them in `runFulfillmentStockSyncWorker` with PostgreSQL collation-aligned lock ordering and per-item fallback on stock batch errors.
- Skip the `SAVEPOINT` and `subscription_command_preview` no-op probe in `createPostgresSubscriptionCommandStore` for lifecycle actions whose preview path never returns `noop` (`pause`, `resume`, `cancel`, `skip_next_cycle`, `order_now`, `reactivate`).

- Add optional `snapshot?: RenewalFrozenSnapshot` forwarding on `AutomaticRenewalRunDeps["inventory"]["reserve"]` so `runOneAutomaticSubscriptionRenewal` passes the claimed snapshot directly to inventory reservation without re-reading renewal state.
- Reduce database round-trips on the subscription renewal and retry hot paths: lightweight SQL for `readMandateEvidence` and `admitDeliveryAlignment`, single snapshot read in `buildCycleSnapshots`, batched stock-wait candidate loading, direct stock-wait recovery snapshot reuse, and `failure_propagation_pending` guarding in `createNativeRetryDriver`.
- Reduce redundant serialization and parsing in `createNativeRenewalCodec` and replace the indirect `requires_action` replay wrapper in `createPostgresProviderRenewalBinding` with a direct helper preserving exact retry-rung and idempotency semantics.

- Return redacted `persistence` facts from `createTpayPaymentAdapter().attemptPort.execute` and synthesize safe, redacted fallback persistence in `createPostgresProviderPaymentRail` when an adapter omits optional `execution.persistence`, preventing post-dispatch throws that stranded live provider attempts.

- Unify direct-PostgreSQL executor and pool-sharing contracts across `@openlup/platform`:
  - Re-export `SqlExecutor` and add `PostgresTransactionRunner` / `createPostgresTransactionRunner(pool)` in `@openlup/platform/data`.
  - Accept a non-owning borrowed `{ pool }` option across `PostgresDataGatewayOptions`, direct-PostgreSQL identity/communications/account-support/marketing stores, and `createPostgresMigrationRunner` (rejecting `{ pool, poolFactory }` fail-closed and never calling `pool.end()` on borrowed pools).
  - Parameterize `PostgresRoleFreeTransactionLane<G = unknown>` covariantly and add a typed overload on `createPostgresRoleFreeTransactionLane<G>(...)` (retaining `PostgresRoleFreeTransactionLane<unknown>` when unparameterized for 1.x compatibility, while accepting supertypes such as `PgGatewayClient`, `SqlExecutor`, or `PgQueryExecutor` for typed callbacks without unchecked casts) plus a runtime `isPgQueryExecutor` check in checkout recovery token storage.
  - Make `DataBindingDependencies.createSupabaseClient` optional so direct-PostgreSQL hosts can call `createDataBindings()` without a hosted-client stub while still failing closed (`OPENLUP_E_DATA_BINDING_SUPABASE_CLIENT_REQUIRED`) when the hosted capability is bound without a client factory.
  - Convert `@openlup/platform/marketing/server/postgres` from eager `pg` imports to lazy peer loading with `OPENLUP_E_PEER_MISSING` preservation.

Migration:

Code that reads `DataBindingDependencies.createSupabaseClient` must handle
`undefined`. Existing `PgGatewayClient.query` implementations keep their 1.2.0
signature. For typed rows or readonly query values, wrap the client with
`asPostgresSqlExecutor` from `@openlup/platform/data`.

`createStore` keeps its per-operation lifecycle; pass `pool` or `store` to reuse one store per binding.

Before (separate pools per store and stubbed hosted client factory):
```ts
import { createDataBindings, type SupabaseCreateClient } from "@openlup/platform/data";
import { createPostgresAccountLinkStore } from "@openlup/platform/identity";

declare const stubClient: SupabaseCreateClient;
declare const connectionString: string;

const bindings = createDataBindings({ createSupabaseClient: stubClient });
const store = createPostgresAccountLinkStore({ connectionString });
```

After (the transaction runner and account-link store borrow the application's pool):
```ts
import type { Pool } from "pg";
import { createDataBindings, createPostgresTransactionRunner } from "@openlup/platform/data";
import { createPostgresAccountLinkStore } from "@openlup/platform/identity";

declare const sharedPool: Pool;

const bindings = createDataBindings();
const runner = createPostgresTransactionRunner(sharedPool);
const store = createPostgresAccountLinkStore({ connectionString: "" }, { pool: sharedPool });
```

- Distinguish the three `openlup verify --app` CLI stages (module load, `createVerificationInput` export check and observation factory execution) with constant diagnostic messages while withholding application error details.

## [1.2.0]

- Publishable on the npm `latest` dist-tag as `1.2.0`, from tag
  `openlup-platform-v1.2.0`.

Unreleased; next minor. API classification: additive stable commerce/server
install/read helpers and commerce/contracts schedule type; additive optional
stage and widened reminder-hour inputs on existing communications contracts.
Native reminder producers read an installed `checkout_recovery_reminders`
schedule. Stage selects tone independently of hours. Absence preserves the
historical waves; old payloads render identically. Unknown stages follow each
handler's existing payload refusal. No new subpath or reminder planner is added.

Migration:

Apply `20261123140000_checkout_recovery_reminder_schedule.sql` through the native
migration runner before using the new helpers. Both producers retain their
signatures, security, search paths, owners and ACLs. The integer-only checkout
wrapper is unchanged. The new restricted SECURITY DEFINER validator pins
`search_path = pg_catalog, pg_temp`, qualifies its settings read, revokes PUBLIC
and conditionally revokes anon/authenticated and grants service_role EXECUTE.
Malformed JSON, extra/missing keys, blank revision, empty arrays, duplicate or
unknown stages, nonincreasing/nonpositive/noninteger hours or a missing final
`last` refuse with `checkout_recovery_reminder_schedule_invalid` before writes.
The maximum hour is 2147483647. The managed chain is unchanged.

Before (host-owned timing and legacy content):
```ts
const recovery = createPostgresCheckoutRecoveryWaves(runtimeDb, { profile: 'capture' });
const vars = { ...emailVars, reminderHours: 20 };
```

After (explicit install, then runtime read and stage-aware content):
```ts
import { installCheckoutRecoveryReminderSchedule, readCheckoutRecoveryReminderSchedule }
  from '@openlup/platform/commerce/server';
await installCheckoutRecoveryReminderSchedule(installationDb, { revision: 'store-1',
  abandonedCart: [{ stage: 'first', afterHours: 1 }, { stage: 'gentle', afterHours: 24 }, { stage: 'last', afterHours: 48 }],
  checkoutRecovery: [{ stage: 'first', afterHours: 1 }, { stage: 'last', afterHours: 48 }] });
const installed = await readCheckoutRecoveryReminderSchedule(runtimeDb);
const recovery = createPostgresCheckoutRecoveryWaves(runtimeDb,
  { profile: 'capture', checkoutSeconds: 72 * 3600 });
const vars = { ...emailVars, reminderHours: 48, stage: 'last' as const };
```

Reads never install. The TypeScript reader needs settings SELECT; enqueue uses
the restricted SQL validator without requiring settings SELECT. Custom runtime
roles must retain their existing producer and relation privileges.

Before (separate runtime producer grants):
```sql
GRANT EXECUTE ON FUNCTION public.commerce_enqueue_abandoned_cart_reminders(integer),
  public.commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz) TO runtime_role;
```

After applying the migration, add exactly one grant:
```sql
GRANT EXECUTE ON FUNCTION public.commerce_checkout_recovery_reminder_schedule() TO runtime_role;
```

Qualified service-role bindings already receive it. Missing EXECUTE fails with
SQLSTATE `42501`, even with an absent setting; it never silently defaults.

Before (fixed SQL waves):
```sql
FOREACH wave IN ARRAY ARRAY[1,20] LOOP
```

After (strictly validated installed waves):
```sql
FOR entry IN SELECT value FROM jsonb_array_elements(
  public.commerce_checkout_recovery_reminder_schedule()->'checkoutRecovery') LOOP
```

Default dedup keys remain byte-identical. Custom waves derive keys by the same
hour spelling: `abandoned_<hours>h:<order-id>` and
`checkout_recovery:<hours>h:<order-id>`. Abandoned event types retain stage routes
1h/24h/72h. Legacy counter names count their corresponding stages. Final waves
retain the preceding-stage processed gate for abandoned carts and first-wave
confirmed-acceptance gate for checkout recovery; a lone `last` has no predecessor.
With an installed key, hours override legacy request offsets; absence retains
those offsets. Existing request-policy validation of legacy offsets (including
defaults) still applies. Checkout expiry, consent, payment activity and token deadlines
remain independent. Changing hours changes dedup identity and never rewrites
pending events or tokens; coordinate installation with in-flight reminders.

The source starter owns the schedule and installs only in its explicit install
step. Startup compares revision, stages and hours and refuses
`starter_installed_policy_drift` without writing. Existing starter applications
must add the owned input and install it deliberately.

Next minor release: add optional `CheckoutReservationLifetimePolicy` to
`reservationPolicyFor` and `normalizedTtlMinutes` in the stable inventory subpath.
Positive integer bounds up to 5270400 minutes (ten years) must satisfy `minMinutes <= defaultMinutes <= maxMinutes`;
each call refuses invalid policy with `reservation_policy_invalid`. Omission
preserves the 1440–2160-minute clamp and 1440-minute fallback exactly.

Calculated expiry is persisted when a purchase reservation is created. Policy
changes do not rewrite stored expiry; matching replay retains the original
command expiry, reservation identity and current status. Native SQL still
requires finite future expiry for fresh holds, with its existing 30-minute
fallback for null. No SQL, starter composition or existing reservation changes.

Migration: no change is required. Before:
`reservationPolicyFor(input)` and `normalizedTtlMinutes(value)`. After:
`reservationPolicyFor(input, policy?)` and `normalizedTtlMinutes(value, policy?)`
with optional `CheckoutReservationLifetimePolicy`; existing calls keep the same
results. To configure, pass `{ minMinutes, maxMinutes, defaultMinutes }`, for
example `{ minMinutes: 1440, maxMinutes: 2160, defaultMinutes: 1440 }` for the
current behaviour.

Unreleased; next minor. Add `RenewalStockProtectionPolicy` and typed install/read
helpers to the stable inventory subpath, with the type also in inventory/contracts.
Native ATP reads the installed `inventory_renewal_protection` commerce setting.
Absence preserves 14 days with revision `default`; malformed JSON, extra/missing
keys, blank revision or noninteger/out-of-range days refuse with
`inventory_renewal_protection_policy_invalid`. Request horizons must match installed
days; `native_stock_read_options_unsupported` remains the mismatch refusal.

Migration:

Apply the native forward `20261123130000_inventory_renewal_protection_policy.sql`
through the migration runner before composing the new helpers. The forward retains
ATP's signature, language, volatility, invoker security, search path, owner and ACL.
It adds a restricted SECURITY DEFINER validator with the exact pinned
`search_path = pg_catalog, pg_temp`, a schema-qualified settings read, PUBLIC
revocation and conditional role revokes/service-role EXECUTE. ATP callers no
longer need SELECT on `commerce_settings`. The TypeScript policy reader still
needs that SELECT to return revision and days. No settings seed or subscription
lifecycle rewrite is performed. The managed adapter and SQL chain retain their
fixed 14-day contract.

Before (custom runtime role, alongside its relation privileges):

```sql
GRANT EXECUTE ON FUNCTION public.inventory_available_to_promise(text,text,timestamptz,boolean),
  public.inventory_channel_exposure_quantity(text,text) TO runtime_role;
```

Keep these and any existing new-purchase-reader EXECUTE grant. They alone now
fail with SQLSTATE `42501` on ATP, even with an absent policy.

After applying the policy migration and before resuming ATP calls, add exactly
one grant, substituting the host's role for `runtime_role`:

```sql
GRANT EXECUTE ON FUNCTION public.inventory_renewal_protection_days() TO runtime_role;
```

Qualified service-role bindings already receive this EXECUTE grant. Missing
permission never silently falls back to 14 days; every admitted role uses the
same installed stock policy.

Before (host):
```ts
const input = { skus: ['ITEM'], horizonDays: 14, excludeOrderId: null };
await stock.readPort.read(input);
```

After (explicit installation, then runtime composition):
```ts
import { installRenewalStockProtectionPolicy, readRenewalStockProtectionPolicy }
  from '@openlup/platform/inventory';
// Install step only, on the host's write-capable connection:
await installRenewalStockProtectionPolicy(installationDb,
  { revision: 'store-1', renewalProtectionDays: 21 });
// Runtime only reads:
const policy = await readRenewalStockProtectionPolicy(runtimeDb);
await stock.readPort.read({ skus: ['ITEM'],
  horizonDays: policy.renewalProtectionDays, excludeOrderId: null });
```

Before (SQL horizon):
```sql
s.next_cycle_at <= p_as_of + interval '14 days'
```

After (installed horizon, validated once per ATP statement):
```sql
s.next_cycle_at <= p_as_of + make_interval(days => (SELECT days FROM policy))
-- policy materializes public.inventory_renewal_protection_days().
```

The source starter owns `inventory.renewalProtection` and installs it only through
its explicit installation step. Startup checks revision and days, refusing
`starter_installed_policy_drift` rather than writing. Existing applications must
add this owned input and install it deliberately. Unrelated raw editor settings
remain unchanged; the private package helper is not an adopter API.

- Add optional `CustomerSavedAddressValidationPolicy.local` callbacks through
  the existing stable `@openlup/platform/shipping` subpath. This additive stable
  API change requires the next minor release. No new subpath is introduced.
- Hosts may normalize and validate their local postal format and normalize or
  refuse their local phone format. Callbacks apply only to the selected local
  country (including aliases), must be effect-free and cannot perform I/O or
  authorization. A throw refuses the affected field with its existing policy
  message. Schema creation rejects missing or nonfunction local callbacks with
  `saved_address_policy_invalid`.
- Omitting `local` preserves the compatible five-digit postal and nine-digit /
  configured-prefix phone behavior. Platform length bounds, normalization order,
  aliases, foreign-country handling and message keys remain in force. Removing
  the compatible defaults is separate future work; no migration is required.

Migration: no change is required. Before: `CustomerSavedAddressValidationPolicy`
had `country`, `countryAliases`, `phonePrefix`, tax callbacks and `messages`.
After: it also accepts optional `local: { normalizePostalCode(value),
isValidPostalCode(value), normalizePhone(value) }`; omitting it keeps the
current behaviour.

### Added

- Let hosts pass authoritative, exact one-time offer allocations to the strict quote engine. Price component lines before promotions, shipping and tax while retaining independently read retail reference prices. Server quote snapshots carry versioned private offer-price provenance.
- Add opt-in explicit offer review to existing signed quote acceptance, including quotes without code, shipping or acquisition adjustments. A bound checkout offer can require that review.

Migration: no database migration. Existing callers keep their price, provenance and token behavior. Opt-in hosts must authorize the offer, resolve the full allocation on the server, sign and verify the same offer revision and checkout context, and re-resolve terms at acceptance. The server-only `catalog_facts_v3` variant is emitted for offers that opt in. Exhaustive TypeScript switches over `CatalogFactsProvenance` should handle the new variant even when the host leaves offer pricing disabled. Older authoritative quote snapshots continue to parse.

Unreleased; next minor. Add stable `SubscriptionCommandAdmission` in the existing
subscriptions/contracts subpath and optional `admitSubscriptionCommand` on the
native command binding. Omitting it preserves existing behavior. Fresh preview
and apply evaluate effect-free owned policy after ownership, key locking and
receipt/fingerprint replay, before translation, pricing or writes. Thrown named
errors propagate with no durable refusal receipt. Native lifecycle, payment and
delivery fences remain unconditional. Completed matching commands replay after
policy narrows; payload conflicts still refuse before admission.

Admission reads payment facts in a fresh statement after acquiring the
subscription lock. Use READ COMMITTED (READ UNCOMMITTED has the same PostgreSQL
behavior); fresh admission refuses REPEATABLE READ and SERIALIZABLE with
`subscription_command_admission_isolation_unsupported` before the callback or
writes. Completed receipts still replay before this check.

The source starter owns account action lists and pause choices in
`owned/renewal.config.ts`. The account pause form preselects the preset default
(`2_weeks` in the demo) and the cancellation save offer keeps its own
`retention.pausePreset` (`1_month`), so starter defaults are unchanged.

Migration: no SQL, schema or installed-policy changes. This additive stable API
requires the next minor set, not a 1.0.x patch; no release is prepared here.
Opt in through host composition; never place the callback in a browser payload
or perform I/O from it. When upgrading starter application files, add
`subscriptionCare.actions` and `pausePresets` to the owned input. Invalid lists
or defaults refuse startup. A removed choice affects fresh work only.

- Unreleased, for the next release after 1.1.0: native purchase activation accepts
  optional `editWindowHours` (integer 1–720), validated with
  `subscription_activation_edit_window_invalid` before database access. Omission
  retains the installed 72-hour default. The value freezes on the created
  subscription; configuration changes and completed replay preserve existing rows.
- Existing native activation/repair signatures and ACLs remain unchanged. New
  separately named invoker SQL functions contain their predecessor bodies with
  the new input and pinned `public, pg_catalog` search paths. The forward never
  redefines or changes privileges on the predecessors. New functions revoke
  PUBLIC/anon/authenticated and grant EXECUTE to service_role where present.
  Managed checkout activation remains a separate unchanged boundary.

Migration: Apply the complete packaged native chain including
`20261123120000_subscription_edit_window_activation.sql` before supplying the new
input. Opting in requires EXECUTE on both new functions (granted to service_role
where present; owner-run self-host installations have it as owner). Old callers
that omit it call the unchanged predecessor with its existing privileges.
The starter owns
`subscriptionCreation.editWindowHours` (default 72) and validates it at startup
with `starter_subscription_creation_invalid`; all initial activation routes pass
it, including 72, and therefore opt in.

