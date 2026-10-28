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
That delivery is partial M14 evidence; the [Platform release notes](../../../packages/platform/CHANGELOG.md#0300)
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
| E-only qualified 89 | Four historical profile expectations and eight production reference/renamed-target checks belong to their exact E2 source. They are not F90 or current 91 expectations. |
| F qualified 90 | Restore-bound only: aliased migrator `f10dd81aadf543e9b14b5fca30e377c6d0d8689dde379837ad0c145795c09d8f`, separate migrator `d68dd042c487c30b9082cd70103c63de81e2f6ee1754ff52e5961144f172d4b1`. The [once-only reference report](https://github.com/openlup/openlup/pull/404#issuecomment-6451079203) is not target qualification. This is the qualified tail described by published 0.30.0. |
| Source qualified 91 | Preserves every F90 path/hash/position and appends only runtime completion at position 90. Current manifest inventories are aliased `feba6f9f401d749b7f9d3eb5b380e5d1e0eaf9e8322164e282ae8ec82ead388d`, separate `6f58dd8ba4b83c5f73e80f25b2319721c505926d6b7a374d6defe4f6d7fc1efb`. This later source is absent from published 0.30.0. |

The [selected manifest](../../../config/platform-migration-manifest.json) owns
current catalogue bytes. Fresh `qualified-v2` supports the two explicitly tested
role modes with actual declared principals: the migration login remains a
SUPERUSER database owner, and runtime/optional restore logins are distinct
restricted nonowners. It is not legacy conversion, no-super qualification or
managed-host proof. Current session identity, complete role graph, ACLs,
canonical catalog resolution, exact ledger prefix and selected object inventory
must pass under the existing lock. No alias, projector/expectation override,
SET ROLE substitute or fixture grant can qualify the offered runtime.

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
