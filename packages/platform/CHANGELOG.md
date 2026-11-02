# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.36.0]

- Publishable on the npm `latest` dist-tag as `0.36.0`, from tag
  `openlup-platform-v0.36.0`.

Add the existing neutral partner-acquisition schemas, type-only port and unchanged
three-operation PostgreSQL factory through the existing marketing entries.
Partners retains domain/data ownership; host routing, authorization and runtime
selection stay separate. Pipeline `closed_won` does not create a customer or
marketing consent. Partner privacy export/erasure remains unavailable.

Migration: before, partner submit/list/transition required reference-source
contracts and store imports; after, consumers can use the existing marketing,
marketing/contracts and marketing/server/postgres exports against a complete
compatible source catalogue. No SQL, grants, npm export subpaths or automatic
route activation change. Sparse npm SQL assets alone are not a complete install.

- The public reference partner schemas, neutral ports and PostgreSQL factory
  delegate to the existing marketing package exports. Rich managed contracts and
  host authorization, drain, environment selection and connection ownership are
  unchanged. Frozen R1 expectations remain unchanged.
- The shared isolated consumer adds the actual public default-binding journey
  against its existing native catalogue fixture, covering original persisted
  replay and cache/close/reopen without an injected factory.

Migration: before, reference neutral schemas, ports and the PostgreSQL store had
local copies; after, the same reference import paths delegate to the existing
`@openlup/platform/marketing` schemas, `marketing/contracts` types and
`marketing/server/postgres` factory with unchanged observable contracts. Install
no new SQL or grants for this delegation. Existing compatible adopter SQL remains
owned by that adopter; this source refactor grants no publication or activation.

## [0.35.0]

- Publishable on the npm `latest` dist-tag as `0.35.0`, from tag
  `openlup-platform-v0.35.0`.

- Add experimental normalized channel contracts/helpers and Node ingest, retained paid-source, webhook/operator, pull and recovery bindings at existing Platform subpaths. Existing commerce owners retain order, payment, inventory and fulfillment effects.
- Preserve original capture/approval/BOM/money/payment identities and page/CAS receipts. Managed retained conversion uses the existing ATP hook and unchanged allocator; portable physical conversion refuses by name. Privacy lifecycle export/erasure is unavailable.

### Account newsletter withdrawal

- Portable PostgreSQL account newsletter opt-out now atomically denies newsletter
  permission, including repeated opt-outs, while preserving suppression and other
  purposes. Opting back in changes the account preference but leaves the evaluator
  refusing until an explicit grant is recorded separately.
- An opt-out recorded before this version does not change an existing `granted`
  row until an operator runs the idempotent upgrade statement in the data and
  migrations guide. The account setter schedules no external provider sync, and
  a denial stays tied to the old email fingerprint after an email change.
- Newsletter withdrawal uses database-specific lowercase rules; addresses containing
  Turkish `İ` or context-dependent Greek `Σ` can still differ from JavaScript, and
  C-locale databases also differ for `Ä`; this withdrawal path assumes a UTF8 database.
- Account withdrawal records newsletter denial without duplicating the evaluator's
  address-acceptance rule. An evaluator-refused address remains refused even if a
  denial is recorded under its fingerprint.

Migration: Before selecting the channel surface, an existing same-rail catalogue lacks the two M17 units. After selecting it, install the complete catalogue through `20261030121000_channel_retained_basis.sql` and `20261030122000_channel_purchased_source.sql`; the sparse package assets are not an installation chain. The Risk API snapshot only reorders unchanged enum members, so Risk callers need no code or SQL migration.

Install the complete selected catalogue including the newsletter withdrawal forward and the two new channel forwards; sparse `CHANNEL_INGEST_MIGRATIONS` package assets are byte-identical projections, not an install chain. Hosts explicitly supply provider decoding, owner ports, currency policy and enablement. Importing the package enables no route, job, simulator or provider. No hosted or provider qualification is implied.

For account opt-outs recorded before this set, an operator must run the idempotent [newsletter withdrawal upgrade statement](https://github.com/openlup/openlup/blob/openlup-platform-v0.35.0/docs/platform/DATA_AND_MIGRATIONS.md#account-newsletter-withdrawal-upgrade). Installing or replaying the forward alone does not change an existing granted recipient-consent row.

With the complete 0.35.0 catalogue, `outbox_events` also needs the owner path, so the generic utility refuses it; that owner path is reference-source only.

With the complete 0.35.0 catalogue, `outbox_events` also needs the owner path, so the generic utility refuses it; that owner path is reference-source only.

## [0.34.0]

- Publishable on the npm `latest` dist-tag as `0.34.0`, from tag
  `openlup-platform-v0.34.0`.

### Measurement consent

- Add optional `consentPolicy` modes to the data-layer factory. The default
  `analytics-only` mode preserves legacy behavior. `independent` admits optional
  events under either stored purpose grant; `host-authorized` also admits events
  before choice and after refusal for explicitly authorized consent-aware host
  tags. Both opt-in modes emit independent stored purpose signals. Hosts must
  fence private routes, authorize denied-state transmission and gate every tag
  by purpose. Explicit all-denial updates remain available; no replay is added.
- Migration: Upgrade the complete package set together. Existing callers keep
  `analytics-only` behavior unless the host opts in. In either opt-in mode,
  update(true) publishes stored purpose flags and update(false) denies all
  signals; neither changes admission policy or fences routes. The host must
  authorize every admitted event and its data. Queue admission does not grant
  storage consent or establish delivery or attribution. No SQL migration is
  introduced by this set.
