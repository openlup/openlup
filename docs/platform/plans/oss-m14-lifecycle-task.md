# M14 C: application lifecycle task

Status: development-preview source delivered. The combined C+D slice landed in
[#401](https://github.com/openlup/openlup/pull/401) and package set 0.30.0;
the executable application-upgrade proof subsequently landed as source in
[#408](https://github.com/openlup/openlup/pull/408). Later source is not part of
the published 0.30.0 artifacts. The [module record](oss-m14-operations-portability.md)
owns the 13-PR delivery summary, remaining D32 and current source-only follow-ups;
M14/C6, provider support and whole-store transfer remain open.

## Outcome and authority

The first C outcome is conservative application-file upgrade in an existing
application outside the platform workspace: explicit predecessor/candidate UTF-8
managed files, customization preservation, pre-write refusal and exact-byte
resume. D contributes only its read-only legacy PostgreSQL role-prerequisite
observer and refusal witnesses. Database evolution and runtime drain have their
own owners; neither API certifies qualified installation.

Master M14 coordinates the finite programme. The 27 October human grant
`01a17c90-a079-7f02-b102-a9e35d770649` extended the original draft endpoint
through ready, actual source/native admission, group checks and confirmed merge.
The subsequent direct instruction to complete M14 through C6 preserves that
ordinary reviewed delivery route. It grants no production promotion, real-store
cutover, new accounts/settings/credentials, publication dispatch, stable-framework
claim or M19 work. Temporary source-only and no-test/checkpoint grants in the
historical record remain attributed to those turns; they waived no delivery proof.

Original C isolation was `/private/tmp/openlup-m14-lifecycle`, branch
`codex/oss-m14-lifecycle`; initial code/policy pin was
`80d27906a6d4bc679c011871948e88d185bb1c63`. The executable proof's code and
separate policy pin were `4ff46904029c1cb9b388ed6c1cf07ac53b0296fd`.
This compaction's separately supplied fresh policy is
`535349050419abe5122bd74fa6766c58947be3dd`; no review base is changed.
This documentation-only compaction asserts no new test, verification,
installation or delivery result.

## Smallest complete scope and acceptance

The implementation belongs at the isolated Node-only
`@openlup/platform/lifecycle` subpath, using existing exports, API, boundary and
installed-consumer infrastructure. No independent package, optional peer,
runner, dependency, arbitrary hook or new schema mechanism is justified.

`AppVersionSnapshot` declares a version, caller-defined integer schema range and
finite managed-file contents. `planAppUpgrade` only reads; `applyAppUpgrade`
recomputes preflight rather than executing an old serialized plan. Both snapshots
must admit the caller-observed schema version. This proves range admission only,
not database compatibility or an observed migration/backfill result.

Required witnesses cover a real temporary application outside the repository;
preservation of unmanaged brand/policy and upstream-unchanged customized files;
create/replace/remove and replay; stale-plan and divergent-file refusal before
any writes; interruption/resume; byte-exact comparison; canonical roots,
traversal, normalized aliases, links and file-parent collisions. Apply requires
an exclusive maintenance window. Per-file rename provides a local atomic file
replacement, not an all-files transaction, hostile concurrent-writer protection,
power-loss durability or npm installation.

Simplicity pre-check: compare explicit old/current/new bytes using native fs
operations. Already-completed bytes provide resume state without a persistent
journal, lock, source-merging engine, scaffolding framework or new dependency.
Do not execute SQL, npm, deployment or arbitrary hooks from this API. Adopter
customizations in a changed managed file require human reconciliation, while an
upstream-unchanged file carries no authority to overwrite its customization.

## 2026-10-28 continuation: executable application upgrade proof

Finite scope: extend the existing cold native PostgreSQL scenario with two
executable releases of one outside-workspace application, using the installed
operations and lifecycle entries. The canonical migration runner observes its
complete actual ledger and object inventory before fixture grants; that observed
88-unit count supplies the schema ordinal. Both app releases use this unchanged
schema and selected package set. A real restricted application login writes and
reads control state. Managed-file conflict and incompatible range refuse before
writes; a SIGKILL after an actual rename interrupts execution; exact resume runs
the new release; compatible code rollback leaves durable data unchanged. Adopter
theme and unmanaged brand remain. No new runner, database matrix, runtime API,
migration, dependency, package cap, version, fixture bypass or database rollback
mechanism is added. Explicit disposable application grants are not a claim about
the qualified-install role profile.

Historical working evidence before DCO: own Node 24.21.0/npm 11.19.0
installation from lock,
AST, policy/navigation, inventory, full lint, five-project typecheck, all three
package API checks and actual working-tree artifact/browser selection pass.
The latter executed 21 selected assertions; 25 unrelated assertions were filtered.
The new consumer also passed the complete existing cold installed/native route
against preserved, verified published 0.30.0 artifacts from
`fea0854a1a5a27c1a48f8c2c9078c618f47f66a3` in 29.692 seconds. Its actual app
1.0.0→1.1.0 result records schema 88, login `m14_upgrade_runtime`, revision 2,
SIGKILL/resume and code-only rollback. This working trial is not exact-candidate
final proof. Raw commands, exits and streams remain in the owned task scratch.
Policy's first unanswered routing-owner failure is retained and resolved by the
substantive ownership explanation; no gate or baseline was weakened.

Simplicity pre-check: reuse the existing installed consumer, native database,
canonical schema observer and gateway type adapter rather than a scaffolder,
synthetic migration or parallel upgrade framework. Preliminary read-only source
fit caught a plain driver's timestamp decoder mismatch; composing the existing
installed gateway overrides fixes the application readback. This is not counted
native review. Final #408 candidate `66abc461` had two fresh FULL PASS reports
and all 14 canonical phases PASS at cycle 0/3 before merge `333ac427`. It proves
the executable application and compatible code rollback on the same packages
and schema; it does not verify a later candidate. Review cycles, findings and
24-hour expiry remain bound to their actual append-only native history.

## Earlier C+D candidate working record (2026-10-27)

This section summarizes dated history, not the current candidate. The
[immutable complete record](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-lifecycle-task.md)
retains all intermediate source/tree/artifact identities, exact command outputs,
actor exclusions, handoffs, failed attempts and native findings. The
[historical FAIL handoff](https://github.com/openlup/openlup/pull/401#issuecomment-6449877511)
retains the restored session/intent/two-report bytes. Its hash-checked restoration
was data recovery, never preparation, finding closure or review renewal.

Material findings and recovery remain part of the same history:

| Finding/failure | Necessary recovery and evidence boundary |
| --- | --- |
| Early C-E1 malformed UTF-16 paths could encode to one UTF-8 name | UTF-8 round-trip validation for paths and contents; focused alias refusal without mutation. Early source feedback was not counted native review. |
| Initial symlink witness timed out (34/35) | Test inventory changed to `lstat` recursion without following links; 35/35 then passed. No production fix or waived case. |
| C-P1 managed parent spelling/ownership and CDR0-A-1/CDR0-B-1 prefix omission | Existing preflight gained one normalized-prefix/exact-spelling map across both snapshots. Old source admitted absent `A/one.txt` and `a/two.txt`; corrected source refused before writes and retained exact-prefix replay. |
| D CDR0-B-2 hostile search path | D's single fixed SELECT binds functions, types, operators and relations to `pg_catalog`. Actual old-source red falsely reported restricted login as superuser/admissible; the unchanged native case passed current source. |
| CDR1-A-1/CDR1-S-1 sigma/final-sigma collision | One mechanism: native aliases wrote successfully then refused identical replay. Existing NFC/lowercase identity expressions gained uppercase consistently for files and parent prefixes, preserving earlier equivalence/refusals. Actual old-source red/current green and fresh-build 45/45 followed. |
| Three combined pack caps exceeded | Stop-first refusal, then bounded technical read and actual remeasurement; no inferred file-cap headroom. Later explicit owner reserve is below. |
| Two lint obstructions from owned historical configs/source under scratch | First ENOENT config, then immutable deep import. Required regroup moved only the complete owned archival inventory outside tool traversal with exact hashes/path mappings. No ignore/control weakening. |
| Load admission timeout / Docker setup refusal / unsupported strip-only probe | No started workload or unexecuted case was called PASS. Authorized own-fixture transport/transform recovery and exact provenance remain in the full record. |

Original D proof was six tests TOTAL (three unit and three actual PostgreSQL),
not six of each. Combined progression was 39 unit, then 42/42 including actual
PG and 89/89 packed consumer/falsifier; repaired source later passed 45/45 with
four PG cases. These observations retain their original frozen-tree attribution,
not a passing stamp for the current transfer correction. The installed observer's
finite report never meant installation readiness.

## Owner-authorized fixed byte reserve, 2026-10-27

The owner explicitly allowed a suitable future-session reserve after reading
the packet. The supervisor computed `ceil(measured * 1.05 / 1024) * 1024`;
computed values are evidence, not an owner quotation:

| Dimension | Prior cap | Measured repaired artifact | Fixed approved cap |
| --- | ---: | ---: | ---: |
| Code gzip bytes | 1,659,891 | 1,660,249 | 1,743,872 |
| Tarball bytes | 1,932,480 | 1,932,801 | 2,029,568 |
| Unpacked bytes | 8,995,279 | 8,996,893 | 9,447,424 |

This was one bounded reserve, not an automatic percentage increase. Code/total
files 2574/2628, docs 73,728 bytes/ten files, browser caps, baseline, package
versions and lockfiles stayed unchanged. Final Unicode-repair working pack
measured 1,660,263 / 1,932,817 / 8,996,949 bytes within those caps; lifecycle
API remained SHA-256
`786e4874f6fca5a2037bf5010d5dc332315eb1a7b6e3005f6d8a666e11b12e13`.
The full record preserves each earlier exact-minimum read and failed measurement.

## Review, delivery and remaining dependencies

Original actors include master `01a17909-94d4-7cc0-b40f-9a8782a0986f`, C
coordinator `01a17945-72cc-71d3-afcf-a8f04fa8503f`, C writer
`01a17946-9893-7a51-a8ea-74d29b00d048` and D writer
`01a1794e-d18c-7200-a544-59abafd34d3a`. Receiving supervisor and repair
contributors, verification contributors and all earlier author/coordination
contexts remain excluded from independent review, as enumerated in the immutable
record and native intent; this summary does not replace that actor inventory.

C+D retained cycle 0/3 and both FULL FAILs during restoration; the next evaluation
closed CDR0 cards and left the paired CDR1 cards at cycle 1/3. The Unicode repair
was allocated the next candidate, cycle 2/3, without reset or owner continuation.
Passing working proof did not itself close native cards. Final #401 evidence
records all material cards closed at cycle 2/3, two fresh FULL and two fresh
integration PASS reports. Full anchor
`07cad9930ece5ce2835f725f5b8c39df76599d87`, tree
`a9596a826dd1d22afa255130554526bd6f5cde12`, passed all 14 phases (22,042 root
cases plus two skips; pgTAP 226 files/5199 assertions). Final head
`b040add7f9fbc5cdd461881f09421cb0a6700145` retained that anchor and inherited
expiry through mechanical integration with 67 focused cases PASS; no full rerun
or copied verification stamp was claimed. The PR merged as `35ee4227`.
Earlier or later candidates cannot borrow that evidence.
Two fresh independent FULL reviews (one testing simplicity), all material
findings closed, required clean-tree native/full/cold/coverage proof and live
receipt/head/expiry preflight remain required for changed candidates. Earliest
counted PASS expires after 24 hours; three automatic repair cycles and any actual
owner continuation remain append-only. Queue rebuild recovery is at most two
retries and does not reset native cycles. A rejected external-write permission
cannot be retried through another transport.

The [module record](oss-m14-operations-portability.md) and canonical
[data/migration](../DATA_AND_MIGRATIONS.md#compatibility-lifecycle) and
[runtime](../RUNTIME_AND_SELF_HOSTING.md) owners retain installation, historical
transfer, executor exclusion/reconciliation, restricted role and provider proof.
Legacy 88 remains immutable; qualified 89/90/91 are distinct selections under
six prior source controls. Published 0.30.0 and later 91-unit source must not be
conflated. This app proof's explicit disposable runtime grants do not establish
qualified role support. Current migration/runtime/control-witness corrective dependencies are in progress,
not merged or published; historical runtime-91 pilot/review belongs to its old
tree. The current transfer correction has working PASS on both connected PG
cases and 44 filesystem/S3 cases after the reviewed dependency integration,
with actual lint/types/API/cumulative pack checks; fresh native/full proof remains due. D32 still needs end-to-end connected native-91/data/object transfer,
effective identity/history/privacy/key continuity and storage/access mapping,
all-writer exclusion and effect recovery. The finite native-73/media/tmp/S3
adapter and old native-91 pilot/44 filesystem-S3 cases do not settle those
obligations. The manifest/trigger-owner correction and new tamper/preexisting
obligation assertions passed working proof; app/all-writer/effects source is wired but
unintegrated and unrun. Bootstrap without superuser is separate. No managed/
no-super/all-writer, whole-M14/C6 or support claim follows.

Self-retro: existing preflight, query qualification and canonical fixture seams
resolved the demonstrated failures without new runners or controls. Keeping
immutable chronology behind a compact current record prevents stale proof and
source-only follow-ups from being mistaken for delivered acceptance. This edit
ran no executable proof and resets no finding, retry budget or expiry.

## Runtime drain owner

The separate [runtime-drain record](oss-m14-runtime-drain-task.md) concerns
local Node callback and lock draining. See the [scheduled-jobs boundary](../../../packages/platform/README.md#scheduled-jobs)
for its limits; old-host effect fencing and accepted-before-acknowledgment
reconciliation remain with the [transfer boundary](../ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery).
