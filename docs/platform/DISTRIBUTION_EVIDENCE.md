# Distribution evidence

Status: historical record, 2026-11-09.

Status: development-preview source tooling. No complete release outcome or
supported installation is claimed.

## Exact published-set qualification

Added 2026-11-14. The post-publication
[`exact-set-qualification`](../../.github/workflows/registry-tutorial.yml) job
is blocking for its qualification result. It follows the blocking
registry tutorial job and consumes that job's bounded visibility result; an
invisible set fails qualification rather than being deferred. A tutorial failure
fails its own workflow run; PR `install-proof` remains unchanged. A maintainer can also
use `workflow_dispatch` on the default branch with an existing
`openlup-core-vMAJOR.MINOR.PATCH` tag; historical qualification does not require
that version to remain npm's `latest`.

The trusted default-branch [entry point](../../scripts/packages/exact-set-qualification.mjs)
archives the validated tag as data and calls the trusted starter extractor.
Extraction is `released` when the tagged source includes versioned extraction,
or `reconstructed` with a recorded reason for older tags. Its recorded source
revision is the tag commit. The npm lock is generated for that exact set and
committed by extraction, then installed with `npm ci --ignore-scripts` in an
independent application without ancestor/workspace dependency resolution. The
entry point owns the shared `proveNeutralStarterConsumer` proof, re-exported by
[the candidate consumer](../../scripts/packages/platform-cold-consumer.ts).
Its explicit released-input mode installs the committed lock and shares the
candidate's isolation, confinement and application assertions; candidate callers
and their offline tarball installation remain unchanged. Candidate extraction
starts in the existing temporary parent before creating the application directory.

Before executing application checks, `npm audit signatures --json --include-attestations`
verifies registry signatures and provenance. Every OpenLup package must have a
verified provenance subject matching its locked SHA-512, this repository's
release workflow certificate identity, its package release tag and the same
source commit. Registry metadata alone is insufficient; missing or mismatched
provenance refuses the named package. This uses retained npm provenance rather
than the publisher's seven-day pack artifacts, allowing later requalification
without changing publication. PostgreSQL uses the digest-pinned GHCR mirror
with job-scoped GitHub token authentication and no upstream fallback. The
installed application checks the PostgreSQL major, typechecks, builds, runs its
application tests and runs the existing development-loop HTTP proof.

The local 2026-11-14 run against published 0.41.0, source commit
`699157a61f5be9befc268225bb5e8b1539a8ec0a`, passed in 25.816 seconds with
Node 24.21.0/npm 11.19.0 and the same pinned PostgreSQL 17 content available
locally under its upstream digest. It recorded reconstructed extraction,
verified all three package provenances, and passed typecheck, build, 296
application tests and two development-loop tests. This is local evidence,
not a hosted qualification receipt. The qualification step's two-minute bound
is 4× that measurement rounded up; the first hosted run must remeasure it. The
shared-proof follow-up on the same date passed against that set in 27.814
seconds, with all three provenances, 296 application tests and two development-loop
tests passing. The existing two-minute bound still covers 4× the follow-up.

One JSON workflow artifact, retained for 90 days, records the set/tag/commit,
extraction mode and content hash, committed lock SHA-256, each package SHA-512
and provenance verification source, commands/results, runner image and times.
A failed entry-point run retains its partial receipt and error. This supplies
bounded exact-set qualification; it does not certify a full store, provider
behavior, browser journeys, database upgrade/recovery, public hosting, stable support or
a production deployment. Later proofs need their own executed evidence.

## Interrupted adjacent-set starter upgrade

The same qualification job adds one step using the existing
[distribution CLI proof](../../scripts/packages/distribution-cli-proof.ts) in
pair mode. Its no-pair mode retains the fixed published 0.35.0→0.36.0 witness
and existing PR execution. Pair mode chooses the greatest stable core release
tag below the target whose version appears in every publishable package's npm
history. Missing complete predecessors refuse qualification. Both tag-bound
starters reuse the exact-set extractor, lock checker, isolated install and npm
signature/provenance checks above; older sources are labelled `reconstructed`.
The shared released-input consumer proof checks both extracted applications,
including the target application that supplies the installed upgrade CLI.

Managed snapshots are derived from each extracted `ownership.json`, excluding
generated and owned paths. The proof customizes owned theme and fragment files,
uses the target's installed public CLI for plan/apply, and checks the exact
`current bytes match neither predecessor nor candidate` managed conflict before
any writes. After reconciliation it SIGKILLs apply immediately after the first
rename. The harness asserts `incomplete_application_upgrade` against target
managed bytes and declared/installed package versions, then resumes and proves
replay applies nothing. That refusal is a harness observation, not a CLI-added
application serving guard. The CLI changes files only; the harness installs
the target's separately regenerated, extractor-verified lock through that same
shared consumer proof. It runs `npm ci`, typecheck, build, application tests and
development-loop checks on the upgraded application, including package
confinement, installed provenance and unchanged target-lock assertions.
Owned customization bytes must remain identical.

For 0.40.0→0.41.0 the only changing managed file is the extracted
`package.json` with exact package pins. The kill therefore interrupts the CLI
after that replacement, and resume recognizes it as already applied; dependency
installation is still outstanding. The proof does not manufacture extra source
changes to make this pair appear broader. The receipt retains both versions,
extraction identities, package provenance, plan SHA-256, phase results and
commands.

The local 2026-11-14 0.40.0→0.41.0 run passed in 49.62 seconds on Node
24.21.0/npm 11.19.0. Both extractions were reconstructed; old and upgraded apps
each passed typecheck, build, 296 application tests and two development-loop
tests. The shared-proof follow-up on the same date passed in 65.08 seconds;
both baseline extractions and the upgraded application each passed all shared
checks, including 296 application tests and two development-loop tests. This is
local evidence, not a hosted upgrade receipt. The step's five-minute bound is
4× the follow-up measurement, rounded up; the first hosted run must remeasure
it. An earlier attempt exposed the development-loop
witness's fixed demo brand assumption; customization now changes theme colors
and a fragment class while retaining that witness unchanged.

This is file/dependency qualification on the neutral starter, with
no SQL, database compatibility, browser/provider, rollback or support claim.

## Public outcome projection

The [generated projection](OUTCOME_PROJECTION.md) derives its package entries,
class counts, API snapshots and executable proof links from `config/openlup-packages.json`,
the package manifests and each code export's existing `packageSmokeEvidence`
(the manifest export carries none). It
introduces no independently maintained capability list or private register.
Rows group every code export by its existing top-level class and link common proof
parents, keeping per-provider details in their source owners. Counts and the
fingerprint retain every code export; grouping never turns partial evidence complete.

From the source checkout, with its recorded Node version:

```sh
node --experimental-strip-types scripts/generate-outcome-projection-cli.ts --write
node --experimental-strip-types scripts/generate-outcome-projection-cli.ts --check
node --experimental-strip-types scripts/generate-outcome-projection-cli.ts --assert-complete
```

`--write` changes the one generated Markdown file. `--check` verifies its exact
bytes and public-input fingerprint. Neither runs the linked tests. A present
declaration remains `partial`; an absent witness or API snapshot is `missing`.
`--assert-complete` refuses both. This generator consumes no execution receipts,
so it cannot emit complete or promote source presence into release qualification.

The file is regenerated and `--check`ed on each release set. Between releases,
its hash and counts can lag the source tree. The test compares the committed
file's declared package-set version with the real package-set version, so a
set-version change requires regeneration in that release-set preparation tree.

The existing package instruments do not enumerate all composed-store,
deployment, recovery and adopter outcomes. The projection therefore remains
partial and blocks that full claim. Completing the broader outcome instrument
requires its public owners and executable evidence; a private denominator is
not an input to this file. The [task record](plans/oss-m19-g16.md) retains that
requirements for a later complete claim.

## Package-set BOM

The BOM generator consumes the existing exact-commit `packages-manifest.json`
and its retained tarballs. The package producer owns building, packing and its
verification; generating a BOM never invokes it or installs anything.

After an authorized pack has produced the complete set:

```sh
node --experimental-strip-types scripts/packages/generate-release-bom-cli.ts /path/to/packs/packages-manifest.json <full-source-commit> > /path/to/evidence/package-set-bom.json
```

The output is a deterministic first-party npm package-set BOM: exact public
source commit, set version, package coordinates/licenses, committed manifest
hashes, and verified tarball SHA-256/SHA-512 integrity. The existing manifest
verifier refuses an omitted, extra, duplicated, version-mismatched, symlinked,
unconfined or altered artifact. Package identities and inventory come from the
named Git commit, so later working-tree edits cannot silently redefine that
release set. Write the BOM outside the pack directory: the existing verifier
requires that directory contain only its manifest and declared tarballs.

The real BOM will be generated from the release tarballs of a published set.

The [BOM witness](../../scripts/packages/generate-release-bom.test.ts) also checks
real npm archive payloads and member paths, public documentation and any tracked
starter files for the retained root-reference SKU. Synthetic refusal cases cover
each carrier. An absent starter remains unqualified; the check does not infer
starter evidence from its fixtures.

This is not the dependency SBOM, an image or composed-application inventory, an
npm publication receipt, a provenance attestation or a claim that any runtime
proof passed. The producer's commit attribution remains process evidence; the
BOM does not independently attest how those bytes were built. Existing per-package
SBOM, provenance and [release gates](DEVELOPMENT_AND_RELEASE.md#releasing-a-package)
retain their duties. No workflow, release asset upload or publication is changed.

## Current neutrality and runtime limits

The accepted `brand` baseline contains 27 counts in eight paths. The
[review disposition](plans/oss-m19-g16.md#neutrality-review) accounts for every
count and the separately identified local reference SKU mapping. Scanner rules
and negative fixtures are retained because they detect forbidden identity;
unrelated source-test data and immutable publication history remain scoped debt.
No baseline allowance or scanner is changed.

Root `ui-*` counts remain shrink-only reference-source debt. They are not a
neutrality certificate for copied root pages, npm artifacts, a starter or an
adopter application. New neutral application presentation is constrained to
system fonts only; the root reference's existing font choices are not transferred.
Node/OCI rollback and portable-Postgres Vercel recipes await the starter's own
documented entry and exercised evidence; they are not delivered by these tools.

The 0.42.0 source candidate supplies explicit card provider composition on portable
PostgreSQL, exercised with an offline client and installed runtime roles.
The starter still selects sandbox payments. A portable composition for the
second reference provider and live-provider qualification remain separate.
The native rail supports the two reference payment providers through declarative provider profiles. A third provider needs a profile declaration plus its adapter. Read the [install policy](../../.github/INSTALL_SUPPORT_POLICY.md)
before relying on any preview profile.
