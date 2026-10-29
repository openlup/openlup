# M14 restricted connected restore

Status: development-preview parcel 8C, local work in progress. The code review
base is `15a708a6b5b34f8a6d27b25f4867787425084bf7`; the freshly fetched
policy revision is `6e7adb51e742a132b879a94ef07e5cfed60f694c`. The only
relevant instruction delta in `CONTRIBUTING.md` was read; it adds offline
context-command policy and does not alter this parcel's authority.

## Outcome and boundary

Admit connected capture and restore for the `qualified-admin` installation in
both role modes, preserving exact catalogue, ledger, target-key, row, ownership
and refusal checks without privileged cluster reads. Admit a declared trusted
provider control-plane bootstrap principal with bounded outside elevated roles,
while refusing elevated roles or unexpected memberships in the application role
graph. The migrator remains a trusted administrator with ADMIN membership; this
task makes no isolation claim against it.

The active supervisor is the sole writer in the assigned worktree. Existing M14
authority permits local changes, signed commits, submission and queue/merge
after required reads, review, checks and live admission; the merge freeze was
lifted on 2026-10-29. No secrets,
hosted resources, deployment, release, settings or production action is granted. This parcel owns
restricted connected restore, qualified-admin admission and the capture cluster
identity check. Parcel 8A owns fixed table lists and insertion order in restore
and capture; object adapters, recipe runner, catch-up and recovery are separate.

## Acceptance and proof

Use the smallest local discriminators on fresh PostgreSQL 16 installations to
model the two documented hosted role shapes in both bootstrap modes. Then run
the complete restricted connected restore witness, including replay, conflict
and restricted operations. Prove source/target identity with observations
available to a restricted login; retain independent target-key preservation and
exact schema/ledger checks. Refuse unexpected role edges and selected catalogue
changes without relaxing RLS or application ownership. Run focused policy,
structural, security and documentation checks before the load-gated broad gate.

Any new issued SQL identity follows reader, exact-byte approval and active
selection in separate checkpoints, with disposable PostgreSQL 16 parse-and-apply
proof in both role modes before approval. No issued SQL change is planned.
Stabilized API and security-control changes need an exact-tree maintainer read
before DCO. Two fresh full native reviews and final verification follow it.

Local fixtures cannot prove the actual hosted control-plane membership graph,
provider SQL privilege behavior, managed role inventory, grantor semantics,
connection routing or service policy. Neon and RDS confirmation remains in the
later hosted receipts; local PostgreSQL evidence does not close that boundary.
The incarnation observation is weaker than a cluster system identifier: two
clusters behind one address and port with the same postmaster start time and
database OID are indistinguishable. Unix-socket sessions return NULL address
and port, weakening the observation further. A postmaster restart refuses
restore until a new pristine capture is made. In Neon, a compute suspend or
restart between capture and restore has this effect; the hosted Neon receipt
plans for it. These are known limits, not acceptance conditions for this parcel.

## Execution and self-retro

Smallest adequate alternative: adapt the existing finite qualification and
connected restore branches, without new SQL identities, provider registry or a
generic privilege policy. The main security risk is admitting a provider role
edge that reaches an application principal, or treating a stale observation as
a fresh target. Both require negative discriminators.

An interrupted preliminary local run supplied no durable qualification result;
all witnesses were rerun for the current tree. No native review or DCO commit
existed before the read. The maintainer delegate accepted the exact tree
`efeba337599436747ad01904f636e4979b2de758` for API and security control
before DCO; the local read record is
`.context/scratch/oss-m14-restricted-connected-restore/maintainer-read-20261029.md`.
The accepted tree was committed as `99dab83b66132fc07ed53cecfa834a77cd7a57f9`
with the documented test-guidance impact trailer. `npm ci` passed on the pinned
toolchain.

The first rebuilt full case exposed a test-fixture mistake: its cleanup tried to
delete an append-only client record after a correctly refused target conflict.
The discriminator now uses a reversible commerce setting. The rebuilt
Neon-shaped installer-managed case passed its target-conflict refusal, restore,
replay, role sealing and restricted-login checks (1 passed, 7 skipped;
14.72 seconds). The complete fresh four-shape matrix passed (8/8, 86.02
seconds), including both role modes, elevated-provider membership refusal,
undeclared outside elevation refusal, application-graph edge refusal, target
conflict rollback, restore, replay and restricted-login denials. The existing
connected transfer regression also passed (5/5, 32.23 seconds). The required
lint command passed with zero errors; its 33 warnings are outside this delta.
The structural scan, redacted source/history scans, public neutrality, tracked
inventory and whitespace checks passed. The policy checker found the two
affected canonical owner sections updated; its remaining test-guidance
obligation was addressed by a scoped no-impact trailer in the signed
commit. No package files, issued SQL identity or approval pin changed; the
inspected publication caps require no raise. Once the two new files became
tracked, the public output inventory required two `public-output` rows in
`config/openlup-publication-catalog.json`. This is the only publication-control
delta; policy and tracked inventory now pass. The maintainer delegate accepted
that exact-tree delta before DCO, recorded in
`.context/scratch/oss-m14-restricted-connected-restore/maintainer-read-20261029-2.md`.
It was committed as `a0b23ca21bf58911ca64b0b1de6ba0839d86f9b6`.
Review preparation observed a mainline move to `6e7adb51e742a132b879a94ef07e5cfed60f694c`.
The native preflight refused carry-over because main changed the publication
catalogue and publication machinery. A mechanical merge of that mainline tree
had no conflict and preserved the two 8C catalogue rows and all 8C source
changes. The maintainer delegate accepted the two-parent integration tree in
`.context/scratch/oss-m14-restricted-connected-restore/maintainer-read-20261029-3.md`
before DCO. The signed merge `8931508adf64a089efd9fbe44e08652b6bcb0b72`
has parents `62e12aad936380a5082f0043381283673e192d12` and
`6e7adb51e742a132b879a94ef07e5cfed60f694c`, and tree
`b15a468d0718a7c2ba1276683708ee5493f7a98c`. The 8C change excluding
this task record has stable patch-id
`ef63e864825d6a76c338b7520015bb9f053a9934` both before and after the
merge. The documentation policy passes against the new main base with three
obligations and none unanswered. Native review, canonical verification and
submission follow.

The first full native review of tree
`c112bd6567d9f49e466aace10d6888bd6e372a0c` produced one PASS and one
material finding, `8C-REPLAY-LEDGER`: replay rechecked the final catalogue
after closing its owner window but omitted the final ledger comparison. An
outside ledger update between the initial read and relation lock could then
survive a successful replay. The repair adds the same final ledger comparison
used by fresh restore and a concurrent-update replay refusal discriminator.
The focused PG16 race discriminator passed (1 passed, 7 skipped; 16.54
seconds). The complete restricted matrix then passed (8/8, 64.37 seconds),
and the existing connected-transfer regression passed (5/5, 30.96 seconds).
`npm run lint` passed with zero errors and 33 unrelated warnings. The first
race-test run exposed a fixture wrapper that handled SQL strings but not the
catalogue reader's query object; correcting that wrapper made the focused
case pass. A new exact-tree maintainer read and two fresh full reviews are
required before canonical verification and submission.
The test change uses the existing PostgreSQL test location and command, so
the development-check instructions remain correct. The maintainer delegate
accepted exact tree `24095fe27c5f2850334d6f62e31c1705d75a7f9f` before
DCO, recorded in
`.context/scratch/oss-m14-restricted-connected-restore/maintainer-read-20261029-4.md`.
Commit `c67e5c89183e06cb63625ddddab393d75f167e84` contains that exact tree
and the scoped `tests` no-impact trailer; policy has three obligations and
none unanswered.

Self-retro: the disrupted preliminary work and append-only cleanup mistake
cost two local setup runs. The replay finding exposed a missing final check;
one shared comparison on both success paths is the smallest repair. The race
fixture's query-object omission cost two failed focused runs, then the full
case passed. No further process change is justified within this parcel.
