# M14 legacy installation qualification

Status: development-preview finite observer delivered with C in
[#401](https://github.com/openlup/openlup/pull/401) and package set 0.30.0.
This read-only probe does not enable restricted installation or complete M14.
The [module record](oss-m14-operations-portability.md) owns current D32,
qualified-install generations and source-only follow-ups; the
[C record](oss-m14-lifecycle-task.md) owns combined delivery and recovery.

## Outcome, scope and authority

The human-authorized Master M14 coordinator granted one small actual PostgreSQL
role observation and executed legacy-bootstrap refusal witnesses. Owned source
is `packages/platform/src/lifecycle/postgresInstallQualification.ts`, its unit
and `tests/postgres/m14InstallQualification.test.ts`; shared exports, manifests,
API, SQL and controls required Master's exact integration handoff. C owns app
upgrades, B transfer/objects/effect-time authority, A operations.

The initial local-work/signed-preparation/draft grant was extended by the direct
27 October human grant `01a17c90-a079-7f02-b102-a9e35d770649` through ready,
required source/native admission, merge queue/group checks and confirmed merge
for this same finite M14 programme. It added no scope or native cycles. Scoped
M14 coordination with Master and named E/F source/API/proof handoffs was granted.
Release/npm/deployment, live provisioning, secrets/accounts/settings, real-store
and production actions remain excluded. Exact live head, receipt identity,
expiry and predecessor-on-main checks remain required before external writes.
Queue recovery is at most two retries; no guard bypass, scanning dismissal or
alternate transport after a permission rejection is authorized.

Original isolation was `/private/tmp/openlup-m14-install-qualification`, branch
`codex/oss-m14-install-qualification`, initial code/policy pin
`80d27906a6d4bc679c011871948e88d185bb1c63`. Combined delivery moved to the
existing C worktree on B R2 `f6f0b15c3422dd8e16aea7965b180fc584eb159c`;
original isolation remained provenance. The original four-file untracked handoff
was byte/hash checked; only its root witness's rejected preliminary private
import changed to the declared lifecycle export. HEAD80d never identified those
untracked bytes. Full hashes and exact path mappings remain in the history.
This compaction uses separately supplied fresh policy
`535349050419abe5122bd74fa6766c58947be3dd`, without changing a review base.

## API and acceptance

`inspectLegacyPostgresInstallRoles(db, request)` runs one fixed parameterized
SELECT through an injected PostgreSQL query handle. The caller declares the
migration login, runtime login and installer-managed/operator-provisioned mode.
Both `current_user` and `session_user` must equal the declared migration login;
SET ROLE cannot stand in for logging in as that principal. The legacy bootstrap
also requires the runtime login to be that same principal.

The report's scope is `legacy-fresh-bootstrap-role-prerequisites`. It observes
database/session identities, the selected roles' flags and incident membership
edges in one statement snapshot. Memberships are inventory, not a transitive ACL
or privilege certification. `rolePrerequisitesMet` means only that the finite
legacy role prerequisites pass at observation time. It does not establish schema
inventory, install completion, object ACL correctness, direct/session pooling,
provider support, data import safety or future freedom from concurrent changes.
Driver errors are redacted rather than returning connection diagnostics.

Acceptance: fixed read-only query and bound input; truthful superuser/shared-login/
pre-existing-role/mode refusals; actual PostgreSQL positive and ordinary-login
observations; execution of immutable legacy SQL proving restricted acquisition
42501 and pre-existing actor-role failure before schema writes. Missing Docker
fails the witness. Unit tests cover malformed observations and error redaction.
No synthetic result certifies a hosted provider or an installed runtime grant set.

The smallest adequate implementation is observation over the existing query
handle. No permission broker, grant synthesizer, alternate migration runner,
observed-hash blessing, runtime SQL rewriting or persistent process is added.

## Whole-module dependencies retained

The immutable legacy acquisition foundation requires SUPERUSER, absent capability
roles and sole runtime SET membership bound to CURRENT_USER. Actor bootstrap
unconditionally creates cluster-global anon/authenticated. Their actual owners
remain `db/platform/migrations/20260816140000_acquisition_case_foundation.sql`
and `20260810180001_self_host_actor_auth.sql`; unchanged legacy SQL cannot be
made restricted-compatible by a later forward or this observation helper.

The accepted programme still requires installer-managed and operator-provisioned
installation, separate runtime/direct migration purposes, historical domain
transfer and actual runtime refusal/operation proof. Qualified catalogue/source
selection belongs to its [data owner](../DATA_AND_MIGRATIONS.md#compatibility-lifecycle):
unchanged units plus only exact admitted replacements, honest ledger identities,
explicit generation and matching publication/release/manifest admission. No
whole dump, implicit fallback, skipped/split immutable SQL, observed-digest
blessing, trigger disabling or session_replication_role shortcut is authorized.

Concrete ownership/grantor/membership proof, restricted ownership transfer,
creator ADMIN memberships and final private-owner sealing require actual
PostgreSQL evidence. Temporary membership cannot be sealed before later ownership
transfers. Historical ordinary INSERT can fire lifecycle effects or consume live
subscription receipts; exact history, identities, frozen terms, pending duties,
receipts and late-delivery invariants remain with the domain/transfer owners.
The initial pre/post-data transport idea was an owner decision, never an
implemented shortcut. Current qualified 89/90/91 source and six prior controls
supersede that proposal without changing legacy 88. Published 0.30.0 does not
include the newer 91 tail. No managed/no-super/all-writer or provider-support
completion follows from the finite observer or these source selections.

This dependency analysis records the D checkpoint. For later scope and
ownership, see [D's read-only role observation](../DATA_AND_MIGRATIONS.md#legacy-fresh-bootstrap-role-observation),
the separate [qualified installation lifecycle](../DATA_AND_MIGRATIONS.md#compatibility-lifecycle),
and [F's retained-row routes](../DATA_AND_MIGRATIONS.md#compatible-data-transfer).
The [B transfer record](oss-m14-existing-store-transfer.md) retains the wider
transfer and effect-time obligations; these narrow routes do not establish
full-store or hosting qualification. E's [qualification history](oss-m14-operations-portability.md)
and C's [application-upgrade history](oss-m14-lifecycle-task.md) retain their separate
scope and proof records.

## Execution and evidence

The [immutable full D record](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-install-qualification.md)
retains exact command/log, handoff/source/API/archive hashes, policy reads,
scheduling holds, failures, budgets and remaining-proof notes. Material history:

- Initial Node 24.22.1 ignore-scripts installation was superseded by canonical
  `npm ci` on Node 24.21.0/npm 11.19.0 (eight seconds); no global change. Master
  holds/GO governed heavy work, never elapsed-time or new delivery authority.
- The first Docker-sandbox setup failed with three PostgreSQL cases unexecuted;
  authorized actual access then passed. Original selection was six tests TOTAL:
  three unit plus three PG, 5.12 seconds overall/4.87 seconds PG. Positive
  observation ran in `BEGIN READ ONLY`; actual restricted login produced 42501
  before acquisition writes, preexisting anon produced 42710 before actor writes,
  and SET LOCAL ROLE failed session-login equality.
- Initial lint rejected the root test's private import; it was not a passing
  candidate. Combined handoff changed only that import to the public entry.
  Combined 39-unit proof preceded PG; its pack exceeded all three old C-only byte
  caps. Stop-first refusal was followed by a bounded exact technical read, then
  approved-input remeasurement. Neither file capacity nor past PG implied PASS.
- Two further mandatory lint failures came from owned archival configs and old
  root source under scratch, first ENOENT and then private-import rejection.
  Regroup preserved complete original hashes/paths outside tool traversal;
  no lint ignore, control weakening, source/SQL/API change or cycle reset followed.
- Frozen integrated proof then passed lint (zero errors/33 existing warnings),
  17 browser budgets, 2609 boundary cases, 42/42 combined cases including real
  PG, and 89/89 packed consumer/falsifier cases. Later hostile-search-path
  finding/old-source red/current green and final 45-case proof are retained in
  the [combined C record](oss-m14-lifecycle-task.md#earlier-cd-candidate-working-record-2026-10-27).
  These results belong to their original trees, not the current transfer repair.

The combined technical budget read allowed exactly 1,659,891 code-gzip /
1,932,480 tarball / 8,995,279 unpacked bytes, with actual remeasurement required.
The later explicit owner reserve and all unchanged file/docs/browser constraints
are retained in [C's budget record](oss-m14-lifecycle-task.md#owner-authorized-fixed-byte-reserve-2026-10-27).
No automatic future headroom follows.

Original author `01a1794e-d18c-7200-a544-59abafd34d3a`, master
`01a17909-94d4-7cc0-b40f-9a8782a0986f`, integration coordinator
`01a17945-72cc-71d3-afcf-a8f04fa8503f`, C writer
`01a17946-9893-7a51-a8ea-74d29b00d048` and later actual contributors remain
excluded from independent review. Advisory fit agents were not counted. D had
zero native cycles before consolidation; combined failures/cycles and finding
closure remain in that same append-only native history. No new session or
counter is created by this summary. Changed candidates need two fresh FULL
reviews, material closure and exact required full proof; counted PASS expires
after 24 hours and only an actual owner continuation extends exhausted cycles.

Current migration/runtime/control-witness corrective dependencies remain in progress,
not merged/published.
Historical 91-runtime pilot/review remains old-tree evidence. Current transfer
working proof passed both connected PG cases and 44 filesystem/S3 cases after the
reviewed dependency integration, with lint/types/API/cumulative pack checks;
new native/full verification is still owed. D32, M14/C6 and
whole-installation/support acceptance remain open at the module owner.

Self-retro: keeping finite observation separate from installation admission
avoided a new installer. Combined integration preserved original byte provenance
and distinguished old PG success from fresh artifact proof. Compaction links
that immutable history instead of repeating stale execution instructions; this
documentation edit does not renew the observer proof or change budget/authority.
