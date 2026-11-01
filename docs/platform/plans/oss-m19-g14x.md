# Bundle admin write-store export

Status: repair validated; delta-only coordinator read pending before fresh reviewers (2026-11-01).

## Outcome, scope and authority

Expose the existing PostgreSQL bundle admin write binding through
`@openlup/platform/catalog` for installed consumers: create/update drafts,
composition, target price, clone, activate/deactivate, archive/restore.
This is the export portion of M19 G14, rows T03-32 through T03-40. The first
commit preserves behavior and identity; the separately approved native JSON
encoding repair below is the only behavior change. Transaction ownership and
error/factory identity remain unchanged.

Worktree: `oss-m19-g14x`; branch: `codex/oss-m19-g14x`.
Code base and freshly fetched policy revision are independently recorded as
`bb0008481a11267ec6dbe3e7e531299777cddc19`.
The worker implements under the stores supervisor. Programme authority covers
local edits, focused checks, independent review and conditional delivery for this
row. The supervisor cleared unchanged declaration moves with reference re-exports,
disjoint shared-file hunks, the catalog documentation corrections and the minimum
catalog-to-data runtime lint edge. The facade authority question is resolved.
The stabilized public API/control read precedes DCO sign-off and commit; the
identity witness must then be committed and independently reviewed. Canonical
verification and landing wait for the lead's named slot. Publication, release
dispatch, credentials, settings, hosted resources and adopter changes are excluded.

No SQL, migration, injection seam, structural replacement class, managed refusal
change, new native checkout or other store row is included. The sole authorized
behavior exception is the native JSON encoding repair recorded below.
The human authorization and mutation/activation gates remain host-owned.
An actor identifier is routine input, not authorization. Preserve the existing
sequential replay boundary; add no concurrency or hosted qualification claim.

## Before-touch confirmation and placement

The assigned matrix was correct: the constructor and shared writer existed in
reference source but were not public package exports. Catalog already exported
the write port and handlers. The shared writer constructs BundleRpcError, whose
DomainRpcError base is used by the reference response mapper's instanceof check.

Use the existing catalog server entry for the writer, native pooled binding and
both constructors. This exposes the generic base solely as the existing bundle
error's inherited contract; its placement was accepted with the limit below.
Move the exact AgentReason union to catalog/contracts and re-export it from the
browser reference to avoid a server runtime edge. No new package or subpath.

The initial ownership stop and later shared-file stops for lint and the package
guide were resolved by direct supervisor decisions. Shared files are now checked
with other workers' HEAD-relative zero-context diffs: stop only for overlapping
lines or required reordering/reformatting. G12's lint additions and the G12/R0/kit
README edits are disjoint from this row. No other worktree is modified.

## Actual reference changes

- `server/adapters/postgres/bundleAdminWriteStore.ts`: re-export.
- `server/adapters/bundleAdminWriteStore.ts`: re-export.
- `server/domains/bundle/adminBundleWritePort.ts`: re-export.
- `server/_lib/admin-domain/rpcErrors.ts`: re-export the moved class and import rewrite for local use; mapper body unchanged.
- `src/lib/agent-domain/lifecycleRules.ts`: re-export the unchanged AgentReason type.
- `server/adapters/README.md`: documentation update for the native writer's package ownership.
- `src/domains/bundle/README.md`: documentation update linking the export and identity witnesses.

Boundary-lint loosening: the existing catalog graph row moves data from types
to values because the unchanged native constructor calls the data transaction
lane at runtime. Leaving it in types would still prohibit the value import.
Data depends only on kernel, so the added value edge is acyclic. The adjacent
comment distinguishes injected-executor reads from pooled writes. No other
rule or graph row changes; reviewers and the API read must assess this loosening.

The catalog package README corrects only the now-false writer/error ownership
sentences. The package reference explains the existing role-free lane and host
boundaries. Publication catalogue and release evidence receive this row's
additions only; no existing inventory is reordered.

## Acceptance and sufficient evidence

| Boundary and credible failure | Discriminating proof |
| --- | --- |
| Relocation changes arguments, normalization, defaults or errors | Byte-equal donor body checks; unchanged native/managed shared contract suite |
| Public entry creates duplicate constructors or breaks old-path instanceof | Root identity witness catches a packaged error through both old paths, checks mapped status/body, and runs real Node against emitted JS |
| Installed artifact leaks workspace code or loses declarations | Own tarballs installed into scratch; realpath checks and NodeNext/Bundler compilation of public exports |
| Writer bypasses grants or loses durable replay/rollback | Complete qualified-v2 chain, separate restricted runtime login, nine installed mutations, permission/rule/absence refusals, dry run and one-row replay ledger assertions |
| Packaging or dependency boundary drifts | Public typecheck, lint, API snapshots, real base/candidate pack measurement and unchanged caps |

Existing `server/adapters/bundleAdminWritePortContract.test.ts` and
`tests/postgres/bundleNative.test.ts` stay byte-unchanged and must pass.
The new witnesses are `tests/postgres/m19BundleWriteIdentity.test.ts`,
`tests/postgres/m19BundleWriteExport.test.ts` and the package smoke test
`packages/platform/test/catalog/bundleAdminWriteStore.test.ts`.
Release gates register the consumer and identity evidence on the affected entries.

## Current execution and handoff

Donor comparisons PASS: both complete store bodies, both class declarations,
AgentReason union and response mapper body are byte-equal. Only the necessary
imports change. Syntax checks PASS for moved stores and new root witnesses.
Publication policy/docs-update has run; five delta-bound no-impact trailers are
prepared in ignored scratch for the first signed commit after the API read.
The remaining owners retain unchanged runtime, browser, capability and test
semantics; the lint loosening is separately disclosed. Pending trailers mean
policy is not yet PASS. Navigation generation has no new tracked output.

Focused execution used Node 24.21.0 and npm 11.19.0. Dependency installation,
package builds, additive API snapshots, ast-grep scan, public typecheck and lint
PASS. Lint reports zero errors and 33 warnings; no optional cleanup was made.
Seven focused files PASS (96 cases): package smoke 1, identity 2, unchanged
native/managed contract 72, unchanged RPC mapper 6, unchanged lifecycle 4,
unchanged human bundle handlers 6 and unchanged native PostgreSQL suite 5.

The installed tarball witness compiles in both NodeNext and Bundler and installs
the complete qualified-v2 chain. Through the actual restricted runtime login it
proves no elevated role flags, forbidden ledger writes, successful draft create,
update and create replay, constraint read and absent-bundle refusal. It then
FAILS at setComposition with SQLSTATE 22P02, invalid input syntax for type json.
Remaining price/clone/lifecycle and composition-replay assertions are not reached;
the required nine-mutation installed proof is incomplete. Owned containers and
pools were closed/removed on both attempts.

### Functional blocker and matrix correction

The unchanged shared writer passes p_components as a JavaScript array to the
native transaction lane. PgGatewayClient passes that array as a pg parameter;
pg encodes it as PostgreSQL array text, not JSON. The routine parameter is jsonb,
so PostgreSQL refuses it before executing the routine. The exact same donor body
exists at the code base; this is an existing binding defect exposed by the new
installed proof, not an authorized behavior change made here.

The original native SQL suite supplies JSON.stringify itself; the shared contract
uses a scripted pool and never exercises pg input encoding. Their green results
therefore do not establish that this adapter can set composition on a real driver.
Matrix row T03-34 requires an encoding repair in addition to an export; the
matrix's source-only binding classification is incomplete for that operation.
Do not narrow acceptance or claim functional qualification from the pure move.

The coordinator packet asks about the public API/error placement and lint edge,
and requests a bounded decision on native-only JSON argument encoding. No repair
is implemented: it would change a moved body and exceed the pure-move grant.
Managed marshalling and SQLSTATE translation remain byte-unchanged; no SQL or
migration is changed. No DCO, commit, native review or canonical verify proceeds
while this mandatory proof is red. Repair/review cycles used: zero.

### Package measurements and failed attempts

Real packs compare the assigned base with this row only. Packed bytes:
2,102,771 -> 2,109,002 (+6,231); unpacked bytes: 9,809,502 -> 9,835,583
(+26,081); files: 2,840 -> 2,855 (+15). Candidate code is 1,815,885
compressed bytes / 2,796 files; docs 58,111 bytes / 6 files. Every existing
package budget passes; no cap change is proposed. Aggregate programme growth is
owned by coordination and is not inferred from this row's measurement.

Focused admission waits were 542 seconds (timeout behind an earlier verifier),
243 seconds for dependency install, 152 seconds for build/pack, 30 seconds for
type/lint and 335 seconds for serialized tests. The first test launcher lacked
npm's local binary PATH; correcting invocation required no source change. The
first installed witness wrongly expected the runtime to lack ledger SELECT;
it was corrected to probe forbidden ledger UPDATE with WHERE false. The rerun
then reached the actual JSON failure. These fixture corrections add no grant,
setup seam or production change. The initial documentation-only run also corrected
catalogue placement/staging before its policy pass.

Self-retro: the real installed-driver witness caught a gap hidden by scripted
adapter tests and owner-issued SQL. Keep argument serialization in the tested
boundary; do not replace the mandatory failing proof with a fixture workaround.
Disjoint hunk ownership avoids repeating file-level stops. The authorized pure
move and all passing evidence remain staged for the coordinator's bounded read.


## Coordinator answer and two-commit continuation

The coordinator accepted the existing catalog placement and the catalog-to-data
lint edge, and explicitly authorized two signed commits: first the unchanged move
with the identity witnesses and five recomputed documentation trailers, then a
native-only encoding repair with real-driver red/green evidence. The known red
installed proof is deliberately preserved in the move commit; this later direct
grant permits that first commit without pretending that acceptance is complete.

Recorded placement limit: promotions already takes DomainRpcError as an injected
constructor, and root CatalogRpcError extends the class. If a second package
module ever needs it, it moves to a lower entry with catalog re-exporting the
same class, never a copy.

Only packages/platform/src/catalog/postgresBundleAdminWriteStore.ts may change
production behavior for the repair. Shared writer, managed marshalling,
SQLSTATE translation, roles and SQL remain byte-unchanged. Cover every jsonb
argument: p_composition_constraint and p_metadata in
`db/platform/migrations/20260812210000_bundle_operator_write_boundary.sql:90`
and `:91`, and p_components at `:170`. No jsonb parameter is excluded.

The root PostgreSQL facade inherits THE ONE behavior change: setComposition goes
from always failing to working on the native rail. Encoding the other two JSON
arguments preserves their existing JSON value semantics and null/default behavior.
No other operation or refusal semantics are authorized to change. Any further
real failure stops this continuation for the supervisor.

The repair needs a fresh delta-only API read before fresh-context reviewers.
No final verification, landing, queue action or publication is authorized at
this stop. Native review/repair cycles remain zero; prior failures and proof
are retained above and in ignored read-1 evidence. All existing source and
policy pins remain unchanged on this resumption.


## Repair execution

The unchanged move is DCO-signed commit
`1a7648fd1fe3fd40c0ff0e27d764ae2b6f52197a`, tree
`a3a6c058087b5d4c3da9760c0d85ddf62a3723a4`. Its five documentation
trailer identities were recomputed and matched the read-1 packet before sign-off.
The committed identity witnesses are included. The committed ref passes gitleaks.

Only the native store's rpc binding changes production behavior: it copies the
arguments and JSON.stringify-encodes each non-null/non-undefined value for the
three jsonb parameter names. Missing arguments and SQL NULL are left alone;
all non-JSON arguments, transaction use and gateway error translation are untouched.
No jsonb argument from the cited migration is omitted. Shared writer, managed
adapter, error constructors, roles, SQL and migrations remain byte-unchanged
against the move commit. The root PostgreSQL facade is unchanged and inherits
THE ONE native behavior change: setComposition now works instead of always failing.

The expanded installed witness at `.context/scratch/g14x/repair-before.log`
FAILS on the unmodified move with SQLSTATE 22P02 at composition. Before that
failure, the real runtime already round-trips metadata/constraint objects,
nested arrays, quotes, Unicode and omitted-argument SQL defaults. After the
native repair, `.context/scratch/g14x/repair-after.log` PASSES the same witness
through the restricted bundle_runtime login: all nine mutations, composition
replay, target price, clone, lifecycle replay, refusal, rollback and all three
JSON parameters. No further real driver/routine failure appeared. Pools and
owned containers were removed after each run.

The initial post-repair scripted contract run has 71 PASS / 1 FAIL because its
native observation compared JSON wire text directly with a logical array.
The named `server/adapters/bundleAdminWritePortContract.test.ts` and its scenario
table remain byte-unchanged. The helper below now requires a string for every
non-null native JSON argument, strictly JSON-parses it, then applies the same
full logical-value assertions. This strengthens the native wire check: the
old array would now fail the string assertion. The managed branch is unchanged;
no scenario, field expectation or refusal is removed or relaxed. The resulting
native/managed suite PASSES all 72 cases.

Additional touched source-tree test file:
- `server/adapters/bundleAdminWritePortContract.testFixtures.ts`: test fixture only; strict native JSON wire decoding before unchanged logical argument comparisons.

This is a test-observation correction, not another production behavior change;
it must be explicit in the delta read. The smallest adequate repair remains
local native encoding; no new abstraction, dependency, seam or gateway-wide
change is needed. The catalog README documents that boundary, and its former
unchanged-native-writer wording is narrowed in the bundle owner and changelog.
API declaration checks PASS without snapshot changes. Fresh type/lint, final
artifact measurement and the delta-only read remain to finish this continuation.
No fresh reviewer, native session, final verify or delivery action has begun.


### Final repair validation and read stop

The final native implementation passes public typecheck, full lint, ast-grep and
API declaration checks. Lint retains the same 33 warnings and zero errors. Its
first rerun caught one unnecessary escape in the new fixture string; removing
that escape preserves the runtime string payload and requires no production
change. Current-artifact runs PASS: identity 2 cases, shared native/managed
contract 72 cases, and installed qualified-v2 witness 1 case. The latter includes
both declaration modes and all nine mutations through bundle_runtime. The other
unchanged suites retain their recorded earlier green evidence. No further real
failure appeared; no native review cycle was used.

Final real pack: 2,109,373 packed bytes, 9,836,651 unpacked bytes, 2,855 files.
The repair delta from the unchanged move is +371 packed bytes, +1,068 unpacked
bytes and zero files. Overall from the assigned base: +6,602 packed bytes,
+27,149 unpacked bytes and +15 files. Code is 1,816,267 compressed bytes /
2,796 files; docs 58,155 bytes / 6 files. All existing caps PASS without changes.
The repair changes no public declarations, export map, dependency or lint rule.

The repair commit carries fresh adapter/test documentation no-impact trailers
where the new fixture observation and expanded witness changed the fingerprints.
The first commit's remaining unchanged-owner explanations remain applicable.
The delta packet binds the signed repair against the move commit, not a new
whole-program read. Two independent fresh reviewers remain unstarted until the
coordinator answers it; final verify and landing still wait for the lead's slot.

Repair self-retro: native JSON values and pg wire representation are different
observations. Strictly validate wire JSON, then preserve the existing logical
scenario table. Enumerating all three migration-declared JSON inputs in the
local adapter is the smallest adequate fix; a generic gateway serializer or a
new injection seam would widen the change unnecessarily.
