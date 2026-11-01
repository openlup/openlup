# Operations and existing-store portability

Status: development-preview programme in progress (28 October 2026).
Audience and purpose: contributors recovering the approved M14 scope, current
source/release boundary and remaining proof. M14, C6 and stable-framework
acceptance remain open; source and local evidence establish no supported
hosting, provider certification or managed-installation readiness.

## Outcome and authority

Complete the approved synthetic existing-store outcome: compatible installation
and application upgrade, managed-to-portable and portable-to-portable transfer,
interruption/catch-up/resume, database/object/external-effect recovery and
controlled executor handover. Preserve identity, ACLs, history, active
subscriptions, frozen terms, unsettled amounts, pending duties and
idempotency/outbox/provider ledgers. Domain commands and truth keep their owners.
Executor isolation never pauses a subscription or discards obligations. An
undelivered replacement is never marked delivered; actual late arrival extends
the next cycle later once, without stacking or moving it earlier.

The accountable maintainer authorized implementation and independent review,
with Codex coordinating bounded workstreams. The direct amendment of
27 October 2026 (message `01a17c90-a079-7f02-b102-a9e35d770649`) extended the
same programme from stacked draft PRs through push, readiness, source checks,
native admission, merge queue, group checks and confirmed merge. The later direct
instruction to complete M14 through C6 retains that finite scope. Technical
review is delegated; it does not claim personal human reading of each diff.
Publication dispatch, provider activation, live provisioning/cutover, deployment,
accounts, settings, credentials, other repositories and M19 need their own
applicable authority. The actual 0.30.0 release is a separate completed event;
it grants no future dispatch or promotion.

The active supervisor is Codex context
`01a17909-94d4-7cc0-b40f-9a8782a0986f`. Named source contributors and
coordinators remain excluded from independent review in their existing native
histories. Those histories, exact reviewer identities, findings, owner
continuations, expiry and used repair cycles survive this compaction. Machine-
specific source-only/draft-only holds and later execution grants are historical,
not competing present permissions. This compaction itself is source-only: no
execution, native admission or external write is claimed.

The original source/policy base was
`80d27906a6d4bc679c011871948e88d185bb1c63`. The freshly verified policy pin for
this continuation is `535349050419abe5122bd74fa6766c58947be3dd`, separate from
the original signed transfer candidate
`dcd8971dc8042bfe99cd6be61a2371824b5d8eb3` and its later dependency/review base.
Follow the canonical [freshness](../../../CONTRIBUTING.md#instruction-freshness-and-handoffs),
[native review](../../../CONTRIBUTING.md#native-review-and-accountability) and
[documentation-impact](../DOCUMENTATION.md#impact) rules rather than copied
procedures here.

## Delivered source and current release boundary

Through source `53534905`, thirteen programme PRs had landed. The published
package set is 0.30.0:
[Platform release](https://github.com/openlup/openlup/releases/tag/openlup-platform-v0.30.0),
[Core release](https://github.com/openlup/openlup/releases/tag/openlup-core-v0.30.0)
and [Outbox release](https://github.com/openlup/openlup/releases/tag/openlup-outbox-v0.30.0).
The supervisor verified publication separately from set preparation #407.
That delivery is partial M14 evidence; the [Platform release notes](../../../packages/platform/CHANGELOG-HISTORY.md#0300)
retain package and installation limits. Later source follow-ups, including
qualified runtime completion and connected-transfer repairs, are absent from
published 0.30.0. The delivered application-upgrade proof used the same 0.30.0 package set and
unchanged schema; it did not publish another release.

| Merged PR | Delivered scope | Main merge commit |
| --- | --- | --- |
| [#397](https://github.com/openlup/openlup/pull/397) | Operations A | `80cb0e7063206a9fead36b4e6680c9a83fa3e108` |
| [#400](https://github.com/openlup/openlup/pull/400) | B selected-row/object transfer | `a03d920eec32bfb3d0de90b9a12535cc57f88d53` |
| [#401](https://github.com/openlup/openlup/pull/401) | C+D files and legacy role observation | `35ee4227babaa2fe16f88110af52e61d242b3296` |
| [#402](https://github.com/openlup/openlup/pull/402) | E1 prior controls | `dd6117c4f552fa18e8301bbfed985880784e1755` |
| [#403](https://github.com/openlup/openlup/pull/403) | E2 qualified installation | `83e20493e73be81219b0652f010ea60f0c660a0a` |
| [#404](https://github.com/openlup/openlup/pull/404) | F retained imports | `34dacf747b9e05263ba05c2a4e151436d724ff7d` |
| [#405](https://github.com/openlup/openlup/pull/405) | Runtime drain | `c1ca9994a8e833111e06fd7b280a6bd97c79e7ab` |
| [#407](https://github.com/openlup/openlup/pull/407) | 0.30.0 set preparation | `fea0854a1a5a27c1a48f8c2c9078c618f47f66a3` |
| [#408](https://github.com/openlup/openlup/pull/408) | Executable app upgrade proof | `333ac427b4c62b613d90e1257110f0c6f365cd77` |
| [#409](https://github.com/openlup/openlup/pull/409) | G1 source follow-up | `2b73195a812f56d9b2578d0603fa0cfabd4cae39` |
| [#410](https://github.com/openlup/openlup/pull/410) | Sixth-control reader preparation | `8da4af5a712e22a6fc7b4ba0507e425fdbfe0115` |
| [#411](https://github.com/openlup/openlup/pull/411) | Sixth exact prior pin | `1ef786beaa6c883c5f550923d33b319b0f642d0c` |
| [#412](https://github.com/openlup/openlup/pull/412) | Active qualified runtime91 tail | `535349050419abe5122bd74fa6766c58947be3dd` |

These merges do not complete D32, M14 or C6.

The programme's source owners remain:

| Lane | Current contract and evidence owner |
| --- | --- |
| A operations | [Operations task](oss-m14-operations.md) and [operations architecture](../ARCHITECTURE_AND_EXTENSIONS.md#operations-and-diagnostics): settings, pipeline, alerts, watchdog and control plane through typed injected authority. |
| B transfer/recovery | [Transfer task](oss-m14-existing-store-transfer.md) and [transfer architecture](../ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery): selected-row replay, authenticated object copy/resume and effect-time authority. |
| C+D lifecycle/legacy observation | [Lifecycle task](oss-m14-lifecycle-task.md), [legacy observation](oss-m14-install-qualification.md) and [application-file owner](../ARCHITECTURE_AND_EXTENSIONS.md#application-file-upgrades). File completion and finite role observation are separate from installation readiness. |
| E1/E2/F and runtime completion | [Migration/data owner](../DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories): prior controls, qualified generation, actual runtime grants and retained imports. |
| Runtime drain | [Existing runtime record](oss-m14-runtime-drain-task.md) and [scheduled jobs](../../../packages/platform/README.md#scheduled-jobs). Host disposal does not itself fence external executors. |

Use isolated existing Platform subpaths under the
[package-placement decision](../ARCHITECTURE_AND_EXTENSIONS.md#package-placement-decision-canonical).
Keep browser contracts separate from Node/provider infrastructure. One integration
owner serializes shared exports, manifests, APIs, source/publication descriptors,
reference composition and navigation. Reuse existing migration, scheduler,
identity and domain rails: no second domain engine, generic ETL framework,
universal dispatcher, new proof registry or always-on transfer coordinator is
approved by this record.

## Qualified contracts and retained generation identities

The [six exact prior-approval rows](../../../config/reviewed-platform-forwards.json)
and their [inert whole-byte fixtures](../../../scripts/fixtures/reviewed-m14-qualified/db/platform/migrations/README.md)
remain authoritative source controls. The six units are the qualified baseline,
actor-auth, acquisition foundation, runtime capabilities, retained client/cycle
import and runtime-capability completion. The last two SHA-256 values remain
`56144f8e61b649c9d9f48458a1734abcc8bbd8d36fdc3919d90ceb1bc35d3b48` and
`ec05d0e86a570724fad21916a6fd06976a5e32ae0d0323b1ff902f69c2ae189e`.
Do not repin issued SQL, bless an observed digest, or co-locate new approval with
its qualified SQL or admission machinery. Reader support must land on actual
main before the sixth pin, and the pin before the identical active tail.
[Reader #410](https://github.com/openlup/openlup/pull/410) and
[pin #411](https://github.com/openlup/openlup/pull/411) retain their separate
source/group review evidence; pin main was
`1ef786beaa6c883c5f550923d33b319b0f642d0c`. The trusted old reader's rejection
of six rows before its no-SQL return was a real ordering constraint.

| Selection | Exact scope and evidence distinction |
| --- | --- |
| Legacy 88 | Default remains the immutable 88-unit plan, inventory `cfe3a8b4fa6216f61b1cdd5f004cb0f7a967bc01d9e18ddacb2efee74742d3b3`. Legacy bootstrap SUPERUSER/shared-login/pre-existing-role refusals remain. |
| E-only qualified 89 | Four historical profile expectations and eight production reference/renamed-target checks belong to their exact E2 source. They are not F90 or source-91 expectations. |
| F qualified 90 | Restore-bound only: aliased migrator `f10dd81aadf543e9b14b5fca30e377c6d0d8689dde379837ad0c145795c09d8f`, separate migrator `d68dd042c487c30b9082cd70103c63de81e2f6ee1754ff52e5961144f172d4b1`. The [once-only reference report](https://github.com/openlup/openlup/pull/404#issuecomment-6451079203) is not target qualification. This is the qualified tail described by published 0.30.0. |
| Source qualified 91 | Preserves every F90 path/hash/position and appends only runtime completion at position 90. At that source checkpoint, manifest inventories were aliased `feba6f9f401d749b7f9d3eb5b380e5d1e0eaf9e8322164e282ae8ec82ead388d`, separate `6f58dd8ba4b83c5f73e80f25b2319721c505926d6b7a374d6defe4f6d7fc1efb`. This later source is absent from published 0.30.0. |

The [selected manifest](../../../config/platform-migration-manifest.json) owns
current catalogue bytes. Fresh `qualified-v2` supports the two explicitly tested
role modes with actual declared principals: the migration login remains a
SUPERUSER database owner, and runtime/optional restore logins are distinct
restricted nonowners. It is not legacy conversion, no-super qualification or
managed-host proof. Current session identity, complete role graph, ACLs,
canonical catalog resolution, exact ledger prefix and selected object inventory
must pass under the existing lock. No alias, projector/expectation override,
SET ROLE substitute or fixture grant can qualify the offered runtime.

The separate [restricted-bootstrap task](oss-m14-restricted-bootstrap.md) prepares
a fresh non-superuser installation generation and its own proof. Reader and
inert fixture preparation do not qualify that generation; M14 remains open.

F's fixed import routines retain 13 client and eight cycle fields, precision,
history/frozen terms and exact-row replay; conflicting rows refuse with `23505`,
and non-origin replication refuses with `55000`. Ordinary runtime lifecycle and
alignment triggers remain active. The runtime-completion tail grants only
context INSERT on four columns, UPDATE on three non-key columns and DELETE,
plus review-command receipt SELECT/INSERT. It adds no receipt mutation,
TRUNCATE, role, ownership, RLS, trigger or production API change. Before issue,
recovery may revert the unissued source tail/selection; after application,
preserve its ledger and use a reviewed corrective forward.

## Remaining D32: connected-store transfer and recovery

The connected-native followup started at
`dcd8971dc8042bfe99cd6be61a2371824b5d8eb3`; its bounded source repair now also
integrates the reviewed runtime/control-witness predecessor. Separate corrective
source work is in progress;
it is not merged or published. After the exact reviewed runtime/control-witness
predecessor was integrated, the current working tree passed both connected
PostgreSQL cases, including trigger tamper and pre-existing-obligation refusal,
plus 44 filesystem/S3 cases, lint, five type projects, three APIs and actual
cumulative pack/browser limits. These are working observations, not fresh native
review or full verification. The earlier one-case runtime91 pilot remains
attributed to its preceding tree. All-writer, application and external-effect
continuation source is still unintegrated/unexecuted.

The owner-approved [connected-native trigger boundary](oss-m14-existing-store-transfer.md#connected-native-candidate-explicit-trigger-boundary-2026-10-28)
is separate from generic B, which continues to refuse **every** enabled user
INSERT trigger. Connected-native admits only the exact complete selected
qualified inventory and seven listed triggers, with target locks before catalogue
inspection and retained-data writes. Names alone never admit changed bodies.
Its one current-transaction compensation may remove only the precisely matched
new historical-hold notification absent from the source census; retained,
pre-existing or divergent obligations refuse/roll back. Final comparison covers
all 73 retained tables, unchanged catalogue/ledger and preserved installation-key
tuple identity without reading its payload. The host must actually exclude
writers and DDL, retain the migration lock/transaction and keep target serving
inactive through database and filesystem publication. The administrative M-super
profile establishes no all-writer, no-super or managed guarantee.

D32 still owes the complete connected outcome and its sufficient evidence:
managed identity/history mapping; domain-owned import-safe routes; source-write
catch-up including updates/deletions; remote authenticated object traversal,
byte/version/effective-ACL reconciliation, privacy and installation-key
continuity; old-executor exclusion and
accepted-before-ACK/late-effect recovery across actual restored domain databases;
and installation-specific recovery point/time. Ordinary sign-in reconciliation
is not issuer migration. Independent database locks cannot fence an old process;
pause it after admission immediately before actual egress, hand over, then resume
it and observe actual refusal. Startup-only/cached checks and synthetic provider
proof cannot establish hosted enforcement. Existing compatible-row and local
filesystem proofs are narrower than this denominator.

Next work remains bounded to closing approved D32 acceptance and necessary
source recovery. Current trigger-tamper/unknown-trigger, retained/pre-existing
obligation and pruned-history compensation witnesses have working PASS; two fresh
FULL reviews and complete final verification still require the exact committed tree.
No source update, generated metadata, old pilot or earlier receipt waives that
proof or authorizes a live store action. Remaining M14 evaluation/default,
installation, app-upgrade and recipe obligations keep their owning lane; C6 and
stable-framework acceptance cannot be inferred from thirteen merged PRs.

## Proof and verification

Use existing package/installed-consumer and disposable PostgreSQL harnesses with
neutral fixtures and actual intended principals. Evidence must exercise allowed
operations, neighboring/absent-grant refusals, exact numeric/time/identity values,
replay/conflict, interrupted resume, and complete retained count/value/ownership/
ACL/object reconciliation. Owner observations cannot substitute for restricted
runtime execution. Missing Docker fails the applicable witness. Application
file planning does not prove schema compatibility, dependency provenance or
rollback of durable data.

Run existing cheap contract/artifact/platform checks before broad gates, freeze
tracked inputs and serialize phases sharing outputs. Full clean native
verification, coverage, two independent fresh FULL reviews for material/control
changes, stabilized API/control/budget/recovery reads, actual predecessor landing
and live receipt/head/expiry preflight remain required under canonical rules.
At least one reviewer considers the smallest adequate alternative. Existing
resource locks and limits apply; this record creates no test matrix, gate or
review-budget extension.

## Measurements and completion evidence

### Test ledger

Configured counts are separate from executed results. The original baseline was
`80d27906a6d4bc679c011871948e88d185bb1c63`. A's selected addition was at least
172 cases (84 boundary plus 88 operations); B's was 39 (13 boundary, 25 new
runtime-file and one cold-consumer case). Thus at least 211 selected additions
were observed, not a measured whole-root increase. The
[pinned original test ledger](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-operations-portability.md#test-ledger)
retains collection/delta SHA-256 identities and multiset comparison corrections.
Whole-root configured delta and comparable hosted timing remain UNKNOWN.
PROC28.8's +100-case/+30-second target applies after post-C6 cleanup, not as a
new pre-C6 gate or permission to remove characterization.

The approved Platform reserve remains code-gzip 1,743,872 B, tarball 2,029,568 B
and unpacked 9,447,424 B; code/total file limits remain 2574/2628. Historical
combined E2/F working packs were 1,662,140/1,935,102/9,006,345 B with 2574/2628
files. Runtime completion's pack was byte-identical, with zero file headroom.
Those measurements remain source-attributed historical feedback, not current
transfer pack proof or automatic budget. Actual candidate artifact/browser/cold/
installed/full proof remains with its delivery owner.

### Material failures, retries and history

The [immutable pre-compaction record](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-operations-portability.md)
retains exact candidates, authors/exclusions, commands, raw-evidence locations,
measurements and failed attempts. These records remain evidence, not executable
current instructions or renewed PASS reports:

| History | Material result and accounting retained |
| --- | --- |
| A/B/C+D | A's 21,386 PASS/6 FAIL required inventory/reference repairs. A's owner continuation extended its existing cycle 3 limit from 3 to 6 solely for necessary integration/repair/proof. B's descriptor-size `B0-S1` and surrogate-key `B1-I1` failures, their red/green repairs and exact-minimum caps remain in the [B record](oss-m14-existing-store-transfer.md). C+D's catalogue binding, prefix and Unicode findings remain in its [record](oss-m14-lifecycle-task.md), including historical FAIL reports and cycles. No closed candidate's budget becomes a new candidate's allowance. |
| E1 | Historical 739 PASS/16 FAIL lacks the original errno and is not reclassified. A later sandbox run observed bind EPERM; the identical authorized unsandboxed selection passed 23/23. Fragment/PATH failures, regroup, 50-attempt/seven-probe socket budget, 787-byte cap refusal and later approved predecessor reserve remain [pinned history](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-operations-portability.md#e1-authorized-verification-continuation-27-october-2026). |
| E2 | `E2R0-R-1` identified missing actual-R proof of three approved lock exceptions; one PASS and one FAIL at cycle 0/3 did not establish acceptance. TS2305 stopped the next phase before PostgreSQL; the existing contract entry repaired witness composition. Full 9d26edb then stopped at 22,111 PASS/1 FAIL/2 optional skips because the witness used a generic lane outside its owner. The owned diagnostic/privacy bindings repaired it, retaining cycle 1/3 and requiring fresh review/full proof. [Exact history](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-operations-portability.md#e2-restricted-runtime-lock-evidence-repair). |
| F | Four preliminary production cases reached 90 rows then failed 42501 from using restricted R for an administrative setter; one explicitly bounded repair rerun passed using admin fixture setup and asserting R refusal. Later full 04cff4fe stopped at 22,108 PASS/13 setup-unexecuted/2 optional skips: its legacy SQL fixture incorrectly copied the union manifest. Selecting the canonical legacy fixture repaired the cause; cycle 1/3 remained. [Exact fixture history](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-operations-portability.md#f-standalone-legacy-prefix-fixture-repair). |
| Runtime completion | Initial duplicate-fixture failure was repaired in test only; Docker preflight left four cases unexecuted before authorized transport recovery. Later four production cases passed in 46.49s and selected legacy/prefix/session cases 31/31 on their original inputs. An escaping concern was refuted by actual bytes and created no defect or cycle. [Exact runtime history](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-operations-portability.md#runtime-completion-28-october-2026). |

The [E1 historical handoff](https://github.com/openlup/openlup/pull/402#issuecomment-6449955741),
[coordinator handoff](https://github.com/openlup/openlup/pull/402#issuecomment-6449957049)
and [C+D FAIL handoff](https://github.com/openlup/openlup/pull/401#issuecomment-6449877511)
remain public evidence. A's final source candidate was
`22ddaae6f824f113e101045986f207ec3477365f`, tree
`fadf212905718fb9c244cbea77d4f5d0182bfdbd`, with material findings closed at
cycle 5/6 after its actual owner continuation. Its historical earliest PASS was
`2026-10-27T08:11:05.741Z`, expiring `2026-10-28T08:11:05.741Z`; neither is
current transfer evidence. Recorded final histories are C+D #401 2/3, E1 #402
0/3, E2 #403 2/3, drain #405 0/3, set preparation #407 1/3, app proof #408
0/3 and G1 #409 0/3. Reader #410 0/3, pin #411 1/3 and active SQL #412 2/3
share one append-only history, with actual FULL reviews and fourteen-phase
verification PASS at their own checkpoints. The
[#412 receipt](https://github.com/openlup/openlup/pull/412#issuecomment-6472292064)
retains its exact admission evidence; source run `40710039773` and group run
`40711706365` each had all 12 required checks succeed. Those completed deliveries
do not refresh the current transfer candidate.

Report expiry is 24 hours after the earliest counted
PASS for the current candidate. Missing current expiry/counter evidence refuses
delivery; this compact page supplies no synthetic timestamp, review receipt,
cycle reset or owner continuation. Three automatic repair cycles and two queue
rebuild retries retain their existing accounting; only an actual bounded owner
continuation extends cycles in the same native history.

Self-retro: repeated integration transcripts obscured the current source/release
boundary. One current record with pinned history preserves failures and authority
without making old measurements look like proof of the repaired transfer tree.
No implementation, test, review or delivery result was created by compaction.

### Qualified owner path hardening (F5)

Status: control preparation landed in [PR #418](https://github.com/openlup/openlup/pull/418),
and exact forward approval landed in [PR #420](https://github.com/openlup/openlup/pull/420).
The active SQL checkpoint is prepared for its separate maintainer read. The bounded outcome is to pin name resolution in the owner-executed
acquisition and retained-import paths of the current qualified-v2 installation.
Preserve its issued 91-unit prefix and six approval rows; introduce only one
separately reviewed forward with exact function and file identities. Both
declared role modes retain their ordinary behavior.

Bart Roszkowski is the accountable owner. The active supervisor may prepare,
verify, commit, submit and merge this parcel after the required read and native
review. Release dispatch, npm publication, deployment, settings, credentials
and adopter activation remain separate owner actions. The corrected package
release is outside this parcel.

Acceptance requires the forward to change only the fixed owner-executed
definitions, keep selected metadata, migration ledger and object inventory
coherent, and pass real PostgreSQL negative and ordinary behavior proof on
both affected paths and role modes. Existing source controls and package gates
remain binding. First deliver the fixed forward reader as a separate control
change, then bind the exact forward and prove the qualified chain. Adjacent M14
work may require a signed main integration and renewed review. Execution
evidence and a short self-retro will be recorded here at completion.

Control-preparation checkpoint: the pre-integration tree passed 26 focused
tests, native review by two fresh reviewers and canonical verification with
pgTAP. Main then added the restricted-bootstrap reader on overlapping control
paths. Its required signed integration caused three textual conflicts; the
resolved working tree keeps the six active approvals and the 91-unit selected
qualified plan. The pending qualified forward takes approval position seven,
before the five restricted-bootstrap reservations. It has no active
SQL or pin in this control preparation. The integrated control needs its own
maintainer read before DCO, review and verification.

Self-retro for this stopped run: the pre-integration proof could not carry over
the overlapping reader landing. Resolving its fixed approval order in one
control change preserves the existing qualification boundary; the integrated
tree needs fresh evidence before delivery.

Control delivery: corrected tree `2dcd783a1a0f1994e237065d3a44cc2a259414a2`
passed two fresh FULL reviews and canonical verification with pgTAP. Source and
merge-group checks passed; PR #418 merged as `bc4299bba72aff58159c2739e81a6b69f507b900`.
The next checkpoint adds only the exact seventh approval and an inert copy of
its forward bytes for review. The current selected plan remains 91 units; SQL
introduction and installation proof are the later checkpoint.

Pin delivery: the approved pin tree `de0e1d8904af5b451dfdf3e0149c023045451711`
was integrated with main without changing the nine-path F5 delta. The integrated
tree `cd86ab561f80dbfea2d0c7d92d3f85afa2e09e8a` passed two new FULL
reviews and canonical verification with pgTAP. Source and merge-group checks
passed; PR #420 merged as `3fbd95565ed665c68f3819a9fe27dc14f5bf9c85`.
The seventh approval and inert fixture are now on main; the SQL checkpoint
selects the byte-identical forward as unit 92 and binds its measured inventories.

SQL checkpoint preparation: the active forward is byte-identical to the seventh
approved fixture and appends unit 92 after the issued 91-unit prefix. Fresh
PostgreSQL 16 installations measured inventory SHA-256
`c4f6bb9daa5882877149a78e13d07594b7e8653c3a3ba39f508477b072548f9b`
for the aliased bootstrap/migration shape and
`624cc57789e3aaf36d0b61bdad420fc4eb0b63c2a7eb09358e5c18240ec13f82`
for the separate migration shape, identically across both declared role modes.
The four-case composition passes status, apply, replay, owner-path resolution
and ordinary runtime and restore behavior, with unchanged selected metadata,
ledger and inventory after the regression probes. The package dry run still
measures 2,628 files against its 2,628-file cap, so no budget change is needed.
The active SQL and package change note await a separate maintainer read before
DCO, review, verification and delivery.

Self-retro for this stopped checkpoint: extending the existing four-case
production composition covered the new owner paths without creating a second
installation harness or changing the issued qualification prefix.


## Corrected package-set preparation S1 (29 October 2026)

Outcome: prepare the coherent development-preview set `0.31.0` for Core, Outbox
and Platform from the corrections and runtime changes after the `0.30.0`
release source `fea0854a1a5a27c1a48f8c2c9078c618f47f66a3`. Platform's behavior
changes require a minor set; Core and Outbox republish unchanged with exact
internal pins. npm observations on 29 October found `0.30.0` as the highest
version of each package. This preparation publishes nothing.

Bart Roszkowski authorized the active supervisor as single writer for local
preparation, signed commits, push, PR, receipt, queue and merge after the required
maintainer read and gates. The programme coordinator retains dispatch; the owner
retains protected release approval. No dispatch, npm publish, credentials,
settings, deployment, adopter activation or other repository is in this task.
The active supervisor context is `01a185a8-a347-7c52-b44b-c716d4785e3c`.
Policy revision and initial source base are
`9690386f6d25324bf7cc7a448c7277d9278d98f0`.

Scope follows preparation PR #407: versions and locks, three packed changelogs
and source-only histories, version-specific READMEs, previous-release artifact
baselines, consumed fragments and the generated source release contract. This
section is the single task record. Fixed caps, dependency selection, runtime,
API and SQL implementation remain unchanged by S1. Security-correction notes
use neutral descriptions only.

Acceptance: coherent versions/pins, empty Unreleased sections, verbatim history
rotation, all three existing Platform fragments consumed, accurate adjacent
upgrade notes, integrity-verified `0.30.0` artifact baselines and fresh source
contract. Published tarballs measured Core 167,200 B, Outbox 39,217 B and
Platform 1,930,457 B; their registry SHA-512 integrity was verified against the
actual fetched bytes. All existing caps remain binding.

Proof plan: policy/inventory/neutrality, structural scan, redacted secret scan,
working-tree artifact/content/browser checks and lint before the stabilized
release-control read and DCO. After that read, two fresh FULL native reviewers
(one assessing simplicity), canonical verification including cold package gates
and pgTAP, then normal source/group checks through confirmed merge. Verify the
merged main contexts, cold release-set audit/artifacts and tarball secret scan,
then generate shared notes from that commit and hand off the exact `all`, version,
commit and note bytes for dispatch. M14 and C6 retain their existing remainder.

Working checkpoint: versions/pins, manifest checks, history rotation, source
snapshot, inventory, tree/UI neutrality, structural scan and redacted working
patch/history secret scans passed. Lint passed with zero errors and 33 existing
warnings. Three focused files passed 66 tests in 3.07 seconds, including all
17 browser entries. Working artifacts passed content, growth and fixed caps:
Core 167,346 B / 224 files; Outbox 39,168 B / 41 files; Platform 1,933,379 B /
2,628 files, code gzip 1,669,813 B and unpacked 9,000,038 B. These previews do
not substitute for the committed cold proof. Policy has three answered owners
and one pending scoped repository no-impact trailer: lock changes alter only
workspace versions and exact internal pins, so existing contributor checks,
dependency selections and runtime instructions remain correct. No DCO, native
candidate, review, canonical verification, PR or release is claimed. The required
release-control read precedes sign-off.

Self-retro for this stopped checkpoint: one 60-second admission wait serialized
artifact tests behind another task. Reusing the set-bump helper and previous
preparation's file shape avoided a new release mechanism; published registry
byte measurements remain distinct from working-tree estimates.

## Package-set release preparation S1 — 30 October 2026

Outcome: prepare development-preview `0.33.0` for the complete publishable
inventory: `@openlup/core`, `@openlup/outbox` and `@openlup/platform`.
The release comparison is `eb1a0584f035774251a8c296e82f3b9ffd68180b`
(`0.32.0`) through the integrated `origin/main` at
`4fd84bfead64e11f76e0555117fe072d39807182`.
The independently fetched initial instruction revision was
`6700bcfe7cc63eca7d2bbbd466ebf1daa364ef88`; it was not a review receipt.
Platform adds company-identity and market-pack subpaths and fixes Node scheduler
stop behavior, requiring a minor set under the package release policy. Core's
installed context CLI and generated guidance change; Outbox's generated guidance
changes. The policy still requires all three packages and exact internal pins
to advance together.

Bart Roszkowski delegates this S1 lane through the programme coordinator to the
active supervisor as single writer: local preparation, required read packet,
DCO commits after that read, native review, verification, push, PR, receipt,
queue and merge after passing gates. Two fresh FULL reviewers are required,
one also assessing the smallest adequate solution. The coordinator dispatches;
the owner approves the protected release. Dispatch, npm publication/account
operations, credentials, settings, deployment, adopter activation, other tasks
and other repositories remain excluded. The S1 queue freeze exempts this lane.

Scope follows preparations #440 and #424: versions/locks/pins, three package
changelogs and source-only histories, versioned READMEs, generated package agent
context where affected, measured previous-release baselines, consumption of
`m14-10s`, `m16-r1` and `m16-r2`, and the source-release contract snapshot.
S1's release preparation adds no runtime, API, SQL, dependency selection or
release workflow change; the integrated main includes Core context CLI behavior.
Caps remain unchanged unless an actual overflow needs a measured increase of
`ceil(measurement * 1.02)` in the stabilized maintainer read. The complete source
interval also includes reference-source portability/recovery/local self-host
proof and CI CLI pinning; it does not turn those into npm installation assets.
Hosted recipe receipts and stable-framework or production qualification are
excluded from the release claims.

Acceptance: coherent `0.33.0` manifests and locks, empty Unreleased sections,
accurate adjacent upgrade notes, all three fragments consumed, previous sections
preserved verbatim across history rotation, integrity-verified `0.32.0` artifact
baselines, and a fresh source snapshot. Existing release/fragment/size/source
checks discriminate wrong pins, lost history, stale bindings and cap overflow;
no new test mechanism is needed for this metadata-only change.

Proof plan: cheap inventory/policy/neutrality/structural and redacted secret
checks, existing focused release tests, serial working artifact/browser checks,
strict project typecheck and lint before the stabilized release-control read.
Snapshot the exact tree to a private WIP ref without DCO and stop for that read.
After resumption: DCO, two fresh committed native FULL reviews, canonical
`node scripts/verify-local.mjs --pgtap` including cold package gates, then source
and group checks, receipt and confirmed merge. Prepare notes from the merged
CHANGELOG sections and stop with exact dispatch inputs; preparation publishes
nothing. Load admission and one heavy stage per machine remain binding.

Registry checkpoint: each package's highest version and `latest` are `0.32.0`.
Downloaded tarballs pass their registry SHA-512 integrity: Core 182,424 B,
Outbox 40,849 B, Platform 1,967,831 B. These are prior-release baselines,
not candidate measurements. The first candidate later passed two native FULL
reviews without a repair cycle; these figures precede main integration.

Pre-read evidence: all three serial package builds pass. Working-tree previews
fit every unchanged content/class/file/byte cap and all 19 browser-entry caps:
Core 182,463 B / 229 files; Outbox 40,840 B / 42 files; Platform 1,984,671 B /
2,720 files, 9,253,032 B unpacked and 1,714,668 B code gzip. No cap increase or
release growth explanation is needed. These are uncommitted previews, not cold
committed proof or registry publication. The `0.32.0` tags all resolve to the
previous release commit above, and the three fetched baseline tarballs retain
their registry integrity evidence under ignored scratch.

All five TypeScript projects pass with zero unresolved edges or consumer errors.
Lint passes with zero errors and 33 existing warnings. The four existing bump,
fragment, artifact-size and source-preparation suites pass all 75 tests (6.32 s).
Set/pin, empty-Unreleased, rolling history and consumed-fragment assertions pass;
released note bodies and prior history remain unchanged apart from the packed
EOF separator. Inventory, manifest-only, source-snapshot, structural, tree/UI
neutrality and redacted history/patch secret checks pass. Catalogue-first
navigation regeneration introduces no new public path or catalogue row.

Policy identifies five owner obligations. Three are answered by adjacent package
README updates; two require scoped commit trailers after the required read:
Outbox's version/exact Core peer and the root lock's workspace versions/internal
pins change no command, external resolution, export, runtime or SQL. The
contribution checks remain accurate. The prepared trailer text is included in
the private read packet; the pre-DCO policy result intentionally retains these
two unanswered obligations. History rotation also corrected the existing link
to archived `0.30.0` notes. No required failure is waived.

The first release-control read accepted tree `a99ad962e3099da4017153eb3d8eb347f1d9e879`
and diff SHA-256 `511d806256bdbeefcbae06ec67757f9a004ab088ad5e7211226b24da0efddadb`.
It was DCO committed as `41bcc2a3f7a246041d16e67a51e37d88250aeca5`
with both accepted documentation-impact trailers. Two fresh native FULL reviews
passed with no findings and no repair cycles. No PR, receipt or queue retry exists.

The first complete canonical verification passed phases 1–9, then failed a Core
consumer test because supervisor-supplied `TMPDIR` was inside the checkout.
The corrected full rerun used the macOS user temp directory; its preflight
stopped at build because `origin/main` advanced to `4fd84bfe` and carry-over
conflicted. Both reports remain in ignored S1 scratch; neither is a passing
canonical verification.

Main's #450 adds installed `openlup-context` routing, nested-section and opt-in
package-code search behavior to Core, with tests, generated guidance and owner
documentation. Its Core Unreleased note moves into `0.33.0`; README and generated
contexts describe the integrated installed behavior. The in-progress `--no-commit`
merge resolves Core CHANGELOG and Core/Outbox generated context conflicts, and
regenerates the source-release snapshot. CD-M14-30 cannot waive a new maintainer
read: the merge required manual resolutions in release bytes, so its
conflict-free condition fails. Its old-base patch-id excluding this record is
`97f76b9b6d216528ef9378c67ff2c850d183727d`; the integrated patch-id on
`4fd84bfe` is `0ec0b62f92ca51eb3db5ba3d247ad8e044f8446f`, also unequal.
The merge parents are `41bcc2a3f7a246041d16e67a51e37d88250aeca5` and
`4fd84bfead64e11f76e0555117fe072d39807182`. The old native reviews cover
the first candidate only. Stabilize the integrated tree, request another
release-control read, then
DCO commit the merge, obtain two fresh FULL reviews and rerun canonical proof.

Integrated pre-read checks: the refreshed source snapshot, catalogue navigation,
documentation impact policy and exact package manifests pass. Strict typecheck
passes all five projects with zero unresolved edges or consumer errors; lint has
zero errors and the same 33 warnings. Serial package builds pass. Working pack
previews fit every unchanged cap: Core 183,160 B / 229 files, Outbox 41,496 B /
42 files, Platform 1,985,197 B / 2,720 files, 9,254,969 B unpacked and
1,714,668 B code gzip. All 19 browser entries pass. No CD-M15-6a cap increase
is needed. These are previews before a new read and cold committed proof.
The four release preparation suites pass all 75 tests on the integrated tree.
The merged Core CLI and generator behavior remains for post-read canonical
verification; no separate pre-read qualification is claimed.

Self-retro: about 16 minutes of resource admission dominated preparation; the
existing policy link check caught the archive-link correction before the read.
Reusing this task record and existing release tools avoided new public files or
verification machinery. Keep history rotation and link checking together.
The failed consumer test exposed an unnecessary TMPDIR override; using the
system user temp directory fixed that setup error. Main movement invalidated
the first proof attempt and review candidate; merge preflight caught it before
submission.


## Package-set release preparation s034 — 31 October 2026

Outcome: prepare development-preview `0.34.0` for the complete publishable
inventory: `@openlup/core`, `@openlup/outbox` and `@openlup/platform`.
The comparison is the `0.33.0` release commit
`591a8ec46d3cd74f7047b2a44ea4a50649158690` through main at
`aa745acdb2bed92e7d2b76747f02032963e3a58e`, also the current instruction
revision, separate from the forthcoming code-review base.

Bart Roszkowski delegates this release lane through the programme coordinator
to the active supervisor as single writer: local preparation, stabilized read,
DCO after that read, two fresh parallel FULL reviews, canonical verification,
push, PR, receipt, queue and merge after required gates. The coordinator owns
release dispatch; the owner retains protected approval. Publication, npm account
operations, credentials, settings, deployment, adopter activation and other
worktrees or branches are excluded. Three automatic repair cycles apply; any
further continuation requires the owner route. No release is dispatched here.

Measured package scope: ten changed Platform paths, two production files, one
marketing test, four API reports, one fragment, README and generated context.
The optional measurement consent policy changes the public API, requiring a
minor set. The README also documents the existing minimum peer-release age
in the consumer proof; the context delta updates source line metadata only.
Core and Outbox have no package changes since `0.33.0`. No migration changed.
Reference-source transfer, recovery and storage work outside the packages is
not a shipped package capability of this set and receives no release claim.

Smallest complete scope follows #456: coherent versions, exact internal pins
and lock carriers; consume `independent-measurement-consent`; rotate packed
changelogs with prior sections preserved in source history; update versioned
README/context text; refresh prior-release baselines and the source contract.
Use the existing bump, history, context and snapshot routes, with no new
mechanism, API, SQL, dependency selection or workflow. Raise a cap only after
actual overflow, to `ceil(measured * 1.02)`, included in the required read.

Acceptance: all three manifests and locks at `0.34.0`, exact internal pins,
empty Unreleased sections, accurate consent-mode and host-duty notes, consumed
fragment, byte-preserved historical note bodies, verified `0.33.0` baselines,
and fresh source snapshot. Existing bump, fragment, artifact-size and source
preparation witnesses distinguish wrong pins, lost history, stale snapshots
and cap overflow; metadata preparation requires no new test mechanism.

Proof plan: inventory/policy/navigation, neutrality, structural and redacted
secret checks, focused release suites, serialized package artifact and browser
measurements, strict typecheck and lint before the stabilized maintainer read.
Snapshot the exact tree privately without DCO and stop for that read. After
resumption: DCO of that tree, sensitive native prepare, two fresh full reviews,
canonical `node scripts/verify-local.mjs --pgtap` including cold package gates
with system TMPDIR, then required source/group checks and queue admission.
After merge, verify the actual-main set and prepare notes and exact dispatch
inputs, with publication still reserved. Release-control errors can misstate
consumer upgrade actions or refuse preflight; before publication, revert this
preparation if necessary. Mandatory failures block delivery.


Pre-read evidence: npm reports `0.33.0` as latest and highest for each package.
All three tags resolve to the previous release commit above. Fetched tarballs
pass registry SHA-512 integrity: Core 183,171 B, Outbox 41,549 B and Platform
1,986,429 B. These replace only the `0.32.0` baseline records; fixed code,
docs, tarball, unpacked, file and browser caps remain unchanged.

All three serialized builds pass. Working artifact previews pass content,
growth and every unchanged cap: Core 183,113 B / 229 files; Outbox 41,533 B /
42 files; Platform 1,985,626 B / 2,720 files, 9,257,083 B unpacked,
1,715,302 B code gzip and 55,395 B docs gzip. All 19 browser entries pass.
These are working previews, not committed cold proof or publication evidence.
The four existing release-preparation suites pass all 75 tests (5.57 s).
Strict typecheck passes all five projects with zero unresolved edges and
consumer errors. Lint passes with zero errors and 33 existing warnings.
The seven serialized pre-read stages take 84 seconds after 181 seconds of
initial resource admission waiting. No cap raise or growth explanation is needed.

Set/pin, empty-Unreleased and fragment-consumption checks pass. Prior released
note bodies and existing history remain byte-identical, with only the packed
EOF section separator normalized. Inventory, source snapshot, structural,
tree/UI neutrality and staged/full-history redacted secret checks pass.
Navigation regeneration adds no public path or catalogue row. Three of five
documentation obligations are answered by adjacent package READMEs. The two
remaining scoped trailers, planned for DCO after the required read, explain
that Outbox's exact peer/version and the root lock's workspace versions/pins
change no contributor command, dependency selection, export, runtime or SQL.
Their owner section remains correct. The pre-DCO policy result intentionally
retains those two unanswered obligations; no mandatory failure is waived.
No DCO, native review, canonical verification, PR, receipt or release is claimed
at this read checkpoint. Automatic repair cycles consumed: zero of three.

Self-retro: the three-minute initial admission wait dominated the 84-second
pre-read stages. Reusing the bump and history-preservation route, existing
artifact discriminators and one task section avoided new release machinery.

## Account newsletter withdrawal

Outcome: a portable PostgreSQL account newsletter opt-out made after this change
must make the native consent evaluator refuse `marketing_newsletter` for
evaluator-accepted emails whose database `lower()` agrees with JavaScript `toLowerCase()`, without
creating or weakening another consent. All evaluator-accepted boundary whitespace
is trimmed identically; database-dependent case mapping remains a stated limit. The bounded delivery is an admission-only
change followed by a body-only setter forward, one real-PostgreSQL witness,
required manifest/catalogue/package assets, a pending change fragment, an operator
upgrade statement and affected owner documentation. Historical reconciliation is
excluded from the forward. Managed SQL, baselines, evaluator/policy, acquisition,
retention, provider integration, versions and releases remain unchanged.

The owner delegated local preparation and subsequent gated submission/queue
delivery to one supervisor, with admission delivered first. A combined maintainer
read of both local trees precedes DCO and native review. Release, publication,
credentials, settings and hosted activation remain excluded. The current main and instruction pin is
`fcbaacdf3183bc1c26f023b97248cdf678471171`. The fix belongs to the next set;
the prepared `0.34.0` set does not contain it.
The `0.34.0` set from `fcbaacdf` was published without this fix, which ships in the next set.

Within that email-normalization boundary, every false call must deny
absent/granted newsletter permissions,
preserve denied/suppressed rows and never decrease consent timestamps. A true
call leaves all consent rows unchanged: after opting out and back in, evaluation
continues refusing until a separate explicit grant, although account read-back
reports the preference. The account response and managed setter name only
`marketing_newsletter`, with managed copy version
`customer_account_marketing_newsletter.v1`. Retention creation and claim require their own explicit
grant. The packaged-writer/customer-copy audit is complete, with the source
facts below. Pre-change SQL/JavaScript fingerprint parity passes for mixed-case
and non-ASCII uppercase addresses on all seven selected installation shapes.

The initial admission probes found the non-expand-only and function-identity
boundaries. The owner approved one fourth fixed replacement slot and narrow
identity handling for exactly this signature, preserving earlier slot positions
and refusing unrelated boolean/default identities. Admission is prepared in its
own tree; both working states explicitly merge current main without DCO.
Branch heads remain at their original base until the read. One combined maintainer read remains pending. All three automatic
repair cycles cover the whole change across both deliveries; none is consumed.

Source audit: the packaged acquisition grant path accepts only newsletter and
launch-offer purposes. Native preference synchronization accepts only denials or
suppressions for newsletter, launch-offer and tester purposes; reconciliation
writes suppressions. No packaged writer grants `retention_marketing`. Its creation
and claim both require their own explicit granted row. A host capturing that
purpose owns its withdrawal. The account UI submits only the newsletter boolean;
its visible copy uses host translation keys, with no supplied text promising
that this switch covers all marketing.
Known limits: this setter registers no external provider synchronization; earlier
opt-outs do not override an existing grant automatically. Operators have
an exact idempotent upgrade statement in the data guide, with its own witness. An email-change
witness confirms that a denial remains keyed to the old normalized-email
fingerprint; a different normalized email reads a different key.

Both assigned worktrees retain their original branch heads. Installation completed
in each. The admission slot's 11 focused tests and full 686-test admission regression
pass, along with strict five-project typecheck, lint (zero errors, 33 existing
warnings), structural checks and neutrality. Policy passes on its exact unsigned
snapshot with the proposed scoped documentation trailer, before DCO.
The real setter fails first on all seven shapes: an account opt-out leaves the
newsletter row granted. Legacy fixture roles are composed only after exact canonical installation
and replay; qualified roles retain their production installation contract.
No DCO, native review, submission or canonical verification is claimed.
The seven-shape real-PostgreSQL matrix passes before the main merge (43.60
seconds on the resumed run): legacy;
qualified-v2 installer-managed and operator-provisioned with bootstrap and
separate migrators; qualified-admin installer-managed and operator-provisioned.
Each uses the real restricted actor/auth context and evaluator, checks definer
INSERT/UPDATE authority, mixed-case and `Ä` fingerprint parity, atomic rollback,
absent/denied/suppressed/granted behavior, unchanged-preference withdrawal,
older timestamps, non-granting opt-in, other purposes, evaluator-refused email, manual
upgrade boundaries (including equal timestamps) and idempotent replay.
The three mutation probes fail at their intended behavior assertions: no consent
write leaves a grant; admitting suppression downgrades its row; skipping repeated
false calls leaves a later grant. The unmodified witness is restored byte-for-byte.
The actual email-change case keeps the old denial while a separate grant for the
new email is allowed. The upgrade statement runs through the declared migrator,
not a compensating host runtime grant. The exact catalogue hashes were measured
on all seven real installation shapes before their manifest pins were updated.
The forward contains
no set-version or publication-budget condition, and no cap increase is proposed.
Baseline Platform packing measures 1,986,181 packed bytes, 9,258,510 unpacked
bytes and 2,720 files (2,664 code files; 1,715,302 code gzip bytes), within every
unchanged cap. The pending change fragment applies to the set carrying this
forward, without assigning a release version.

Self-retro: tracing the real header exposed the exact admission boundary before
implementation. Initial fixture failures showed why the legacy inventory must
precede host runtime grants and why principal uniqueness must be retained. The
corrected fixture uses the existing boundaries rather than changing production
controls. Shared resource admission, including a measured 391-second wait, is
serialized; broader admission regression took 327.24 seconds.

Fixture regroup: an initial legacy runtime role before installation changed the
inventory, and later GRANT/REVOKE left stored ACLs during post-behavior replay.
The remaining gap belongs to fixture ordering, not the forward: observe exact
installation/replay while the canonical catalogue is intact, then compose the
restricted legacy host login for actor/evaluator behavior. The passing full matrix
preserves both proofs. Lesson: host fixture ACLs inside a canonical observer
→ finish canonical replay before composing those ACLs.

Current-main integration: both working states merge the fetched main above
without rebasing. Admission merges and applies cleanly. The combined tree has
only a task-record EOF conflict, resolved by preserving both appended sections
verbatim. No control or migration conflict occurs. The inherited source release
contract, package versions, release caps and consumed changelog content remain
exactly main's. Forward version `20261030110000` passes the manifest
evaluator and three-generation exact-prefix history on that main.

Current-main proof passes: the full admission regression has 686 passing cases
(337.50 seconds), including all eleven new refusal/success cases; the seven
installation shapes pass again in 43.59 seconds. Strict typecheck on both trees
has zero unresolved edges or consumer errors. Both lint runs pass with zero
errors and the same 33 existing warnings; structural and tree/UI neutrality
checks pass. The complete Platform suite passes all 7,630 cases with two workers,
with every assertion and default timeout retained, followed by API validation.
The default-worker run had one unchanged fulfillment stress-case timeout;
the full bounded-worker rerun passed. An earlier lint execution error came from
removing a temporary policy export during its scan; serializing those phases
produced the passing lint run without a configuration or source exception.

Same-main Platform pack measurement is 1,985,626 bytes / 9,257,083 unpacked
bytes / 2,720 files before this fix and 1,986,557 / 9,261,193 / 2,721 after it.
Code gzip is 1,715,526 bytes and documentation gzip 55,564 bytes after the fix;
every unchanged cap passes. This is 931 packed bytes and one file added. No
set-version or budget condition enters the forward. Admission and policy proof
use exact exported unsigned snapshots: admission-only over current main, then
the combined fix over that predecessor. No DCO, native review, canonical full
verification, submission or hosted admission is claimed at this checkpoint.
The full read packet binds both trees and proposed documentation trailers.

Self-retro at this checkpoint: canonical replay before fixture ACL composition
kept authority and inventory proof distinct. Temporary policy exports must finish
before lint begins. All three whole-fix repair cycles remain available.


Unicode-whitespace repair (cycle 1 of 3): both independent native cards identify
the same reachable SQL/JavaScript trim mismatch. The extended existing witness
derives all evaluator-accepted trim characters from the runtime and fails first
on the unchanged forward: U+00A0 and U+FEFF leave the evaluator grant active.
The cycle-1 body-only replacement used the same explicit escaped trim set for
its fingerprint and then-existing address check; the operator statement uses that
normal form too. Cycle 2 removes that address check.
The function header, attributes, evaluator, acquisition and other functions stay
unchanged. Canonical/package SQL and all byte-bound pins are re-derived.

Case-mapping measurement uses PostgreSQL 16.15 on its pinned image,
`en_US.utf8` / libc collation version 2.41, against Node 24.21.0 / Unicode 17.0.
All 297,333 PostgreSQL-representable assigned Unicode scalar values are placed
at both ends of an address's local part (594,666 addresses); NUL and the 2,048
surrogate code points cannot be represented as PostgreSQL text and are excluded.
There are 30 differing code points and 59 differing address results:
U+0130, U+03A3, U+A7CE, U+A7D2, U+A7D4 and U+16EA0–U+16EB8.
These include common Turkish `İ` and context-dependent Greek `Σ`, not only newer
letters. A real C-locale UTF8 database leaves `Ä` uppercase while JavaScript
produces `ä`. This residue also exists in the acquisition normalization; this
repair does not change case folding. Evaluator refusal is guaranteed only where
the database and JavaScript lowercase results agree. The fragment and upgrade
guide state this boundary, and the installed README upgrade link is absolute.

Self-retro for this repair: installation-shape breadth shared the same narrow
normalization samples; deriving the accepted trim class tests the actual identity
boundary without extending the evaluator. The measurement's first C-locale
metadata query used an unavailable setting name; querying the database catalogue
instead produced the complete result without changing any product code.

The first repair lint run refused a private package-helper import in the root
witness and diagnostic script. The witness now derives acceptance through the
public evaluator and compares the SQL hash with its recorded decision fingerprint,
which is the real nativeFingerprint(nativeEmail(address)) result. It verifies the
specific control-character refusal before excluding a runtime trim candidate;
other errors still fail. No export, import exception or copied validator was added.
The executed diagnostic source remains archived as private evidence.

The first full package run caught the remaining old digest in the communications
migration tuple (7,629 tests passed; its one asset-integrity test refused). The
tuple and generated API literal are refreshed from the same canonical SQL hash;
no tuple identity, path, position or API structure changes.

Repair proof: the final public-boundary witness passes all seven existing install
shapes in 43.20 seconds, deriving the same 20 accepted trim characters per shape
and checking both string-literal settings. All four mutations fail at their
intended behavior assertions, including reverting to plain btrim. Strict
five-project typecheck and lint pass; lint retains 33 existing warnings and zero
errors. Platform build, all 7,630 tests and API validation pass with two workers,
retaining all assertions and default timeouts. Platform packing measures
1,986,625 packed bytes, 9,261,482 unpacked bytes and 2,721 files, within every
unchanged cap. The final unsigned tree's policy, admission and package results
are bound in the second read packet. Repair cycle 1 remains pending its read,
DCO and fresh native review; both original cards remain open until that review.
Self-retro: derive identity inputs through the public evaluator and refresh every
SQL-byte consumer, including the exported tuple and generated API literal,
before the broad gate. No new helper export or case-mapping mechanism is needed.


Address-selection repair (cycle 2 of 3): two independent cards identified the same
locale-dependent predicate outside the accepted lowercase/UTF8 limits. The lead
ruled that the duplicate predicate protects no requirement and must be removed,
not aligned. The only setter-body change removes the regex line; selection now
uses only the principal ID. The evaluator's acceptance rule is deliberately not
copied into SQL. Clients retain their nonnull/nonempty email invariant; a denial
for an evaluator-refused address sits under a fingerprint the evaluator never
reads and does not change its refused answer. No locale guard, replacement regex,
new class, evaluator change or operator-statement change is introduced.

The new legacy-only database case uses the existing container, pools and install
runner to create a UTF8 database with deterministic ICU en-US default collation,
without a fixture seam or extra role privilege. On the unchanged forward, the
real authenticated actor leaves the U+0085 address's evaluator grant active;
the failing-first assertion reports granted instead of denied. The seven existing
installation shapes remain selected alongside this additional locale case.

Self-retro: duplicated validation created an unnecessary selection boundary.
Removing it leaves one address-acceptance owner in the evaluator and tests the
complete selection-to-fingerprint-to-denial path. Accepted case mapping and UTF8
limits remain unchanged. One cycle remains after this repair; a fresh material
mechanism requires owner regroup before any further repair.

Repair-cycle-2 proof: all seven original installation shapes plus the additional
legacy ICU locale case pass in 47.07 seconds. All five mutations fail at their
intended assertions, including restoration of the exact preceding predicate.
The refused-address case writes preference, event and denial while preserving
its evaluator refusal and every other consent row. Strict five-project typecheck
and lint pass, with zero errors and 33 existing warnings. Platform build, all
7,630 tests and API validation pass with the existing two-worker selection and
unchanged assertions/timeouts. Packing measures 1,986,589 packed bytes,
9,261,268 unpacked bytes and 2,721 files, within unchanged caps.
Exact unsigned-tree policy, admission and package evidence is bound in the third
read packet. No DCO or new native review is claimed before that read.
