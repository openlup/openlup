# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

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

## [0.33.0]

- Publishable on the npm `latest` dist-tag as `0.33.0`, from tag
  `openlup-platform-v0.33.0`.

### Runtime and portability

- Fix Node scheduler shutdown so each timer's stop method retains its original
  receiver. Existing stop/drain behavior and public signatures are preserved.
- In the reference source, add typed connected-transfer projections and bounded
  object/access reconciliation with restricted connected restore. Local catch-up
  and older-snapshot recovery witnesses retain database rows, private objects,
  privacy obligations and effect reconciliation before target activation.
- Add a local self-host recipe receipt covering the declared PostgreSQL,
  identity, object-storage and Node/OCI fixtures, including owned cleanup.
  Snapshot age and recovery timings are finite fixture measurements, not SLOs.
  Hosted recipe receipts remain pending.
- Migration: Upgrade the complete package set together. Reference-source
  installation and transfer bindings remain separate from the sparse npm SQL
  projections; those projections are not a complete installation or transfer
  catalogue. No new SQL migration is introduced by this set. The local witnesses
  establish only their declared profiles, with unresolved effects visibly fenced;
  they do not qualify hosted providers or a general adopter recovery service.

### Company identity and market packs

- Add experimental `company-identity`, `company-identity/contracts`,
  `company-identity/server` and `market-packs` subpaths. Company lookup preserves
  provider order, registry extensions and shared cache; handlers accept the
  host's existing BFF responder and optional identity rules.
- Expose pure settlement, fiscal and formatting helpers and a market descriptor.
  Reference facades delegate through the platform seams with application-owned
  currency/browser policy and explicit host composition. Core contracts retain
  their existing owners.
- Migration: Existing callers retain their signatures and defaults. The market
  descriptor requires explicit language and settlement facts. Country, currency,
  pricing region, fiscal jurisdiction and display facts remain independent caller
  inputs; importing a package installs no market defaults, routes or ambient
  initialization. No environment key, persisted key or SQL change is required.
  These experimental entries make no all-market qualification claim.
