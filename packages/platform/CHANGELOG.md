# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

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

## [0.30.0]

- Publishable on the npm `latest` dist-tag as `0.30.0`, from tag
  `openlup-platform-v0.30.0`.

### Qualified reference-source installation and retained imports

Migration: The reference-source PostgreSQL binding still selects the unchanged
88-unit legacy plan by default. Fresh PostgreSQL 16 installations may explicitly
select `qualified-v2` and either `installer-managed` or `operator-provisioned`
roles. The actual migration session must use the declared SUPERUSER login that
owns the database; it may be the cluster bootstrap login or a separate declared
migration login. Runtime and optional restore logins must be distinct restricted
non-owner principals. Admission checks the actual role graph and capabilities;
selection alone establishes no installation or managed-host readiness.

Migration: Qualified bootstrap/runtime SQL and the reference selection binding
are source-tree inputs, not a complete installation catalogue shipped in the npm
package. The E-only 89-unit shape remains a separate historical expectation.
Selecting the retained-import tail requires the explicit restore binding and its
90-unit catalogue. This fresh-generation route does not convert a legacy database.

Migration: The qualified retained-import tail gives the restore login EXECUTE
only on `client_import_retained_row` and
`subscription_cycle_import_retained_row`. These fixed routines insert an absent
row, replay an identical retained row and refuse a differing row with `23505`;
non-`origin` replication mode refuses with `55000`. Ordinary runtime writes keep
their existing lifecycle and delivery-alignment behavior. Restore parents,
history, frozen terms and identity mappings through their existing owners; the
two routines do not provide a full-store restore or stable upgrade service.

### Added

Add the experimental Node-only `@openlup/platform/lifecycle` entry with explicit
application-file snapshot planning and apply. It preserves unmanaged files and
customized upstream-unchanged files, refuses divergent changed paths before
writes, and recognizes exact completed states for interruption/resume. It needs
no optional SDK and activates no route, timer, provider or installer.

The same entry exports `inspectLegacyPostgresInstallRoles` for one fixed,
read-only PostgreSQL role observation through an injected query handle. Its
`legacy-fresh-bootstrap-role-prerequisites` / `rolePrerequisitesMet` result
retains the immutable legacy bootstrap's superuser, shared-login, mode and
pre-existing-role refusals. It adds no DDL, role support or install-readiness claim.

The owner-authorized byte reserve after the direct directory-prefix and catalog
binding repair sets code-gzip 1,743,872 B, tarball 2,029,568 B and unpacked
9,447,424 B caps. The supervisor computed each as 5% above the actual measured
1,660,249 / 1,932,801 / 8,996,893 B, rounded up to KiB. These fixed limits
supersede the historical exact-minimum C+D allocation and grant no automatic
future increases or additional programme scope. Code/total file caps remain
2574/2628; docs/browser caps, released baseline, versions and locks stay exact.
Actual approved-input remeasurement remains required because metadata edits can
change packed bytes; this budget decision establishes no final review or proof.

### Migration

Select this entry explicitly from a Node application. Supply immutable UTF-8
predecessor/candidate snapshots, an absolute canonical root and separately
observed schema-range evidence. Hold an exclusive maintenance window. Apply
rechecks the current tree; a changed managed file with divergent local bytes
requires adopter reconciliation. Existing managed path components must match
their actual directory-entry spelling exactly; a filesystem case or normalization
alias does not authorize changing an unlisted entry. Per-file rename is not an
all-files transaction or a hostile-concurrency/power-loss guarantee. No SQL, dependency install,
version marker or deployment runs, and file completion does not establish their
compatibility or completion. Keep database expand/contract and dependency
provenance work at their existing owners.

- Add an optional trusted-source session admission observation to the experimental PostgreSQL migration runner. It runs once under the existing migration lock after exact-prefix validation and before status, dry-run or pending SQL; existing sources retain their current queries and execution.

### Added

- Experimental operations contracts/browser/server subpaths expose existing
  settings, pipeline-read, alert overview, watchdog delivery and control-plane
  behavior through injected host ports. The public reference binds these owners.

### Migration

- Existing reference imports remain compatible. Select the new operations entries
  explicitly; imports register no route, job or provider. Identity membership and
  tracking effects retain their existing owners.
- Native control-plane storage requires the complete canonical native prefix,
  including the job ledger and `20260814010000_platform_control_plane.sql`.
  The packaged SQL is a sparse unchanged projection. Supply current capability-local
  operator authority, routine EXECUTE and underlying relation grants; no managed
  parity or hosted-provider certification is established.

### Packaging

- Code/total file limits are 2,574/2,628. After the 0.29.0 main integration, the
  operations candidate measures 2,553 code files and 2,607 total files. The remaining 21
  files are allocated to the seven already-authored B/C/D production TypeScript
  files (4/2/1), each packaged as source, JavaScript and declarations. This is a
  finite source-derived forecast, not an executed B–D package result or capacity
  for later modules. Each stacked candidate must pass its actual pack checks;
  additional files or byte-limit crossings need another bounded review.
- Integrated main's byte, documentation-file and browser limits are unchanged.
  Combining or deleting contracts solely to reduce the count would add ownership and proof churn without
  changing the required capability.

### Added

Add the experimental Node-only `@openlup/platform/portability` entry for verified,
bounded object copy/resume and compatible PostgreSQL row capture/restore through
injected transaction handles. Object reads distinguish absent, denied and
unavailable; private filesystem publication preserves bytes, metadata and source
lineage with an explicit process-owner access policy. Row replay is exact and
conflicts refuse atomically; every enabled user INSERT trigger refuses.

Filesystem publication and readback share one encoded-descriptor byte ceiling
covering admitted Unicode metadata; oversize encodings refuse before publication.
Filesystem locators hash JSON-encoded logical keys, preserving distinct admitted
strings including lone UTF-16 surrogates. This first unpublished layout has no
legacy-format migration or fallback.

The bounded M14 B budget reads approved the initial code-gzip minimum of
1,650,493 bytes, exactly 128 bytes for that necessary Unicode repair and 10 bytes
for exact string-key identity. The current measured minimum is 1,650,631 bytes,
cumulatively 2,631 above 1,648,000.
This allocates no additional forecast headroom. Other byte, file, docs and
browser limits and the released baseline are unchanged by this decision; later
candidates still need their own actual package measurement.

### Migration

Select the entry explicitly. Install the canonical target catalogue
and qualify the source/target privileges separately; this API does not install
schema, copy migration ledgers, map managed identities or activate executors.
Changed-row catch-up, guarded-domain import and hosted effect-time fencing remain
M14 dependencies. Local synthetic proof does not certify complete-store transfer,
provider revocation or a stable migration service.

Node host shutdown now fences its stopped scheduler registrations and waits for
admitted callbacks, including pending lock acquisition and asynchronous unlock,
before closing the dedicated advisory-lock session. Other hosts remain excluded
until the running job releases ownership. Shutdown still attempts the listener
and lock cleanup, caches its promise and aggregates failures in the existing order.
PostgreSQL advisory locks now refuse locally pending or held numeric keys,
including colliding job IDs, so a dedicated session cannot reenter a job lock.
Failed acquisition permits a later attempt; failed unlock remains reserved until
the session closes.

Migration: `NodeSchedulerAdapter.stopAll()` explicitly returns `Promise<void>`
instead of `void`. Await it before disposing resources used by admitted callbacks.
It fences/stops current timers synchronously and supports later registrations.
The only in-tree production caller, `createNodeHost`, awaits that drain before
closing the lock; its public `stop(): Promise<void>` signature remains unchanged.
Custom implementations of `NodeSchedulerAdapter` must return the drain promise.
