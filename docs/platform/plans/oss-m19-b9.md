# Native store journey and transfer proof

Status: stage 1 local candidate, development preview. Final joined renewal
acceptance remains pending the native rows below.

Code base: `4d78e855cf8bbd57704f9503cd7bae28f96453a5`.
Instruction freshness pin: `4d78e855cf8bbd57704f9503cd7bae28f96453a5`, fetched
again at this continuation; applicable instruction paths had no delta.

## Outcome, scope and authority

The final outcome is one native store that runs its purchase journey, is
captured, restores into a pristine database, then renews exactly once and
returns the stored renewal result on replay without another order or delivery.
Stage 1 proves checkout draft persistence, sandbox attempt/observation and
verified ingress capture, activation with an open renewal-attachment duty,
capture, pristine restore and restricted-runtime duty completion/replay.

The worker owns only the two new PostgreSQL test files, one shared fixture,
this record and four publication-catalog rows. Existing transfer/composition
witnesses, adapters, packages, migrations, scripts and the example application
are unchanged. Local implementation and a DCO commit are authorized by the
coordinating supervisor. No maintainer read is required for this test-only
boundary. Push, submission, native-review preparation, reviews, merge, release,
adopter changes and hosted resources remain outside this run. No native review
session, repair cycle or WIP ref was created.

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
