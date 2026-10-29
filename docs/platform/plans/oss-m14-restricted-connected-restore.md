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
authority permits local changes, signed commits and submission after required
reads, review, checks and live admission; merge is currently held. No secrets,
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
delta; policy and tracked inventory now pass. A fresh exact-tree maintainer read
for that control delta precedes its DCO commit and native review. Canonical
verification and submission follow review.

Self-retro: the disrupted preliminary work and append-only cleanup mistake
cost two local setup runs. A durable early snapshot and a reversible settings
row made the final discriminator repeatable; no further process change is
justified within this parcel.
