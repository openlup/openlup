# Native store journey and transfer proof

Status: stage 1 local candidate, development preview. Final joined renewal
acceptance remains pending the joined proof below.

Code base: `4d78e855cf8bbd57704f9503cd7bae28f96453a5`.
Instruction freshness pin: `850c38e33521f3985bbd595fb32060f1f521569d`, fetched
before the renewal continuation. The changed contribution guidance documents an inert
installation-reader identity; it changes no active SQL or runtime absorption
availability. The signed-off code integration remains
`de43b6633e824aad6fe9de4d114c3c030318bd12`, whose parents are the exclusion
candidate and main `ad373b82b830f645cc09c97f355f50022973788c`. The code
comparison base is separate from the instruction pin.

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
The security/trust-boundary read accepted the exact exclusion before its
signed-off commit. This continuation authorizes the required main integration,
test-only repairs and stronger assertions, documentation, checks, one signed-off
test commit and an update to the existing draft. Native-review preparation,
review, canonical verification, readiness, landing, release, adopter changes
and hosted resources remain outside this step.

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
journey. Guest checkout start is now covered by the joined continuation below.

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

Stage 1 stops before post-restore renewal execution/replay. Its original
inspection found a missing terminal replay answer. The owning native renewal
repair is now on main; this is source inspection, not an executed joined
post-restore renewal/replay witness.

The joined renewal execution and terminal replay witness is recorded below.
Paid/dunning notice dispatch remains for the next joined witness.
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

The accepted exclusion is committed on the stage 1 candidate. It adds no
configuration value: its only named value is the exact relation name. Test data and identity
configuration are neutral synthetic fixtures, not reference-adopter values.

The initial real PostgreSQL proof reached restored sign-in and customer reads,
then found the native absorption classification gap: three client-referencing
tables lacked registry dispositions. The earlier failure is retained in
`.context/scratch/b9-challenge-isolated.log`. The initial accepted differential proof required equivalent leads and native
challenges on source and restored stores to yield exactly equal absorption
responses, including outcome, refusal code
and blocking tables. It does not hard-code the complete classification answer.
The challenge registry tuple is compared exactly across restore; its explanatory
note is preserved rather than pinned to prose. No test-only policy row or
reference deletion changes the native answer.

The three previously unclassified client-reference relations now have their
native policy rows on main. The test additionally requires both installations
to refuse absorption of a lead with a populated native challenge and to name
`customer_identity_challenges` among the blocking tables. Exact differential
response equality and the restored registry tuple remain required; containment
does not prescribe whether other tables also block. No fixture policy row or
reference deletion manufactures the answer. Joined post-restore renewal replay
remains pending; the later joined continuation covers guest checkout start.

Earlier fixture defects were repaired: a generated JWK lacked `use: sig`, and
the shared fixture's letters-only routine guard rejected a versioned RPC name.
The new test uses the fixed native SQL call. No unexplained assertion was
rerun and no retry or review history was reset.

The following stabilized evidence predates the accepted read and main integration;
current continuation evidence is recorded separately below.

Self-retro: preserve the native classification answer without fixture policy
changes; once the owning repair lands, add the challenge-specific assertion.


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

The earlier test-documentation obligation was answered by the exclusion commit's
scoped no-impact trailer after its accepted read. The
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

All six conditions passed at the earlier approved differential scope. Joined
post-restore renewal replay remains unproved here; guest start follows below. No hosted/adopter execution, canonical
verify, native review or delivery action is claimed. The staged patch identity
is recorded privately after this final evidence edit; no self-referential hash
is placed in this record.


## Main integration and challenge assertion continuation

The merged-tree control sweep passed: trusted main's class reader accepted the
committed-tree overlay and all seven native forwards; the three catalog suites
passed 1,061 tests. The production exclusion's added and removed lines are
unchanged by integration: the SHA-256 of `git diff --no-ext-diff --unified=0`
filtered to added/removed content lines is
`8ec65931a6e83b6a0622bc18c19d459801580e75be1c93acfa1e617de66024aa`
for both `4d78e855..36bc9739` and `origin/main..de43b663`, restricted to
`server/adapters/postgres/connectedStoreCapture.ts`. No production or control
change accompanies this test-only continuation.

The first merged-tree PostgreSQL run passed 29 tests and failed the challenge
packet's blanket `token_hash` column-name assertion. A different carried table
now legitimately describes that column in its schema, with no rows. The repair
keeps every token and hash value absent from the complete serialized packet.
It checks both column names across all remaining sections after removing only
carried-table schema descriptions, forbids a carried challenge table and proves
that refusal using a mutated packet copy. Census and all outside-profile
sections are included in the column-name check. No database data, grant or
classification is changed. The corrected absorption assertion requires the
effective native challenge block on both stores while retaining exact response
and registry equality.

Self-retro: separate challenge row/value exclusion from unrelated carried
schema vocabulary; a structural packet check preserves the intended boundary.


The six-file continuation run on Node 24.21.0 passed five files and 29 tests;
the challenge test failed at the restricted-runtime absorption call with
`permission denied for table commerce_destinations` (247.01 s total;
`.context/scratch/b9-rulings-postgres.log`). The packet structural assertions,
mutated-copy refusal, registry preservation, restore replay and restored sign-in
checks ran before that call. No absorption response was returned in that attempt, so the new
effective-block assertion remained unproved at that point. The current native
routine scans populated blockers as its invoker, while the destination migration
revokes direct runtime access to its table. No fixture grant, changed runtime,
policy row or production edit bypasses that boundary. That attempt stopped before commit, the remaining pre-review set or draft
update; no retry or fixture privilege change was made.

Self-retro: after a classification gap closes, exercise its actual runtime
privileges; registry completeness alone does not establish callable composition.


Absorption classification is proved with owner access because the restricted-
runtime absorption count read is a documented pre-existing limit on main with
its own closure work; this row does not claim availability for the restricted
runtime. The existing `subscriptionRetainedRenewal.test.ts` and
`commerceDestinationsNative.test.ts` witnesses separately pin that limit.
Only the classification call now uses the owner connection on both stores;
challenge issue/redeem, session binding and customer profile reads retain the
restricted runtime, and all differential and challenge-block assertions remain.


The owner-access continuation passed all six selected PostgreSQL files and all
30 tests on Node 24.21.0 in 245.47 s
(`.context/scratch/b9-owner-postgres.log`). Both real classification results are
refusals naming the challenge relation and remain exactly equal, including the
refusal code and complete blocking-table array. Registry preservation, packet
value/section checks and the mutated-packet control pass as well. No timing or
launch retry was needed. The control sweep remains applicable because this
continuation changes only the challenge test and this record.


Before sign-off, lint passed with zero errors and 45 warnings outside the changed
files, strict published-tree typecheck passed all five projects with zero
unresolved edges and consumer-side errors, and the structural scan and whitespace
check passed. Evidence is in `.context/scratch/b9-owner-lint-before.log` and
`.context/scratch/b9-owner-typecheck-before.log`. Documentation policy identifies
only the test unit's expected fresh no-impact trailer. Committed-tree checks and
the draft update follow; no native prepare, review or canonical verification
has run.

Self-retro: reuse the existing owner-access classification witness for a known
runtime read limit, and state its availability boundary explicitly.

## Joined journey continuation

The remaining named journeys are now in this row's accepted test scope. The
first bounded continuation adds guest checkout start, transferred destinations
and purchase reservations, and actor-owned consent choices, each in a new
PostgreSQL file. Renewal execution/terminal replay and paid/dunning dispatch
remain for the next continuation; they are not claimed by these cases. Only
new tests, generic fixture additions, catalog entries and this record change.
Each step receives its own signed-off commit and draft update; native review,
canonical verification and landing still follow separately.

Guest checkout uses the actual `checkout.create` and `payment.simulate`
composition in `examples/neutral-store/host/purchase-composition.ts:64,189`,
with the contact registrar at
`packages/platform/src/identity/postgresContactClientRegistrar.ts:51`. Both
one-time and subscription modes use synthetic configuration and catalogue
seeds on the native installation, without invoking the starter installer.
The case requires an unlinked contact and a paid order before capture, exact
order/obligation replay on both stores, and native sign-in after restore that
returns the same customer's profile and purchased order. No acquisition intake
row is created or removed to admit capture.

The standard runner `TZ` setting, exposed by `Intl`, selects either of the two
non-default PostgreSQL server session zones for an isolated run. The fixture
verifies actual owner/runtime session zones; all other runner zones preserve
the database default. A direct custom environment read was refused by the
neutrality check and removed; no ratchet baseline or control changed.
All new fixture timestamps are explicit UTC instants. The earlier two-store
case measured about 11 seconds; new guest cases have 90-second limits including
their own installation, leaving loaded-host headroom.

The first guest run refused both modes at checkout admission because the test
supplied a plain requester label where the host contract requires a SHA-256
peer digest. The fixture now supplies that digest; the real limiter and binding
guards remain unchanged. This was a fixture error, not a product defect.

Guest checkout is now proved by `storeJourneyGuestCheckout.test.ts`: two cases
(one-time and subscription), both passing in the default zone (19.34 s),
`Etc/GMT-9` (21.66 s) and `Etc/GMT+5` (21.67 s). Each case uses a fresh source
and pristine target, proves no acquisition intake, buys anonymously through
main's composition, restores the paid purchase, compares exact checkout replay
and purchase rows, then signs in natively and reads the same customer/order.
The 90-second case limit exceeds four times the measured total for both guest cases.
This continuation converged after correcting the peer-digest fixture input;
no assertion or guard was weakened and no production defect was found.

Self-retro: use the host's admitted identity representation in a composition
fixture, rather than replacing its admission callback.

The publication inventory initially refused the new file while it was still
untracked; staging the test with its catalog row resolved that refusal. The
only remaining documentation obligation is the fresh test-unit trailer.

Strict typecheck found an unannotated empty replay-result array inferred as
`never[]`; an explicit `unknown[]` type fixes that fixture-only error without
changing its runtime behavior or assertions.

Guest sign-off checks passed: strict published-tree typecheck, structural scan,
neutrality (zero increases), whitespace and lint (zero errors; 45 existing
warnings). No full scanner set, native review or canonical verification ran in
this continuation.


The destination/reservation continuation follows the native destination port
(`packages/platform/src/commerce/server/destinations/index.ts:19`) and purchase
reservation port (`packages/platform/src/inventory/purchaseReservation.ts:39`).
Its new witness registers an immutable order address, creates observed stock
and purchase holds, captures/restores that graph, then uses the restricted
runtime for exact destination/hold replay, stock-budget equality and changed-
input refusals. An owner-prepared undispatched parcel supports the existing
stable `commerce_view_shipment_destination` read; the read must not pin a new
binding. Expiry one microsecond before and exactly at the fixed UTC boundary
must match on source and target, with exact replay and no extra rows/effects.
No parcel dispatch, arrival or delivery-alignment confirmation is claimed.


The destination/reservation file passed its one joined case in the default zone
(9.78 s), `Etc/GMT-9` (10.82 s) and `Etc/GMT+5` (10.67 s). Source and target
finish with exactly equal public-row census after expiry. The 90-second case
limit exceeds eight times the measured duration. The case converged in this
continuation without a failed PostgreSQL attempt or production defect.

Self-retro: use the stable shipment destination view for a transfer read witness;
a read must not create a binding that later capture would have to explain.

Destination/reservation sign-off checks passed: strict typecheck, structural
scan, whitespace, neutrality (zero increases) and lint (zero errors; 45 existing
warnings). The fresh test-unit trailer answers the documentation obligation.


The consent continuation follows the native actor read and write SQL at
`db/platform/migrations/20261101232000_customer_account_consents.sql:44,94`.
Each purpose receives its own source/restore case with real native account
creation and authenticated, non-superuser runtime calls. The source grant and
its event/work identities must survive restore and replay exactly; the restored
customer must read and withdraw the choice with exact replay. Cross-customer
reads/writes and changed-payload replay must refuse without effects. The existing
outbox rail is enabled with synthetic installation configuration, without
provider dispatch. New consent effect identities are generated only by the
native writer; the source stays byte-identical after target continuation.


The consent file passed both purposes in the default zone (19.37 s),
`Etc/GMT-9` (20.74 s) and `Etc/GMT+5` (18.35 s). Captured permission/work
identities and complete choice responses replay exactly after restore; each
restored customer writes a new denial and replays it without another event or
work item. The other customer cannot read or change the choice, changed-payload
replay refuses, and the source remains unchanged. The 90-second per-case bound
exceeds four times the earlier measured two-case guest file total. No failed
PostgreSQL attempt or product defect occurred in this consent continuation.

All three journeys in this continuation are now proved. Remaining joined proof
is renewal execution with terminal replay after restore and paid/dunning notice
dispatch. No full pre-review set, native preparation/review, canonical verify or
landing has been run here.

Self-retro: replay the captured consent receipt before issuing a new restored-
store change; this distinguishes preserved identity from a replacement write.

Consent sign-off checks passed: strict published-tree typecheck, structural
scan, whitespace, neutrality (zero increases) and lint (zero errors; 45 existing
warnings). Each of the three new test files has its catalog entry and measured
default/two-zone proof. The full pre-review set remains deferred until the
remaining two journeys are joined.


## Joined renewal execution and terminal replay

`storeJourneyRenewal.test.ts` follows the native automatic renewal composition
(`packages/platform/src/subscriptions/automaticRenewal.ts:34`), native sandbox
rail, reservation and settlement ports, and retry lifecycle binding. Its source
purchase registers the immutable destination before activation and completes the
real renewal attachment. Synthetic observed stock and an explicit local parcel
port are installation configuration; acquisition intake remains empty.

After capture and pristine restore, the due row and pre-claim snapshot are
exactly equal. Native claim freezes the registered destination; the expected
snapshot is the original snapshot transformed by the shipped destination codec.
The first attempt completed renewal but exposed the test's mistaken comparison
of that claimed snapshot with its earlier unbound form. Correcting that expected
transformation retains exact snapshot equality; no assertion or native guard is
removed. Both source and restored runtimes then execute the same due renewal
and create one order, settled intent, paid cycle and consumed two-line hold.
The actual paid event drives the native paid-handoff port
(`packages/platform/src/fulfillment/postgresPaidHandoffStore.ts:5`), creating one
shipment obligation. No parcel dispatch or arrival is claimed.

The terminal repeat must return the same operation and identity with
`terminal_replay`, never the earlier `subscription_renewal_claim_not_due` answer.
The sandbox execution count remains one. The entire stored operation, every
public row, and per-table counts/SHA-256 hashes remain equal across both renewal
and handoff replay. The normalized result and frozen snapshot match between
source and restored stores. Every new clock value is an explicit UTC instant.
The 90-second case limit retains headroom over the measured two-store cases.

The restricted-runtime absorption count read remains a documented pre-existing
limit of main with its own closure work; this row proves its classification with
owner access and does not claim restricted-runtime absorption availability.

Self-retro: compare a claimed snapshot against the native destination-binding
transformation, while checking its pre-claim transfer equality separately.


The renewal file passed its one joined case in the default zone (9.69 s),
`Etc/GMT-9` (9.82 s) and `Etc/GMT+5` (9.34 s), including native delivery
obligation creation and full replay census/hash equality. The database fixture
verifies the actual session zone. Strict typecheck identified the method reader's
intentionally opaque result; an explicit string guard narrows that fixture input
without converting or replacing it. No production defect was found.
