# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.34.0]

- Publishable on the npm `latest` dist-tag as `0.34.0`, from tag
  `openlup-platform-v0.34.0`.

Add optional `consentPolicy` modes to the data-layer factory. The default `analytics-only` mode preserves legacy behavior. `independent` admits optional events under either stored purpose grant; `host-authorized` also admits events before choice and after refusal for explicitly authorized consent-aware host tags. Both opt-in modes emit independent stored purpose signals. Hosts must fence private routes, authorize denied-state transmission and gate every tag by purpose. Explicit all-denial updates remain available; no replay is added.

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

## [0.32.0]

- Publishable on the npm `latest` dist-tag as `0.32.0`, from tag
  `openlup-platform-v0.32.0`.

### Installed agent context

- Package a root `AGENT_CONTEXT.md` with excerpts of canonical platform
  guidance, source paths, line ranges and excerpt digests. Core's installed
  offline `openlup-context` command can find it; check the cited source before
  relying on an excerpt. It adds no dependency or runtime activation.

### Generic risk controls

- Add experimental `@openlup/platform/risk`, type-only `risk/contracts` and
  Node-only `risk/server` entries for risk scoring, blocklist checks and the
  operator review queue. Core risk keeps its existing coordinates and algorithms.
- Expose paid-order assessment, structural native/managed persistence adapters,
  admin list/detail/decision factories and explicit host composition. Reference
  bindings delegate to these entries. Risk remains default-off; importing a
  package installs no route, worker, schedule or second paid-event executor.
- Native and managed behavior remains distinct. Shadow-mode review/block
  decisions can prevent fulfillment without a SQL hold; managed assessment
  fingerprints include the occurrence timestamp, and managed admin readback
  returns `replayed: false`. Review the selected rail and mode before enabling it.
- Migration: Upgrade the complete package set together. `RISK_MIGRATIONS`
  projects the unchanged native post-order control catalogue unit; it is not a
  standalone installation chain. Install the complete same-rail canonical
  catalogue and verify its prefix and inventory before selecting risk. Hosts
  supply authorization, trusted actor mapping, clients, hash secret, schema
  readiness and explicit mode; no SQL forward is introduced by this set.

### Privacy composition

- Add a bounded experimental risk privacy contributor for the existing identity
  registry. Hosts inject read-only resource access and explicit retention policy;
  unavailable resources or unresolved ownership remain explicit. Retention
  preserves audit, hash, replay and hold-link facts without a default period.
- Export refuses credential payloads. Identity retains authorization, transaction
  rollback and receipt replay. No deletion adapter or managed erasure support is
  added. The inert privacy binding leaves portability deferred unless the host
  supplies its own opaque binding; it provides no transfer or restore capability.

### Documentation

- Clarify that bundle availability batches nonempty SKU requests once per
  response, skips the port for empty requests, and leaves query strategy to the
  injected host port.
- Clarify pricing batch port responsibilities, caller-keyed offer-cache TTLs
  without a distinct-key count cap, policy-readiness retry conditions,
  reference display-only offer use, and the host-owned monitoring check for
  caller-side policy reasons.

## [0.31.0]

- Publishable on the npm `latest` dist-tag as `0.31.0`, from tag
  `openlup-platform-v0.31.0`.

### Runtime and scheduler

- Keep the Node host's local HTTP listener available until admitted scheduler
  callbacks finish, including callbacks waiting for advisory-lock acquisition
  before calling their HTTP compatibility endpoint. Shutdown still attempts
  listener and lock-session cleanup when draining fails.
- Migration: Supply `createPgAdvisoryLock` with a dedicated direct connection or
  session-mode pooler, never `Pool.query` or transaction pooling. If request work
  uses a transaction pooler, inject a separate session connection for scheduler
  locks and a direct connection for migration/admin work. On uncertain lock
  acquisition or session-affinity refusal, drain the host, close its dedicated
  connection and retire any stranded lock backend before restarting. Follow the
  source repository's PostgreSQL connection recipe; finite observations do not
  certify a pooler's future routing.

### Migration admission and qualified reference source

- Hardened migration ledger admission for status, dry-run and apply. Existing
  canonical migration histories retain their exact-prefix and replay boundaries.
- Migration: Migration-runner qualification covers PostgreSQL 16 and 17. Check
  status on the existing installation before applying pending units; other majors
  need separate qualification.
- Pinned name resolution in qualified install owner paths used by acquisition
  and restore operations.
- Migration: The qualified-v2 reference-source PostgreSQL 16 catalogue now has
  92 units, adding runtime completion and the qualified owner-path forward after
  the previously issued 90-unit prefix. Preserve issued migration bytes and
  apply the ordered forwards through the reference binding. Legacy selection
  remains the unchanged 88-unit plan. The qualified migration login still needs
  the declared database-owner SUPERUSER role; runtime and restore remain distinct
  restricted nonowners. Restricted-bootstrap reader preparation does not activate
  a non-superuser installation generation.
- Qualified installation SQL, reference bindings, connected-store adapters and
  portable operations defaults remain source-tree composition. The npm SQL
  projections are not a complete installation or store-transfer catalogue.
  Application upgrade and local handover witnesses establish only their bounded
  profiles. No stable-framework, supported-upgrade, hosted-provider, full-store
  transfer, M14 completion or production-readiness claim follows from this set.
