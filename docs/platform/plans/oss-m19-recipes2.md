# Local data-bearing image rollback

Status: built ahead with local data-bearing execution and focused checks passed.
Committed review, canonical verification and delivery are deferred.

## Outcome and authority

Extend the existing proof with a local data-bearing A → B → A application-image
swap over the starter’s unchanged demonstration schema and package set. Update
public limits only with the executed result, one hosted-database limit sentence
and a pointer to the starter limits. Part 1 remains the historical image-only
witness. The public-reference descriptor is unrelated and unchanged.

The distribution supervisor coordinates this worker. Bart Roszkowski is the
accountable human. Local edits, isolated local Docker proof and a signed DCO
commit are authorized in this assigned worktree only. Stop built ahead: no
prepare, reviewers, canonical verify, push/upstream, PR, comment, queue, merge,
release or publication. Mechanically merge the starter predecessor only after
the supervisor supplies its frozen head; never rebase or land before it.

Base and policy revision: `4d78e855cf8bbd57704f9503cd7bae28f96453a5`;
base tree: `69ed6ac17997e1f824ab657abc4b862f79326b0a`.
Scope: existing deployment proof/tests/README, this task record, one additive
public-output catalogue row, root README and installation-policy limits.
Exclusions: starter or package edits, migration/workflow/control/budget/baseline
changes; public hosting, hosted database connection, any
requirements/blockers document or vendor-documentation claim; credentials,
accounts, hosted resources, cost, real payments or another worker’s files.

## Verified inputs and acceptance

The runtime URL requires the starter_runtime login, neutral_store database and
no password, query or fragment. Native composition additionally checks actual
runtime identity and restricted role attributes. Lifecycle builds, starts its
Compose database, invokes one-shot `lifecycle.mjs install` with the packaged
history and seed, then starts its own application with that runtime URL.
The source application publication is fixed to loopback 4319. With publicOrigin,
the lifecycle healthcheck sends the configured Host. Partner inquiry submission
is a mounted durable public HTTP write with native command replay.

Connection and installation are local-demonstration only; see the
[starter’s limits](../../../examples/neutral-store/docs/limits.md).

Use the same four lifecycle operations with a scratch Compose override retained
throughout; `lifecycle up` itself replaces ambient Compose file selection on its
last operation. Reusing its existing one-shot installer and application avoids
any second installer, host or binder. No starter source or source Compose edit.

Require A/B/A health with configured Host, one ordinary-loopback Host refusal,
exact original image restoration, original references on both HTTP replays,
and unchanged ledger count/content hash and seeded catalogue counts. SQL counts
are read-only through the disposable database’s local socket. Only an owned
English copy string changes between A and B; schema and packages stay unchanged.
Unique labels/project, loopback-only publication, local Docker refusal and mutual
exclusion protect neighboring work. Clean all proof resources even on failure.

Pure tests refuse malformed identities and every image/ledger/catalogue/count/
reference mismatch. Run unchanged affected publication/documentation/policy tests
under focused admission, strict-zero scan with planted refusals, policy/navigation,
structural checks, lint and both neutrality checks. Public claims follow execution.
The proof establishes no package/schema-upgrade rollback. Database changes retain
the existing expand/compatible-deploy/backfill/later-contract lifecycle and must
remain compatible with code rollback; destructive down migrations are no plan.
The app-file CLI neither installs packages nor migrates a database, and its
schema-range declaration or diagnosis does not prove SQL compatibility.

## Evidence

First data-proof attempt reached healthy A, installed 97 ledger rows, seeded
three products/SKUs/prices and one price list, and wrote one partner inquiry.
The next transport request failed with `socket hang up` after application
replacement. Cleanup passed. The helper used Node’s default pooled agent across
container replacement; requests now use fresh connections (`agent: false`).
This failed attempt is retained as evidence, not a passing rollback result.
Package source inputs equal the
base: `git diff --exit-code 4d78e855cf8bbd57704f9503cd7bae28f96453a5 -- packages`
returned zero, so this change contributes zero package bytes by input equality.
`npm run packages:check -- --out .context/scratch/recipes2/packs` built and packed
all three 0.36.0 candidates without findings on pinned Node 24.21.0/npm 11.19.0.
These are local candidates, not published pins. Their hashes appear in the
successful proof’s frozen package inputs below.

The application was independently extracted with
`node examples/neutral-store/extract.mjs .context/scratch/recipes2/prepared-app`.
Candidate preparation used the starter lifecycle and generated its lockfile:

```sh
node .context/scratch/recipes2/prepared-app/lifecycle.mjs candidate "$PWD/.context/scratch/recipes2/packs/openlup-core-0.36.0.tgz" "$PWD/.context/scratch/recipes2/packs/openlup-outbox-0.36.0.tgz" "$PWD/.context/scratch/recipes2/packs/openlup-platform-0.36.0.tgz"
```

It exited zero (`up to date in 4s`). The following run used Docker 29.8.2 and
Compose 5.5.0 on the local Unix-socket context, with no database publication.
The selected publicOrigin was identical for A and B; every positive application
probe sent its Host. The sole deliberate wrong-Host probe observed the starter’s
existing refusal. B changed only `owned/copy.ts`; package/lockfile hashes and
all other scanned inputs were unchanged. Each successful replay required the
original reference and explicit native replay evidence. Read-only local-socket
SQL found both records. Ledger hashes cover all applied row fields, including
execution timestamps, ordered by position. The final result was emitted only
after cleanup verified no resources with this run’s label remain and removed
its scratch copy. No package or schema upgrade, hosted connection, TLS,
production, complete-store or real-money claim follows.

Successful command (exit zero):

```sh
node --experimental-strip-types deploy/neutral-store/prove.mjs data-rollback .context/scratch/recipes2/prepared-app .context/scratch/recipes2/proof
```

Complete stdout:

```jsonl
{"phase":"A","image":"sha256:db45cce2c47564de373b52465faf79caf898bd18183609233093491e45c04472","healthy":true,"data":{"ledgerCount":97,"ledgerHash":"135d64c89099c4018131b72b501a068e14b1f0d4a10e80821ce7724de49648c2","catalogue":{"products":3,"skus":3,"priceLists":1,"prices":3},"records":1}}
{"phase":"B","image":"sha256:3b9540694e94454c62020114725a183f1e8585e26fd86c890e5f054d73f60c7b","healthy":true,"data":{"ledgerCount":97,"ledgerHash":"135d64c89099c4018131b72b501a068e14b1f0d4a10e80821ce7724de49648c2","catalogue":{"products":3,"skus":3,"priceLists":1,"prices":3},"records":2}}
{"phase":"A-restored","image":"sha256:db45cce2c47564de373b52465faf79caf898bd18183609233093491e45c04472","healthy":true,"data":{"ledgerCount":97,"ledgerHash":"135d64c89099c4018131b72b501a068e14b1f0d4a10e80821ce7724de49648c2","catalogue":{"products":3,"skus":3,"priceLists":1,"prices":3},"records":2}}
{"a":"sha256:db45cce2c47564de373b52465faf79caf898bd18183609233093491e45c04472","b":"sha256:3b9540694e94454c62020114725a183f1e8585e26fd86c890e5f054d73f60c7b","restored":"sha256:db45cce2c47564de373b52465faf79caf898bd18183609233093491e45c04472","equalToOriginal":true,"observations":[{"phase":"A","image":"sha256:db45cce2c47564de373b52465faf79caf898bd18183609233093491e45c04472","healthy":true,"data":{"ledgerCount":97,"ledgerHash":"135d64c89099c4018131b72b501a068e14b1f0d4a10e80821ce7724de49648c2","catalogue":{"products":3,"skus":3,"priceLists":1,"prices":3},"records":1}},{"phase":"B","image":"sha256:3b9540694e94454c62020114725a183f1e8585e26fd86c890e5f054d73f60c7b","healthy":true,"data":{"ledgerCount":97,"ledgerHash":"135d64c89099c4018131b72b501a068e14b1f0d4a10e80821ce7724de49648c2","catalogue":{"products":3,"skus":3,"priceLists":1,"prices":3},"records":2}},{"phase":"A-restored","image":"sha256:db45cce2c47564de373b52465faf79caf898bd18183609233093491e45c04472","healthy":true,"data":{"ledgerCount":97,"ledgerHash":"135d64c89099c4018131b72b501a068e14b1f0d4a10e80821ce7724de49648c2","catalogue":{"products":3,"skus":3,"priceLists":1,"prices":3},"records":2}}],"commands":[{"operation":"partners.submit","key":"recipe-671aee7e-3a80-4670-96b0-d5a6a41d706d","reference":"acquisition-case:9e74506d-1917-43a0-bd00-766eb530ff77"},{"operation":"partners.submit","key":"recipe-18ce8739-4568-48f9-a653-8b80b039a317","reference":"acquisition-case:83e86e93-78c5-47bf-88bc-6934a13fd168"}],"origin":"http://localhost:49293","refusal":"starter_local_host_required","frozenInputs":"6024f08e6620ca694118d929e0485a377164df33d2076be5c80eb75b39a77353","frozenPackages":{"package-lock.json":"d0c2460280b5fd1f7cbe193832f0f68313557e178590f6e128518503654cc1aa","artifacts/openlup-core.tgz":"4ab15b3d7079d0819bfb4c02b392bc9c52e65793e6eee9ea618879fe23fee17d","artifacts/openlup-outbox.tgz":"fca9d1e7a870ae5349c5f3daebea941678d39888acd216ae08555278f86313da","artifacts/openlup-platform.tgz":"4b5cd153af6c978dbe9e17a9bc10c480f4e2d80b2c45a140f01d8d32d068d16a"},"changedOwnedInput":"owned/copy.ts","limitation":"Application-image swap over unchanged schema and package inputs, for the two partner records written by this proof only."}
```


## Focused checks and delivery boundary

Pinned Node 24.21.0/npm 11.19.0 were used. Focused admission preceded root
installation, pure checks, package build/pack, candidate preparation, the
unchanged test selection, typecheck and lint. Docker attempts ran one at a time,
separately from the gate. The largest observed admission waits were 181 and
210 seconds. No canonical verify command or review session was run.

The following existing test files ran unchanged in one focused `npm test --`
selection: 10 files and 467 tests passed, with no skips:

- `scripts/oss-published-tree-check.test.ts`
- `scripts/public-ci-neutrality.test.ts`
- `scripts/documentation-bundle.test.ts`
- `scripts/documentation-cli.test.ts`
- `scripts/documentation-impact.test.ts`
- `scripts/documentation-links.test.ts`
- `scripts/ci-test-scope.test.ts`
- `scripts/source-release-preparation.test.ts`
- `scripts/packages/eslint-import-map.test.ts`
- `scripts/generate-outcome-projection.test.ts`

The existing four proof tests retain their assertions. The extended file passed
all eight tests with `node --test deploy/neutral-store/prove.test.mjs`.
`node deploy/neutral-store/prove.mjs edge .` scanned 65 files and found zero
matches; its pure planted imports/hooks were refused. No new execution file,
entrypoint registration or classifier change was added, so no new execution
surface fixture was needed.

`npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression`,
`npm run oss:published-tree -- --typecheck`, and `npm run lint` passed. Typecheck
reported zero unresolved edges and zero consumer-side errors. Lint’s rule cases
all passed. Repository neutrality with `--base-commit
4d78e855cf8bbd57704f9503cd7bae28f96453a5` reported zero increases; the UI smoke
neutrality check reported zero forbidden hits. No baseline was changed.

Policy was run with `--policy` and then `--policy --docs-update`; navigation had
no delta. Its sole obligation is answered by the commit’s scoped operations
no-impact trailer: the generic self-host boundary still correctly separates
application files, schema compatibility and host qualification. Only a local
proof invokes unchanged starter install/runtime owners; the deployment README
and this record carry its executed evidence. No platform host/runtime contract
changes. Final policy must observe that trailer on the committed tree.

The executed proof source blob is `7816b9bea525e71fc91cd4f63ff7f520ce8beff7`.
Package, starter, migration, workflow and all existing script-test inputs equal
the assigned base. The prepared input remains for inspection; proof scratch is
empty and the mutual-exclusion lock is released. Staged secret scanning found
no leaks. No paths outside the grants are changed.

Public text includes only the local data-bearing image result, unchanged-schema/
package limitation and the single approved hosted-database limit sentence with
its starter-limits pointer. Sandbox-only portable payments, managed-rail real
money, system fonts and unclaimed support/stability/readiness limits remain.
No upgrade, complete-store, hosted, credential, TLS or production qualification
was added. No hosted service or account was used.

The frozen starter predecessor has not been supplied. No merge, upstream,
push, PR, comment, queue, release or publication was attempted. Stop built ahead;
review/verification/delivery need the supervisor’s later continuation.

## Self-retro

Read-only Compose configuration inspection established that a scratch
ports replacement must accompany all four lifecycle operations; delegating the
actual installation and application to their existing owners keeps the proof small.

The failed first swap exposed an unnecessary dependency on pooled HTTP state.
Fresh per-request connections remove that dependency rather than adding retries.
Lesson: container replacement → connect afresh at the transport boundary.
