# M14 connection and pooling recipe

Status: cycle 1 full reviews passed, but canonical verification found an
optional-peer connection-error regression. A scoped repair needs renewed
pre-DCO read and cycle 2 review. M14 remains open.

## Outcome and boundary

Make the existing connection and advisory-lock seams explicit and prove the
current qualified PostgreSQL 16 profile: pooled request work, direct migration
and administration, and session-affine scheduler/job locks. Detectable loss of
session affinity must refuse protected work with an actionable error.
Use existing adapters; no pool dependency, coordinator or new abstraction.
Restricted-bootstrap qualification will reuse this recipe once it lands.
Hosted Neon/RDS qualification, bootstrap, transfer, release and production
activation are excluded.

## Authority and execution

The active supervisor is the single writer. The M14 coordinator coordinates
delivery; the owner grant covers local work, commits, push, pull requests and
merge after required gates. DCO identity: Bart Roszkowski <dev@openlup.com>.
Secrets, signed-in browser, settings, deployment, release dispatch and npm
publication are not granted. API/security-control changes require a stabilized
maintainer read before DCO. Independent native review and final verification
remain required after that read. No adopter endpoint is in scope.

Policy revision and initial source base:
`5433b61c19809f749b3c0ffb08b254eafc406f96` (2026-10-29).
Current policy pin: `bafe6fe6833c935ef953a7d8cd0dfc868bc85fac`.
The maintainer read accepted staged tree
`e76a3d0325e8f23a7726a8091ddcf3bc392faf30` before DCO.
The renewed read accepted staged repair tree
`e0415638300279165d12ba37f1714ff231e3fd70` before its DCO commit.
The signed integration of that source with current main is `d4d47475f1211aa103e592fa51763dc7cf3407d2`.
It preserved the accepted lock source, witness and API snapshots; main's
independent owner-path approval remains outside the selected 91-unit plan.
After cycle 1, main advanced to `bafe6fe6833c935ef953a7d8cd0dfc868bc85fac`.
Signed clean merge `45b69db66f9527c5de738da843e73d2ea5f386ab` integrated its
migration-ledger preflight and auto-merged the overlapping data/package docs;
the lock source and witness remained unchanged by that integration.

## Acceptance and proof plan

- Document the three connection roles in their runtime/data owner sections.
- Preserve lock contention and release semantics using the existing lock port.
- Prove real PG16 lock ownership across statements and refusal before a job
  runs when backend switching or missing lock ownership is observed.
- Use a local existing transaction-pooler image/compose if available; otherwise
  use a faithful real-PG backend-switching witness and state its limits.
- Run cheap policy/artifact/structural/secret checks first, then affected proof,
  required lint, native committed review and full verification/coverage within
  the existing three-cycle budget.

The main risk is claiming transport qualification from client construction or
a finite observation alone. The recipe must require a session-affine transport;
runtime refusal detects observable violations and does not certify a proxy's
configuration indefinitely. Preserve drain-before-close behavior.

## Evidence and remaining work

Task worktree and branch created from current main; implementation and proof
use the existing lock/composition seams with unchanged exported signatures.
The supported recipe and operator recovery are in the runtime/data owner sections.
No local PgBouncer image or compose was available; the qualified witness uses
two real runtime-login PG16 backends, with deterministic switching and reset.

Affected proof: five files, 89 tests passed in 47.54 seconds on Node 24.21.0,
npm 11.19.0, one Vitest worker and pinned PG16 Docker. This includes all four
existing 91-unit qualified compositions, the new target/separate-restore
connection witness, lock unit tests, scheduler tests and host/drain regressions.
Normal lock contention/release is distinguished from switched PID, reset lock,
uncertain acquisition and false unlock; an invalid grant never enters the body.
The refused-release witness proves another backend's grant remains held.
Policy/navigation, publication inventory, neutrality, structural scan, redacted
working-patch secret scan, declaration API check, five-project typecheck and lint passed. Lint reports
zero errors and 33 warnings in untouched files. API snapshots change only
documentation; exported signatures, package manifests and SQL remain unchanged.
The first typecheck caught two generic query-adapter typing errors in the new
witness; existing structural boundary casts fixed them, with zero final errors.
A manual rerun initially lacked the local binary PATH and failed before tests;
the corrected launch produced the final passing result above.

Simplicity pre-check: explicit existing connection injection plus one ownership
observation per successful acquisition is sufficient. Documentation alone cannot
refuse observed backend switching; a new pool API or coordinator is unnecessary.
Native cycle 0: one independent FULL PASS and one FULL FAIL on tree
`ff6a1de9e65102cf0df63fd84e4e5a83b0b74e3f`; finding
`M14-UNCERTAIN-ACQUIRE-ERROR` identified the raw first error on an uncertain
grant, which lacked the required drain/retire guidance. The repair emits the
same actionable affinity refusal on that first failed attempt and proves the
guarded body remains uncalled. The existing sticky refusal and drain stay intact.
Cycle 1 received two new FULL PASS reports and closed the open finding on tree
`2e1872d1a20c98e0cfc8e20e1f4cec1c5eee437f`. Canonical verification passed
policy, inventory, DCO, Gitleaks, install, lint, typecheck, both builds and cold
package/API gates, then failed its broad test phase: seven optional-peer cases
for the scheduler's lazy connection now saw an affinity error before any lock
statement. The scoped repair connects before entering the uncertain-grant path,
preserving the existing peer/transport error; a failed lock statement still
refuses with actionable affinity guidance. The owner docs already limit the
affinity refusal to lock ownership and uncertain acquisition; no public recipe
change follows from preserving pre-connection errors. A new maintainer read of
the security/error boundary, then cycle 2 full review and complete verification,
are required. DCO source, merge and first repair commits are signed; this second
repair is not signed. Full verification/coverage and authorized delivery remain. No
submission or release has occurred.

The first post-merge manual integration run used package output built before
main's migration-runner change, so its new migration witness failed against
stale code. `npm test -- tests/postgres/m14MigrationSessionAdmission.test.ts`
rebuilt the packages and passed 27/27; the seven-file integrated affected run
then passed 145/145 in 57.68 seconds, including the pooling, optional-peer and
mainline migration-session witnesses. The new tree retains the required current
qualified-profile proof without changing the selected outcome.

Self-retro: exclusive heavy-window waits were 541 seconds for affected proof and
661 seconds for lint.
Reusing the existing qualified composition avoided another installation harness;
the late test-generic errors show why test-project typechecking belongs in early
focused feedback alongside production builds. No acceptance or retry-budget
change was needed. Native review caught the missing first-error guidance before
submission; the guarded-callback assertion now proves that refusal reaches the
first affected job before its body runs. The broad gate exposed the untested
pre-connection path; the focused proof now pairs optional-peer errors with
uncertain-statement refusal before another broad run. Rebuilding after the main
merge was necessary to avoid diagnosing old package output as new source behavior.
