# Native sandbox payment ingress and durable attempts

Status: stopped at an existing-suite missing packaged SQL asset failure after
the authorized additive-column assertion passed. The signed candidate is intact;
no source/SQL repair or native review has been performed.
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
`packages/platform/changes/sandbox-payment-truth.md`, with no catalogue row.
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
- `packages/platform/test/payments/stripe/conformance.test.ts`
- `packages/platform/test/payments/stripe/factory.test.ts`
- `packages/platform/test/payments/tpay/conformance.test.ts`
- `packages/platform/test/payments/tpay/factory.test.ts`
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
- `server/bff/commerce/tpay-channels.test.ts`
- `server/domains/payment/paymentTruth.test.ts`
- `server/infra/stripe/stripeApiClient.test.ts`
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
- `tests/stripe/stripeCriticalPathFakeGate.test.tsx`

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
