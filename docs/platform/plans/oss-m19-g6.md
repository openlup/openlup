# Native sandbox payment ingress and durable attempts

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
revoked before conditional service_role execution. CD-M19-47 adds explicit ALL
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
| `src/pages/ReferencePaymentRepairPage.test.tsx` | PASS | 9 |
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
