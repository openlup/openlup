# Native store journey and transfer proof

Status: stage 1 local candidate, development preview. Final joined renewal
acceptance remains pending the native rows below.

Code base: `4d78e855cf8bbd57704f9503cd7bae28f96453a5`.
Instruction freshness pin: `4d78e855cf8bbd57704f9503cd7bae28f96453a5`, fetched
during stage 1. This extension reread the local instruction revision; no fetch
or merge was performed, so remote freshness is unverified.

## Outcome, scope and authority

The final outcome is one native store that runs its purchase journey, is
captured, restores into a pristine database, then renews exactly once and
returns the stored renewal result on replay without another order or delivery.
Stage 1 proves checkout draft persistence, sandbox attempt/observation and
verified ingress capture, activation with an open renewal-attachment duty,
capture, pristine restore and restricted-runtime duty completion/replay.

Stage 1 owns its new PostgreSQL tests, shared fixture and catalog rows. A later
bounded extension also owns the connected-capture adapter's exact authorization
exclusion, one new PostgreSQL test, transfer documentation and this record.
The carried table list, existing transfer/composition witnesses, restore adapter,
packages, migrations, scripts and example application remain unchanged.
The extension is staged and uncommitted pending the required security/trust
boundary read. No DCO sign-off, native-review preparation, review, push,
submission, merge, release, adopter change or hosted resource is authorized in
this round. The existing local stage 1 commit remains the base.

## Authorization-state transfer exclusion

The exact relation `public.customer_identity_challenges` is intentionally not
carried. These rows are single-use, short-lived authorization state holding token
hashes, so carrying them would move live bearer material between stores, and
customers sign in again after a restore. Census includes only relation, owner,
row count and the new `intentionally-not-carried` disposition. The adapter never
reads any challenge column; all other nonempty outside-profile relations still
refuse. The carried table set and restore behavior stay unchanged.

The new PostgreSQL witness must establish no inbound foreign keys or required-id
references, capture used/expired/live challenges without their rows or hashes,
restore zero challenge rows into a pristine installation, issue/redeem a new
native challenge and read the customer's own profile through the restricted
runtime, and preserve the registry tuple and differential lead-absorption result. This is
an explicitly accepted plan item with no equivalent in the reference adopter's
journey. It does not implement the still-missing guest checkout start.

## Acceptance and discriminating proof

Each suite uses owned disposable PostgreSQL and the qualified-v2 chain. The
existing migration owner installs and restores; journey commands use the actual
non-superuser, non-bypass runtime login without extra grants. The tests also
prove that the runtime cannot read attachment and method-event tables directly.
The target is separately installed and pristine before restore.

The two-SKU purchase totals 1027 XXX minor units (274 + 753), with explicit
line, settlement and renewal-term assertions. Paid/activation/next-cycle and
authorization timestamps retain `.123456` microseconds. An independent census
reads lossless PostgreSQL JSON text from every public table except the target's
migration ledger. Populated data missing from the capture profile must refuse
capture or fail exact readback. The target ledger stays unchanged.

Checkout and activation replay, unpaid activation refusal, changed-quote refusal,
changed-purchase-facts refusal and attachment completion/replay leave the exact
expected rows. The transferred duty drains once, retaining one order, one paid
cycle and no fabricated shipment. The original source stays unchanged. The
existing transfer file already separately proves a checkout receipt and a
writer-produced renewal graph; these new tests join purchase and activation on
one store instead of repeating its transfer/refusal matrix.

## Stage boundary and waiting rows

Stage 1 stops before post-restore renewal execution/replay. On inspected main,
`tests/postgres/subscriptionPurchaseRenewal.test.ts` explicitly characterizes a
repeat of a successful public renewal call as throwing
`subscription_renewal_claim_not_due` instead of returning terminal replay.
The first effect is safe, but the required stored replay answer is absent.
The missing G7 repair is terminal admission in `subscription_claim_due_renewal`
and its composed renewal/retry binding. This is source-characterization
inspection, not a newly executed joined renewal/replay witness.

Waiting steps are destinations and purchase reservations, G7 renewal/retry and
terminal replay, G8 paid/dunning notice dispatch, and G11-c consent choices.
Shipment-read composition follows its owning row. These natives are not mocked
or skipped. Later integration is coordinated by the supervisor; this row lands
once after its required predecessors. No complete store, hosted installation,
provider qualification, browser journey or programme closure is claimed.

## Executed evidence

All commands used Node 24.21.0 and npm 11.19.0. Heavy phases used the existing
focused admission gate, with the SQL chain retaining priority.

| Check | Result and evidence |
| --- | --- |
| Unchanged connected-store and qualified composition baseline | PASS: 3 files, 20 tests, 180.29 s; `.context/scratch/b9-baseline.log` |
| Final new PostgreSQL suites, one worker | PASS: 2 tests, 15.24 s; `.context/scratch/b9-journeys-final.log` |
| Published-tree typecheck | PASS: all five projects, zero edges/errors; `.context/scratch/b9-typecheck-final.log` |
| Lint | PASS: 0 errors, 33 warnings outside changed files; `.context/scratch/b9-lint.log` |
| Public CI neutrality | PASS: 0 increases; `.context/scratch/b9-neutrality-final.log` |
| Structural scan, both suppression errors enabled | PASS; `.context/scratch/b9-ast-final.log` |
| Official package check and pack | PASS: 3 packages, no findings; `.context/scratch/b9-official-pack.log` |

The PostgreSQL command is `VITEST_MAX_WORKERS=1 npm test --` followed by the two
`tests/postgres/storeJourney*.test.ts` paths. The baseline command selected
`connectedStoreTransfer.test.ts`, `m14QualifiedComposition.test.ts` and
`m14QualifiedAdminComposition.test.ts`, unchanged. No timing or launch rerun was
used. The ordinary native-review and canonical verify gates have not started.

Full documentation policy is run after the DCO commit because it reads the
scoped `OpenLup-Doc-Impact` trailer from that commit. Its result is retained in
`.context/scratch/b9-policy-committed.log` and the final handoff. The tests stay
under the existing cross-boundary root and use existing test commands; no
production contract or test-running/placement guidance changes.

## Package measurement

`npm run packages:check -- --pack --out .context/scratch/b9-official-packs`
produced the official artifacts. A comparison packed the base's archived
package source and the candidate with the pinned build output; package sources
and all official/comparison SHA-256 hashes were equal. The existing official
`measurePack` function supplied class measurements. All three deltas are zero
packed bytes, unpacked bytes, code bytes and files. No new test/helper is packed.

| Package | Packed B | Unpacked B | Files | Code-class B |
| --- | ---: | ---: | ---: | ---: |
| Core | 182871 | 765428 | 229 | 153067 |
| Outbox | 41407 | 143183 | 42 | 21424 |
| Platform | 2439455 | 11467472 | 3024 | 1952891 |

Comparison evidence: `.context/scratch/b9-pack-comparison/result.json`.

## Repairs and self-retro

The initial catalog placement failed sorting; only the four new rows moved.
Pre-commit documentation policy then required a committed trailer; the
supervisor corrected the execution order without changing any control.
The initial new-suite helper hashed a nullable external reference; it now uses
the contract's settlement-ID fallback. Inspection corrected differing census
and capture ordering by sorting copies of raw row strings. Typecheck found
optional context access (TS18048), then a replacement shape with optional mode
(TS2322). Narrowing the original context resolved both; current checks pass.
Earlier pauses and failures remain in the scratch logs; no retry/review budget
was reset or hidden.

Self-retro: narrow the fixture's existing optional value before mutation; that
preserves its required contract fields without constructing a weaker shape.


## Authorization exclusion continuation

The extension is staged on the stage 1 commit and remains uncommitted pending
the security/trust-boundary read. The exclusion adds no configuration value:
its only named value is the exact relation name. Test data and identity
configuration are neutral synthetic fixtures, not reference-adopter values.

The initial real PostgreSQL proof reached restored sign-in and customer reads,
then found the native absorption classification gap: three client-referencing
tables lacked registry dispositions. The earlier failure is retained in
`.context/scratch/b9-challenge-isolated.log`. The approved current proof is
narrower: equivalent leads and native challenges on source and restored stores
must yield exactly equal absorption responses, including outcome, refusal code
and blocking tables. It does not hard-code the current classification answer.
The challenge registry tuple is compared exactly across restore; its explanatory
note is preserved rather than pinned to prose. No test-only policy row or
reference deletion changes the native answer.

The challenge-specific absorption assertion lands together with the
classification repair for the three client-referencing tables. B9 adds it once
that repair is on main. The SQL stream owns the classification repair and its
full-chain regression proof. Guest checkout start and renewal replay remain
outside this extension and await their owning native rows.

Earlier fixture defects were repaired: a generated JWK lacked `use: sig`, and
the shared fixture's letters-only routine guard rejected a versioned RPC name.
The new test uses the fixed native SQL call. No unexplained assertion was
rerun and no retry or review history was reset.

Current continuation evidence follows. No commit, DCO sign-off, native review, push or canonical verify is
authorized before the read is answered.

Self-retro: separate a transfer-equivalence proof from an independent native
classification repair; keep the latter's explicit assertion with its owning
repair instead of manufacturing policy in the transfer fixture.


## Stabilized exclusion evidence

Pinned Node 24.21.0 and npm 11.19.0; heavy phases used the focused gate with
SQL-chain priority. No timing-only or launch-error rerun was needed.

| Check | Result and evidence |
| --- | --- |
| PostgreSQL, all six selected files | PASS: 23 tests, 198.70 s; `.context/scratch/b9-challenge-differential-postgres.log` |
| Unchanged transfer/composition baseline within that run | PASS: 3 files / 20 tests; Git diff confirms no baseline-file delta |
| Challenge proof and both stage 1 suites within that run | PASS: 3 files / 3 tests, including exact differential absorption response and unknown-table refusal |
| Published-tree typecheck | PASS: all five projects, zero edges/errors; `.context/scratch/b9-challenge-differential-typecheck.log` |
| Lint | PASS: 0 errors, 39 warnings outside changed files; `.context/scratch/b9-challenge-differential-lint.log` |
| Neutrality | PASS: 0 increases; `.context/scratch/b9-challenge-differential-neutrality-final.log` |
| Structural scan | PASS with both suppression errors enabled; `.context/scratch/b9-challenge-differential-ast.log` |
| Documentation policy and navigation update | Two obligations, exactly one unanswered: `tests` at `CONTRIBUTING.md#development-preview-checks`; `.context/scratch/b9-challenge-differential-policy-final.log` |
| Official package check/pack | PASS: 3 packages, no findings; `.context/scratch/b9-challenge-differential-official-pack.log` |

The pending test-documentation obligation requires the later commit's scoped
no-impact trailer; no commit or sign-off is permitted before the read. The
transfer owner's section is updated. Test placement and invocation remain the
existing root PostgreSQL suite and npm test command. Documentation update
produced no generated tracked delta.

The current official archives match both base and candidate comparison archives
by SHA-256. The fresh measurement reproduces the package figures in the table
above: core 182871 packed B / 765428 unpacked B / 229 files; outbox 41407 /
143183 / 42; platform 2439455 / 11467472 / 3024. Every package has zero delta in
packed bytes, unpacked bytes, code-class packed bytes and files. The capture
adapter, tests and documentation are not packaged. Comparison uses the official
size classifier, the unchanged base package sources and pinned build output.
Evidence: `.context/scratch/b9-challenge-pack-comparison/result.json` and its
`official-verification.json` companion.

All six conditions pass at the approved differential scope. The challenge-
specific absorption assertion, guest checkout start and post-restore renewal
replay remain deliberately unproved here. No hosted/adopter execution, canonical
verify, native review or delivery action is claimed. The staged patch identity
is recorded privately after this final evidence edit; no self-referential hash
is placed in this record.
