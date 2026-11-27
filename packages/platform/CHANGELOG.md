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

Eleven acquisition and partner acquisition definer functions now pin `pg_temp` last on their search path.

Added `@openlup/platform/adapter-kit` (`experimental` rail) exporting shared zero-dependency provider adapter primitives: `createHardenedFetch`, `createOAuth2TokenManager`, `parseRetryAfter`, `createRetryAfterCooldown`, `verifyHmacSha256`, `verifyHardenedStandardWebhook`, and `verifyEd25519Signature`.

- Managed renewal reporting can classify prepared, acknowledged and settled payment attempts independently of the legacy cycle result.
- Managed operator support can opt into up to three attempts for rolled-back subscription actions and recovery commands on returned PostgreSQL `40P01`.
- Watchdog ledger adapters can batch up to four already-admitted alert observations over their existing store transition.

For the next 1.x release. Adds partial indexes for active `public.outbox_events`
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

---
type: feat
---

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

---
type: feat
---

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

For the next 1.x release. Marks the derived promise from `Reflect.apply(Promise.prototype.then, ...)` in `settled` (`packages/platform/src/fulfillment/conformanceSchema.ts`) with an explicit `void` operator to satisfy type-aware `@typescript-eslint/no-floating-promises` without changing runtime behavior.

Seventeen channel and customer self-service definer functions now pin `pg_temp` last on their search path.

For the next 1.x release. Adds JSDoc `@deprecated` notices to legacy 1.x
surfaces scheduled for removal or simplification in 2.0.0: the 11 experimental
payment reference-support exports under provider payment subpaths, the
7-generic `RenewalCyclePolicy` interface, `createFulfillmentCommandLedger`, and
the legacy hosted-bundle default in `DEFAULT_PLATFORM_BUNDLE`.

Migration: no runtime or type changes in 1.x. Existing 1.x replacements
(`PaymentAdapter` / `PaymentProviderRegistry` from `@openlup/platform/payments/contracts`,
`createPaymentProviderRegistry` from `@openlup/platform/payments`,
`createDefaultRenewalCyclePolicy`, `createPostgresFulfillmentDispatchStore`,
and explicit `PLATFORM_BUNDLE`) are already available in 1.x.

---
type: fix
---

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

---
type: feat
---

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

For the next 1.x release. On the native rail, `public.fulfillment_advance_shipment`
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

For the next 1.x release. Adds an optional 3-rung `p_cadence` parameter
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

For the next 1.x release. Adds an optional bounded `concurrency` option
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

---
kind: minor
surface: cli
---

Add the experimental `openlup recipe scaffold --domain <domain> --provider <slug> [--dest <dir>] [--force] [--verify] [--json]` subcommand to `@openlup/platform`'s `openlup` CLI for generating schema-valid, recipe-contract-isolated starter provider recipes across all eight supported adapter domains.

Added the experimental Agent-DX `openlup recipe list|show|add|verify` CLI subcommands to the `openlup` bin (`packages/platform/src/lifecycle/openlup.mjs` and `packages/platform/src/lifecycle/recipeCli.mjs`) for discovering, inspecting, copying into `owned/adapters/<domain>/<provider>` with provenance tracking, and offline-verifying (manifest parity, recipe-contract static isolation, `@openlup/platform` SemVer compatibility, and Stages 1–3 Vitest conformance/mount-proof suites) provider recipes.

Migration: Additive CLI subcommand under the existing `openlup` binary; no breaking changes for existing `openlup upgrade`, `verify`, `catalogue`, or `settings` invocations.

### Parcel contact privacy coverage

The `fulfillment-parcel-contacts` contributor advances from `fulfillment.parcel-contacts.v2` to `fulfillment.parcel-contacts.v3`. Its export coverage now explicitly includes parcel contacts projected from retained destination bindings. The existing export shape and contact erasure also cover those parcels.

Native migration admission allows one exact slot that adds a nullable receipt reference and widens the subscription quote preview acceptance CHECK to allow receipt-backed no-ops. The admission requires the issued CHECK preimage and keeps both existing acceptance states valid.

- Added the reserved nullable `price_lists.amount_basis` column with the `price_lists_basis_check` constraint (`tax_inclusive` or `tax_exclusive`). `NULL` keeps the legacy gross basis; no released path reads or writes the column yet.

For the next 1.x release. On the native rail, closed-from-open provenance can
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

---
type: feat
---

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

---
type: feat
---

Add the experimental local rate-table adapter, offline tax adapter conformance, and settings catalogue descriptors for application tax composition.

---
type: fix
---

Tax verifiers report oversized canonical JSON as `tax_invalid_input` with a
size remedy at the document's JSON Pointer. Missing and explicitly undefined
required calculation evidence both point to `/evidenceDigest`.

---
type: fix
---

Migration: branch on `instanceof FulfillmentStockReplayConflictError` or `CheckoutRecoveryScheduleChangeBlockedError` (driver error in `cause`); checkout treats raw stock `23505` as operational.

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

## [1.1.0]

- Publishable on the npm `latest` dist-tag as `1.1.0`, from tag
  `openlup-platform-v1.1.0`.

Widen native subscription edit-quote CHECK, actor preview and command preview
cadence admission to 1..3660 whole days, matching `MAX_CADENCE_DAYS` in Core.
The two current function definitions change only their upper cadence bound;
headers, security, search paths, ownership, ACLs and replay behavior stay intact.
The validated CHECK uses the reviewed integer-range superset capability.

Migration: apply the complete selected native catalogue through
`20261122190000_subscription_cadence_bound.sql` before using longer cadences.
The forward replaces the validated CHECK and takes the usual table DDL lock;
plan installation around concurrent edits. No stored rows change. The managed
chain has no corresponding cap and receives no migration. Do not downgrade
history; unbind longer offers if rolling back application composition.
Checkout-command and saga-fallback replay above 3660 remains a follow-up for
unreleased development data. No release or activation is included.

## [1.0.0]

- Publishable on the npm `latest` dist-tag as `1.0.0`, from tag
  `openlup-platform-v1.0.0`.

- Add optional effect-free `admitSubscriptionTerms` to classic, exact and sized
  subscription editor ports. It checks the full normalized base/add-on set with
  nominal plan and effective cadence before pricing or durable writes, including
  edits retaining frozen prices. Completed receipts replay before current limits
  and admission; mismatched payloads still conflict. Omitting the callback keeps
  existing behavior.
- Replace the checkout/quote/recovery/account DTO cadence caps of 90/120 days
  with positive PostgreSQL integer bounds. Historical generic SQL bundle and
  lifecycle quoting still cap cadence at 90; longer periods on those paths
  require a separate forward migration. Package/exact writers are separate.

Migration: no database migration in this change. Hosts may compose the optional
callback with adopter-owned rules; no default offer list or starter derivation
is supplied. Check date representation for the selected operation.

Add native live-SKU quantities and an explicit owner-only bounded backfill driver.

Migration: apply the complete native catalogue through `20261122110000_catalog_quantities.sql`, then call `backfillCatalogNetContent` with the install executor and batch size. Old grams and readers stay unchanged; the managed rail does not supply this feature.

Add optional effect-free full-result admission to the existing classic, exact
and sized editor ports. Supply nominal and effective cadence separately; run
before pricing and writes, including frozen-price edits. Completed receipt
replay precedes mutable limits and admission while fingerprint conflicts refuse.
Absent callback preserves behavior.

Cadence admission is superseded by [subscription-cadence-bound.md](#100):
fresh quotes, drafts and editor results accept 1..3660 whole days. Transport,
stored data and completed receipts retain PostgreSQL integer representation
bounds. Historical generic SQL bundle/lifecycle paths retain their 90-day guards
pending a separate forward.

Migration: no SQL or core changes. Compose the optional callback in the host and
validate resulting dates; starter offer derivation and activation remain separate.

- Clarify the offline fulfillment conformance failure for missing provider
  selection: `prepare(providerRef:null)` must return `selection_required` before
  I/O. The expected refusal and zero-I/O requirement are unchanged.

Add readonly catalogue pack descriptors, typed v1 draft authoring, declarative metadata, shared definition issues and server-computed definition/manifest digests. Catalogue quantity types now re-export Core's identical shape.

Migration: additive catalog and catalog/contracts exports. Existing definitions remain valid; v1 command bytes and quantity/option helpers are unchanged. Invalid definitions retain invalid_catalog_type_definition and now carry their first structured issue. Pack results are recursively readonly. Typed SKU options follow each product's selected dimensions, including a closed empty shape, while preserving all inline v1 SKU fields. Explicit CatalogPackDraft annotations use the second type parameter for the selected keys; list quantity unit references are checked recursively. Inherited draft fields accept readonly identifiers and asset references as well as mutable arrays. Descriptor objects are closed at authoring boundaries; retain literal reference keys when declaring arrays separately. Quantity dimensions follow their declared units. The Node catalogPackIssues helper reports closed pack shape and reference issues through the shared definition validator. Pass readonly authored drafts through catalogDraftPayloadSchema.parse before assigning them to mutable v1 draft/command DTOs. Import the runtime CATALOG_CONFORMANCE_RULES record from @openlup/platform/catalog; catalog/contracts exports the conformance codes and rule shapes as types only, keeping checker prose out of the browser bundle. Attribute values remain outside v1 drafts. No installation, publication, SQL or activation; target package set 0.44.0.

- Mark unbound catalogue extension symbols `@experimental`; retain the
  starter's consumed product-type input without the tag.

Migration: no runtime, signature, export or database change. The added TSDoc tags
identify experimental symbols for compatibility guidance; existing readers keep
their contracts.

### Added

Versioned catalogue draft payload v2, resume and stateless candidate previews.

Migration: apply the complete native catalogue through position 147 before
using v2 commands. `CatalogDraftPayload`, `CatalogDraftCommand` and their existing
schemas retain v1 behavior. New `CatalogDraftPayloadV2` and command schemas carry
typed attribute data and complete immediate positive gross one-time base-price
commands at minimum quantity one, including the wholly-null or wholly-set
expected entry ID and amount. A zero new amount refuses. Unknown payload and
command versions refuse; later versions cannot reinterpret or rewrite v2 bytes.
There are no price writes in this change.

Opt in with `createPostgresCatalogDraftStoreV2` and `createCatalogDraftHandlerV2`;
the original factories retain v1 admission and result types. These new factories return
`CatalogDraftStoredRecord` / `CatalogDraftStoredApplyResult`, whose payload is the
explicit v1-or-v2 union. Version-specific schemas remain available. `draftsFor`
adds definition-typed v2 attributes and required-key checking; the wire schema
and handler still save incomplete drafts, reporting publication readiness issues.
The async `validateCatalogDraftV2` reuses the attribute owner and optional reference
resolver. Old v1 consumers keep their exact canonical command and receipt bytes.
Stop v2 authoring before rolling back readers; old latest-record readers refuse
v2 records. Retain schema and history, and keep a compatible reader to access v2.

The v2-only `resume` command copies an abandoned draft's payload into an open
revision under the same retained reservations. Original abandonment receipts
still replay exactly, and legacy revise on an abandoned head still refuses.
No backfill or history rewrite occurs. All four draft relations remain
authoritative retained transfer data in their existing order and privacy class;
the round-trip matrix now covers v2 price plans and resume history. No new
relation, client foreign key or absorption class is needed.

`createCatalogCandidateService` prepares read-only previews through explicitly
supplied authorized readers. Its reference encodes the immutable draft revision
and expected publication identity, or known unpublished state. Reconstructing
resolves and compares the whole head including documentDigest, compares installed
and composed definition digests, and hashes the parsed canonical payload,
definition evidence and expected head. The caller's head and candidate digest
are checked by `compareCandidate`; missing price validation leaves a blocking
issue for price-bearing drafts. Publication must run reconstruction and refusal
of all issues inside its own transaction. No candidate table/cache, publisher
constructor, publication binding or capability activation is added.

Managed divergence design: the managed rail does not supply this feature.
A future twin replaces the existing managed draft apply routine with the same
version discrimination, retained receipts and resume semantics on its four
existing draft relations. It derives the actor from verified session membership,
retains their RLS/default-deny browser access and operator-session checks for
drafts. Publication retains its separate human-admin boundary and excludes
service credentials. Native
owner/runtime invoker authorization maps to managed routine grants plus RLS;
no native-only authorization role semantics are introduced. No live product/SKU
column, including industry-specific nullable fields, is changed or relaxed here.

- Add draft payload v3 for ordered publication operations, explicit eligibility,
  immutable provenance/media claims and explicit document-derived SKU cache
  effects. Freeze the shared-content extraction envelope and include every new
  field and operation order in candidate reconstruction/digests. Saving a draft
  executes no operation; publication and runtime capabilities remain unbound.

Migration: upgrade to the explicit `createPostgresCatalogDraftStoreV3` and
`createCatalogDraftHandlerV3` readers before authoring payload/commands v3.
`CatalogDraftPublicationStored*` is the additive v1/v2/v3 union; existing v1 and
v2 DTOs, parsers, handlers and adapters retain their version boundaries and exact
canonical bytes, fingerprints and original receipt replay. Unknown versions
refuse. The self-contained candidate-reference format remains v1 and resolves
immutable v3 data without an additional candidate table. V3 prices use the
unchanged positive gross one-time/minimum-one command; no scheduling, tier,
context-version or zero-price extensions are added.

The native forward expands only draft apply admission on the four existing
retained draft relations. Abandon/resume retains reservations and payloads;
there is no backfill, new relation or change to transfer order, privacy or
absorption classes. Stop v3 authoring before rolling readers back; retain a
compatible reader for v3 history. No live catalogue, price, subscription, order
or delivery fact is changed.

`sharedContent` has a closed versioned envelope for action, document,
presentation, memberships, requested modes and complete authored SKU facts;
installed validators own the opaque data within it. Provenance for the current
draft resolves from its persisted receipt rather than recursively embedding its
own fingerprint. Retained provenance uses an explicit immutable tuple and a
matching evidence claim. The publisher still verifies every claim and operation;
these input contracts provide no authorization or external readiness guarantee.

Managed divergence design: the managed rail does not supply this feature.
A future twin expands the managed draft apply routine on its existing heads,
revisions, receipts and reservations, deriving the actor from verified session
membership and preserving RLS, operator access and default-deny browser writes.
The native invoker's owner/runtime grants have an equivalent managed routine
and RLS expression; no native-only authorization semantics are introduced.
No product/SKU column is changed; industry-specific food-column relaxation
remains with the later reader/adoption boundary.

Adds an unbound native immediate base-price writer, validated preview/apply/readback
use case, PostgreSQL store and portable receipt/command contracts under pricing.
The command retains the draft-v2/v3 price-operation grammar and exact canonical
bytes. Later context, scheduling and list-lifecycle command extensions remain
reserved for a new payload version.

Migration: install the complete native catalogue through position 150,
`20261122180000_catalog_base_price_writer`, after the native readiness-input unit.
Old price readers continue reading ordinary price entries. New callers explicitly
bind a verified human administrator's session to the store and handler; the SQL
derives the actor, serializes receipt before price context, compares the expected
base and atomically closes/inserts at one database statement instant. No capability
is activated. Readiness reads native financial, agreement and audited cohort
evidence; missing proof hard-refuses independently of ordinary readiness reasons.
The existing global reason-membership aggregation defect remains unchanged: a
second invalid SKU can remain hidden by an already present aggregate price-shape
reason. This writer changes no agreed subscription money or schedule.

The catalogue-local receipt relation is authoritative transfer data. Retain its
exact fingerprints, actor metadata and responses with price history; no customer
foreign key or client-absorption rule is added. Rollback means unbinding callers;
retain committed history and receipts, and use a later expected-base command to
correct a price. Do not delete evidence or downgrade a live database.

Managed divergence design: a managed twin would use the existing managed
`price_lists`, `price_entries`, subscription, promotion and operational evidence
tables, plus a separately admitted catalogue receipt relation. Managed RLS must
deny direct receipt/price writes and expose bounded execution only to verified
active human administrators, excluding machine and revoked principals. Reconcile
the managed role/administrator authority with its incumbent policies; authorization
does not depend on a native-only role. The native readiness-input mapping and its
audited never-populated baseline delta require their managed equivalents. Existing
industry-specific catalogue columns are untouched; this price-only change needs
no relaxation. The managed rail does not supply this feature.

Stable 1.0 coordination (CD-S1-1): all new catalogue base-price writer symbols,
including contracts, schemas, handler/store ports and factories, canonical command
serialization and refusal helpers, are marked `@experimental` from their introduction.
They are outside the 1.0.0 SemVer promise. Existing catalogue readers retain their
current status. New result/kind unions and the hard-refusal reason tuple grow by
addition only (D3); no existing union member is removed or renamed.

Add unbound native offer-policy readiness inputs for the catalogue price writer.
Existing subscriptions receive the legacy policy pair and a default-false fixture
marker; future ordinary inserts default to pending acquisition. Installation
records immutable marking-time count, membership fingerprint and database time.
The separately audited, parameterless service capture inserts its baseline once.
The audited-zero admission is a deliberate platform-forced delta: “a fresh install
has nothing to protect.” It requires genuine empty marking provenance; a populated
marking becoming empty retains the empty-baseline refusal.

Migration: Apply the complete native migration catalogue. Old readers ignore the
additive evidence columns. New price-writer integration must call the read-only
input checks on its transaction before and after provisional prices, propagate
hard domain/provenance refusals, and retain ordinary acquisition reasons.
Graduation and edits that can preserve old quotes retain the governing purchase
order provenance; an event name never turns those copies into independent quotes.
Audit
the complete legacy non-fixture cohort, including paused and cancelled rows,
before explicitly invoking `commerce_capture_offer_policy_v2_legacy_baseline()`
through the existing service SQL boundary. Installation and transfer never
capture a baseline. Capture replay returns the original audit. Transfer carries
marking and baseline bytes, reconciling only the actual pristine target marking
row. Code rollback leaves the additive evidence and immutable audit in place;
never reset a baseline to make a failed comparison pass. No capability is enabled,
no application is composed, and no agreement is repriced or rescheduled.

Managed divergence design: A managed twin would reuse its existing
`public.subscriptions` policy/fixture columns and
`public.commerce_offer_policy_rollout_baselines`, add marking provenance and
implement the input checks over its managed promotions, prices, orders and
agreements. Its incumbent service grants and RLS need separate reviewed
reconciliation: marking must remain owner-written and immutable to ordinary
service DML; baselines need service SELECT/INSERT with browser and UPDATE/DELETE
denial, while capture retains the service authorization boundary. The same
semantics are expressible through managed ACLs and RLS, including explicit
handling of bypass roles. No food-column relaxation applies: this change authors
no product or SKU shape.
The managed rail does not supply this feature.

### Fixed

Preserve policy digests across a revision close.

Migration: additive native catalogue position 146 adds `closed_from_open` to
`subscription_price_policy_revisions`. The existing one-time NULL-to-finite
close sets it atomically without changing any original digest input or digest.
This single bit is sufficient because the guard admits no other close shape.
The byte-identical package asset is part of the complete migration catalogue.

Updated native readers verify the original tuple and serve the shortened
half-open window. `SubscriptionPricePolicyRevision.closedFromOpen` is optional;
legacy inputs keep their exact canonical bytes. Already-shortened legacy rows
whose stored tuple cannot verify refuse with
`subscription_price_policy_original_tuple_unverified`. No backfill guesses the
original tuple or replaces a historical digest. Apply schema first, upgrade
readers next, and verify retained history before enabling any later writer.
Old readers retain unchanged-tuple behavior but refuse newly closed revisions;
after a close, rollback must retain the new verifier. Keep schema and rows.

The marker follows the existing AUTHORITATIVE policy capture/restore class and
ordering, including byte-exact restore and replay. No new table, client foreign
key, absorption or privacy-erasure duty is added. Subscription agreements,
renewal terms and operations, orders, quantities and cycle dates are unchanged.
This repair ships unbound: no scheduler, closing command, capability or activation.

Managed divergence design: the managed rail does not supply this feature.
Its future twin adds the same marker and validated CHECK to managed
`subscription_price_policy_revisions`, preserving RLS and existing grants.
Administrative write grants and RLS express the native owner-only mutation
boundary; browser roles cannot close revisions or write the marker. The twin
must update its reader and guard together and prove original-digest verification,
shortened-window serving and legacy refusal. No native-only authorization role
is required and no food-column relaxation applies to this policy-only forward.

Add opt-in catalogue definition/quantity/v1-draft checks, explicit refusal
fixtures and installed recipes with a copied stationery skeleton. Attribute/projection and combination fixtures reuse their owners; taxonomy, tax,
profile and promotion semantics remain explicitly pending.

Migration: Additive tooling for the next package set. Old imports and v1 canonical
bytes remain unchanged. The new Node-only `@openlup/platform/catalog/testing`
subpath and `openlup catalogue check --packs ./owned/catalogue.json --json` require
explicit JSON fixture text; the supplied file is never imported. No database migration, installation,
host wiring, publication or capability activation occurs. Upgrade all packages as
one exact set; an offline PASS is scoped evidence only.

Quantity fixture type references now use the shared `catalogProductTypeRefIssues`
owner before resolution; malformed keys/versions report existing definition codes.
Refusal capability keys must be own string keys, and pack versions share the
installer's existing positive bounded integer rule. Valid inputs are unchanged;
malformed fixtures and pack versions that could pass offline now refuse.

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

Primitive quantity fields are admitted before owner handoff. Only deliberate
owner input errors in the checker's explicit code allowlist become input refusals
(exit 1 at the input path). All other owner exceptions propagate unchanged;
the direct promise rejects and the CLI returns 74 with raw errors withheld.
Default failure is 74; only the tagged `JSON.parse` site gives 64. Integrity codes
are never input-denial codes and propagate to CLI 74. API signatures, SQL and
release caps are unchanged by this checker repair.

Add native-only immutable catalogue definitions, install receipts, tax-class keys
and nullable product type bindings. Export the explicit install-role installer,
read-only registry probe and opt-in catalogue-write guard. Target set 0.44.0;
no runtime capability is activated.

Migration: apply the complete selected native catalogue including
`20261122100000_catalog_definition_binding.sql`, then explicitly call
`installCatalogDefinitions(installExecutor, pack)` with the native migration-owner
executor. Existing rows stay NULL-bound legacy, with no backfill or inferred
mapping. Old readers ignore the new nullable product columns; new readers treat
NULL as not mapped and follow the composite FK for installed versions. Managed-to-native
retained transfer supplies NULL only when a source binding column is absent;
provided values and all other missing-column refusals are preserved. SKUs
inherit the product type. `model_binding_state` is omitted because it would
repeat NULL-ness before publication is introduced. Keep installed old versions
in code while any product references them. Rolling code back leaves additive
storage and immutable install history intact; do not delete versions or undo SQL.

Applications can supply the probe result as `ReadinessInput.catalogRegistry` in
`createVerificationInput()` for `openlup verify --app`, and wrap catalogue writes
with `createCatalogDefinitionWriteGuard`. No existing store is automatically
rebound. The probe needs SELECT on both catalogue tables through table ownership
or a BYPASSRLS read role with row security inactive on both tables. Active row
security makes the observation incomplete, including empty visible results; a
missing definition remains a binding with a NULL installed digest. Either yields
existing `unknown` readiness and makes the guard refuse before the write.
Host calls after migrations, the net-content backfill driver and boot
readiness are deferred to the later V2 reader/composition stage. Explicit
type-upgrade mappings remain part of publication; this slice adds no reader V2
or publication transaction.

Managed divergence design: the managed rail does not supply this feature.
A managed twin needs the three definition/install/tax-key tables, nullable product
references and their complete-reference check, composite FK and index. Restrict
installation to an administrative migration principal and expose only the read
access the composed observer needs through grants and RLS. Runtime has no
installer EXECUTE, direct definition writes or migration-owner membership.
A same-table immutability trigger and invoker routine have managed equivalents;
no native-only authorization semantics are required. This slice changes no constraints
on `net_weight_g`, `pet_type`, `kcal_per_unit`, `requires_pet_profile` or
`feeding_grams_per_unit`. Alternative quantity readers and managed nullability
changes stay with the V2 reader stage. Definitions and receipts contain no customer foreign
keys or personal data, and transfer carries all three relations as AUTHORITATIVE metadata.

Add native-only nullable physical quantities on live SKUs and the explicit
install-role `backfillCatalogNetContent(installExecutor, {batchSize})` driver.
Target set 0.44.0; no capability or runtime composition is activated.

Migration: apply the complete selected native catalogue through
`20261122110000_catalog_quantities.sql`, then explicitly drain the backfill with
the migration-owner executor and a positive integer `batchSize`. The migration
itself does not backfill data. The driver converts positive legacy grams exactly
to mass / scale 0 / `openlup:g`, preserves native zero as unknown and never
replaces existing net content or infers gross mass. Interrupted runs resume;
replay is a no-op. Gross dimension is explicit to reject non-mass values at the
storage boundary. SQL checks complete groups, positive stored coefficients and
scale 0–12, leaving unit admission to the later publisher and installed unit
metadata. PostgreSQL `numeric(40,0)` coerces inputs before CHECK evaluation;
trusted writers enforce decimal-string integrality before sending values.

Old readers continue reading the unchanged non-null `net_weight_g`. V2 readers,
the checked compatibility projection, nullability change and host migration
wiring arrive in the later reader/composition stage. The new export is additive
and requires explicit invocation; it is not a runtime writer. Rollback leaves
nullable columns and converted content intact; do not reverse migration data.
No subscription agreement, quantity, price or schedule is changed.

Transfer carries all new columns in existing AUTHORITATIVE `catalog_skus` rows
with unchanged restore order. No new customer reference, absorption policy or
personal-data contributor is needed. Managed-to-native retained mapping fills
only absent fields with NULL and preserves supplied values and existing
refusals, including the exact-number guard.

Managed divergence design: the managed rail does not supply this feature.
The managed `catalog_skus` twin adds the same nullable groups and CHECKs, retaining
table grants and RLS. Its administrative migration principal runs an equivalent
owner-restricted invoker batch; runtime principals (including service, operator
and browser roles) receive no backfill EXECUTE or migration-principal membership.
The native design uses no authorization construct that managed grants and RLS
cannot express. Existing `pet_type`, `net_weight_g` and `kcal_per_unit` are mandatory
without defaults, `requires_pet_profile` has a default and
`feeding_grams_per_unit` is already nullable. Their non-food relaxation belongs
to the later reader stage; this forward changes none of them.

Add native-only attribute storage and the single rebuildable SKU-keyed
projection. Target set 0.44.0; everything remains unbound.

Migration: apply the complete selected native catalogue through
`20261122120000_catalog_attributes.sql` (position 144). Products and SKUs gain
nullable `attribute_values` JSONB, checked as objects with an independent
1,048,576-byte PostgreSQL rendered-text ceiling. Existing canonical JSON depth
and byte safety checks remain at the owner boundary; the later V2 draft retains
its separate aggregate canonical-byte ceiling. These byte measures differ.
Existing rows keep NULL, opaque documents remain unchanged, and no default or
backfill infers values. Old readers ignore the nullable columns; future V2
readers consume typed values with publication evidence. V1 DTOs and canonical
bytes are unchanged. Rollback leaves the expansion and data intact; do not drop
populated columns or reverse the migration.

The projection key distinguishes SKU, publication revision, attribute key,
definition version and ordinal. There is no premature publication FK, synthetic
revision, second attribute store or generation seed. The table is RLS-enabled
with owner-only access and no runtime grants. Decimal/quantity exactness must be
checked before future SQL writes because PostgreSQL numeric can coerce inputs.
Value validation and pure preparation, publication/digests/atomicity, generation
switching, serving and restore rebuilding remain pending. No capability flips,
writer bindings or subscription agreement changes are supplied.

Transfer retains product/SKU values as AUTHORITATIVE and classifies the
projection REBUILDABLE: count-only capture, no carried rows, empty-target restore
and no stale rows on replay. Managed retained mapping fills only absent new
columns with NULL before supplied rows, retaining exact-number and other
refusals. Free text/reference values may contain personal data and follow the
sensitive retained stream. No direct clients FK means no new absorption census
row; no new subject-erasure claim is made.

Managed divergence design: the managed rail does not supply this feature.
The managed twin adds nullable `attribute_values` JSONB on `catalog_products` and
`catalog_skus`, equivalent object/rendered-byte CHECKs, and one projection table
with the same key/index layout. Existing authoritative table grants and RLS
remain. The administrative migration principal maintains the projection;
runtime projection access remains denied pending a later explicit grant/RLS
policy, and browser roles have no direct projection writes. Native ownership
adds no authorization policy that managed grants and RLS cannot express.
Relaxation of existing food-mandatory columns remains the later reader stage.

Add the unbound catalogue attribute owner validator, injected allowlisted batch
reference resolution and pure preparation for the single SKU-keyed projection.
Supplied malformed values refuse; required values/locales are publication
readiness issues. Each product/SKU attribute object independently fits the 1 MiB
PostgreSQL-rendered text storage ceiling, including separator spaces and UTF-8
string bytes. Numeric exponent expansion is conservatively bounded; admitted
attribute shapes are counted exactly. Oversized objects refuse with
`attribute_storage_too_large` and the product/SKU owner path. The aggregate
canonical JSON safety bound remains separate. Each projected text slot also fits
2,048 UTF-8 bytes, including whole localized maps and list scalars, independently
of facet/filter flags. This conservative composite-index budget on the qualified
8 KiB-page PostgreSQL profile refuses with `attribute_projection_text_too_large`
before insertion; it does not depend on compressibility. Signed decimals remain strings, and Core quantity conversion
refuses inexact or overflowing canonical numeric values before SQL.

Migration: additive server exports and shared conformance codes only. Existing
V1 drafts, DTOs, canonical bytes and readers are unchanged. Compose the new owner
with installed definitions explicitly; do not pass attribute values to V1 drafts.
Old readers ignore the nullable storage introduced separately. Future V2 readers
must consume publication evidence. Shared conformance guidance and installed
recipe links include all new attribute codes beside the offline checker's codes.
The checker still checks definitions, exact quantities and v1 drafts only;
attribute-value/projection checker integration remains pending. No SQL, data backfill, runtime writer or
serving switch is included; rolling back this helper cannot rebuild or publish
stored values. LC1/LC2 still own validation/digest/atomic publication integration,
and later serving/restore work owns shadow generations and rebuilding.

The L1 required-locale witness proves readiness and the admission predicate;
it does not prove an actual publish has zero effects. Managed storage enablement
remains absent: the managed rail does not supply this feature. All capabilities
remain unbound; subscription agreements are unaffected.

Add unbound native variant axes and V2 combination identity preparation for target
package set 0.44.0. No catalogue consumer or capability is activated.

Migration: apply the complete selected native catalogue through
`20261122130000_catalog_variant_axes.sql` (position 145). Products gain nullable
`variant_axes text[]` in declared display order. SKUs gain nullable object-checked
`option_values`, `canonical_option_bytes` and a 32-byte-checked
`combination_digest`. Existing rows keep NULL: no default, inferred mapping,
empty combination or legacy digest is manufactured. Old readers ignore these
nullable fields; future V2 readers require publication evidence. The additive
code rollback leaves these columns, identities and data intact; do not drop
populated columns or reverse the migration. Existing UUIDs, codes, ownership,
history and legacy constraints remain.

The active-SKU partial unique index uses only `(product_id, combination_digest)`
with `status='active' AND combination_digest IS NOT NULL`, independently of
product state or type. SQL enforces storage and uniqueness; it does not certify
that caller-supplied bytes are canonical. `canonicalizeCatalogCombinationV2`
computes versioned canonical bytes and SHA-256 server-side from installed
definitions and complete selected options, using Core exact arithmetic and
explicit unit factors. Labels and display order do not enter combination
identity. Existing `canonicalCatalogOption`, v1 draft bytes and replay are
unchanged. `classifyCatalogCombinationConflictV2` distinguishes duplicate bytes
from a digest collision; neither case merges identities.
V2 quantity options use Core's exact decimal grammar and canonical bounds after
conversion/normalization, allowing equivalent padded coefficients up to 52 input
digits. The v1 wire schema retains its 40-digit coefficient ceiling. Canonical
integer overflow and precision loss still refuse; strict option-field closure
is preserved.
The shared conformance rule record includes the combination owner's codes and
links them to the installed axis/unit recipes. The offline checker keeps its
definitions, quantity fixtures and v1-draft scope; V2 combination fixtures and
publication are not activated by these links.

`validateCatalogCombinationChangesV2` is pure LC2 preparation over authoritative
retained facts and incoming options, with no client digest input. It preserves
omitted SKUs and withdrawal facts, requires a new SKU for an existing mapped
identity change, and refuses occupied active combinations. The 10,000-SKU
payload bound is separate from configured product capacity (default 50,000),
counting retained and incoming identities without enumerating combinations.
The publisher must bind definitions, enforce human authority, lock and validate
within its transaction, enforce persisted incremental capacity and record
immutable history. Explicit legacy conversion and the 15,768-SKU incremental
publication witnesses remain LC2 integration obligations. Direct owner SQL
uniqueness/concurrency witnesses are preparatory substrate, not a publish API.
See the canonical catalogue extension agreements and lock order; this change
adds no locking runtime, commerce caller, trigger or independently committing
publisher. Referenced identity keys must never be changed in place.

The new fields ride existing AUTHORITATIVE product/SKU capture entries and
restore order. Managed retained mapping initializes only absent fields to NULL,
preserves supplied fields and keeps existing refusals. The round-trip matrix
compares every field, bytes, legacy NULLs and axis order after restore/replay.
Text/options follow the sensitive retained stream. No new relation, client FK,
absorption entry or privacy-erasure claim is introduced.

Managed divergence design: the managed rail does not supply this feature.
Its twin adds the same nullable columns to `catalog_products` and `catalog_skus`,
with equivalent object and 32-byte CHECKs,
and active-SKU partial uniqueness while preserving existing managed grants and
RLS. Restrictive administrative writer grants and RLS can express the same
authorization as native ownership; browser roles receive no direct identity
writes. Existing format/content uniqueness remains until generic publication
parity is proven. Food-column relaxation remains a later migration. The public
release retains this divergence and supplies no managed activation.

Distinguish combination identity integrity failures from incoming SKU identity
changes in the unbound V2 combination owner for target package set 0.44.0.

Migration: handle the additive `combination_identity_integrity_failed` code for
inconsistent authoritative option identity evidence and colliding derived
digests. An incoming mapped identity change still reports
`sku_identity_change_requires_new_sku`. The earlier `combination_digest_collision`
code remains in the exported union and guidance record for compatibility;
`validateCatalogCombinationChangesV2` now reports the new integrity code for
that condition. Refusal conditions, validation order and all other behavior stay
unchanged. No SQL migration, writer activation or capability change is required.

Declare per-subpath stable, experimental and test-support policies for the coherent 1.0.0 package set. Stable APIs follow SemVer with open unions and literal sets; symbols tagged `@experimental` remain outside the stable promise. Consumer evidence is explicitly first-party.

Migration: keep a default branch for unknown union and literal-set values. Check the generated maturity table for experimental and test-support subpaths before upgrading. No runtime behavior or package export changes.

Bound fresh subscription quotes, order drafts and editor results to 1..3660
whole days (ten years), using the shared browser-shareable `MAX_CADENCE_DAYS`
export from `@openlup/core/subscription`. Adopters choose offered cadences in
owned configuration.

Checkout command/intent transport, resume, recovery and account reads, editor
contexts, retained renewal terms and frozen renewal snapshots keep PostgreSQL
integer representation bounds (1..2147483647). Editor and native draft
completed receipts replay before current limits; SQL ownership and fingerprint
checks still refuse changed payloads. Fresh edits also check the resulting
cadence when inherited from stored data. Classic historical price comparisons
use retained billing facts rather than submitting old cadences for a fresh quote.

Fresh native renewal snapshots and starter graduation above 3660 refuse with
`NativeRenewalCadenceError`, reason `cadence_limit_exceeded`, the observed value
and `maximumCadenceDays`; choose an executable cadence before starting a new
renewal. Historical frozen operations remain readable and replayable. Quantity,
revision and money bounds are unchanged.

Identity persistence admits fresh cadence before its writing RPC. Historical
completed retries authenticate a single read snapshot of the stored response and
the writer's canonical JSONB fingerprint, including the route-verified identity,
and refuse changed payloads without reopening the key. Fresh quote execution and unfinished resume writes
also admit cadence before dependencies; expired recreation checks both stored
cadences before provider I/O and returns `cadence_limit_exceeded`.

Fresh work is bounded at 1..3660 whole days. Replay of completed commands above
3660 is preserved on editor, native draft and renewal paths, but is not guaranteed
on the checkout-command and saga-fallback paths: checkout command execution
quotes before identity and draft replay, and `commercePaidOrderOrchestration`
re-quotes before draft replay when no quote is supplied. Those two paths remain
a follow-up. No published version admitted cadence above 120 days; PR4a's
widening is unreleased, so no released data can contain values above 3660.

Fresh subscription future-terms commands admit supplied cadence/plan days after
receipt replay and before host translation or native preview/apply dispatch,
so an out-of-range preview cannot persist a refusal receipt.

Migration: no SQL changes. Existing 90-day SQL guards and the starter's
`starter_database_cadence_limit` refusal above 90 remain pending a separate slice.

## [0.43.0]

- Publishable on the npm `latest` dist-tag as `0.43.0`, from tag
  `openlup-platform-v0.43.0`.

- Fix concurrent ecommerce-event projection and personal-data erasure by taking the receipts relation lock before subject row locks through a restricted preparation function. Recipient erasure, export, retained source facts and replay fences keep their existing behavior.

Migration: install the complete selected native chain through `20261119200000_communication_event_prepare_erasure.sql` before using the updated privacy contributor.

- Add optional neutral fulfillment capability declarations, readiness refusals and native execution probes. Existing adapter operation flags and outputs remain unchanged; no unsupported native lifecycle operation becomes implemented.
- Add selected-intake dispatch ACK composition, snapshot-only stock synchronization and compatible receipt/observation aliases.

Migration: install the complete selected SQL catalogue through `20261120100000_fulfillment_intake_channel.sql` before using the updated native dispatch store. Polling hosts pass the selected intake declaration to native ACK composition; omitted intake remains push and existing accepted receipts retain their channel.

Migration: omitted descriptor fields preserve existing behavior. Provider-owned reservations and provider-managed consumption now have explicit readiness refusals. Explicit `stockMovements: false` selects snapshots with a separate movement refusal and preserves the movement watermark; absent retains movement reads. Pass the declaration to the stock worker.

Migration: `transportSelection: "provider"` admits nullable native parcel carrier/service; saved customer preferences still require strings. PDF remains the sole supported label document format. Independent split, standalone pickup/locker, native label create/void and remote cancel requests remain named limits.

Migration: optional `receiptKey` must equal required legacy `labelKey` byte-for-byte. Neutral observation status aliases `code`/`detailCode` coexist with required legacy `primary`/`subStatus`; neutral shipment event kinds coexist with legacy order event kinds. Preserve event keys, occurrence identity and historical acceptance JSON; no backfill or receipt rewrite is supplied.

- Add native order delivery-contact resolution, latest-shipment contact comparison and fenced operator correction with exact retained replay, creation capture, privacy export/erasure and finite native transfer. Operator creation validates the resolved contact, with pre-parcel correction taking precedence over the original destination.
- Add source-specific delivery selection with injected normalized options and canonical point evidence. Provider-selected checkout/preferences remain constrained by their existing contracts.

Migration: install the complete selected catalogue through `20261121100000_order_delivery_contact_correction.sql`. Native response schemas accept older inputs without `deliveryContact` and normalize its absence to null. Select the native response schemas and authorize the OMS correction handler. Submit both the PostgreSQL digest and revision; register the updated parcel-contact privacy contributor for private order contacts and retained correction responses. Historical baselines stay null; no backfill or provider activation is performed.

- Compose replacement preparation and dispatch under the new parcel identity, retaining optional frozen line lot/expiry fields and adapter-owned sequence numbering.
- Bind retained and in-flight dispatch replay to parcel sequence and optional line lot/expiry, preserving omitted versus explicit-null metadata selection.
- Add the explicit native customer alignment row reader for the existing current-schedule mapper. Reduced list/detail retain their existing projection; overview requires host data.
- Process changed non-null arrival timestamps while preserving subscription-first locking, all-unsuperseded-arrivals admission and the monotonic once-only schedule clamp. No automatic replacement confirmation is added.

Migration: install the complete selected SQL catalogue through `20261120130000_fulfillment_alignment_arrival_chronology.sql`. Bind `createPostgresCustomerAlignmentRowsReader` from `@openlup/platform/fulfillment/native` to `readFulfillmentDelay`; authorize IDs and supply current schedules. Optional `parcelSequenceNo` is additive; adapters own any provider-facing format and existing callers default to the original parcel. Bind the selected adapter's order-identity codec to intake. Historical status alone supplies no arrival, reservation generation or inferred customer case. There is no backfill or hosted qualification.

- Add explicit native commerce creation and operator-attempt recording with cancellation composition. Local creation checks settled money, recorded order mode, contact, holds, cycle and reservations before committing a parcel; it makes no provider call.
- Fence selected native submission on succeeded same-provider operator attempts and full per-line held/committed reservation coverage. Admit initial `subscription` orders; retain the paid-cycle check only for recorded `subscription_cycle`. Replacement submission is supplied by the later native alignment composition; accepted-proof recovery remains available.
- Add selected native dispatch candidates and final admission, actual-command shadow fingerprint forwarding, draft promotion/refresh and durable neutral failed/uncertain diagnostics. Operator audit attempts remain separate from command proof attempts.

Migration: install the complete selected catalogue through `20261120110000_fulfillment_dispatch_outcomes.sql` before using these factories or the updated native dispatch store. Select `nativeDispatch: { portKey, providerRef }` or retain the existing host reader/list composition. Supply the adapter's pure `shadowCommandFingerprint` to preserve actual command identity across shadow and stage.

Migration: same-parcel/provider mapped-attempt replay returns the first attempt across draft refresh and promotion. Submitted references retain their mode and command identity. Existing dispatch outcomes stay NULL; no historical contacts, reservations, modes or acceptance proofs are reconstructed. Connected native transfers include the new private operator-attempt table.

Migration: the reference adapter preserves unreadable rejection bodies as network uncertainty, including HTTP 400. Readable definite rejections remain failed. Neither failed nor uncertain outcomes authorize automatic resubmission. No hosted provider qualification is implied.

Compose native provider ingress and leased reconciliation over the existing workers, recorded dispatch commitments, exact parcel reservations, shipment commands and job ledger. Retain first webhook envelopes, current polling tracking snapshots, closed occurrence/recovery facts and scoped holds without rewriting parcel status. Provider identity resolves first; all recorded fallback associations must agree on one order before ACK, and every match checks the adapter's outbound order identity. Delivered observations with no references retain the documented manual arrival path.

Migration: install the complete catalogue through `20261120120000_fulfillment_provider_intake.sql` before binding `createPostgresFulfillmentProviderIntake`. Adapters selecting native intake must add closed `intake` facts and retain original occurrence bytes in optional `intake.occurredAt`; missing original chronology uses receipt time. Supply the adapter-owned optional `orderIdentity` mapping when outbound merchant identity differs from the recorded order number; existing generic callers and unbound operator fallbacks remain compatible. The optional durable observation readback is additive. Historical rows are not inferred or backfilled.

Migration: typed consumers can now handle three native dispatch refusals that were already returned.

- Remove provider trace columns from the source status facade and generated JSON; adapter-owned dictionaries retain provider status translation.

Migration: shared status-map JSON carries only the neutral core map. Use adapter-owned dictionaries for provider trace requirements. Prefer canonical `packed`; historical display aliases remain accepted without changed customer-step results.

- Add the experimental `./fulfillment/testing` offline certification entry and scripted transport. Full qualification validates copied data with closed schemas and credits only independently compared invocations in one ledger. Evidence includes mode, derived profile, capability digest and port-less declarations. Host locking, durable deduplication, cancellation races, replacement and alignment remain real-PostgreSQL evidence.

- Keep executed refusal probes for non-PDF formats, label create/void, provider-side cancel, independent split, provider-owned reservations, snapshot-only movements and pickup-point/locker execution. The closed port-less list contains only courier pickup: unsupported records `probe: "no_port"`; supported fails with `capability_not_certifiable`. Callable unsupported operations need refusal witnesses. No provider behavior or SQL changes.

- Bind captured-adapter qualification to the deeply frozen original dispatch port and methods. Freeze scripted transport method slots. Derive refusal fixtures and the unchanged refusal type from the internal shared `FULFILLMENT_REFUSAL_REASONS` tuple.

- Apply readback capability and observation checks to paged rows; bind scenario aliases to their operation's existing capability guard. Snapshot and validate closed scripted outcomes once at enqueue. Refuse shared-memory buffers and views with `validation:shared_memory`.

- Check unmapped poll evidence, observation replays, provider references and diagnostics through the shared projections before qualification credit. Snapshot asynchronous outcomes once; copy synchronous throws separately.

Migration: the unreleased testing subject's label-void expectations require an exclusive `canProceed` branch; successful cleanup cannot carry a refusal. Production label-port types and baseline callers remain unchanged.

Migration: scripted fake outcomes now contain snapshot-compatible data; construct `Response` objects from copied body/status data at the injected fetch boundary. Unknown outcome fields refuse before invocation; descriptor and buffer checks mitigate accidental accessor/proxy and shared-memory misuse. Paging evidence is recorded under `readback`.

Migration: captured adapters and their nested capabilities/ports are immutable; compose a separate adapter for custom behavior. The unreleased testing subject requires an expected dispatch after prepared results and forbids dispatch/replay keys after refused preparation. Existing baseline subject types remain accepted. Baseline host-storage label reads remain available when adapter label reading is unsupported; full mode still requires an explicit refusal. The internal shared `FULFILLMENT_REFUSAL_REASONS` tuple preserves every existing reason.

Migration: existing imports and one-argument calls retain baseline mode with shared data validation. Full mode requires independent expectations for every slot and mutually exclusive sync `{ input, expected }` / `{ input, throws }` roles. Refused preparations omit dispatch/replay keys; scenario indices are distinct integers in range. Supply read-only `fake.calls` handles backed by the private log, not caller arrays. Replace snapshot worker callbacks with `snapshotOnly: true`; the runner executes the real worker with its own isolated provider/store. Profile is derived: only the captured adapter factory brand permits dispatch-only qualification, which earns no other capability certification. Supported operations need contract-positive success and typed failure; unsupported cannot stand in for the failure of a supported operation. Missing expectations and malformed branches fail validation; descriptor-based snapshots mitigate accidental proxy, accessor and hidden-property misuse. Executable methods are captured once and invoked through a captured intrinsic. Return native promises without constructor/species overrides; native-promise checks and captured `then` handling mitigate accidental redirection. Policy callbacks and optional host-store methods use the same capture boundary; their returned and thrown data is copied before use. Inputs and outcomes are copied before use and compared by kind and deep strict equality. The kit certifies adapter behaviour against honestly built data fixtures and rejects missing, malformed or contradictory fixtures and contract-violating adapter results. Deliberate accessor, proxy or overridden-intrinsic manipulation to defeat the caller's own certification is outside the threat model. These mitigations reduce accidental misuse; they are not an attestation.

Migration: existing `./fulfillment` and `./fulfillment/testing` imports, signatures and behavior stay unchanged. Shared conformance support now belongs to fulfillment internals; the testing entry re-exports the same scenario types and scripted transport.

- Replace native provider identity predicates with immutable declarative profiles, retaining existing evidence, refusal codes, validation order and replay behavior. Reference adapters carry typed profile declarations; SQL/TypeScript parity and a declaration-only third-provider witness exercise both policy variants.
- Add optional host-selected execution flow labels to the portable payment rail; omission preserves the existing composition. The second reference provider's portable composition remains unsupported.

Migration: apply the complete selected catalogue through `20261121090000_payment_provider_profiles.sql`. It replaces exactly ten functions and retains their existing privileges, including the sealed interactive body. Historical slots, witnesses, stored identities and receipts are unchanged. Arbitrary admitted providers retain their generic fallback; claims and reopening remain opt-in by profile. No mutable registry, provider activation or live qualification is introduced.

Known limits for the complete set: Provider and carrier proof is limited to fake clients, scripted adapters and offline fixtures; no live provider or carrier qualification is claimed. The starter still selects sandbox payments. The native payment rail supports the two reference providers through declarative profiles; a third provider needs a declaration plus its adapter. The supplied portable payment composition covers the reference card provider only; the second reference provider has no supplied portable composition. The included warehouse adapter is a reference example. Imports, declarations, package installation and offline certification activate no integration.

Fulfillment retains local reservations and local finished-picking consumption; provider-held reservations, provider-managed consumption, independent splits, standalone pickup-point/locker execution, native label create/void and provider-side cancellation remain unsupported. Labels are PDF only; reference-adapter label reads remain host-owned. Courier pickup has no provider-reaching port and declared support cannot earn full certification. Snapshot-only stock has no movements. Saved preferences require carrier/service strings even when native provider-selected parcels allow nulls. Native overview data requires a host reader.

Historical contacts, reservations, modes, acceptance proofs and arrival facts are not backfilled. Failed or uncertain dispatch and a lost replacement acknowledgement never authorize blind resubmission. Fulfilled parents need an authorized host workflow for replacement dispatch. Replacement creation/dispatch never confirm arrival: record actual delivery; an undelivered replacement remains outstanding. Delivered observations without admitted tracking references retain status evidence but cannot record arrival or alignment. The monotonic clamp never moves a cycle earlier or stacks deliveries.

Intake uses sequential page numbers, not opaque cursors; polling-only providers refuse webhook intake. Empty collections prove no absence. Human holds, terminal provider exceptions and evidence without usable chronology require manual handling. Native reads refuse missing destination/line snapshots. Replaying incomplete webhook transport metadata may replace polling-enriched nullable reference fields. Resolve missing or conflicting historical associations and evidence through authorized recovery; no inferred parcel, chronology or stock is supplied.

Offline certification checks honestly built fixtures and contract results; deliberate accessor, proxy or overridden-intrinsic manipulation to defeat the caller's own certification is outside its threat model. It is not an attestation of durable host behavior. Absence auto-reopen stays off by default and later dispatch requires explicit due-reopen consumption. Refund creation remains separate; refund evidence does not pause or cancel subscription service. Experimental services remain inert until explicitly composed.
