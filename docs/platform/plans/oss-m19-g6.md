# Native sandbox payment ingress and durable attempts

SQL admission update, 6 November 2026: supported class data, exact approval pins
and SQL may land together under the [current admission rule](../DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).
Earlier requirements here for a separate class or pin approval before SQL are
historical; other scope, proof and owner gates remain unchanged.

Status: implementation and focused proof complete. Native review waits for the
forward class and the supervisor. Final signed policy/pack evidence accompanies
the immutable handoff.
Development preview; sandbox money only.

## Outcome, scope and authority

G6 closes the no-key simulator path through verified ingress, existing truth and
settlement, with database-only active-attempt fencing, replay, ambiguity and late
outcomes across restart. Cancelled capture remains a durable operator-review fact,
without reopening the order or creating a refund. Scope is payments, the native
forward, PostgreSQL witnesses, facade, native store transfer, owner documentation
and publication rows.
No real PSP, generic prepared-provider store, method setup, refund creation,
managed rail, publication, release, credential, settings or hosted work is added.

Worktree `oss-m19-g6`; branch `codex/oss-m19-g6`.
Code base: `bb0008481a11267ec6dbe3e7e531299777cddc19`.
Resume policy pin: `3887ee7425fd0eddeecd9a8e2ef3e1420bcf640d`; applicable
AGENTS, contribution, AI and documentation instructions are unchanged from base.
The approved programme permits implementation and later supervised delivery under
its existing gates. The maintainer accepted the public API, definers, channel
isolation, cancelled-capture design and transfer tables at head
`1acac911a02b326f660dfc9b6e4bdb1aeb9d6626`, tree
`3c2a831be835bd9cf82821b4e63dc4498a57fd9b`, after recomputing the base/diff.
The only required edit is the documented operator listing plus its PostgreSQL
witness; no new read is required for that bounded delta. The latest direct grant
now permits DCO sign-off and clean consolidation of the unreviewed, never-pushed
WIP history. No native review, approval pin or checker edit is authorized.
Submission and canonical verify await later supervision and the prior control.

## Fixed design and safety boundary

Forward: `db/platform/migrations/20261101222000_sandbox_payment_attempts.sql`.
The signature inventory is unchanged: replace native ingest, terminal application,
reconciliation, sweep and readback with identical headers; create four bounded
simulator definers and two private tables. No existing CHECK changes. Only
`payment_truth_events.review_required_at` and its new consistency CHECK are added.
Cancelled capture has outcome=captured, state=open, a review marker and no
settlement transition. Its application disposition is terminal `review_required`:
sweep excludes it and reconciliation cannot apply/clear it or mark evidence
applied. Readback exposes the marker/status, preserving existing OMS visibility.
`commerce_record_settlement` and its later-only subscription clamp are unchanged.

New functions are begin_attempt(text,uuid,text,jsonb,timestamptz),
record_observation(uuid,text,text,text,timestamptz), read_attempt(uuid,uuid), and
assert_truth(uuid,text,bigint,text,timestamptz,jsonb), all prefixed
`public.payment_simulator_`, pinned to `pg_catalog, pg_temp`, with PUBLIC execution
revoked before conditional service_role execution. The accepted table-privilege narrowing adds explicit ALL
revokes on both new tables from PUBLIC and separate conditional revokes for anon,
authenticated and service_role. This removes hostile creation-time default grants.
No RLS is enabled. No new table grants, policies,
role actions or backfills. Terminal application resolves older indeterminate truth for the same verified
attempt using the existing transition, with no second money/notice/fiscal effect.
Attempt replacement refuses while such truth remains open. Cancelled capture
marks those older unknowns for terminal review as well, preserving first-event
fingerprints and replay. New generic truth calls the assertion only for sandbox;
the assertion itself returns before simulator access for other channels.
The unchanged generic prepared-store descriptor/refusal still excludes real PSPs.

`createPostgresSandboxPaymentSimulator` composes existing verified ingress and the
PostgreSQL truth port. Only server-authored observations can become purchase truth;
recording alone cannot pay. Dispatch is recorded conservatively before returning;
replay never redispatches and an unresolved/ambiguous attempt blocks replacement.
Saved sandbox method facts preserve original authorization time on subsequent
renewal/retry/recovery. G2 reuses the store with its own settlement transaction,
without also settling renewal through purchase ingress.

OMS dispatch history is `payment_simulator_attempts`: id, settlement_intent_id,
dispatched_at, state, is_active, last_observation_id. Include inactive history.
`payment_simulator_observations.attempt_id/outcome` preserves synthetic facts.
Neither supersededByStableJourneyKey nor checkoutAbandoned is written. All six
purchase facts have the agreed documented host read seam.

## Acceptance evidence and limits

The original real-PG witness confirmed cancelled capture raised 22023 and rolled
back its truth row, including redelivery. The repaired suite now has 15 passing
cases in `tests/postgres/m19PaymentCancellation.test.ts`: fresh qualified install
through the production runner and restricted login; capture/refusal/expiry replay;
late capture; ambiguous no-redispatch/reconciliation; fresh-process exact replay
with fractional-second instants; wrong/stale and browser/direct-table refusals;
a separate hostile-default-grant installation checks all seven table privileges
for browser/service/runtime roles, removes PUBLIC ACLs, and exercises all four
definers through an unprivileged login;
review terminality, older-unknown closure, sweep exclusion and OMS/readback visibility; saved jsonb method
facts; and other-channel truth while both simulator tables are exclusively locked.
A fresh Node child consumes only database state and request identities. The new
operator witness executes the owner doc's exact listing SQL through the runtime
role: a writer-created cancelled capture is discoverable with order/amount, and
an ordinary open event is excluded.

The recovery case proves named 55P03 and full capture rollback under notice-table
contention, then same-event redelivery from a fresh process. There is one success
transition, one paid event and one recovery notice. Wrong money/currency/attempt evidence and
invalid review-marker state also have real PostgreSQL refusal assertions. The existing notice coupling
is intentionally not repaired. Seven existing native payment conformance cases
also pass on the new legacy selection, including replay/rollback, refusal,
concurrency and the monotonic cycle rule. All fixture parent rows are synthetic;
this does not qualify the programme's complete joined journey or an npm release.

Independent reference runs measured all five catalogue shapes: legacy, both
qualified migrator bindings and both restricted installer modes. Shared suffix
manifest pins reflect those measurements; the fresh qualification uses these
pins rather than repinning a target observation. Earlier migration bytes are
unchanged. The current registry/checker correctly refuses this unapproved slot;
no registry or checker edit is present. Package SQL/installer generation remains
with its prerequisite owner until that work lands.

Checks: package builds, focused ast-grep, API snapshots/check, lint (33 existing
warnings), and all five public TypeScript projects pass, with zero unresolved
edges/errors. Whitespace and secret scans accompany the WIP checkpoint. Policy
navigation is regenerated; test/facade no-impact commit trailers explain their
unchanged owner guidance. Full canonical verify and native review have not run.
Final checks used Node 24.21.0 and npm 11.19.0, including a fresh npm ci.
All 15 payment, 11 connected-transfer, seven native payment conformance and
2,822 package-boundary cases pass in the final focused run. The three unreviewed,
never-pushed WIP commits are consolidated into one DCO-signed candidate as
authorized; the accepted source identity remains in the handoff evidence.
Repair cycles: zero. No native review or external write in this run.

Real packs, bytes/files: base 2,102,771/2,840; current 2,108,397/2,846 (+5,626/+6).
A separate real tarball projection adds the new SQL asset: 2,114,246/2,847,
+11,475 bytes/+7 files against base. This is slightly above the approximately
10 KB soft target; the extra terminality logic prevents stuck unknown obligations. The projection does
not include the prerequisite's regenerated complete installer manifest and is
not an installed-chain qualification. The resumed table-narrowing change adds 14 packed bytes to that projection.
Root-only transfer additions have zero packed-byte/file effect: both actual
and SQL-inclusive real tarballs are byte-for-byte identical to the prior
candidate. The final operator-doc/test-only edit also has no packed-byte/file effect; its
SQL-inclusive tarball SHA-256 remains unchanged. No package cap changes are requested.

Static managed-source checks found no managed runtime dependency on these native
truth routines/new names; the adopter has only a source-characterization reference.
The supervisor included native store transfer in this PR. Add both simulator
tables to capture's owned companions of payment truth and restore immediately
before payment truth. Restore stages state=dispatched and last_observation_id=NULL,
inserts observations, then restores both exact captured values in the same locked
transaction; the final census must match. The immediate cyclic FKs and state CHECK
remain unchanged. Eleven real-PostgreSQL connected-store cases now pass, using writer-created
attempt/observation/truth rows and clean qualified targets. Exact whole-row
census/replay, dispatched and ambiguous fences, stale refusal, pending-capture
redelivery/late convergence, review sweep/reconciliation/OMS visibility, and
missing-observation rollback are proved. No private payment row is inserted by
hand; only the existing synthetic parent fixtures use owner setup.
Treat linkable references as personal data and check existing transfer row/byte
limits for each added table; lower capture row/byte limits and the restore
10,000-row ceiling refuse with no target mutation. No new transfer budget or
SQL is needed. Extra method-fact payerEmail refuses; observation contact/payload
sentinels are absent from the carried rows/packet. The five reference keys,
SQL signatures and explicit binds enforce structure; opaque string values are
not semantically scrubbed and hosts must not embed contact or secrets.
The local transfer addition/proof completed within the supervisor's few-hour
bound. The remaining supervised integration/review estimate stays 0.5–1 working
day after the prerequisite controls; this is not a whole-journey transfer claim.

## Simplicity pre-check and continuation

The eventual first review must challenge all five replacements, four definers and
two tables. Each replacement serves a different required ingest/application/
reconciliation/sweep/readback boundary. Preserving invoker headers requires a
bounded assertion over private tables; bounded begin/observation/read routines
avoid broad grants. Immutable observations retain negative/late/replay evidence
that a single mutable attempt outcome would lose, including settlement rollback.
A generic provider framework or action router adds behavior without this need.
No new signature is needed for the current implementation.

Next: prior control landing,
feature approval pins under the existing policy, then the supervisor's scheduled
native review and canonical verify. Local implementation/proof is complete;
remaining integration/review estimate is 0.5–1 working day after those dependencies,
with no promise about control/landing wait or repair findings.

Self-retro: initial reference SQL exposed a CASE-expression parse ambiguity;
parentheses fixed it before proof. Fresh-process replay exposed potential Date
millisecond loss, removed with direct Date preservation and fractional-second
regression input. Initial lint errors in temporary typing/interface declarations
were repaired; scratch TS was archived as text. Two colder isolation runs then
exposed that private %ROWTYPE declarations themselves lock simulator tables before
an early return. RECORD declarations remove that dependency; the regression now
uses a fresh connection under exclusive locks. The fixed inventory is unchanged.
Two failing-first older-unknown cases demonstrated a stuck row/replacement gap.
Terminal resolution now shares its transition or review marker with that attempt's
older unknown facts, while replacement waits for open truth; all 13 cases pass.
Stale unprocessed observations use the existing ingress ACK/skip vocabulary, not
an endless 503 retry. The shell initially selected newer tool patch versions; the final pass uses the
repository's Node 24.21.0 and npm 11.19.0 explicitly. An earlier overlapping typecheck
was invalid; the final serial typecheck passed. Keep shared-output verification
serial and preserve conservative dispatch history across failures.

Resume self-retro: creation-time default grants need explicit revocation even
when clean-install defaults already deny access. A separate hostile-default
PostgreSQL fixture proves both narrowing and continued bounded runtime access,
without adding RLS or changing any function signature/body.
The resumed reference run was briefly started after reading another worker's
admission in the shared log. It was terminated, its own container removed, and
restarted only after this run's gate returned ADMITTED. Use the command's result,
not the shared log's latest line, as admission evidence.

Transfer-resume self-retro: the first full transfer run passed 10/11 cases; its
continuation case reached the final assertion but wrongly expected cancellation
to have no intent transitions. Preserve and compare that source history, and
separately refuse any successful settlement for the review-marked order. The
restore code, SQL inventory and transfer controls did not need a repair.

DCO-resume self-retro: readback by known event ID did not establish operator
discovery. The owner now supplies a listing query, and the PostgreSQL witness
executes that exact documentation block against positive and negative facts.
The export uses existing payments/index.ts and payments/contracts/index.ts
entries in the closed package inventory; no new subpath or source move is needed.

## Existing-suite compatibility audit

The supervisor requested unchanged existing-suite coverage before native review.
Only the one-forward literal counts/current inventory pins and the change-note
move are authorized repairs here; source/SQL failures stop for a delta read.
No new approval pin, checker edit or native review is permitted.

The change note moves unchanged to
a platform release fragment, with no per-file catalogue row, following the
[release guidance](../DEVELOPMENT_AND_RELEASE.md).
Current complete counts are qualified-v2 96, qualified-admin 95 and legacy 92.
The released-schema helper is an indirect companion of the qualified-admin proof;
its current-chain literal receives the same +1. Issued-prefix counts and historic
`inventory`/`sha256` values remain untouched. Fresh independent PG16 measurements
on the byte-identical forward agree with the prior reference runs:

- legacy: `f86acaf1c03e228c8dddb3e01f20f4a524b36989e0ffb112e31b2966456b6685`.
- bootstrapMigrator: `6b54e3182cb105c95d47a27c04fa71136f712c6980c8710aa4129f628f2b63b6`.
- separateMigrator: `e9544067ee22ba9b6ff8044c1aaead3455f64c2a016f999590f51a39b37bb769`.
- installerManaged: `465ced2137adce08fa2af8dfa4fb1109d2fc72e0f5005420485ddb9f8d4a089b`.
- operatorProvisioned: `fc6b68ffbef31684ac25b9cdf25149541033612ddbeb56621bd3a24a59f253c2`.

Compatibility findings from the owning code, to be checked against the suites:
non-sandbox truth does not consult simulator tables; ordinary settlement and
renewal retain their existing writers. Native readback adds optional application
status/review fields, while the port accepts old responses that lack them.
Cancelled captured truth now becomes a review fact on the native truth path,
including non-sandbox channels, instead of rolling back. Exact recorded event
replay returns before new-attempt validation. Fresh sandbox ingestion or
terminal reconciliation without a simulator companion are refused with wrong_attempt;
there is no backfill or implicit adoption of a legacy sandbox attempt. Complete
selected-schema installation remains a precondition for connected capture; old
cohorts with empty new companion tables must still capture/restore.

The exact pre-G6 connected-transfer test bytes will run against current production
modules, then the accepted candidate file will be restored unchanged. This
separately checks the old cohort rather than relying on its added G6 fixture.
Other suites keep their test bytes, apart from the authorized literal/pin edits.
The inventory includes direct module/table/routine references, proof wrappers,
and the retained subscription-composition discriminator; fixture-only lexical
hits are conservatively included. Private run logs/results are under
`.context/scratch/g6-existing-*`.

Existing suite inventory (55 files; two passed, one failed, 52 not run at stop):
Suite paths with wildcards each identify exactly one tracked file.

- `packages/platform/test/account-support/ownerRefusals.test.ts`
- `packages/platform/test/account-support/paymentMethodComposition.test.ts`
- `packages/platform/test/packageBoundary.test.ts`
- `packages/platform/test/payments/adapterConformance.test.ts`
- `packages/platform/test/payments/bindings.test.ts`
- `packages/platform/test/payments/contracts.test.ts`
- `packages/platform/test/payments/postgresPaymentTruth.test.ts`
- `packages/platform/test/payments/preparedAttempt.test.ts`
- `packages/platform/test/payments/reconciliation.test.ts`
- `packages/platform/test/payments/refundEvidence.test.ts`
- `packages/platform/test/payments/repairAuthority.test.ts`
- `packages/platform/test/payments/repairContinuity.test.ts`
- `packages/platform/test/payments/s*/conformance.test.ts`
- `packages/platform/test/payments/s*/factory.test.ts`
- `packages/platform/test/payments/t*/conformance.test.ts`
- `packages/platform/test/payments/t*/factory.test.ts`
- `packages/platform/test/payments/truth.test.ts`
- `packages/platform/test/payments/verifiedIngress.test.ts`
- `packages/platform/test/payments/verifyHandler.test.ts`
- `packages/platform/test/subscriptions/contracts.test.ts`
- `scripts/documentation-impact.test.ts`
- `scripts/packages/platform-cold-consumer.test.ts`
- `scripts/payment-truth-schema.test.ts`
- `scripts/public-ci-payment-allowance.test.ts`
- `scripts/reference-adapters/paymentEventPortConformance.test.ts`
- `scripts/source-preview-release.test.ts`
- `server/_lib/publicCoordinates.test.ts`
- `server/adapters/paymentFailureDisplay.test.ts`
- `server/adapters/paymentFailureEvidenceCompatibility.test.ts`
- `server/adapters/postgres/paymentTruth.test.ts`
- `server/adapters/supabase/commerce/paymentRecoveryGuidance.test.ts`
- `server/adapters/supabase/payment/paymentProviderReconciliation.test.ts`
- `server/bff/commerce/*-channels.test.ts`
- `server/domains/payment/paymentTruth.test.ts`
- `server/infra/s*/*ApiClient.test.ts`
- `server/shared/preparedProviderAttempt.test.ts`
- `src/pages/ReferencePaymentRepairPage.test.tsx`
- `tests/platform/checkoutRecoveryProviderConformance.test.ts`
- `tests/postgres/channelConnectedRestore.test.ts`
- `tests/postgres/connectedManagedRetained.test.ts`
- `tests/postgres/connectedStoreTransfer.test.ts`
- `tests/postgres/invoicingContinuity.test.ts`
- `tests/postgres/invoicingNativeConformance.test.ts`
- `tests/postgres/m14ManagedCatchup.test.ts`
- `tests/postgres/m14QualifiedAdminComposition.test.ts`
- `tests/postgres/m14QualifiedComposition.test.ts`
- `tests/postgres/m14RecipeConformance.test.ts`
- `tests/postgres/m14ReleasedSchemaUpgrade.test.ts`
- `tests/postgres/m14RestrictedConnectedRestore.test.ts`
- `tests/postgres/managedStorageTransfer.test.ts`
- `tests/postgres/paymentsNativeConformance.test.ts`
- `tests/postgres/reviewedBatchForwards.test.ts`
- `tests/postgres/reviewedPortableCreation.test.ts`
- `tests/postgres/subscriptionComposition.test.ts`
- `tests/s*/*CriticalPathFakeGate.test.tsx`

Audit stop: `server/adapters/postgres/paymentTruth.test.ts` passed 4 cases and
`tests/postgres/invoicingContinuity.test.ts` passed 3, unchanged.
`tests/postgres/invoicingNativeConformance.test.ts:100` failed the first case,
"fresh complete install and exact pre-M09 prefix upgrade preserve rows/history
and bind both native forwards and three sparse rails". The prior event replays
successfully at line 99, but SELECT * after upgrade returns an added
`review_required_at: null` field (21 columns versus the captured pre-forward 20).
The comparison reports only that added field. This is an observed G6 schema
compatibility failure of the unchanged preservation witness, not an authorized
chain-count edit. No assertion or production/SQL fix was attempted. Resolving it
requires the supervisor's decision on a bounded preservation-test exception or
a source/SQL delta read; the current audit cannot be called green. The runner
stopped immediately, leaving 52 suites pending, including connected/retained and
renewal continuation proofs. Unexecuted cases may expose additional failures.

The permitted count/current-pin changes and fragment move remain uncommitted
on top of the intact signed candidate; no new DCO commit was made over a red
mandatory check. The forward's SHA-256 is unchanged:
`7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29`.
Fresh inventory measurements and the full suite list/results are retained in
private scratch; no pin, checker, native review or external mutation occurred.

Audit self-retro: the first scratch runner invocation lacked npm's executable
PATH and never started Vitest. That launch is retained separately, PATH was
corrected without changing a test, and the actual run then exposed the preserved
row-shape failure. Focused new witnesses had not covered this older complete-row
upgrade contract; unchanged existing suites must precede a read.

## Resumed existing-suite audit: additive assertion accepted, new asset failure

The supervisor authorized exactly the full-row additive-column expectation:
`tests/postgres/invoicingNativeConformance.test.ts:100` now requires
`[{...h.legacy.row, review_required_at: null}]`. Every prior field still matches,
and the new field must be null. This is the only such expectation edited; no
field subset, second additive exception, fixture privilege or source/SQL edit.

Reran that suite through the focused gate. The nullable-column assertion and
legacy replay now pass; the same first case fails at line107 with ENOENT for
`packages/platform/sql/20261101222000_sandbox_payment_attempts.sql`. The complete
installation manifest includes the forward, but the packaged SQL mirror is
absent on this pre-R0-merge candidate. This is a new actual failure, not the
prior row-shape failure. Under the explicit "any other failure: stop" instruction,
no SQL asset, manifest, source or assertion repair was attempted and no merge was
performed. A byte-identical SQL asset/manifest projection was already planned
for the later authorized merge, but that does not make this existing suite green.

Results remain two existing files PASS (paymentTruth4, invoicingContinuity3),
invoicingNativeConformance FAIL at line107 (first case; other8 unexecuted), and
52 listed suites pending. No later suite was executed. Previous failure retained
in `.context/scratch/g6-existing-first-stop-results.json`; resume output in
`.context/scratch/g6-existing-logs/resume-01.log`; gate admission in its adjacent
resume-01-gate.log. All test containers/pools cleaned by the harness.

Sandbox retry compatibility answer: G2's renewal operation/ACK fence alone is
insufficient for subscription_retry_record_recovery on sandbox. It must have
an active simulator attempt on that exact renewal intent and latest captured
observation, and pass its six exact evidence fields plus evidenceKey
sandbox:<observation UUID>. Otherwise wrong_attempt/evidence-mismatch refuses
and rolls the recovery back. A purchase attempt cannot satisfy a renewal intent;
a retry with no purchase attempt can create its first simulator attempt on its
pending-payment order and failed/unsettled intent, using saved authorized method
facts, before simulated dispatch. Existing NativeRetryPositive fields alone do
not supply this evidence. Ordinary renewal completion calls settlement directly
and bypasses the assertion, so its success does not prove retry compatibility.
Full call conditions, replay, ordering and limitations are recorded under G7 in
the shared purchase-interface; this is code tracing, not joined recovery proof.

The count/hash edits and changelog fragment remain intact and uncommitted, as
does the authorized exact assertion. No signed follow-up commit was made over
the newly red mandatory check; signed HEAD remains bff1fb3935ea8f7ee8be4cd79d1231453b79c772.
Forward SHA remains 7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29.
No pin/checker/native review; native repair cycles remain zero.
Self-retro: the complete existing case caught a missing packaged migration after
its older-row check was tightened; a SQL-inclusive size projection is not proof
that the checked-in installer contains the asset. No further optimization added.

## Authorized R0 integration and real package measurement

The supervisor authorized a signed checkpoint, one merge of current main,
additive conflict resolution and the existing R0 projection route. Checkpoint
20104adad611e84a9cb8e1ea2c77080f3b7be680 contains the count/current-pin changes,
fragment move, exact full-row nullable-marker assertion and audit history.
Signed merge 36d44adf93b6cdb0eaadb294258d79ce65dc8eb0 has parents that checkpoint
and main 09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a. No rebase or force-push.
Manual additive conflicts: publication catalog entries retained from both sides;
DATA_AND_MIGRATIONS compatibility paragraphs retained from both sides. No
production implementation or SQL body was changed in resolution.

Stable patch IDs excluding only the task record differ:
premerge d3b4836e5c8c3f7cc5ccc816eefd5740b676ccbb;
postmerge 76ccb8c56d9bfbcbe91bb509503ebb3b55657597.
This is not a conflict-free mechanical/no-read claim. Excluding those two
manually resolved paths as well gives identical IDs on both sides:
4720749323dfef65d3249034d5fc5634242364c3. The integration is within the explicit
supervisor grant; native review has not begun and consumes zero repair cycles.

R0 task record and owner regeneration instructions were read. The documented
checkPlatformMigrationProjection(process.cwd(),true) generator produced exactly
packages/platform/sql/20261101222000_sandbox_payment_attempts.sql and the
sql/manifest.json changes. The canonical forward and generated copy both hash
7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29.
The only additional R0-required authored delta is the new SQL asset's
public-output catalog row. Generated catalog.ts and all prior SQL copies are
unchanged; no manual generated-value merge, checker edit or approval pin.

Fresh real PostgreSQL16 measurements on the main prefix plus exact forward
retain current counts legacy92, qualified-v2 96, qualified-admin95 and hashes:
legacy f86acaf1c03e228c8dddb3e01f20f4a524b36989e0ffb112e31b2966456b6685;
bootstrapMigrator 6b54e3182cb105c95d47a27c04fa71136f712c6980c8710aa4129f628f2b63b6;
separateMigrator e9544067ee22ba9b6ff8044c1aaead3455f64c2a016f999590f51a39b37bb769;
installerManaged 465ced2137adce08fa2af8dfa4fb1109d2fc72e0f5005420485ddb9f8d4a089b;
operatorProvisioned fc6b68ffbef31684ac25b9cdf25149541033612ddbeb56621bd3a24a59f253c2.
Historic issued inventories/pins remain untouched. The scratch bundler initially
inlined an imported CLI's main guard, printing usage and setting exit1 despite
completing all five measurements. The corrected launcher externalizes that CLI;
its separate log preserves the initial result. This is not a suite failure or
production change.

Real npm packs with the same compiler/dependencies compare main09cd599b with
the integrated candidate: base2318731 bytes /10978278 unpacked /2913 files;
candidate2330148 bytes /11034179 unpacked /2920 files; delta+11417 packed bytes,
+55901 unpacked bytes,+7 files. Candidate tarball SHA256 is
f6f235bcde0676483a963e594d129bc61506b3707967d1d9205e6f8c8976d20f.
Actual archive inspection confirms the packaged SQL and complete generated
manifest equal source exactly. Root connected transfer files are absent from
the package and add zero tarball bytes/files. This replaces the earlier SQL-only
projection estimate; the approximately10KB target is soft, and the actual
2330148 total stays below2485000. No cap change.

The audit restarts all55 selected existing files against this integrated base,
including the two previously passing files, so no final result silently reuses
a pre-R0 installation proof. The only full-row assertion exception remains
invoicingNativeConformance.test.ts:100; no other such edits have been made.

## Existing-suite audit on the integrated base: PASS

All55 existing files pass on main09cd599b plus G6, totaling 4334 cases. Each file
ran unchanged through its focused admission, except the explicitly authorized
current counts/hashes and invoicingNativeConformance.test.ts:100 full-row
expectation. No additional additive-column comparison was edited. The original
connectedStoreTransfer.test.ts ran with exact main09cd599b bytes (pre-G6);
the candidate test file was restored in finally and matches its committed bytes.
The two premerge passes were rerun, so no result below relies on the pre-R0 base.
Recorded admissions waited 4433s in total (largest 421s); test execution totaled
798.899s. Logs/results and the prior two stopped audits are retained separately.

| Existing file | Result | Cases |
| --- | --- | ---: |
| `server/adapters/postgres/paymentTruth.test.ts` | PASS | 4 |
| `tests/postgres/invoicingContinuity.test.ts` | PASS | 3 |
| `tests/postgres/invoicingNativeConformance.test.ts` | PASS | 9 |
| `tests/postgres/paymentsNativeConformance.test.ts` | PASS | 7 |
| `tests/postgres/channelConnectedRestore.test.ts` | PASS | 1 |
| `tests/postgres/connectedManagedRetained.test.ts` | PASS | 16 |
| `tests/postgres/connectedStoreTransfer.test.ts` | PASS | 7 |
| `tests/postgres/m14ManagedCatchup.test.ts` | PASS | 1 |
| `tests/postgres/managedStorageTransfer.test.ts` | PASS | 1 |
| `tests/postgres/subscriptionComposition.test.ts` | PASS | 20 |
| `tests/postgres/m14QualifiedComposition.test.ts` | PASS | 4 |
| `tests/postgres/m14QualifiedAdminComposition.test.ts` | PASS | 2 |
| `tests/postgres/m14RestrictedConnectedRestore.test.ts` | PASS | 15 |
| `tests/postgres/m14ReleasedSchemaUpgrade.test.ts` | PASS | 1 |
| `tests/postgres/m14RecipeConformance.test.ts` | PASS | 22 |
| `packages/platform/test/account-support/ownerRefusals.test.ts` | PASS | 27 |
| `packages/platform/test/account-support/paymentMethodComposition.test.ts` | PASS | 16 |
| `packages/platform/test/packageBoundary.test.ts` | PASS | 2843 |
| `packages/platform/test/payments/adapterConformance.test.ts` | PASS | 7 |
| `packages/platform/test/payments/bindings.test.ts` | PASS | 2 |
| `packages/platform/test/payments/contracts.test.ts` | PASS | 1 |
| `packages/platform/test/payments/postgresPaymentTruth.test.ts` | PASS | 5 |
| `packages/platform/test/payments/preparedAttempt.test.ts` | PASS | 7 |
| `packages/platform/test/payments/reconciliation.test.ts` | PASS | 4 |
| `packages/platform/test/payments/refundEvidence.test.ts` | PASS | 7 |
| `packages/platform/test/payments/repairAuthority.test.ts` | PASS | 2 |
| `packages/platform/test/payments/repairContinuity.test.ts` | PASS | 1 |
| `packages/platform/test/payments/s*/conformance.test.ts` | PASS | 1 |
| `packages/platform/test/payments/s*/factory.test.ts` | PASS | 16 |
| `packages/platform/test/payments/t*/conformance.test.ts` | PASS | 1 |
| `packages/platform/test/payments/t*/factory.test.ts` | PASS | 64 |
| `packages/platform/test/payments/truth.test.ts` | PASS | 1 |
| `packages/platform/test/payments/verifiedIngress.test.ts` | PASS | 8 |
| `packages/platform/test/payments/verifyHandler.test.ts` | PASS | 3 |
| `packages/platform/test/subscriptions/contracts.test.ts` | PASS | 3 |
| `scripts/documentation-impact.test.ts` | PASS | 101 |
| `scripts/packages/platform-cold-consumer.test.ts` | PASS | 108 |
| `scripts/payment-truth-schema.test.ts` | PASS | 3 |
| `scripts/public-ci-payment-allowance.test.ts` | PASS | 8 |
| `scripts/reference-adapters/paymentEventPortConformance.test.ts` | PASS | 1 |
| `scripts/source-preview-release.test.ts` | PASS | 718 |
| `server/_lib/publicCoordinates.test.ts` | PASS | 3 |
| `server/adapters/paymentFailureDisplay.test.ts` | PASS | 7 |
| `server/adapters/paymentFailureEvidenceCompatibility.test.ts` | PASS | 16 |
| `server/adapters/supabase/commerce/paymentRecoveryGuidance.test.ts` | PASS | 16 |
| `server/adapters/supabase/payment/paymentProviderReconciliation.test.ts` | PASS | 17 |
| `server/bff/commerce/*-channels.test.ts` | PASS | 4 |
| `server/domains/payment/paymentTruth.test.ts` | PASS | 8 |
| `server/infra/s*/*ApiClient.test.ts` | PASS | 15 |
| `server/shared/preparedProviderAttempt.test.ts` | PASS | 14 |
| src/pages/ReferencePaymentRepairPage.test.tsx | PASS | 9 |
| `tests/platform/checkoutRecoveryProviderConformance.test.ts` | PASS | 8 |
| `tests/postgres/reviewedBatchForwards.test.ts` | PASS | 106 |
| `tests/postgres/reviewedPortableCreation.test.ts` | PASS | 20 |
| `tests/s*/*CriticalPathFakeGate.test.tsx` | PASS | 20 |

Compatibility findings now have existing-suite evidence: retained and connected
stores with no simulator-written companions, native late/replayed settlement,
managed catch-up/storage, current qualified installations and issued-prefix
upgrades pass. Fresh sandbox truth/recovery without companions is intentionally
refused; ordinary renewal settlement bypasses that assertion, as documented in
the shared G7 interface. Non-sandbox generic assertion skips simulator storage;
cancelled captured truth retention also applies to native non-sandbox events.
No automatic backfill/adoption is claimed. Supabase SQL remains unchanged, and
its existing recovery/reconciliation suites pass. The new G6 acceptance/transfer
fixtures and final cheap checks are still to be rerun before the packaging commit.

## Final integration check stop: public typecheck TS2698

Runtime proof on the integrated base is green: all55 existing files /4334 cases,
G6's fresh15 PostgreSQL acceptance cases, and all11 candidate connected-transfer
cases. The candidate transfer run includes the new writer/restore proof in
addition to the separately executed exact pre-G6 seven-case file. Lint, including
its structural rules and gated package rebuilds, passes with zero errors and the
same33 existing warnings. No test, production-source or canonical-SQL repair was
made after the R0 merge/projection.

The next required gate, public typecheck over all five projects, FAILS with one
consumer-side TS2698 against a zero ceiling; unresolved edges remain zero.
The authorized expectation at invoicingNativeConformance.test.ts:100 spreads
h.legacy.row. That property is inferred from tests/helpers/invoicingNativeHarness.ts:30,
which declares legacyRow: unknown, and its getter returns that unknown unchanged.
TypeScript cannot spread unknown into an object. The exact comparison passes
all nine real-PG runtime cases, but Vitest does not validate its TypeScript type.
The raw gate summary is retained in g6-postmerge-typecheck.log. No cast, assertion
relaxation or helper/source type change was attempted. This is not a count/hash
or generated projection fix, so the run stops under the supervisor's failure
rule. API and documentation-policy checks after this gate were not run.

The signed checkpoint20104ada and signed merge36d44adf remain intact. Generated
package SQL/manifest, the required asset catalog row and this task evidence are
staged but uncommitted; no final packaging commit was made over the red gate.
The package measurement remains2330148 packed bytes /2920 files (+11417/+7
against merged main09cd599b), including SQL and the complete manifest. Both
canonical and packaged forward remain byte-identical at SHA256
7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29.
No approval pin, checker edit, native review or external write. Native repair
cycles remain zero; the estimate stays0.5–1 supervised working day after the
remaining typecheck/approval prerequisites.

Self-retro: the accepted runtime full-row assertion also needs a valid static
row type; the unchanged suite passes while the five-project compiler catches
its unknown spread. Keep both runtime and compiler proof before readiness.
The scratch reference launch initially bundled a CLI main guard; its first
externalization also exposed a relative-import launch error. Externalizing the
image-pull module corrected the launcher, and all five real-PG measurements then
completed successfully with the same hashes. One initial pretest build started
while admission was pending; the later gated lint rebuilt all three packages,
and every test/pack/final-check stage waited for its own admission. Serialize
admission completion and stage launch; no gate/control change was introduced.

## Authorized test narrowing and handover continuation

The supervisor classified TS2698 as a test typing detail and authorized local
record narrowing in the one expectation. Only h.legacy.row is narrowed to
Record<string,unknown> inside that spread; the full old-row equality and exact
review_required_at:null requirement remain. No any comparison, harness type,
production source or SQL change. The five-project public typecheck now passes
with zero consumer errors and zero unresolved edges.

The opt-in handover witness changes exactly its two current literals: selected
inventory e9544067ee22ba9b6ff8044c1aaead3455f64c2a016f999590f51a39b37bb769
(the separate-migrator/restore value measured on real PostgreSQL after R0), and
connected table count84, measured by importing connectedNativeStoreTables.
The two added tables moving the prior82 count are payment_simulator_attempts
and payment_simulator_observations. The guard's message text remains unchanged.
The default witness will use the already-local immutable Node24.21.0 image
sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20.
No image pull/build, new witness mode or extra data/setup step is introduced.
Its end-to-end outcome and table population are pending actual execution; the
separate G6 transfer suite already proved both tables populated through writers.
All55 prior existing suites remain passing evidence; the changed invoicing file
is being rerun with the type-only narrowing before final readiness.

## Handover completion and signed-candidate preparation

The authorized local Record<string,unknown> narrowing passes the nine-case
invoicing suite and the five-project public typecheck: zero unresolved edges,
zero consumer errors. Lint passes with zero errors and the same33 warnings;
the platform API snapshot/export checks pass without generated API changes.
The harness type and full-row equality remain unchanged in runtime meaning.

The opt-in default handover ran to its end with exactly the two permitted
literal edits. Its real PostgreSQL catalogue reports96 units, ending at the G6
forward, and inventory e9544067ee22ba9b6ff8044c1aaead3455f64c2a016f999590f51a39b37bb769.
The captured/restored graph has84 tables. payment_simulator_attempts and
payment_simulator_observations are the two tables added to the former82-table
profile. This witness populated neither simulator table (zero rows in each);
it transferred their installed empty relations. The separate G6 transfer suite
passed all11 cases with writer-created populated attempts/observations, stale
fences, review terminality, exact replay and redelivery.

The handover result is LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION:
two accepted effects recovered, one uncertain shipment still fenced, one ordinary
target post, graph/filesystem publication before target activation, and zero
cleanup failures. Source writers were frozen. Selected target readiness was
99738ms in this single finite local run; this is no whole-store RTO or hosted
provider qualification. Evidence is retained in the owned journey report and
handover summary under ignored task scratch. No setup, privilege, mode, message
text or assertion logic in the handover script changed.

Policy caught two authoring details: the new SQL asset catalog row was after
manifest.json instead of in lexical order, and the task record named a release
fragment excluded from the materialized public inventory. Only our added row
was moved; the task now links the public release guidance instead. No checker,
catalog exception, new fragment row or package input was added. Structural
policy checks now pass. Current source fingerprints require two fresh scoped
no-impact trailers (portability-capability and tests), prepared for the signed
commit under the existing documentation process. The explanations retain the
same fixture, command, retirement/publication and finite readiness contracts;
existing payment/data/transfer owner updates cover the new behavior. Final
signed-head policy binding is retained with the handoff.

The last actual complete pack remains2330148 packed bytes /2920 files,
+11417 bytes/+7 versus main09cd599b. The local narrowing, witness literals,
catalog ordering and task citation changes alter no packaged input. The
requested post-signing real repack is reported with the immutable handoff.
Canonical and packaged forward SHA256 remain
7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29.
SQL inventory, OMS table/column facts and the G7 recovery interface are unchanged;
commerce_record_settlement and managed SQL are untouched. No native review,
approval pin, checker edit, push or external delivery. Repair cycles remain zero.

Self-retro: a complete witness run exposed no further runtime defect. Policy
caught an incorrectly placed authored catalog row and a citation to an
unpublished release input; correct the row placement and point at the public
owner guidance, keeping the existing checker and publication boundary intact.

Self-retro: the full-tree neutrality ratchet caught adapter names in unchanged-suite
evidence that focused runtime checks did not cover. Neutral suite path patterns
retain all file references and pass counts without adding vocabulary debt.

## Stacked native review preparation

The supervisor authorized one merge of predecessor control
`cd0f0980cb92692106ba00563925e7fb2650dbb0`, with
`OPENLUP_STACK_BASE=cd0f0980cb92692106ba00563925e7fb2650dbb0`.
Merge `8f51a321` united only disjoint publication-catalog additions manually;
all other merge results were mechanical. Before binding the feature pin, G6's
stable patch ID excluding this task record and the conflicted catalog is
`9475f405488c6e0c56968ae23a4891561447bb3b` both before (against main09cd599b)
and after (against the predecessor). No source or SQL changed during the merge.
The first `nativeStoreForwards` binding is explicitly authorized: the checker's
exported identity/hash readers compute all nine after-hashes and the whole-file
hash. Class data and admission machinery stay unchanged. Native review is now
authorized; canonical verify and external delivery remain outside this run.

Stack proof stopped at the package-growth reporting boundary. Static append-only
history, feature-approval and co-located-approval paths passed. The bound native
catalog suite passed 124 cases across both role modes; the sandbox acceptance
suite passed 15. No executed suite failed. The transfer rerun was interrupted
when the measured growth became known; remaining existing/pre-verify suites,
AST/lint and native reviews are pending. Policy passed eight obligations with
zero unanswered; neutrality passed with zero increases. A scratch launcher first
omitted the local executable directory and exited before executing any test;
adding that directory after the official toolchain corrected the invocation.

Official Node v24.21.0/npm 11.19.0 packs against main
`5f9c45e6c5b77b5861b486593b51af2babdd6e25`: base 2358480 packed bytes,
1893540 code-gzip bytes, 11126930 unpacked bytes and 2949 files; candidate
2369992 packed bytes, 1898154 code-gzip bytes, 11182831 unpacked bytes and
2956 files. Delta: +11512 packed, +4614 code-gzip, +55901 unpacked, +7 files.
The prior reported official packed delta was +11112 against an earlier base;
the new measurement is +400 above that figure. No packaged source/SQL was added
by this integration beyond the unchanged G6 contribution. The current common
brief requires reporting growth before proceeding, so native review did not start.
Private evidence: `.context/scratch/g6-stack-size-result.json` and
`.context/scratch/g6-stack-proofs/report.json`. Both forward copies retain
SHA256 `7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29`.

Self-retro: a changed base can change compressed delta while unpacked growth is
identical. Measure before long reruns so the size stop is visible earlier.

## Frozen control merge and code-gzip stop

The supervisor accepted the earlier packed variation and replaced the stack base
with `fd8c13bd99f22652a9d08302d8228dfd5a03a465`:
`OPENLUP_STACK_BASE=fd8c13bd99f22652a9d08302d8228dfd5a03a465`.
Merge `674e1e9d2da99e82746d985906eeee09515555f6` was mechanical with no manual
resolution. G6's stable patch ID excluding this task record is
`53c7f4fbe34b11df63e19488a378117f88d68570` both before (against the prior
control) and after (against the frozen control). Class data, checker and catalog
witness are identical between those controls. Earlier partial proof results
were superseded; no test result was carried to this new tree.

Fresh proof: all three static admission paths pass; the bound PostgreSQL catalog
suite passes 124 cases in both role modes; sandbox acceptance/refusals pass 15;
connected transfer passes 11. No executed suite fails. Neutrality has zero
increases; the all-ref secret scan finds zero leaks across 1729 commits. The path
audit checks all 36 changed paths against the original grant and finds only
`server/adapters/README.md` outside it, covered by the accepted adapter-owner read.
The importer audit additionally identifies the runtime payment-truth binding and
managed webhook suites; both remain pending with the remaining original suites,
pre-verify files and AST/lint. Policy needs the refreshed portability no-impact
binding because the merged composition proof changed the source digest; its
owner section still describes the same transfer/recovery contract.

Official Node v24.21.0/npm 11.19.0 measurement against
`c3c213d94ec653f0b08dcefd9a3017a122d36b00`: base 2364865 packed bytes,
1899251 code-gzip bytes, 11153236 unpacked bytes and 2955 files; candidate
2376264 packed bytes, 1903923 code-gzip bytes, 11209137 unpacked bytes and
2962 files. Delta: +11399 packed, +4672 code-gzip, +55901 unpacked and +7 files.
The new stop condition permits packed variation but refuses code-gzip above
+4641: this measurement exceeds it by 31 bytes. The proof queue stopped at that
boundary, before native review; no package code was changed to recover bytes.
Private evidence is `.context/scratch/g6-frozen-size-result.json`,
`.context/scratch/g6-frozen-proofs/report.json` and the `g6-frozen-*` logs.
Both forward copies remain SHA256
`7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29`.
Native review has not begun; repair cycles remain zero.

Self-retro: code-class gzip also changes with the comparison base while unpacked
bytes and file growth stay constant. Apply the explicitly named measurement
threshold, report the observed delta, and preserve the package implementation.

Tail-position repair: the hostile-defaults case locates exactly one G6 forward and applies its preceding prefix; all 15 PostgreSQL cases pass. Lesson: bind a forward witness to identity. Native review still waits for the frozen control.


## Payment and purchase-renewal bundle

The owner's bundle decision joins G6 and G2 as one candidate and one PR,
implemented at the existing `oss-m19-g2` stack top on `codex/oss-m19-g2`.
Both task records remain. The supervisor authorizes merging only main,
binding the purchase-renewal feature pin, focused proof, a signed candidate and
one full native session with two fresh parallel reviewers and a fresh 0/3
budget. No `OPENLUP_STACK_BASE` applies: review covers the full combined diff
from main. Canonical verify, push, PR creation, production, credentials,
publication and external writes remain excluded in this run.

Main `a7ce403cef3b790c28418d786f153e50ac595084` merged mechanically as
`933d688e5a7a77d0f9d3bb8762295b66731ae72c`, tree
`809f736e99f03f6b56c7b37968b2c9b413c67704`. `git merge-tree --write-tree
 d698609ecdb92a88ce4b289789c2acbda9103aa1 a7ce403cef3b790c28418d786f153e50ac595084`
returned that exact tree. No hand resolution or other branch merge occurred.
The purchase-renewal pin is computed with `nativeStoreFunctionDefinitions`
and `sqlSha256` from `scripts/reviewed-platform-forward.ts`, after the existing
sandbox-payment pin. No class data or issued pin changes.

The accepted production/SQL deltas remain exact. Reproduce with
`python3 .context/scratch/g2/bundle/read_identity.py`: it takes
`git diff --no-ext-diff --unified=0 --no-renames <base> <read> -- <production paths>`,
keys every added/removed line by exact path, sign and content, preserves its
multiplicity and hashes sorted tuples. The original base is
`bb0008481a11267ec6dbe3e7e531299777cddc19`; read heads are
`eb97697cb5de2cff0047208a133024c12bc27e4e` for purchase renewal and
`1acac911a02b326f660dfc9b6e4bdb1aeb9d6626` for sandbox payments.
The actual combined production delta equals exactly those two accepted deltas
plus one merge-only blank separator at connectedStoreCapture.ts:22.
`git show b98cc9eb --cc -- server/adapters/postgres/connectedStoreCapture.ts`
identifies that empty separator with `++`; it belongs to neither row's own
accepted source delta. The script asserts this complete accounting before
subtracting the other row and that one exact separator. There is no general
whitespace normalization, ignored production path or unaccounted difference.

Equal accepted/current own +/- SHA-256 values:
- Purchase renewal: `1a2cefbf86eaea14b5775098c2436925a987a84d61877dffa8b0e2444ace65bd`.
- Sandbox payments: `db4fb97f016f789996e96648f45873f954763427e98d9a4ec5392bcbfa0eb693`.

Other post-read changes are test-only simulator purchase setup shared by three
callers, the offline installed-consumer helper, the missing-method compatibility
witness, mechanical current-chain counts/measured inventories, selected-chain
lookup in the hostile-default payment test, neutral task prose and documentation
impact trailers. The SQL package copies/manifest are the canonical projection
introduced by the packaging prerequisite; each copy retains its read SQL bytes.
Registry changes bind only the accepted forward/function identities. Owner
documentation and public API semantics are unchanged by this integration.

Both canonical/packaged forward SHA-256 values remain
`7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29` and
`2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34`.
Static native admission passes both slots. The real PostgreSQL catalog witness
passes 126/126 cases across service-role present and absent modes with both pins.
Core/platform rebuilt first with official Node 24.21.0, without tracked changes.

Real official pack against the main pin above: baseline 2,364,865 B packed,
1,899,251 B code gzip, 11,153,236 B unpacked, 2,955 files; candidate 2,394,059 B
packed, 1,916,125 B code gzip, 11,287,990 B unpacked, 2,972 files. Delta:
+29,194 B packed, +16,874 B code gzip, +134,754 B unpacked and +17 files.
The unpacked/file deltas exactly equal the two earlier row measures combined;
the shared test helpers are root-only and add no package bytes/files. Combined
compression saves 382 B against adding the two earlier packed deltas. No cap
change is required. Real tarballs and measurePack output are in bundle scratch.

Paths outside the original programme grant's list are the additive routing
entry in config/doc-routing.json, server/adapters/README.md (accepted additive
owner description), and the explicitly authorized test-only helpers
captureSandboxPurchase.ts and installSubscriptionConsumer.ts under tests/helpers.
All are retained additions with no control, budget, baseline or runtime change.
Full bundle proof, trusted-main registry preflight and native review follow on
this exact combined boundary; no readiness verdict is claimed before they pass.

Self-retro: account for each row independently on shared transfer files and
retain the exact merge-only separator separately. Comparing the union to either
row alone falsely treats the other row as a new production semantic. Keep the
byte inventory explicit; never hide a source difference with broad normalization.


### Bundle stopped: captured-observation timestamp precision

Status: BLOCKED before feature DCO and native review. Signed main merge remains
`933d688e5a7a77d0f9d3bb8762295b66731ae72c`; G2's computed feature pin and both
bundle records remain staged. No production, canonical/packaged SQL, class data,
check, baseline or budget was changed. No native session or counted review began;
review budget remains 0/3 and there is no counted PASS timestamp.

A new real-PostgreSQL counterexample exposes a valid-input failure in
`createPostgresSandboxPaymentSimulator`. Its restricted `micro_runtime` caller
is neither superuser nor BYPASSRLS. `beginAttempt` and `recordObservation`
accept `2026-10-30T12:00:00.123456Z`; bounded readback returns the exact stored
`2026-10-30T12:00:00.123456+00:00` captured observation. Verified ingress returns
503, the settlement intent remains `created`, and accepted truth rows remain
zero. The underlying error is `payment_simulator_evidence_mismatch`, SQLSTATE
22023. The timestamp is genuinely in the past; future-time clamping is irrelevant.

Mechanism: the simulator's `instant` helper uses JavaScript Date and drops
microseconds. The verifier applies it to `providerAuditPayload.sandboxObservation`
at line 49, so payment control supplies rounded `occurredAt` and `observedAt` to
`payment_truth_ingest_event`. The immutable-observation guard
`payment_simulator_assert_truth` correctly requires exact timestamp equality
and refuses. Repeating this ingress cannot settle that captured observation.
The accepted-event replay branch also projects the PostgreSQL timestamp through
Date and needs the same precision assessment. The source inspection and one
failing restricted-role counterexample demonstrate a wrong refusal of an
in-scope captured observation, independently of the passing catalog boundary.

Reproducer: after the normal focused admission, run
`node --import tsx .context/scratch/g2/bundle/micro-probe.ts` on official Node
24.21.0. Evidence: `micro-result.json`, `micro.log`, and `micro-repeat.gate.log`
in that directory. A transparent executor records the original PostgreSQL error
and stack without changing SQL, arguments or role. Attempt and observation rows
are produced only by their bounded production writers. Only the existing
client/order/line fixture setup uses the owner. The initial scratch run omitted
the fixture's order/line transaction and stopped on its deferred sum constraint;
that setup mistake was corrected before the counterexample above (3.878 seconds).
Both diagnostic containers and pools were cleaned.

A two-line proposed source patch is retained as
`timestamp-preservation.proposed.patch` in bundle scratch, **not applied or
qualified**. It preserves the server observation's original timestamp in the
raw audit evidence and the accepted replay's saved evidence timestamp. It does
not relax the SQL guard or create browser-supplied paid truth. A production fix
would no longer have the accepted read's +/- source identity, so this run stops
with the mechanism and proposal before changing those production bytes.

Completed unchanged regression proof: 220 files pass, 6,182 passed cases,
zero failed cases and one existing managed-database opt-in skip. That includes
all previous 212 files, packageBoundary 2,894 cases, documentation impact 101,
cold consumer 108, source preview, payment truth schema/allowance, domain truth
and managed-storage transfer. The reviewed-batch suite was deliberately
interrupted after this independent material finding; reviewed portable creation,
eslint-import-map and generate-outcome-projection did not start. Interrupted
work is not counted as a product failure. Its owned test processes exited and
an owner-PID-labelled container census found zero remaining containers.

Separate executable truth: catalog 126/126 across both service-role modes and
transfer 13/13 pass. Both static native approvals and the trusted-main reader's
co-located/native-store preflight pass on the staged working-tree data snapshot.
The real pack and accepted-read identity accounting above remain valid.
The new timestamp counterexample is 0 passed / 1 failed. Joined handover, Linux
glibc consumer, final cheap checks, final signed-head preflight and native review
were not run after this stop. No canonical verify, push or external delivery.

Self-retro: millisecond-only fixtures hid PostgreSQL's greater timestamp
precision. Preserve authoritative evidence in its original representation;
normalize timestamps only where the consumer contract permits that precision
loss. Add fresh and replay precision counterexamples when the repair is authorized.


### Pre-review precision repair and native identity blocker

The supervisor authorized in-bundle TypeScript precision repairs before native
review. The current signed head is ba5e5c2d18130e265cc5e2e30728b93038c059c4,
a mechanical, DCO-signed merge of main 21c057038b25db6bdf490496a341df5b2f1fdbcc.
Its tree is 650cc25b3d4270dc4b7141fbf9f17fca702030e5. The preserved feature pin
and both task records remain staged; the authorized repairs and regression tests
remain uncommitted. No native session began and no repair cycle was used.

The simulator regression uses a restricted non-superuser, non-BYPASSRLS role
and a captured observation at 2026-10-30T12:00:00.123456Z. Before the repair,
the focused test fails: ingress gives 503 instead of 200 (one failed case).
The two-line repair retains the observation string in the raw verified payload
and uses accepted source_evidence.observedAt on replay. It passes the same case
(one passed, zero failed; 4.406 seconds), including one settled intent, one truth
row, one dispatch, and unchanged truth row version and dispatch state on replay.
Only envelope metadata still uses Date; the values compared by the immutable
SQL assertion come from the preserved evidence string. SQL and contract types
are unchanged. This is an authorized pre-review restoration of the accepted
contract, not a new semantic or a native repair cycle.

The purchase/renewal regression goes through that repaired simulator ingress,
activation, the attachment writer, listDue and buildCycleSnapshots. Before the
renewal precision repair it fails with subscription_renewal_snapshot_not_found
(one failed case; 22.920 seconds). The captured observation settled, the caller
has neither elevated role flag, and activation produced an exact stored
next_cycle_at of 2026-09-29T12:00:00.123456Z. No schedule row was hand-written.
The pending TypeScript repair projects UTC ISO timestamps with microseconds,
keeps the existing .sssZ dialect when the final three digits are zero, and
reads renewal observation/evidence timestamps as text. The test then passes
snapshot schema/round-trip checks, exact scheduledAt and authorization time,
scheduledInstant consistency, and codec/policy identity equality.

It stops at the subsequent real claim with
subscription_renewal_claim_invalid_snapshot (one failed case; 19.296 seconds).
The existing subscription_renewal_identity(uuid,timestamptz), defined in
20260815120000_automatic_subscription_renewal.sql, formats the key timestamp
with SS.MS. subscription_claim_due_renewal compares its input key with that
function at line 408, so a key retaining .123456Z is refused in favor of .123Z.
The exact schedule is now preserved; the failure is the SQL identity dialect.
Changing that SQL is outside this TypeScript-only repair authorization, while
truncating both TypeScript keys would contradict the explicit instruction that
an identity-key timestamp retain the exact stored instant. Stop for a bounded
supervisor decision on that dialect; do not weaken the test or SQL guard.

Evidence is in .context/scratch/g2/bundle-repair/: fail-before.json,
g6-pass-after.json, g2-fail-before.json, g2-pass-after.json,
precision-repairs.patch and precision-stop.json. Commands use official Node
24.21.0, the focused gate with exit-3 retry, and scripts/run-vitest.mjs with the
respective sub-millisecond test filter. Core and platform rebuilt successfully
before each production version was exercised. No existing assertion changed.
The full repaired-tree suite sweep, real pack, signed-head registry preflight
and native review have not run after this blocker. Earlier proofs do not claim
coverage of this repaired tree. A complete charge/replay result is not claimed.

Both canonical and packaged forward bytes remain unchanged: simulator
7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29;
purchase renewal
2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34.
Class data and forward pins were not changed by either precision repair.

Self-retro: preserving a snapshot timestamp is necessary but not sufficient;
trace the native identity formatter before assuming an exact timestamp can
reach claim unchanged. The counterexample exposed the remaining contract
conflict before spending time on the full sweep or starting review.

### Precision continuation after native key decision

The supervisor resolved the renewal identity stop without SQL: the label keeps
the native millisecond dialect using string truncation, while every schedule
lookup and timestamp comparison keeps the exact stored instant. Both precise
capture and purchase-to-renewal regression tests are included in the combined
pre-review repair. The simulator's only production repair remains preservation
of fresh/replayed authoritative evidence strings. It changes no contract type,
SQL assertion, permission, class data or forward bytes. The full combined
proofs and pack must pass before DCO; native review remains unstarted, 0/3.


### Precise renewal passed; package growth stop before full proof

The identity decision is implemented without SQL changes. On the restricted
non-superuser/non-BYPASSRLS runtime, the purchase-to-renewal precision regression
now passes: the simulator capture settles, activation completes, one snapshot
is built with exact schedule/authorization time, the claim is acquired, one
charge succeeds, the outcome settles a paid cycle, and a second run creates no
second charge or cycle. The known terminal public-run replay refusal remains
for the later renewal row; this test does not claim that later repair.
Both TypeScript keys equal PostgreSQL subscription_renewal_identity for all
four requested fractions: .123456 -> .123Z, .123999 -> .123Z,
.999999 -> .999Z (no carry), and .000000 -> .000Z.

Focused regression results: simulator 1 failed before / 1 passed after
(4.406 seconds after); purchase renewal 1 failed before with
subscription_renewal_snapshot_not_found / 1 passed after (21.159 seconds).
The intermediate exact-key attempt failed at claim before the supervisor's
millisecond-label decision, as recorded above. Existing assertions are
unchanged. These filtered runs are not the complete existing-suite sweep.
Official core/platform rebuild passes. Neutrality against main 21c05703
passes: 6,964 text files, 57 binary files, zero increases. The accepted-read
source accounting passes after listing only the two authorized precision
repairs separately; no other production or SQL delta is present.

The real official-toolchain pack was deliberately checked before the long
sweep, because the binding growth rule requires an immediate stop on a row's
increase. Against main 21c057038b25db6bdf490496a341df5b2f1fdbcc:
baseline 2,364,865 B packed, 1,899,251 B code gzip, 11,153,236 B unpacked,
2,955 files; repaired candidate 2,394,606 B packed, 1,916,655 B code gzip,
11,288,853 B unpacked, 2,972 files. Delta: +29,741 B packed, +17,404 B code
gzip, +135,617 B unpacked, +17 files. This is +547 B packed, +530 B code
gzip and +863 B unpacked above the previous combined figure, with no new file.
The code class remains below 1,970,000 B; no cap was changed.

The explicit comparison stop is nevertheless hit: +135,617 unpacked exceeds
the earlier two-row sum of 134,754 by 863 B, which the root-only test helper
does not explain. All 863 B are the authorized precision repairs' source and
emitted JavaScript: simulator -98 B, codec +106 B, renewal store +516 B,
sandbox renewal rail +339 B. No declaration, SQL, manifest, dependency or
other package file changed. There is no unrelated package growth to remove.
Stop for the supervisor to disposition this measured repair increment before
DCO and the full proof/review. No budget, cap, baseline or checker is edited.

Evidence: .context/scratch/g2/bundle-repair/g2-identity-pass-after.json,
identity-pass-after-command.json, neutrality.log, read-production-identity.json,
pack/summary.json, pack/repair-growth.json, and precision-repairs.patch.
Real pack command: on official Node 24.21.0, after focused admission,
`python3 .context/scratch/g2/bundle-repair/pack.py`; it builds an archived
main source, packs both real packages and applies the official measurePack
classifier. It exits with the explicit unpacked-growth stop above.

No new commit or native session was created. The signed head/tree remain
ba5e5c2d18130e265cc5e2e30728b93038c059c4 /
650cc25b3d4270dc4b7141fbf9f17fca702030e5; feature edits remain pending.
Both forward SHA-256 values and main's class data are unchanged, and both
feature pins remain as preserved. The full repaired-tree sweep, catalog,
transfer, handover, Linux consumer, final cheap checks, signed-head preflight
and native review remain required; prior-tree results are not carried over.
Native cycles used: 0/3; no counted PASS or source-review expiry.
OMS: neither supersededByStableJourneyKey nor checkoutAbandoned is written.
The bundle's previously disclosed new dispatch location is
payment_simulator_attempts; the precision repair adds no dispatch location.

Self-retro: a real-engine identity comparison closes the representation
ambiguity without widening SQL. Measure an explicitly authorized repair before
spending the long proof run when its package increment is itself a hard stop.


### Accepted repair size and combined proof continuation

The supervisor accepted the precisely itemized +863 B unpacked repair increment,
with zero added files. It is not an owner or cap matter. The reference against
main 21c05703 is now +29,741 B packed, +17,404 B code gzip, +135,617 B unpacked
and +17 files; candidate code class 1,916,655 B. No cap/baseline changed.
Subsequent growth stops only beyond this reference without an authorized
change's own itemized bytes, or beyond the 1,970,000 B code-class cap.
No pack is repeated while package inputs remain unchanged. The complete
combined repaired-tree proofs now resume before DCO and native review.


### Complete proof anchor before integrating native-store promotion

The repaired tree passes the complete 224-file sweep: 6,454 cases passed,
zero failed, and one unchanged managed-database opt-in skip. Every suite file
kept its pre-run hash. The previous 212-file set contributes 2,343 passing
cases, including the two new precision regressions. Additional checks include
packageBoundary 2,894; documentation-impact 101; cold consumer 122; source
preview 718; reviewed batch forwards 106; reviewed portable creation 20;
eslint-import-map 123; generate-outcome-projection 7; payment-truth schema 3;
payment allowance 8; domain truth 8; managed storage transfer 1. Full file names
and individual results are in .context/scratch/g2/bundle-repair/sweep-results.json.
The unchanged subscriptionComposition suite passes 20/20.

The restricted-role purchase-renewal suite passes 12/12 (including the paid-gap
second caller and precise purchase-to-renewal regression); method compatibility
3/3; retained method compatibility 1/1; simulator/cancellation 16/16; populated
connected transfer 13/13. Catalog truth passes 126/126 across service-role
present/absent modes. Both static native admissions pass. The offline Linux
glibc consumer passes on Node24.21.0/glibc2.36 with network disabled, a fresh
empty cache, exactly 16 local tarballs, and pg resolved at
/consumer/node_modules/pg/lib/index.js. No additional dependency was needed.

The unchanged joined handover witness completes in 100.952 seconds with
LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION, two accepted
effects recovered, and one uncertain operation fenced. The selected chain has
97 units and 88 transfer tables, current inventory
7c51eda0ec825e993283ba7d73463cea8e84e097d28543755a2e6bb2b8044dc3.
Graph/filesystem publication and target continuation assertions execute;
cleanupFailures is empty. Its report is under
.context/scratch/oss-m14-connected-catchup/journey-EN9LSx/report.json.
These finite handover rows do not claim the separate whole-journey proof.

Official core/platform builds, ast-grep (including suppression checks), lint
(including all eight structural-rule groups), strict public-tree typecheck,
neutrality against 21c05703 (zero increases), and gitleaks git with --log-opts=--all
all pass. The policy check reports only the scoped tests no-impact record,
whose current digest and explanation are included in this commit; CONTRIBUTING
is unchanged. Policy must be checked again after that record is committed.
No navigation regeneration is requested. All 2,972 package files still match
the measured tarball byte for byte; the accepted +29,741/+17,404/+135,617 B,
+17-file measure therefore remains applicable to this proof anchor.

The source-line identity command is
`python3 .context/scratch/g2/bundle-repair/read_identity.py 21c057038b25db6bdf490496a341df5b2f1fdbcc`.
It rejects every production path outside the two accepted own deltas, lists
the authorized precision repair lines separately, and accounts for exactly
one merge-only separator from b98cc9eb. Accepted original own +/- hashes:
G2 1a2cefbf86eaea14b5775098c2436925a987a84d61877dffa8b0e2444ace65bd;
G6 db4fb97f016f789996e96648f45873f954763427e98d9a4ec5392bcbfa0eb693.
G2 accepted-own plus authorized repairs and candidate-own +/- hashes are
both 6f41615d74d256b40721467ef1a31c3e85184b1b1af2f82de8239a002e6c4d69;
repair-only +/- hash 0acd0db3adc3129d5a40ae0d0dc4fb07eae828d6e9ec3126c528d02c63837749.
G6 accepted-own plus authorized repairs and candidate-own +/- hashes are
both e15695de449804d893c9f2a2f379df13fbe334b2ab58fd24fad71f3f6c86f2d1;
repair-only +/- hash f9fe546686050c70bc061a583a71a3f2d607a091a02225033b3f664549045710.

The only production changes beyond the accepted reads are the explicitly
authorized simulator evidence preservation and renewal timestamp/key repairs.
Canonical/packaged SQL bytes, class data and the two pins are unchanged.
Managed payment/subscription adapter and reference-runtime suites above pass
unchanged; no managed migration or served composition was edited.

During proof, shared main advanced to 2d5547dcccb5d9e3c40bece5016382fbf9f6a670
(native store promotion). A dry merge reports only disjoint publication-catalog
additions, with architecture and package README merging automatically. The
proof anchor above remains for the 21c05703 tree; it is not a claim that the
future integration has been checked. The authorized catalog union, subsequent
integration checks and pack, trusted-main reader preflight and two fresh full
reviewers remain before READY_FOR_VERIFY. No native session has started, 0/3.

Self-retro: the complete sweep took substantial admission wait time; no suite
was weakened to shorten it. Separate executable-source proof from scheduling
and from a later main integration rather than silently carrying results over.


### Required pre-review native-store integration

The full repaired-source proof anchor is DCO-signed at
bd07308db5d579f7df5c7a8539d40d3a04df697d, tree
5fc12f0406933b7ed5394d5a0a08d20a6c20cfe9, on main 21c05703.
The required fresh fetch found main at
2d5547dcccb5d9e3c40bece5016382fbf9f6a670 (native store promotion).
The dry and actual merges conflict only in disjoint publication-catalog
additions: preserve the two simulator test paths before both native-store
promotion test paths in lexical order. Every base entry and both disjoint
addition sets are byte-for-value preserved, with no duplicates or key changes.
Architecture and package README merge automatically. No own production, SQL,
class-data or pin change is introduced by this union. The only manual edits
beyond the catalog resolution are this integration bookkeeping in both records.
This is the authorized registry union, not a claim of a conflict-free merge.
No prior native session exists; the first full review still starts at 0/3.
The merged tree requires its updated build, integration proof, real pack,
policy and trusted-main admission before review. The earlier anchor's tests
are retained as source proof and are not relabelled as this integration's run.


### Timestamp representation audit and first native repair

The comparison base for provenance is `31423ca5`. The audit uses
`rg` for time fields, comparisons, ordering, SQL strings and fingerprints,
then follows their callers and checks `git blame --line-porcelain` ancestry
against that base. New package files have no base-path blame; the promoted
payment-truth implementation is additionally compared with the incumbent
`server/adapters/postgres/paymentTruth.ts` on that base.

Forms: **1** parses/compares full microsecond instants in PostgreSQL;
**2** preserves the exact database/request text without a JavaScript date
round trip; **3** canonicalizes JSON timestamp text in the same PostgreSQL
statement; **4** is the previously decided SQL millisecond identity label,
never a timestamp lookup. Column order in the archive and schema-ledger
position order are not chronological order. Rows below include time-bearing
SQL bindings and selections as well as actual decisions.

| Site | Form | Use and comparison | Provenance against base |
| --- | --- | --- | --- |
| `packages/platform/src/payments/contracts/sandbox.ts:8` | 2 | Authorization, observation, dispatch and recorded-time contracts remain strings (lines 8,18–19,32,39,42); no time decision in declarations.  | bundle-owned |
| `packages/platform/src/payments/contracts/truth.ts:28` | 2 | Evidence/ingest/reconciliation/source time strings (lines 28,40,51,65,103); no conversion in declarations. Most are main contracts; optional reviewRequiredAt is additive. | main f0b6087b |
| `packages/platform/src/payments/postgresPaymentTruth.ts:16` | 1 | INGEST parameter $8 / input.occurredAt is bound unchanged to the timestamp argument; evidence JSON contains the unchanged observedAt string. Promoted unchanged from main server/adapters/postgres/paymentTruth.ts:12,41. | main d77a966a |
| `packages/platform/src/payments/postgresPaymentTruth.ts:18` | 1 | RECONCILE parameter $6 / input.occurredAt is bound unchanged; evidence JSON preserves observedAt. Promoted unchanged from main server/adapters/postgres/paymentTruth.ts:14,59. | main d77a966a |
| `packages/platform/src/payments/postgresPaymentTruth.ts:20` | 1 | SWEEP binds input.now to the database timestamp cutoff; READ returns database JSON, never driver-parsed timestamp columns. Promoted unchanged from main server/adapters/postgres/paymentTruth.ts:16–17,71. | main d77a966a |
| `packages/platform/src/payments/postgresPaymentTruth.ts:116` | 2 | Payment-truth codec copies reviewRequiredAt from database JSON unchanged; it is metadata, not a comparator.  | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:15` | 2 | readAttempt returns PostgreSQL JSON time strings unchanged, including methodFacts and latestObservation.  | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:38` | 2 | Accepted-event replay takes the exact durable evidence observedAt, rather than the driver-parsed occurred_at.  | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:58` | 2 | Fresh/replayed observation time is passed unchanged as observedAt, truth occurredAt and returned application occurredAt (lines 58,62,71).  | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:78` | 3 | Explicit method-facts authorization time is canonicalized with to_jsonb(timestamptz) in the function-call statement; comparison uses the same session TimeZone. Defect repaired in this cycle; omitted/non-string facts are untouched. | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:80` | 1 | beginAttempt dispatch input.at is parsed by PostgreSQL as an exact timestamp; no JavaScript date conversion.  | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:84` | 1 | Observation occurredAt is bound unchanged to $5::timestamptz.  | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:85` | 2 | Observation request fingerprint preserves original input.occurredAt bytes. An identical request keeps the same bytes; alternate spellings are changed request payloads, not reconstructed database times.  | bundle-owned |
| `server/adapters/postgres/connectedStoreCapture.ts:101` | 2 | Captured rows are database JSON text under UTC; timestamp strings do not pass through JavaScript dates.  | main dcd8971d |
| `server/adapters/postgres/connectedStoreCapture.ts:69` | 2 | Server-incarnation fingerprint consumes PostgreSQL-rendered postmaster-start epoch text; no JavaScript timestamp round trip.  | main 99dab83b |
| `server/adapters/postgres/connectedStoreCapture.ts:149` | 2 | ORDER BY to_jsonb(row)::text is deterministic archive byte ordering, not chronological ordering; timestamp strings are opaque.  | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:392` | 3 | Restored simulator row is parsed with jsonb_populate_record then compared to the target via to_jsonb in the same UTC statement, including dispatch/update/authorization timestamps.  | bundle-owned |
| `server/adapters/postgres/connectedStoreRestore.ts:283` | 2 | Restore pins UTC before timestamp serialization and comparisons.  | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:212` | 3 | Retained lifecycle rows are parsed with jsonb_populate_record and emitted as database JSON in UTC.  | main a508a23f |
| `server/adapters/postgres/connectedStoreRestore.ts:298` | 2 | Schema-ledger JSON captures timestamp strings under UTC and compares unchanged JSON at lines 329 and 417; ordering is by position, not time.  | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:358` | 1 | Retained cycle/client import binds typed created/updated/scheduled times from jsonb_populate_record; generic insert uses the same typed record route.  | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:571` | 3 | Cleanup compares JSON occurredAt with PostgreSQL-rendered created_at in the UTC restore transaction.  | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:574` | 1 | Cleanup compares created_at/available_at with the exact transaction timestamp, in PostgreSQL.  | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:144` | donor follow-up | Unchanged donor compares nested audit revokedAt spelling with a membership timestamp string. Equivalent instants in different spellings can refuse projection; investigate under the identity-transfer owner, outside this bundle acceptance.  | main 99321e13 |

Non-decision coverage: the simulator's `instant()` at line 8 is used only
for envelope `providerOccurredAt` and display/audit `recordedAt` (lines 38
and 46), never for its SQL comparisons, lookup, dispatch key or payment
fingerprint. The accepted-row SELECT also reads an unused driver timestamp;
authoritative application/evidence time comes from `source_evidence.observedAt`.
Its read/observation contracts return PostgreSQL JSON time strings.
The truth codec only copies optional `reviewRequiredAt` as a string.
The payment adapter facade and index barrels contain no timestamp operation.

The renewal codec's `Date.parse` at lines 29,98,106,136,146 is the required
legacy `scheduledInstant` millisecond compatibility projection and its
internal consistency/finite checks; it does not match stored rows, identify
cycles or compare two distinct stored instants. `scheduledAt` remains full
precision. The sandbox rail's fresh host-clock Date at lines 14 and 48 only
creates a dispatch-reference suffix; operation UUID and existing ACK fence
supply its identity. The operation wildcard selects unused driver timestamp
columns; none feeds comparison or identity. Purchase completion and method
transitions have no caller-supplied timestamp. Transfer preserves all table
rows through database JSON text and typed record insertion, including the
newly owned tables; unused row timestamps never enter JavaScript dates.

The only additional bundle-owned comparison defect found is explicit
method-facts replay: PostgreSQL now canonicalizes the authorization timestamp
inside the begin-attempt statement. No SQL, forward hash, pin or class data
changes. Omitted facts and non-string values pass unchanged. An invalid
string on a replay now fails at the timestamp cast with `22007`, where the
old raw-JSON comparison returned `23505`; both refuse without a new dispatch.
The unchanged donor audit/membership lexical comparison above is recorded as
a follow-up, not repaired or included in this bundle's acceptance.

Restricted-role regressions before the repair: three explicit spellings and
the session-zone replay failed with request conflict; the one-microsecond
change and changed method reference already refused correctly. Invalid-string
creation already refused with `22007`; its replay returned `23505`.
After the repair all seven added cases pass, with the same durable attempt
row/version, dispatch timestamp and zero observations after successful replays.
The zone witness uses separate UTC and Etc/GMT-9 connections in both
directions. The first native repair cycle is one of three; both original
replay finding cards remain open until fresh independent reports close them.

Own-delta identity proof is extended by one authorized production repair:
`packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:77–81`
canonicalizes only a string authorization timestamp before the existing SQL
function call. The new repair-only +/- line SHA-256 is
`996048ebe5cd68d5f08388c3c64b7e8cad781ee5093131d510fc1dae6ac6fe0f`.
The earlier two repair hashes remain fixed; applying all three authorized
line deltas to the accepted reads yields the same production/SQL +/- line
multisets as this candidate against `31423ca5`. The admission test's only
delta is the separately authorized pin-path expectation and slow-case timeout.
No other production or SQL line difference is admitted by the proof script.
Commands and line inventories are retained in worktree scratch under
`.context/scratch/g2/method-replay-repair/`, including `read_identity.py`,
`timestamp-audit.json`, direct/symbol importer searches and base blame output.

The cross-session regression now uses the neutral fixed-offset zone
`Etc/GMT-9` (UTC+09:00, no daylight saving). Repeating that case with the
previously packed factory whose source is byte-identical to the pre-repair
signed head reproduces `23505`; restoring the repaired factory passes all
23 simulator cases. Both neutrality checks report zero increases. The repair
adds 240 bytes to source and 240 bytes to emitted JavaScript, with no new
package file. The real compressed measure remains a separate required proof.


### Zone-forced and mixed-session observations before the second repair

The unrepaired signed candidate is `239ebb6c`, on main comparison `31423ca5`.
The before probe runs eight real PostgreSQL suites unchanged under each of
`Etc/GMT-9` and `Etc/GMT+5`: each zone has 138 passed and four failed cases.
The process-scoped diagnostic preload adds the startup TimeZone option to
all loaded pg clients, including installed-consumer copies, preserving other
startup options. It changes no committed harness default or timestamp parser.

The three pre-existing main test observations are outside product acceptance:

| Site | Observation |
| --- | --- |
| `tests/postgres/subscriptionRetryLifecycleCases.ts:104–107` | A date-only SQL fixture means midnight in the session zone, while its assertion expects midnight UTC. |
| `tests/postgres/connectedStoreTransfer.test.ts:524` | Whole-row PostgreSQL JSON text is compared with a previously captured UTC rendering. |
| `tests/postgres/connectedStoreTransfer.test.ts:676` | Raw `next_cycle_at::text` is compared with a fixed UTC spelling. |

The bundle's retained-method test at
`tests/postgres/subscriptionRetainedMethodCompatibility.test.ts:162` has the
same raw-text assertion issue. Its authorized repair must still assert exactly
`2026-10-27T12:00:00Z`; it remains pending at this diagnostic stop.

The added mixed-session before probe alternates new connections between UTC
and UTC+09:00. It completes all eight suites with 133 passed and nine failed
cases. Six failures are additional main test snapshot comparisons:
`subscriptionRetryLifecycleCases.ts:163,201`,
`subscriptionStockWaitCases.ts:74` (missing and stale stock), and
`subscriptionStockAccountingCases.ts:30` (one and two restored lines).
Their `prepareState`/`allPublicRows` snapshots serialize timestamps with the
session spelling. Exact offset normalization makes every printed changed
line equal, including all six snapshot comparisons. These sites are unchanged
from main and are not among the three specifically classified exceptions;
no assertion or helper was changed to bypass them.

Mixed transfer also exposes the bundle's optional `reviewRequiredAt` readback
string changing spelling between source and restored sessions at
`connectedStoreTransfer.test.ts:394`. This is a bundle-owned identity-boundary
failure explained by the canonical timestamp rule. The known date-only fixture
and retained-method raw-text check account for the other two mixed failures.
The concurrent-ingress finding remains open; no interleaving regression or
canonical helper has yet been added.

The diagnostic harness patch exists only in child-process startup hooks.
Every child has ended, the probe environment does not escape the runner, and
`git diff -- tests/helpers/postgresContainer.ts tests/helpers/fulfillmentNative.ts tests/setup vitest.config.ts`
is empty. Full per-case results, diff normalization and revert evidence are in
`.context/scratch/g2/cycle2/`. No product, SQL, pin or class change was made.
The second repair stops before implementation because the mixed probe adds
unclassified main test failures beyond the allowed three; it needs disposition
before the required post-repair probe can be declared green.

Self-retro: mixed-session probes must account for diagnostic snapshot serializers
as well as product identity boundaries. Keep an actual readback identity defect
separate from unchanged test snapshots whose only difference is timestamp text.
### Canonical timestamp identity: second native repair

The regroup distinguishes **VALUE** (exact strings cast and compared by
PostgreSQL as timestamps) from **IDENTITY** (hashes, keys, strings and JSON
equality). Identity uses UTC ISO with exactly six fraction digits and `Z`.
The internal helper is not a new package entry or barrel export. It parses
strict RFC3339, validates whole seconds and offset arithmetic without putting
fractional digits through Date or a number, and pads the untouched fraction.
The same-statement PostgreSQL normalization of explicit method facts remains,
as does the SQL millisecond identity label: it truncates, never rounds, and
is not the full-precision lookup. The table supersedes the earlier forms.

All 42 earlier sites are reclassified below, split by additional consumers
where needed. Provenance uses `git blame --line-porcelain` against `31423ca5`;
promoted lines are also compared with their incumbent facade implementation.
The search covers time fields plus `fingerprint`, `Fingerprint`, `===`,
`JSON.stringify`, `createHash`, `Key(` and `identity` in every changed source.
The first sweep missed readback identity consumers (including optional review
time), and wrongly exempted original request spellings from fingerprint
identity. These are corrected in the bundle's own callers, with shared hashes,
gateway parsing, SQL, class data and forward pins unchanged.

| Site | Consumer | Use | Form | Own/main |
| --- | --- | --- | --- | --- |
| `packages/platform/src/payments/contracts/sandbox.ts:8` | Timestamp declarations; no comparison in types. Attempt time readbacks use IDENTITY below. | VALUE | string contract; consumers below | bundle-owned |
| `packages/platform/src/payments/contracts/truth.ts:28` | Timestamp declarations; no comparison in types. Optional review time uses IDENTITY below. | VALUE | string contract; consumers below | main f0b6087b |
| `packages/platform/src/payments/postgresPaymentTruth.ts:17` | INGEST parameter $8 / input.occurredAt is bound unchanged to the timestamp argument; evidence JSON contains the unchanged observedAt string. | VALUE | exact SQL cast / typed timestamp | main d77a966a |
| `packages/platform/src/payments/postgresPaymentTruth.ts:19` | RECONCILE parameter $6 / input.occurredAt is bound unchanged; evidence JSON preserves observedAt. | VALUE | exact SQL cast / typed timestamp | main d77a966a |
| `packages/platform/src/payments/postgresPaymentTruth.ts:21` | SWEEP binds input.now to the database timestamp cutoff; READ returns database JSON, never driver-parsed timestamp columns. | VALUE | exact SQL cast / typed timestamp | main d77a966a |
| `packages/platform/src/payments/postgresPaymentTruth.ts:116` | Optional reviewRequiredAt readback compared across source/restored sessions. MISSED by the first sweep; now canonicalized. | IDENTITY | canonical UTC six digits via internal helper | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:21` | readAttempt and beginAttempt readbacks: dispatchedAt, methodFacts.unattendedChargeAuthorizedAt, latestObservation.occurredAt and recordedAt. Cross-session JSON equality; MISSED readback consumers in the first sweep. | IDENTITY | canonical UTC six digits via internal helper | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:38` | Accepted replay occurredAt from evidence and recordedAt from UTC SQL text; canonical event payload/readback, no Date round trip. | IDENTITY | canonical UTC six digits via internal helper | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:65` | Own sandbox ingress canonicalizes occurredAt once, and passes that same UTC microsecond string as truth/evidence/result time before invoking the unchanged generic fingerprint dialect. | IDENTITY | canonical UTC six digits via internal helper | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:85` | Explicit method-facts authorization time is canonicalized with to_jsonb(timestamptz) in the function-call statement; comparison uses the same session TimeZone. | IDENTITY | same-statement PostgreSQL rendering / typed record | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:87` | beginAttempt dispatch input.at is parsed by PostgreSQL as an exact timestamp; no JavaScript date conversion. | VALUE | exact SQL cast / typed timestamp | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:91` | Observation occurredAt is bound unchanged to $5::timestamptz. | VALUE | exact SQL cast / typed timestamp | bundle-owned |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:85` | Observation request fingerprint normalizes occurredAt before shared payload hash; equivalent spelling replays, changed microsecond refuses. | IDENTITY | canonical UTC six digits via internal helper | bundle-owned |
| `server/adapters/postgres/connectedStoreCapture.ts:101` | Captured rows are database JSON text under UTC; timestamp strings do not pass through JavaScript dates. | IDENTITY | unchanged main archive spelling, UTC-pinned where applicable | main dcd8971d |
| `server/adapters/postgres/connectedStoreCapture.ts:69` | Server-incarnation fingerprint consumes PostgreSQL-rendered postmaster-start epoch text; no JavaScript timestamp round trip. | IDENTITY | unchanged main archive spelling, UTC-pinned where applicable | main 99dab83b |
| `server/adapters/postgres/connectedStoreCapture.ts:149` | ORDER BY to_jsonb(row)::text is deterministic archive byte ordering, not chronological ordering; timestamp strings are opaque. | IDENTITY | unchanged main archive spelling, UTC-pinned where applicable | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:392` | Restored simulator row is parsed with jsonb_populate_record then compared to the target via to_jsonb in the same UTC statement, including dispatch/update/authorization timestamps. | IDENTITY | same-statement PostgreSQL rendering / typed record | bundle-owned |
| `server/adapters/postgres/connectedStoreRestore.ts:283` | Restore pins UTC before timestamp serialization and comparisons. | IDENTITY | unchanged main archive spelling, UTC-pinned where applicable | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:212` | Retained lifecycle rows are parsed with jsonb_populate_record and emitted as database JSON in UTC. | IDENTITY | same-statement PostgreSQL rendering / typed record | main a508a23f |
| `server/adapters/postgres/connectedStoreRestore.ts:298` | Schema-ledger JSON captures timestamp strings under UTC and compares unchanged JSON at lines 329 and 417; ordering is by position, not time. | IDENTITY | unchanged main archive spelling, UTC-pinned where applicable | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:358` | Retained cycle/client import binds typed created/updated/scheduled times from jsonb_populate_record; generic insert uses the same typed record route. | VALUE | exact SQL cast / typed timestamp | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:571` | Cleanup compares JSON occurredAt with PostgreSQL-rendered created_at in the UTC restore transaction. | IDENTITY | same-statement PostgreSQL rendering / typed record | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:574` | Cleanup compares created_at/available_at with the exact transaction timestamp, in PostgreSQL. | VALUE | exact SQL cast / typed timestamp | main dcd8971d |
| `server/adapters/postgres/connectedStoreRestore.ts:144` | Unchanged donor compares nested audit revokedAt spelling with a membership timestamp string. Equivalent instants in different spellings can refuse projection; investigate under the identity-transfer owner, outside this bundle acceptance. | IDENTITY | DONOR FOLLOW-UP: lexical timestamp comparison unchanged | main 99321e13 |
| `packages/platform/src/payments/postgresPaymentTruth.ts:36` | Inherited generic fingerprint call preserves the exact historical request dialect, including its timestamp text. New simulator caller canonicalizes its occurredAt/evidence before reaching this main hash. Changing old ledger fingerprints requires separate compatibility work. | IDENTITY | unchanged main fingerprint dialect; new caller is canonical | main d77a966a, restored donor behavior |
| `packages/platform/src/payments/postgresPaymentTruth.ts:57` | Inherited generic fingerprint call preserves the exact historical request dialect, including its timestamp text. New simulator caller canonicalizes its occurredAt/evidence before reaching this main hash. Changing old ledger fingerprints requires separate compatibility work. | IDENTITY | unchanged main fingerprint dialect; new caller is canonical | main d77a966a, restored donor behavior |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:53` | Envelope providerOccurredAt and providerAuditPayload observation times; all returned exact UTC microsecond strings, including recordedAt. Previously dismissed as metadata. | IDENTITY | canonical helper | bundle-owned |
| `packages/platform/src/payments/nativeInstant.ts:3` | Strict RFC3339 shape including gateway output; split fraction string, whole-second date/offset arithmetic, six-digit padding, rejects guessing. | IDENTITY | module-local exact helper, shared vectors | bundle-owned |
| `packages/platform/src/payments/nativeInstant.ts:10` | Offset conversion and calendar validation use Date only without a fraction; identity fraction is never a number or rounded. | IDENTITY | whole seconds only; fraction remains text | bundle-owned |
| `server/adapters/postgres/paymentTruth.ts:2` | Existing path forwards factory to package implementation; managed served composition does not import this factory. | VALUE | facade only; no time operation | bundle-owned |

The existing main capture/restore archive bytes are retained. UTC-pinned
archive and schema-ledger spellings, and retained membership `revokedAt`
lexical equality, are donor-parity observations; no main production code is
changed. Typed record reconstruction/comparison stays in one PostgreSQL
statement. The purchase writer's pending, complete, method-transition and
method readbacks return no time fields. All own simulator time readbacks,
truth review time, activation time and renewal lease/ACK/terminal times now
have the canonical spelling. Frozen native wire identity uses six digits;
the native revision stays unchanged before first landing, and decode refuses
noncanonical frozen bytes rather than silently rewriting stored history.

The main test observations authorized for the probes are nine classified
sites/cases: date-only retry fixture, two transfer raw-text assertions, two
retry rollback snapshots, two technical-stock snapshots, and two restored-line
stock-accounting snapshots. Exact offset normalization removes all printed
snapshot differences. They remain unchanged and outside product acceptance.
The bundle's retained-method assertion selects UTC microseconds and still
asserts exactly `2026-10-27T12:00:00Z`.

The lead-authorized Review lessons entry in CONTRIBUTING promotes the recurring
lesson: classify value versus identity, canonicalize every identity, and run
the real-database suites under two non-UTC session zones. This prose-only path
is separately authorized outside the ordinary path set.

#### Second repair draft: proof stop before commit

The deterministic restricted-role interleaving counterexample fails before
the repair: session B returns HTTP 503 after A commits one capture. The
same draft regression passes after normalization, with one truth row, one
settlement and one dispatched attempt. Equivalent observation spellings also
fail replay before normalization; after it, the full simulator suite passes
25 cases, including explicit facts, offset, cross-session and one-microsecond
refusal cases. The helper unit suite passes 18 cases. The new purchase facts
counterexample fails before with `subscription_renewal_purchase_conflict`.
Its first diagnostic launch used an incorrect scratch transpiler module mode;
the one permitted launch retry corrects that scratch mode and reaches the
expected real-PostgreSQL assertion. No product assertion is credited to the
failed launch.

The default after probe passes all 25 simulator cases, then stops in purchase
renewal: 12 passed, one failed. The unchanged existing malformed-facts case
at `subscriptionPurchaseRenewal.test.ts:344` receives a synchronous
`native_instant_invalid` from `register()` for the `infinity` authorization
timestamp. Before the draft, that refusal was a rejected promise from SQL;
the `.rejects` assertion now cannot observe it. This is a draft source
regression, not an allowed main test observation. No assertion is changed,
no repair is attempted after the failure, and no commit or new native review
starts. The new purchase identity/readback case and the original precision
and four-fraction SQL key equality case both pass in this 12-case subtotal.
The remaining default suites and both forced-zone/mixed after runs are unrun.

The before matrix remains 138 passed/four failed per fixed zone, and 133
passed/nine failed mixed. The authorized main observations remain unchanged.
The 53-site draft audit has 23 VALUE and 30 IDENTITY sites, including the
readback sites missed by the first sweep. Its implementation claims still
require the unfinished after matrix and native class review.

Both neutrality checks pass (zero increases / zero UI hits). Both raw forwards
and the registry/packaged SQL have no changes. The process-only harness hook
has ended; the tracked harness diff is empty and no probe environment remains
in the parent. Artifacts, full first error and the revert evidence are under
`.context/scratch/g2/cycle2/`. No new pack, signed-head preflight or cycle-2
review result is claimed. The open concurrent-ingress card remains open in
the native session; cycle 2 is a draft and has not been prepared.

Self-retro: normalizing an input before an asynchronous SQL boundary must
preserve the public promise rejection contract as well as timestamp identity.
The existing malformed-input refusal case caught this before commit/review.

#### Pre-commit refusal boundary correction

The purchase writer's `register` is now async. Canonicalization therefore
rejects its promise instead of throwing synchronously, preserving the existing
malformed-input assertion unchanged. Its invalid timestamp message is now
`native_instant_invalid`, replacing the database validation message for that
input; both refuse and no write is dispatched. Other asynchronous public
callers normalize inside their async methods or after an awaited read. Codec
and identity-policy methods intentionally remain synchronous, as before.
This corrects the uncommitted draft within the timestamp rule; no SQL,
assertion, fixture, harness, contract declaration or package export changes.

#### Private helper placement: pre-commit boundary stop

The asynchronous refusal correction passes the existing purchase suite:
13 passed, zero failed, with the malformed-facts assertion unchanged. The
resumed default probe also passes the simulator (25 cases) and transfer
(13 cases): 51 passed, zero failed across those three files. Transfer teardown
completed before the owned runner and its next gate waiter were stopped.
No test process or container was interrupted. The remaining default suites
and all forced/mixed after-probes are unrun on this draft.

The unchanged package-boundary suite reports 2,936 passed and three failed
cases at `packageBoundary.test.ts:333`. The rejected imports are the private
payment helper in nativePurchaseRenewal, nativeRenewalCodec and
sandboxRenewalRail. Its `relativeImportAllowed` rule permits cross-module
access only through an existing public entry. The unchanged module graph in
`eslint.config.js:167–168` gives subscriptions and payments no runtime value
edges. A root private helper is not a module/public entry and also has no
allowed path under that rule. No existing exact public-core timestamp helper
was found by the scoped canonical/microsecond search. A helper relocation
therefore has no permitted common location without a new public route or
boundary change; separate module-local helpers would require changing the
explicit one-helper constraint. No alias, indirect import, policy exemption,
control edit or new public export is introduced to evade this boundary.

The catalog diff contains only the two helper source/test entries (eight
added lines), in file order. The early unstaged policy invocation cannot
materialize those untracked files yet; its inventory refusal is not a signed
policy result. Lint/import-map, pack, staged/signed policy, preflight and fresh
cycle-2 review remain unrun. No commit is made. The native session stays at
its cycle-1 signed candidate; the cycle-2 repair remains a draft and its open
concurrent-ingress card has not been closed.

The process-local diagnostic hook has ended, the tracked harness diff remains
empty, and the parent has no probe variables. The full boundary failure and
resumed counts are in `.context/scratch/g2/cycle2/boundary-stop.json` and
`package-boundary.json`. SQL, migrations, packaged SQL, pins and class data
remain unchanged. The new Review lessons text and all earlier draft edits
are retained for the next disposition.

Self-retro: a shared internal mechanism must have an allowed module home
before its callers are wired. Preserve the closed graph instead of exporting
an internal utility or adding an unapproved dependency edge to silence a test.

#### Authorized module-local copies

Each module now owns the same private `nativeInstant` implementation, with no
cross-module private import, boundary change or package-entry export. The
single vector suite calls both copies and asserts identical canonical outputs
and identical Error names/messages for refusals. Its 27 cases cover no fraction,
one through six digits, both offset signs, gateway RFC3339 conversion across
day/year boundaries, `.999999` without carry, invalid shapes, `infinity` and
seven fraction digits. The full package-boundary suite passes 2,942 cases;
`git diff 239ebb6c -- packages/platform/api` is empty. The draft catalog delta
contains only the three new helper source/test file entries. The audit now has
55 sites: 23 VALUE and 32 IDENTITY, adding the second module's two helper sites.
This explicitly supersedes the one-helper placement assumption and resolves
the private-import draft regression without changing the controls.

#### Due VALUE carrier compatibility correction

The default retained-method case exposed a draft regression, with
`subscription_renewal_claim_invalid_snapshot`: its existing injected legacy
codec builds SQL's millisecond identity label directly from the due carrier.
Changing that carrier's zero-microsecond spelling to six digits changed that
label. The due carrier now preserves the prior three-digit form only when its
last three fraction digits are zero; nonzero microseconds remain untouched.
It is a VALUE cast for row lookup, and compatibility with the explicitly
retained millisecond label is preserved. Native freeze separately canonicalizes
its scheduledAt identity field to all six digits before hashing/encoding.
No SQL, assertion, fixture, harness or public export changes are made. This
corrects the uncommitted draft within the VALUE/IDENTITY rule under the
supervisor's pre-commit repair authority. It is not one of the nine main test
observations and must pass on the final draft.

The retained-method regression now passes on the restricted role unchanged
apart from its previously authorized exact-instant assertion. The audit splits
the due VALUE carrier from the native frozen IDENTITY consumer: 56 sites,
24 VALUE and 32 IDENTITY. The complete probe matrix is rerun after this draft
compatibility correction; earlier default results are not its final proof.

#### Official pack after the second repair draft

Node `v24.21.0` from the official toolchain measures the current bundle against
`31423ca5`: +33,028 packed bytes, +19,841 code-class gzip bytes, +143,783
unpacked bytes and +23 files. The candidate code class is 1,950,394 bytes,
below 1,970,000. The prior signed candidate `239ebb6c` on the same base measures
+30,971 packed, +17,490 code, +136,097 unpacked and +17 files. Its exact
unpacked increase over the accepted reference is the previously authorized
480-byte third repair; the compressed delta changes with the integrated base.
The fourth repair adds +2,057 packed, +2,351 code, +7,686 unpacked bytes and
six files relative to that prior candidate. The six files are the two private
helpers' source, emitted JavaScript and declarations. The shared vector test
and root adapter/transfer files add no tarball bytes. No unrelated packaged
path changes. The detailed real-pack reports and content hashes are retained
under `.context/scratch/g2/cycle2/pack/`.

| Pack path | Before bytes | After bytes | Delta |
| --- | ---: | ---: | ---: |
| dist/payments/nativeInstant.d.ts | 0 | 144 | +144 |
| dist/payments/nativeInstant.js | 0 | 950 | +950 |
| dist/payments/postgresPaymentTruth.js | 5743 | 6164 | +421 |
| dist/payments/postgresSandboxPaymentSimulator.js | 6781 | 7390 | +609 |
| dist/subscriptions/nativeInstant.d.ts | 0 | 144 | +144 |
| dist/subscriptions/nativeInstant.js | 0 | 950 | +950 |
| dist/subscriptions/nativePurchaseRenewal.js | 3493 | 3763 | +270 |
| dist/subscriptions/nativeRenewalCodec.js | 11665 | 12126 | +461 |
| dist/subscriptions/sandboxRenewalRail.js | 7670 | 7758 | +88 |
| src/payments/nativeInstant.ts | 0 | 920 | +920 |
| src/payments/postgresPaymentTruth.ts | 5869 | 6270 | +401 |
| src/payments/postgresSandboxPaymentSimulator.ts | 6792 | 7407 | +615 |
| src/subscriptions/nativeInstant.ts | 0 | 920 | +920 |
| src/subscriptions/nativePurchaseRenewal.ts | 4549 | 4809 | +260 |
| src/subscriptions/nativeRenewalCodec.ts | 11789 | 12234 | +445 |
| src/subscriptions/sandboxRenewalRail.ts | 8142 | 8230 | +88 |

#### Accepted-read identity after the canonical timestamp repair

The fourth production repair is confined to the two private instant helpers,
the payment-truth and simulator callers, the purchase writer, the native codec
and the sandbox renewal rail. The new helpers and caller line changes are
listed in `.context/scratch/g2/cycle2/read-production-identity.json`, with
fourth-repair +/- line SHA-256
`1befe291e24a63a9d568c2713a35c88d1265416b962dcfb104bb40a598f5079a`.
The first three authorized repair counters remain pinned unchanged. After
accounting for these four repairs and the previously identified merge-only
blank separator, each row's own production and SQL delta equals its accepted
read as a multiset of path, sign, exact line and multiplicity.

Reproduce with:
`python3 .context/scratch/g2/cycle2/read_identity.py 31423ca5b3e44698eb9a1ce342addad3e58b5d71`.
The G2 expected/candidate hash is
`722e90a8507d94b490a45151bf57fa85138a2a7e6a1e27131ff32208ba681cab`;
the G6 expected/candidate hash is
`e83b0896dcfa2cd0d14cb7c9b80a190bb71cbf41dd67c077da55e4d43e903b32`.
No other production/SQL delta is admitted. The two forward hashes remain
`7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29`
and `2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34`,
including their packaged copies. The API-report directory and package export
manifest are unchanged against `239ebb6c`.

| Repair site | Consumer and change |
| --- | --- |
| `packages/platform/src/payments/nativeInstant.ts:1` | Private exact UTC microsecond identity conversion. |
| `packages/platform/src/subscriptions/nativeInstant.ts:1` | Same module-local implementation, checked by shared vectors. |
| `packages/platform/src/payments/postgresPaymentTruth.ts:36` | Canonical ingest/reconciliation fingerprint time fields; optional review readback uses the same canonical instant. Exact SQL VALUE inputs stay unchanged. |
| `packages/platform/src/payments/postgresSandboxPaymentSimulator.ts:9` | Canonical attempt/observation readbacks, accepted replay projection, envelope time and observation-request fingerprint. The earlier same-statement facts comparison fix stays. |
| `packages/platform/src/subscriptions/nativePurchaseRenewal.ts:32` | Async facts normalization before JSON replay comparison, plus canonical activation readback. |
| `packages/platform/src/subscriptions/nativeRenewalCodec.ts:54` | Canonical native frozen identity and lease/ACK/terminal readbacks, preserving the exact due VALUE carrier and SQL millisecond label. |
| `packages/platform/src/subscriptions/sandboxRenewalRail.ts:49` | Canonical dispatch-reference clock and fallback evidence times, plus the existing truncated SQL identity label. |

Nonproduction changes are counterexamples, the shared vector test, the exact
retained-method assertion, helper-only catalog additions, neutral task records,
the owner/fragment timestamp explanation and the lead-authorized Review
lessons entry. The earlier admission-suite change is test-only under the
separate authorization: first-two pin paths and one timeout/comment only.

#### Final draft probe stop: own raw transfer snapshot

The default matrix completes eight suites with 145 passed and no failures.
Each fixed zone completes with 142 passed and the same three authorized main
test failures. Their reasons are checked from the actual diffs: the date-only
SQL input denotes session midnight; every raw snapshot difference vanishes
under exact UTC microsecond normalization. All bundle-added or changed cases
pass in the default and both fixed zones.

The mixed run passes the simulator (25 cases) and purchase renewal (13 cases),
then transfer reports 11 passed and two failed. One is the already classified
main raw-schedule spelling at line 676. The new failure is the bundle's own
accepted transfer test at `connectedStoreTransfer.test.ts:565`, outside the
nine allowed main cases. It compares `to_jsonb(t)::text` from independently
pooled source and target sessions. The first table, renewal attachments, has
the same order/subscription IDs, purchase facts and exact timestamps, but
created_at/completed_at render with +09:00 at source and +00:00 at target.
Exact offset normalization removes every printed difference. This is another
test-side raw timestamp spelling assumption, not demonstrated stored-data
loss or a product readback defect. The preceding reviewRequiredAt comparison
now passes. The later duty-completion and renewal assertions in this case
are not reached in this mixed run and are not claimed as mixed proof.

No existing assertion, fixture, harness or production code is altered to make
this new case pass. The probe stops as required for an unclassified failure;
the automatic post-probe checks refuse to start. The five remaining mixed
suites are unrun. Lint, final policy/preflight, commit and fresh cycle-2 review
are unrun. No native finding is closed or new repair cycle prepared.

Pre-commit results completed before the stop: shared vectors 27/27; full
package boundary 2,942/2,942; import-map 123/123; catalog 126/126; admission
210/210; ast-grep and strict typecheck pass; all-ref gitleaks scans 1,760
commits with zero leaks. API reports and export manifest are unchanged against
239ebb6c. The three draft regressions corrected are asynchronous refusal,
private cross-module helper placement (authorized local copies) and the
millisecond due VALUE spelling for injected legacy identity codecs. They are
recorded separately from this new unchanged-test assumption.

The real pack remains +33,028 packed, +19,841 code, +143,783 unpacked bytes
and +23 files against 31423ca5; absolute code 1,950,394 bytes. No packaged
byte changes follow that measurement. Both forward hashes, packaged copies,
pins, class data and main controls remain unchanged. All uncommitted edits,
including the two helper copies and lead-authorized lesson, are retained.
The process-only hook has ended, no probe variables remain in the parent, and
the tracked harness diff is empty. Evidence is in
`.context/scratch/g2/cycle2/mixed-own-transfer-stop.json`.

Self-retro: mixed-session coverage can expose raw test snapshots only after
an earlier failing case completes further work and changes connection reuse.
Preserve full-row equality and exact instants when a test-side query eventually
gets an authorized canonical projection; do not change product session policy
to accommodate diagnostic text comparisons.

#### Full-row assertion timezone scope and accepted-reference size attribution

The standing test-side authority is applied only to the bundle's row equality
at `connectedStoreTransfer.test.ts:565`: each source/target read now owns a
read-only transaction with `SET LOCAL TimeZone='UTC'`, followed by rollback
and release. The original SELECT, all six tables, all columns, exact instants,
row ordering and full-row equality stay intact. Main's nine test sites and the
shared harness remain unchanged. No production session timezone is set.

The accepted tarball pair on `21c05703` reproduces +17,404 code bytes,
+135,617 unpacked bytes and +17 files. The current tarball pair on `31423ca5`
reproduces +19,841 code, +143,783 unpacked and +23 files. Their difference is
exactly +2,437 code, +8,166 unpacked and +6 files. The table below uses the
same measurePack implementation and exact lexical-order marginal gzip
contributions for each pair, then subtracts those per-path contributions.
Gzip dictionary interactions make standalone per-file gzip sizes nonadditive;
zero-content-growth rows explicitly identify compression-context effects.
These rows do not imply changed source. The earlier standalone f130 comparison
reproduced unpacked/files but had a different compression context; it is not
the accepted-reference attribution.

All content growth is the authorized timestamp repair: 480 bytes from the
third repair and 7,686 from this fourth repair. The six files are the two
private helpers' source/JavaScript/declarations; no new package export exists.
The vector test, root transfer assertion and owner/record prose add no tarball
bytes. Absolute code remains 1,950,394, below 1,970,000. The artifact is
`.context/scratch/g2/cycle2/itemization/accepted-reference-itemization.json`.

| Pack path | Code gzip delta | Unpacked delta | Files | Attribution |
| --- | ---: | ---: | ---: | --- |
| dist/payments/contracts/index.d.ts | -2 | +0 | +0 | Compression context only; content unchanged |
| dist/payments/contracts/sandbox.d.ts | +11 | +0 | +0 | Compression context only; content unchanged |
| dist/payments/contracts/sandbox.js | +4 | +0 | +0 | Compression context only; content unchanged |
| dist/payments/contracts/truth.d.ts | +4 | +0 | +0 | Compression context only; content unchanged |
| dist/payments/nativeInstant.d.ts | +45 | +144 | +1 | Authorized timestamp helper/caller change |
| dist/payments/nativeInstant.js | +339 | +950 | +1 | Authorized timestamp helper/caller change |
| dist/payments/postgresPaymentTruth.js | +71 | +421 | +0 | Authorized timestamp helper/caller change |
| dist/payments/postgresSandboxPaymentSimulator.d.ts | +7 | +0 | +0 | Compression context only; content unchanged |
| dist/payments/postgresSandboxPaymentSimulator.js | +179 | +849 | +0 | Authorized timestamp helper/caller change |
| dist/subscriptions/index.d.ts | -8 | +0 | +0 | Compression context only; content unchanged |
| dist/subscriptions/index.js | +3 | +0 | +0 | Compression context only; content unchanged |
| dist/subscriptions/nativeInstant.d.ts | +56 | +144 | +1 | Authorized timestamp helper/caller change |
| dist/subscriptions/nativeInstant.js | +354 | +950 | +1 | Authorized timestamp helper/caller change |
| dist/subscriptions/nativePurchaseRenewal.d.ts | -14 | +0 | +0 | Compression context only; content unchanged |
| dist/subscriptions/nativePurchaseRenewal.js | +51 | +270 | +0 | Authorized timestamp helper/caller change |
| dist/subscriptions/nativeRenewalCodec.js | +123 | +461 | +0 | Authorized timestamp helper/caller change |
| dist/subscriptions/postgresRenewalStore.d.ts | -1 | +0 | +0 | Compression context only; content unchanged |
| dist/subscriptions/postgresRenewalStore.js | +15 | +0 | +0 | Compression context only; content unchanged |
| dist/subscriptions/sandboxRenewalRail.d.ts | -23 | +0 | +0 | Compression context only; content unchanged |
| dist/subscriptions/sandboxRenewalRail.js | -27 | +88 | +0 | Authorized timestamp helper/caller change |
| src/payments/contracts/index.ts | -1 | +0 | +0 | Compression context only; content unchanged |
| src/payments/contracts/sandbox.ts | +3 | +0 | +0 | Compression context only; content unchanged |
| src/payments/index.ts | +3 | +0 | +0 | Compression context only; content unchanged |
| src/payments/nativeInstant.ts | +364 | +920 | +1 | Authorized timestamp helper/caller change |
| src/payments/postgresPaymentTruth.ts | +76 | +401 | +0 | Authorized timestamp helper/caller change |
| src/payments/postgresSandboxPaymentSimulator.ts | +233 | +855 | +0 | Authorized timestamp helper/caller change |
| src/subscriptions/index.ts | -2 | +0 | +0 | Compression context only; content unchanged |
| src/subscriptions/nativeInstant.ts | +416 | +920 | +1 | Authorized timestamp helper/caller change |
| src/subscriptions/nativePurchaseRenewal.ts | +20 | +260 | +0 | Authorized timestamp helper/caller change |
| src/subscriptions/nativeRenewalCodec.ts | +153 | +445 | +0 | Authorized timestamp helper/caller change |
| src/subscriptions/postgresRenewalStore.ts | -18 | +0 | +0 | Compression context only; content unchanged |
| src/subscriptions/sandboxRenewalRail.ts | +3 | +88 | +0 | Authorized timestamp helper/caller change |
| **Total** | **+2,437** | **+8,166** | **+6** | Authorized changes, caps unchanged |

#### Generic fingerprint donor parity correction before commit

A new restricted-role counterexample writes a retained native event through
the existing production truth routine using the unchanged public fingerprint
function. The draft generic port's normalization then refuses the identical
replay with `payment_truth_event_fingerprint_conflict` (23505). This was an
uncommitted draft regression: changing the generic fingerprint input would
invalidate existing native ledger history. The generic ingest/reconciliation
calls are restored byte-for-byte to the inherited main dialect; no shared main
hash, gateway or SQL is changed. The new simulator instead canonicalizes its
own occurredAt/evidence/result instant at its source boundary, before that
unchanged generic call. The full simulator suite passes 26 cases after this
correction, including the retained replay and concurrent-zone counterexamples.
No second event or settlement is produced for the retained replay.

The audit now explicitly marks the two inherited fingerprint sites as donor
parity, not as a new format to impose on stored history. The source-boundary
normalization satisfies the identity rule for new sandbox work. Generic host
inputs retain their previous lexical fingerprint contract; versioning or
migrating that historical dialect is outside this bundle. The preceding fourth
repair hash and size table are superseded by the final corrected source and
pack measurements to follow. All post-repair probes are rerun on that source.

#### Corrected final repair identity and size reference

The generic-fingerprint donor-parity correction supersedes the preceding
fourth-repair hash and pack figures. The corrected fourth-repair +/- line hash
is `8aac26c2259ae3f70dec5aa06264fc38a1355e608a8416cd10aba4b1967bae19`.
The G2 expected/candidate hash remains
`722e90a8507d94b490a45151bf57fa85138a2a7e6a1e27131ff32208ba681cab`;
the G6 expected/candidate hash is now
`8a4a84b9522f56d08935e4bcfcda6f0d2bc0ea7c40ce646c6dd735fda53cba03`.
The first three repair counters and both SQL hashes remain unchanged. The
same read_identity.py command verifies every production/SQL line against
accepted reads plus those explicit repairs.

The refreshed official real pack against `31423ca5` is +32,965 packed bytes,
+19,791 code-class gzip bytes, +143,197 unpacked bytes and +23 files. Absolute
code is 1,950,344 bytes. Relative to the preceding measured draft, restoring
the generic dialect and normalizing only the sandbox source removes 63 packed,
50 code and 586 unpacked bytes, with no file-count change. Only the two payment
callers' source/emitted JavaScript changed packaged bytes. No cap or baseline
is changed. Growth over the accepted reference is now exactly +2,387 code,
+7,580 unpacked and +6 files: the 480-byte third repair plus the corrected
7,100-byte fourth repair, with exact gzip attribution below. Every content
change remains one of the authorized timestamp helper/caller paths.

| Pack path | Code gzip delta | Unpacked delta | Files | Attribution |
| --- | ---: | ---: | ---: | --- |
| dist/payments/contracts/index.d.ts | -2 | +0 | +0 | Compression context only |
| dist/payments/contracts/sandbox.d.ts | +11 | +0 | +0 | Compression context only |
| dist/payments/contracts/sandbox.js | +4 | +0 | +0 | Compression context only |
| dist/payments/contracts/truth.d.ts | +4 | +0 | +0 | Compression context only |
| dist/payments/nativeInstant.d.ts | +45 | +144 | +1 | Authorized timestamp caller/helper |
| dist/payments/nativeInstant.js | +339 | +950 | +1 | Authorized timestamp caller/helper |
| dist/payments/postgresPaymentTruth.js | +26 | +103 | +0 | Authorized timestamp caller/helper |
| dist/payments/postgresSandboxPaymentSimulator.d.ts | -4 | +0 | +0 | Compression context only |
| dist/payments/postgresSandboxPaymentSimulator.js | +210 | +869 | +0 | Authorized timestamp caller/helper |
| dist/subscriptions/index.d.ts | -5 | +0 | +0 | Compression context only |
| dist/subscriptions/nativeInstant.d.ts | +55 | +144 | +1 | Authorized timestamp caller/helper |
| dist/subscriptions/nativeInstant.js | +357 | +950 | +1 | Authorized timestamp caller/helper |
| dist/subscriptions/nativePurchaseRenewal.d.ts | -13 | +0 | +0 | Compression context only |
| dist/subscriptions/nativePurchaseRenewal.js | +45 | +270 | +0 | Authorized timestamp caller/helper |
| dist/subscriptions/nativeRenewalCodec.d.ts | +2 | +0 | +0 | Compression context only |
| dist/subscriptions/nativeRenewalCodec.js | +125 | +461 | +0 | Authorized timestamp caller/helper |
| dist/subscriptions/postgresRenewalStore.js | +16 | +0 | +0 | Compression context only |
| dist/subscriptions/sandboxRenewalRail.d.ts | -22 | +0 | +0 | Compression context only |
| dist/subscriptions/sandboxRenewalRail.js | -29 | +88 | +0 | Authorized timestamp caller/helper |
| src/payments/contracts/index.ts | -2 | +0 | +0 | Compression context only |
| src/payments/contracts/sandbox.ts | +2 | +0 | +0 | Compression context only |
| src/payments/contracts/truth.ts | +1 | +0 | +0 | Compression context only |
| src/payments/index.ts | -1 | +0 | +0 | Compression context only |
| src/payments/nativeInstant.ts | +366 | +920 | +1 | Authorized timestamp caller/helper |
| src/payments/postgresPaymentTruth.ts | +29 | +103 | +0 | Authorized timestamp caller/helper |
| src/payments/postgresSandboxPaymentSimulator.ts | +256 | +865 | +0 | Authorized timestamp caller/helper |
| src/subscriptions/index.ts | -2 | +0 | +0 | Compression context only |
| src/subscriptions/nativeInstant.ts | +415 | +920 | +1 | Authorized timestamp caller/helper |
| src/subscriptions/nativePurchaseRenewal.ts | +21 | +260 | +0 | Authorized timestamp caller/helper |
| src/subscriptions/nativeRenewalCodec.ts | +152 | +445 | +0 | Authorized timestamp caller/helper |
| src/subscriptions/postgresRenewalStore.ts | -17 | +0 | +0 | Compression context only |
| src/subscriptions/sandboxRenewalRail.ts | +3 | +88 | +0 | Authorized timestamp caller/helper |
| **Total** | **+2,387** | **+7,580** | **+6** | Exact accepted/current artifact attribution |

#### Current-main co-location preflight stop

While the corrected final probes run, origin/main advances to
`eedb9f9a9927002f20a30b0111ca044f9f51175a`. The current-main reader is copied
unchanged into scratch, with recorded source hashes, and used against the
signed checkpoint `239ebb6c` whose registry, pins and SQL are unchanged in the
draft. Both native forward checks pass. Co-location refuses with the exact
message: `reviewed replacement admission machinery must be approved separately before co-located SQL/pins`.
The previous authorized integration is `31423ca5`; newer main changes include
`.github/INSTALL_SUPPORT_POLICY.md` and `scripts/oss-publication-contract.ts`.
Those paths trigger the unchanged reader's control/release-path guard when
comparing current main with this older candidate. The uncommitted timestamp
repair touches neither path and cannot clear that refusal. No checker, pin,
class, budget or main code is changed to bypass it, and no later main is merged.
A current-main integration needs the supervisor's explicit disposition under
the existing no-later-main instruction.

The corrected source completes default with 146 passed/no failures and UTC+09
with 143 passed/the same three classified main observations. UTC−05 and mixed
are unrun on this final donor-parity correction; earlier intermediate probe
results are not claimed for it. The prior corrected UTC assertion did pass the
mixed transfer continuation, including pending attachment completion, before
the final donor-parity correction. The active test is allowed to finish and
run teardown, then only the owned waiting probe/check runners are stopped.
No native review, commit, verify, push or PR starts. The native cycle stays 1;
the pending source is the intended cycle-2 repair, not a new counted finding.

The new retained-native fingerprint counterexample fails before the correction
with 23505 and passes afterwards as part of 26/26 simulator cases, with one
truth and one settlement. Completed pre-correction boundary/vector/import-map,
catalog/admission and typecheck results remain separately dated evidence;
final lint, typecheck, boundary rerun, signed policy and signed preflight are
unfinished. The read-identity proof on the final source still accounts for all
production/SQL lines with the corrected fourth-repair hash. Package delta and
accepted-reference per-file itemization remain the corrected figures above:
+32,965 packed, +19,791 code, +143,197 unpacked, +23 files; +2,387 code,
+7,580 unpacked and +6 files above the accepted reference; absolute code
1,950,344. No package, API, pin or SQL bytes change after that measurement.
The source and all diagnostic observations remain uncommitted. Evidence and
cleanup/harness-revert proof are in `.context/scratch/g2/cycle2/main-preflight-stop.json`.

Self-retro: canonicalize newly reconstructed source identity without changing
an inherited ledger's fingerprint dialect; the real retained-replay case
caught that draft regression. Refresh the trusted-main preflight before long
proof sequences so unrelated main control-path drift is surfaced earlier.


#### Final cycle-2 repair checkpoint and authorized leaf integration

The supervisor authorizes exactly `eedb9f9a9927002f20a30b0111ca044f9f51175a`
after the current-main preflight refusal. The repair is committed first; the
leaf integration follows as a separate signed mechanical merge. This is cycle
2 of the existing native session, with no budget reset. Review has not begun.

Final draft lint passes (36.056 seconds). Tree-wide neutrality reports zero
increases; UI neutrality reports zero forbidden hits. All API reports and the
package export manifest remain unchanged against `239ebb6c`. Policy's sole
unanswered tests obligation is answered by the measured scoped trailer in the
repair commit. The tarball-relative paths in the size table are plain text so
that the repository-path checker does not interpret them as repository links.
This changes no size attribution or runtime behavior.

The exact accepted-read comparison is rerun with
`python3 .context/scratch/g2/cycle2/read_identity.py 31423ca5b3e44698eb9a1ce342addad3e58b5d71`.
It confirms the same four explicitly itemized production repairs and no other
production or SQL difference. The fourth repair's line hash remains
`8aac26c2259ae3f70dec5aa06264fc38a1355e608a8416cd10aba4b1967bae19`.
The generic native truth fingerprint retains its inherited dialect; only the
new simulator's caller normalizes time identity before invoking that hash.
The retained truth counterexample passes after this correction. No shared
managed hash, gateway, SQL, pin, class or boundary is changed.

Default and UTC+09 final probes completed before this integration: 146/0 and
143/3 respectively, with all three failures the previously classified unchanged
main test observations. UTC−05 and mixed remain to run on the integrated head.
The integration carry-over check is
`git diff --name-only 31423ca5 eedb9f9a -- db packages tests` (empty).
The signed merge must equal the independently computed merge-tree. Its policy,
trusted-main preflight, starter and remaining proof results are subsequent
scratch evidence, not claimed by this pre-integration checkpoint.
