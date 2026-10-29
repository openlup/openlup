# M14 older-snapshot recovery

Status: development-preview local parcel, working proof and prior native review
passed; main integration review and final verification pending. The predecessor
`613091a91b0029d34846f1b922e42fed30f99d3e` landed on main. The integrated
review base is main parent `9195f281a741ca83c7974dd956a33a41d32cf8a4`;
the stack pin is removed. Current instruction revision is that same main head.

## Outcome and authority

Persist a consistent finite native DB/private-object snapshot before synthetic
provider acceptance, then exercise lost acknowledgment, induced unavailability,
actual older-snapshot restore, authenticated late observations, reconciliation
and controlled executor takeover. Preserve the connected journey's retained
graph, active subscriptions and outstanding duties. Reapply later privacy
obligations before serving restored data. One unknown dispatch remains visibly
fenced; readiness explicitly permits that refusal while ordinary work resumes.

The active supervisor is the single writer in the assigned task worktree.
Authorized actions are local implementation, DCO after the required maintainer
read, two independent fresh FULL reviews, verification and delegated submission
and merge after all gates. Draft PR #451 is open against main; readiness and
queue admission wait for the current queue window to close. Main integration
uses a signed merge, never a rebase.
Hosted recovery, release, settings, credentials and production are excluded.
The managed retained-history sidecar is owned by the separate managed journey:
if it lands before delivery, integrate and reapply its privacy obligations;
otherwise retain that explicit proof boundary here. Local proof is no hosted
provider qualification, universal exactly-once guarantee or SLO.

## Acceptance and proof

Use the existing one-shot handover executable and independent durable synthetic
provider ledger. Snapshot approximately 60 seconds before failure, with admitted
dispatches paused and media writers retired; preserve private bytes and reload
them for restore rather than recapture after failure. Keep target effects and
serving fenced until DB/object publication, privacy, authorization and effect
reconciliation agree. Attempt the cached old executor across the fence and after
ownership transfer; attempt the new executor before reconciliation and retain
the unknown operation's explicit refusal after ordinary-job completion/replay.

Report actual timestamps, snapshotAgeSeconds, effectiveRpoSeconds (failure minus
latest recoverable consistent boundary) and rtoSeconds (declared readiness minus
induced unavailability). Readiness includes restore, object publication,
reconciliation, authorization, serving and ordinary-job readback. Report row,
object and obligation counts, recovered/lost counts, fixture bytes and human/
access waits separately. Refusal has no numeric RTO. Numerical observations
describe this bounded run only; code rollback is not data recovery.

Run publication policy/inventory/neutrality, structural/security and focused
discriminators first. Run strict typecheck and load-gated lint before the first
stabilized recovery read packet. Catalogue new files and regenerate navigation
before that read. Required native review and canonical verification follow its
acceptance; do not DCO while a required read is pending.

## Execution and self-retro

Baseline: 6,625 tracked files / 50,048,693 bytes. No package source, export, SQL,
role model, migration pin or gate budget change is planned. The smallest adequate
solution is a mode of the existing executable plus finite snapshot/privacy
fixture composition, using current capture/restore and erasure operations.
Primary risks: accidentally restoring the post-failure census, resurrecting
erased data, or counting a safe refusal as readiness. Native cycles: zero.

The first live `--older-snapshot` run passed on Node 24.21.0 and the existing
local immutable Node image. Evidence:
`.context/scratch/oss-m14-older-snapshot-recovery/journey-aFv2Rt/report.json`
and its `recovery-measurement.json`. Snapshot age and effective RPO were
60.069889167 seconds; scoped RTO was 87.08743075 seconds. The conservative
unavailability boundary starts at planned application retirement, before the
backup, so RTO includes that quiescence and the real 60-second age wait. The
separately timestamped induced failure follows provider acceptance without a
local ACK. Readiness permits the single visible uncertain dispatch refusal and
includes DB/object publication, privacy replay, reconciliation, authorization,
serving and ordinary-duty readback/replay. Human and access waits were both zero;
pre-run resource waiting is outside these measurements. No SLO is claimed.

Recovered: 173 snapshot rows across 73 tables, 3 objects, 1 partial file and 12
obligation rows (4 dispatch, 1 settlement, 1 invoice, 4 outbox, 2 pending media).
The later erasure receipt was recovered separately; the prior erasure remained.
Lost retained rows, objects, partial files and obligations: zero, measured by
raw snapshot readback and source/restored comparisons after privacy replay.
Financial/history comparisons preserve raw PostgreSQL JSON precision. Snapshot
graph bytes: 160,468; object/partial bytes: 228. Three diagnostic marker files
are outside the canonical media namespace and explicitly excluded. The actual
serving matrix passed 24 probes (5 allowed, 19 denied). Two external acceptances
were recovered from the restarted independent ledger; the late authenticated
delivery observation extended its cycle once, and ordinary dispatch accepted
once and replayed without another effect. New execution refused before recovery;
the exact terminally retired old executor could not restart after transfer.
Each refusal has null RTO. Cleanup failures: zero.

At the first proof, main lacked the stacked predecessor and the managed retained-
history continuation. This proof selects the native graph; managed-sidecar recovery
remains covered by that continuation's own restore/redaction proof unless it
lands before this parcel's delivery, when integration and replay are required.
No ready PR, queue action, hosted target or release has been attempted.

Self-retro: the first live recovery attempt passed. Before it, strict checking
first found missing workspace artifacts, then an inferred empty fixture array;
the existing lint prebuild and an explicit finite-array type resolved those
separate preparation errors. Resource-gate logs recorded at least 2,281 seconds
of waiting before the live proof. Reusing the existing restore and privacy
transactions avoided a new backup engine, grant or production activation API.
Working-tree checks and the exact-tree read precede DCO/review; canonical
verification follows committed native review.

The first run measured 61.232 seconds from first dispatch launch through the
last egress exclusion/release boundary. Its ×1.02 rounded-up allowance is 63
seconds, proposed only for the older-snapshot release hold; the other modes
retain 30 seconds. No package or canonical gate budget changes.

The stabilized 63-second witness also passed, with evidence in
`.context/scratch/oss-m14-older-snapshot-recovery/journey-TLg71a/report.json`
and `recovery-measurement.json`: snapshot age/effective RPO 60.081404667 seconds,
scoped RTO 87.345286667 seconds, 172 snapshot rows, 3 objects, 1 partial file,
12 obligation rows, graph 159,382 bytes and object/partial data 228 bytes.
Its source/restored comparisons measured zero lost rows, objects, partial files
or obligations. Both accepted effects, the late observation, both privacy
checks, 24 serving probes, old/new refusals and ordinary-duty execution/replay
passed again. One uncertain dispatch stayed fenced; cleanup failures were zero.
Its measured release upper bound was 61.440 seconds; ×1.02 still rounds to 63.

The 60.081-second effective RPO is the chosen snapshot age. The 87.345-second
scoped RTO conservatively includes quiescence and the wait. These are
declared-scope fixture measurements, not an SLO or hosted claim. The maintainer
read accepted the exact WIP tree and the older-snapshot-only 63-second release
hold before DCO; this wording-only correction narrows the reported claim.

Final working checks passed: all five strict TypeScript projects (zero unresolved
edges and consumer errors), lint (zero errors, 33 existing warnings), structural
scan, whitespace, documentation policy (two obligations, none unanswered),
the 6,627-path inventory, neutrality (zero increases) and redacted history/diff
secret scans. Both new paths have catalogue rows and navigation was regenerated.
At the time of those working checks, no DCO, counted native review, canonical
verification, PR or queue action had occurred. The final pre-read candidate
is preserved in a private WIP ref.
The maintainer accepted its exact identity and 63-second allowance on
2026-10-29; subsequent deltas are claim-narrowing prose recorded here.

Native review cycle 0: two independent full reviews found the same material
prose error in the architecture owner: it named induced unavailability as the
RPO endpoint, while the executable uses the later induced failure. Cycle 1
corrects that endpoint and clarifies that conservative RTO starts at planned
retirement. One optional incomplete-run diagnostic label remains outside this
successful fixture's acceptance. No code, fixture or control changed in the
repair; two fresh full reviews passed the repaired tree with both material
documentation findings closed. Canonical `verify-local --pgtap` then passed
14/14 phases on that clean tree, including 2,178 root test files / 22,524 tests
and 226 pgTAP files / 5,199 assertions. Draft PR #451 used the stacked head.

After the predecessor landed, native receipt preflight refused source-review
carry-over, so main integration was required. The automatic merge had no
conflicts or manual resolution. Its parents are parcel head
`ff0208f2043cd569af2b372c160c050835d29d9f` and main
`9195f281a741ca83c7974dd956a33a41d32cf8a4`; its pre-note automatic tree
was `8df5e960af40002014185f2a7981dbafa6f04c98`. The stable parcel patch-id,
excluding only this task record, was
`499a6af9ac66dd7abac566116080568b5614159a` against both the former stack
base and the new main parent. This task-record note is the only extra merge
edit. Integration review and canonical verification must use the unpinned main
fork point. The managed retained-history continuation remains absent from main;
its own restore/redaction proof retains that boundary until it lands.
