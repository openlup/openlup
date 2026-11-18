# Distribution evidence

Status: historical record, 2026-11-09.

Status: qualification evidence for the one supported stable 1.x installation
composition: the npm starter, PostgreSQL and the qualified image.

On 2026-11-18, [run 44263843134](https://github.com/openlup/openlup/actions/runs/44263843134)
qualified `openlup-core-v1.1.0` (`ec24f180`): 1.0.0→1.1.0 upgrade,
schema and canary passed. 1.1.0 is the first qualified stable set, including
the npm set and `ghcr.io/openlup/neutral-store-starter:1.1.0` at
`sha256:96f31906a5100d986ec5a0c0b8474ef2daa417e5d08d0816efc590bd9b74eadf`.
Its evidence image, `ghcr.io/openlup/neutral-store-starter:1.1.0-evidence`, is at
`sha256:5d779d5beaffe5a548cda51b571ef8eca1ef9502125090031ea1a9f5d448d75b`.
Both are attested by `registry-tutorial.yml` on `main`. The first automatic
[run 44255571945](https://github.com/openlup/openlup/actions/runs/44255571945)
qualified the npm set, but image publication was refused before any registry
write because the publisher lacked the containerd image store; the fix on
`main` was followed by the single recovery run above.

1.0.0 initially failed starter-upgrade qualification in
[run 44156615468](https://github.com/openlup/openlup/actions/runs/44156615468).
On 2026-11-18, [run 44256496392](https://github.com/openlup/openlup/actions/runs/44256496392)
passed exact-set qualification for 0.43.0→1.0.0 using the
[starter migration published with 1.1.0](../../packages/core/docs/guide/upgrade/v1-0-0.md#starter-applications-from-0430).
This qualifies the 1.0.0 npm set without an image; it remains superseded by 1.1.0.

## Released starter inputs

The source-only pairs under `examples/neutral-store/release-inputs/<tag>/`
retain the exact `manifest.json` and `package-lock.json` bytes from
`prepareReleasedStarter` in the [existing qualification producer](../../scripts/packages/exact-set-qualification.mjs).
They are public source files delivered by ordinary contributions, not release
assets: the [package publisher](../../scripts/packages/package-release.ts)
requires immutable, assetless releases. Preserve every historical pair unchanged;
add a new directory for another tag. The [starter recipe](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#prepare-the-application)
selects input commit `87dadb251b27b72a18718b08ac39951dd4f1fdd0` separately
from the released source commit. Fetch both inputs from that exact commit,
never from a moving branch or an independently resolved replacement lock.

The [0.43.0 manifest](../../examples/neutral-store/release-inputs/openlup-core-v0.43.0/manifest.json)
and [lock](../../examples/neutral-store/release-inputs/openlup-core-v0.43.0/package-lock.json)
were produced with Node 24.21.0/npm 11.19.0 from `openlup-core-v0.43.0`, source
commit `6facc3e72441ade5813397f65ac7edbe34fd1d0f`. The manifest binds that source
revision and each exact npm package's SHA-512 integrity; the lock retains the
complete registry dependency closure and matching root pins. Its SHA-256 is
`1341821438e57653386bc6900130e3f0e60a33406091c3a917fcfef6a84a9353`.
These files are extraction inputs, not a qualification receipt. Extraction
records `mode: released` and a supplied archive revision, commits the lock, and
performs no installation. Package provenance verification and the broader
qualification result remain separate below. No publisher or producer behavior
changes, and this does not close M19 A5 or the separate P1-SF DEMO conditions.

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

Before executing application checks, `npm audit signatures --json --include-attestations
--workspaces=null --prefix <application>` runs from the isolated parent against
the installed application. Resetting the starter's `workspaces=false` to npm's
default prevents npm 11.19.0 from filtering out the application's root dependency
edges. The installation, manifest and lock stay unchanged. Every OpenLup package
must have exactly one verified provenance subject matching its locked SHA-512, this repository's
release workflow certificate identity, its package release tag and the same
source commit. Registry metadata alone is insufficient; missing or mismatched
provenance refuses the named package; invalid or missing registry signatures also
refuse qualification. This uses retained npm provenance rather
than the publisher's seven-day pack artifacts, allowing later requalification
without changing publication. PostgreSQL uses the digest-pinned GHCR mirror
with job-scoped GitHub token authentication and no upstream fallback. The
installed application checks the PostgreSQL major, typechecks, builds, runs its
application tests and runs the existing development-loop HTTP proof.

The local 2026-11-14 rehearsal against published 0.41.0, source commit
`699157a61f5be9befc268225bb5e8b1539a8ec0a`, passed in 25.816 seconds with
Node 24.21.0/npm 11.19.0 and the same pinned PostgreSQL 17 content available
locally under its upstream digest. It recorded reconstructed extraction,
used an auxiliary audit view for all three provenances, and passed typecheck, build, 296
application tests and two development-loop tests. This is local evidence,
not a hosted qualification receipt. The qualification step's two-minute bound
is 4× that measurement rounded up; the first hosted run must remeasure it. The
shared-proof follow-up on the same date reported 27.814 seconds, 296 application
tests and two development-loop tests. Neither rehearsal established that the
committed audit invocation verified the complete installed set.

On 2026-11-15, [hosted run 43656204743](https://github.com/openlup/openlup/actions/runs/43656204743)
passed the registry tutorial and failed exact-set qualification for 0.42.0 with
`@openlup/outbox@0.42.0: missing or duplicated verified provenance`; the image
publisher was skipped. Local reproduction with Node 24.21.0/npm 11.19.0 on both
0.42.0 and 0.41.0 found only core among the OpenLup `verified` entries, with empty
`missing` and `invalid` arrays. Outbox and platform were omitted, not duplicated:
their only incoming edges were from the filtered application root, while core
also had incoming package edges. Running outside the application with `--prefix`
still loaded its `.npmrc`. The explicit default above fixes that audit scope;
the exact-one bundle, locked subject, signer, tag and commit checks remain intact.
The corrected entry point passed locally on 2026-11-15 for the 0.42.0 tag commit
`494387957789fc2d4596646658ad186d15ff3cbf` in 25.981 seconds: all three
provenances, 296 application tests, typecheck, build, two development-loop tests
and the PostgreSQL 17 major check passed. It used the cached pinned PostgreSQL
content locally; this is not a hosted mirror-access or full canary result.
The same local entry point's adjacent 0.41.0→0.42.0 starter upgrade passed in
59.778 seconds, including all three provenances for both releases, interruption,
resume, replay and preservation of application-owned bytes.

One workflow artifact, retained for 90 days, contains the qualification receipt
and the [exact-set BOM](#package-set-bom). The receipt records the set/tag/commit,
extraction mode and content hash, committed lock SHA-256, each package SHA-512
and provenance verification source, commands/results, runner image and times.
A failed entry-point run retains its partial receipt and error. This supplies
bounded exact-set qualification; it does not certify a full store, provider
behavior, browser journeys, database upgrade/recovery, public hosting, stable support or
a production deployment. Later proofs need their own executed evidence.

## Interrupted adjacent-set starter upgrade

Before publication, the set-release preflight also runs this file/dependency
proof after packing and before release planning, tags or npm publication. The
target comes exclusively from the retained complete local set, verified by the
pack manifest against its commit, SHA-256 and SHA-512 digests. Extraction admits
local tarball resolutions only for those verified entries; other dependencies
retain registry-origin checks. The receipt identifies the target as
`candidate, local digest-verified`. A failed application test or typecheck on
the upgraded predecessor fails the receipt and blocks dispatch. This candidate
proof supplies no published provenance, schema, image or canary qualification.

After publication, the unchanged qualification job adds one step using the existing
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
generated and owned paths. For 0.43.0→1.0.0 or 1.1.0 it first follows the packaged
starter migration: the three new owned files are target-only snapshot entries;
the four required existing owned contracts take the target extraction's bytes
while pristine. For a 1.1.0 target, starters from either 0.43.0 or 1.0.0 also
take the target's pristine `owned/renewal.config.ts` retention contract, as
documented in that set's upgrade page. The proof then customizes
owned theme and fragment files,
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

The local 2026-11-17 0.43.0→1.0.0 file/dependency proof passed with the
updated migration harness and the published packages. Both extracted starters
and the upgraded application passed the shared consumer checks. The owned
migration, managed conflict refusal, interruption, incomplete-state refusal,
resume, replay and owned-byte preservation all passed. This uses the migration
published with 1.1.0. The later hosted qualification results are recorded above.

The local 2026-11-17 1.0.0→1.1.0 published-to-candidate proof also passed
through the same CLI pair harness and shared locked-input consumer checks.
The 1.0.0 owned files matched the immutable source tag; its published package
provenance was verified. The 1.1.0 target used verified local cold tarballs.
Both baselines and the upgraded application passed application tests,
typecheck, build and development-loop checks. The exact target lock moved
unchanged; conflict refusal, interruption, incomplete-state refusal, resume,
replay and owned customizations passed. The old store configuration imports
remained in place, with the documented retention migration in
`owned/renewal.config.ts`. This is local file/dependency evidence; the later
hosted 1.1.0 qualification and provenance results are recorded above.

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

## Released-pair schema compatibility

The qualification job's separate schema step consumes both original installed
applications retained by the adjacent-set starter proof. It checks their
extraction identities, lock hashes, installed package versions and locked
integrities against that proof's receipt. Runner, payment, delivery-alignment
and readiness exports resolve inside those installations. The
[existing schema proof](../../tests/postgres/m14ReleasedSchemaUpgrade.proof.ts)
has an explicit released-pair mode; its no-argument historical execution and PR
CI selection are unchanged. The schema step uses the existing digest-pinned
PostgreSQL 16 mirror in a separate disposable container; the rest of the job
keeps its PostgreSQL 17 service. Cleanup removes both retained installations
after the BOM has checked the original installed target.
Before image acquisition or container setup, the schema step records its start
and FAIL in the receipt. Final sealing requires a successful schema step and
schema result; setup failure, interruption or a skipped schema step cannot retain
the preceding upgrade's PASS.

The predecessor's shipped runner installs its packaged `qualified-v2` catalogue,
using the starter bootstrap's installer-managed profile with distinct install,
runtime and restore roles. Its payment port writes a settled event before the
upgrade. The target's shipped `createPlatformPostgresMigrationRunner` applies
the same profile's packaged forwards.
SIGKILL interrupts the first forward after its real SQL executes but before the
ledger insert commits. The old exact ledger prefix must survive. The installed
readiness evaluator refuses the harness-supplied target catalogue-tail
requirement as `OPENLUP_E_SCHEMA_BEHIND/version_mismatch`; this is a supplied
readiness observation, not a new starter serving guard. Resume completes the
catalogue, checks its inventory and proves migration replay applies nothing.

Execution switches target → predecessor → target on the unchanged upgraded
schema. Both installed payment ports read retained events, make fresh writes
and replay them; both delivery ports exercise late and early arrival evidence
and replay. The named `subscription_monotonic_clamp` assertions require that
no cycle moves earlier, no cycle or delivery stacks, a late arrival extends
exactly once, and replay leaves the extension unchanged. The target's inventory
and exact ledger are rechecked after each code switch.

The receipt labels the separate **historical** 0.23-prefix invoicing backfill;
that witness is not rerun or represented as adjacent-pair backfill. Later
contraction and adjacent-pair backfill remain **PARTIAL** until a real retirement
ships: the 0.41→0.42 pair has no object needed only by the older application.
No destructive fixture or new migration admission grammar is introduced. A
pair with identical catalogues records its schema-forward interruption as
`not-applicable: no forward migrations in this pair`. It still must pass the
cross-version reads, fresh writes, replay and named subscription checks to
qualify; no interrupted-forward evidence is claimed for that pair.
This evidence supplies no general rollback, hosted-service or stable-support
guarantee.

The installed qualified runner explicitly refuses PostgreSQL 17 as
`qualified PostgreSQL installation refused: requires_qualified_postgresql_16_profile`.
The historical legacy chain retains its original profile and execution path.
Local exact-artifact rehearsals on 2026-11-14 passed the real one-forward
0.39.0→0.40.0 pair and the no-forward 0.40.0→0.41.0 pair, including code rollback
and the named subscription checks. These local results are separate from the
first hosted qualification, which must remeasure the step's bound.

## Public outcome projection

The projection uses the release tooling's coherent-set rule: `0.N.P` with N at
least 1, or `MAJOR.MINOR.PATCH` with MAJOR at least 1; prereleases are refused.

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

Both BOM formats use the same coherent-set rule as release preparation. Their
`posture` follows the selected version: `development-preview` for 0.x and
`stable` from 1.0.0. Re-qualifying a historical 0.x tag preserves its preview
posture; a stable version alone supplies no execution or provenance evidence.

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

The same [generator](../../scripts/packages/generate-release-bom.ts) also exports
`generateExactSetReleaseBom` for the post-publication qualification entry point.
Its format version 4 binds the exact set version and tag commit, each package's
registry SHA-512 and npm signature/provenance verification source and bundle hash.
It hashes the canonical, name-sorted signature verification records produced before the
BOM; it does not hash the final qualification receipt. The final receipt names
the SHA-256 of the BOM's formatted JSON bytes, including the final newline.

The composition is the provisional neutral-store PostgreSQL 16 + Node/OCI recipe.
The BOM lists and hashes these extracted files in lexical order:
`.dockerignore`, `.npmrc`, `Dockerfile`, `compose.yaml`, `installation/install.ts`,
`lifecycle.mjs` and `package.json`. They define build context, dependency/build
commands, service topology and launch commands, installation profile and lifecycle.
The profile requires the Compose PostgreSQL 16 pin and `qualified-v2` installer;
it does not substitute the job's separate PostgreSQL 17 application-test service.
Other application files are covered by the starter content identity.

The schema catalogue lists each packaged `sql/manifest.json` by package path,
SHA-256 and zero-based position in package-name order (currently outbox, then
platform). Hashing the entire manifest preserves its internal migration order
and hashes. Each manifest must match the tagged source byte for byte in the
installed package; missing, extra or altered manifests refuse qualification.
The starter binding checks extraction mode, tag source revision, content hash
and committed lock SHA-256 against the original target extraction and rehashes
the extracted files. Locked package versions and integrities must match the
closed verified set. Named refusals and deterministic/tamper cases are covered
by the BOM witness below. The qualification job emits one BOM after its checks
and retains it beside the receipt for 90 days. The schema stage leaves the overall
receipt at FAIL with its completed schema result recorded separately; only the
BOM step records a provisional PASS after writing the BOM and its digest.
Canary completion grants the final qualification PASS.

The [BOM witness](../../scripts/packages/generate-release-bom.test.ts) also checks
real npm archive payloads and member paths, public documentation and any tracked
starter files for the retained root-reference SKU. Synthetic refusal cases cover
each carrier. An absent starter remains unqualified; the check does not infer
starter evidence from its fixtures.

The pack-based format version 1 and its existing CLI retain their original
bytes and npm-only scope. The exact-set format also includes the application
image name, Linux amd64 platform, OCI manifest digest and pinned Node base index
digest. Version 4 also binds the two SBOMs described below. The pack-based
format still supplies no dependency SBOM; neither BOM is an npm publication
receipt or provenance attestation. A BOM is
not itself evidence that runtime checks passed; the final receipt records those
results. The producer's commit attribution remains process evidence; the
BOM does not independently attest how those bytes were built. Existing per-package
SBOM, provenance and [release gates](DEVELOPMENT_AND_RELEASE.md#releasing-a-package)
retain their duties. Version 3 historically lacked dependency SBOM bindings;
version 4 adds them without incorporating the final receipt or attestation. No release-asset, stable-framework or supported-installation
claim follows from a BOM.

## Qualified application image

The read-only qualification job builds one OCI archive from the original verified
target extraction retained by the adjacent-set proof, after the schema step.
The released Dockerfile is supplied on stdin with only its Node base reference
replaced by the [owned mirror pin](../../config/ci-images.json). The extraction
and lock stay unchanged; its `.dockerignore` excludes installed dependencies and
build output. The image installs the locked registry packages and builds the
released application, with the tag commit time as `SOURCE_DATE_EPOCH` and rewritten
layer timestamps. The bundled Docker builder uses the containerd image store;
no separate builder image or implicit scanner is pulled. Only authenticated
GHCR base pulls are allowed; missing mirror access fails qualification.

The exact-set BOM's version 4 image section binds the manifest digest computed
from Skopeo's raw single OCI manifest, not a configuration ID or an index digest.
The base image field identifies the pinned multi-platform Node index. The archive,
BOM and receipt pass through a one-day workflow artifact. The existing 90-day
qualification artifact keeps the BOM and receipt without the large archive.

`publish-qualified-image` runs only after successful qualification and only for
a release-event run or an explicit `publish_image: true` dispatch. This is the
only qualification job with job-scoped `packages: write`, `attestations: write`
and `id-token: write`; it uses pinned first-party actions, shell/JQ and preinstalled
Skopeo, Docker and GitHub CLI, with no checkout, npm or execution of
archive contents. It checks the BOM hash against the receipt and recomputes the
archive manifest digest before any write. With `publish_image: false` (the default),
the publisher job is skipped and no write token is minted. That run retains the
qualification job's receipt, with no separate publication receipt. The in-script
`PUBLISH_IMAGE` guard remains a second layer.
Both qualification and publication enable the bundled Docker builder's
containerd image store before exporting archives.
The existing per-tag workflow concurrency serializes these runs. An existing
version tag with a different digest refuses by name; ambiguous registry errors
also refuse. A digest-preserving copy is followed by registry manifest readback.
Any mismatch fails and no further publication steps run. A registry readback
failure can occur after a copy; the failed receipt does not certify that tag.

A separate 90-day `qualified-image-publication` artifact keeps the final receipt
and BOM when the publisher job runs. The receipt includes the manifest digest,
`published` or `refused`, and the registry readback (null if unobserved). The
defensive shell guard can record `skipped-dispatch` if reached with publishing
disabled. Organization owners must make the package public, link it to this
repository and choose its retention policy. Source presence and local OCI-layout copy evidence establish neither GHCR
activation nor a hosted qualification run. The running-image canary below must
pass before the archive is handed to this publication job.

Qualified sets also publish the four evidence files (BOM, both CycloneDX SBOMs
and the unmodified qualification receipt) at the root of a scratch image in the
same GHCR package, tagged `<set-version>-evidence`, never `latest`. The publisher
admits canonical set versions, including 1.x, and reuses the existing write
permissions and tools. Both version tags refuse a changed digest; both subjects
are read back and attested with the same pinned provenance action. Final PASS
requires verification of both attestations. The final publication receipt records
`evidence.manifestDigest`, registry readback and the evidence bundle SHA-256.
Dispatches that skip publication issue neither attestation nor durable copy.

Maintainers retain each `*-evidence` tag, its digest-addressed contents and its
associated provenance attestation in GHCR for at least one year after release;
do not delete them during that period. Keep the 90-day Actions copies for
convenience. GHCR retention is a maintainer obligation, not an Actions artifact
retention setting. The durable copy contains the qualification receipt before
publication adds registry and attestation results, avoiding a self-referential
receipt digest.

Retrieve the evidence digest from the final publication receipt (or resolve the
version's evidence tag), then verify and extract without running the image:

```sh
image=ghcr.io/openlup/neutral-store-starter
# Set digest to the recorded evidence.manifestDigest, including sha256:.
docker pull "$image@$digest"
gh attestation verify "oci://$image@$digest" --owner openlup --signer-workflow openlup/openlup/.github/workflows/registry-tutorial.yml --bundle-from-oci
container=$(docker create "$image@$digest" /unused)
docker cp "$container:/" ./release-evidence
docker rm "$container"
```

Alternatively, preserve the digest in an OCI layout with
`skopeo copy --preserve-digests "docker://$image@$digest" oci:release-evidence:qualified`.
The verified digest covers all four files; the BOM's `sbom` hashes additionally
check each inventory's exact bytes, and the receipt's `bom.sha256` checks the BOM.
Local fixtures establish refusal behavior; hosted publication and later retrieval
remain execution evidence from the release run.

### Exact-artifact canary

The read-only qualification job's `--canary` stage checks the BOM hash and image
subject, loads that OCI archive and requires Docker's loaded manifest descriptor
to match, then reads the daemon's manifest to check its configuration digest.
It runs the extracted starter's
Compose services without building: mirror-pinned PostgreSQL 16, installation
through `lifecycle.mjs install` using the packaged qualified profile, then the
same loaded image's runtime. Compose uses the starter's existing bounded health
check against `/api/config`. Both example configurations have isolated databases.

The [existing browser runner](../../scripts/starter-browser-ci.mjs) uses its
mirror-pinned browser and existing purchase group, narrowed to the sandbox
purchase spec. It must observe two purchases, one per configuration. The
[installed recovery witness](../../scripts/packages/platform-cold-consumer.ts)
then runs through the installation image against the first database: selected-row
restore/readback, exact integer/microsecond preservation, idempotent replay,
conflict refusal and guarded-table refusal. This proves neither a complete
store backup nor package/schema rollback. The completed `upgrade` and
`schemaUpgrade` sections remain separate evidence, referenced without rerunning
their steps.

The receipt's `canary` section records image/configuration identities, install,
journey and recovery results and durations. A failed or interrupted stage cannot
retain a final PASS. The existing 90-day qualification and publication artifacts
retain the receipt; no release asset is created. The write job's existing
qualification dependency blocks image publication on a failed canary. Compose
cleanup runs on success and failure; the job's existing `always()` cleanup also
removes containers and volumes labelled with a `canary-*` Compose project after
cancellation or a step timeout.
This is qualification evidence for the one supported stable 1.x installation
composition, not provider certification. The first-party demo store is separate adoption evidence.

A local 2026-11-14 rehearsal on the qualified 0.41.0 set passed archive loading
and identity, lifecycle installation/readiness (30.857 seconds), the existing
purchase spec for both configurations (2.320 seconds) and selected-row recovery
(1.281 seconds). Total time including cleanup was 38.480 seconds; four times
that measurement rounded up sets the canary step's three-minute bound. The
first hosted run must remeasure it. All four inventory-pinned images were
already cached: Node from the organization mirror, PostgreSQL 16 and Syft from
their recorded Docker upstreams, and the browser from its recorded Microsoft
upstream. This local-only resolution exception changed no CI image source or
credential and establishes no hosted mirror access. The exercised manifest was
`sha256:8457d5ec1d44c806e1baa617c061c1bdc3fa21a62b747c334a02880e777225a2`.

There is no stable maintenance line or previous stable major, so previous-major
backports are not applicable. Maintenance evidence remains partial; backport
automation follows explicit owner stable activation under the
[maintenance policy](../../.github/VERSIONING_AND_EOL.md#support-window).

### Dependency inventories and image provenance

Added 2026-11-14. Historically, version 3 bound the image without an image SBOM
or build attestation. Version 4 generates both CycloneDX inventories before the
BOM: npm 11.19.0 runs `npm sbom --sbom-format cyclonedx --package-lock-only` in
the verified target application, including development and optional dependencies
in its locked set. The BOM hashes the exact SBOM bytes produced and retained in
that run, including npm's serial number and timestamp. Every OpenLup component
must match the verified package set's version and SHA-512; missing or differing
components refuse by package name.

Syft scans the final OCI archive, after rechecking its manifest digest. The
scanner has no network or Docker socket and mounts only that archive read-only.
The `sbom` section records each inventory's SHA-256 and tool name/version, the
scanner image digest and the image inventory's manifest subject. The existing
90-day qualification artifact retains both inventories alongside the BOM.
These are dependency inventories, not vulnerability assessments or a guarantee
that every runtime-loaded dependency is discoverable. The npm inventory includes
locked dependencies even when the final image omits them; Syft inventories the
final image's visible filesystem, including base-system software.

The publication job issues provenance only after archive/BOM equality, immutable
tag checks and registry readback pass. GitHub CLI verifies the newly issued
bundle against the digest-addressed OCI subject, organization owner, expected
workflow signer and certificate source repository. The verified statement must
name precisely that image and the BOM's SHA-256 subject. A mismatch fails the
job. The final receipt remains FAIL until verification passes and records its
result and the detached bundle SHA-256. The 90-day publication artifact retains
the bundle and verification JSON. Dispatch without publication skips issuance.
The certificate describes this repository's trusted publication workflow; the
released starter, lock, packages and release revision are bound separately by
the BOM and its qualification receipt. No independent attestation of those
materials is claimed.

The added third-party inputs are inventoried here and in the existing controls:
`actions/attest-build-provenance` v3.2.0 at
`96278af6caaf10aea03fd8d33a09a777ca52d62f` (the publisher's action allowlist),
and Syft v1.38.0 at
`sha256:825cad3a952c87676a6d07e9a3bb05ac9c401d598360070e970aa46d54c1727e`
(the CI image inventory and mirror list). Qualification uses the authenticated
GHCR mirror through the existing bounded pull helper, without an upstream
fallback or implicit BuildKit scanner download.

A local 2026-11-14 rehearsal on the 0.41.0 set, using the auxiliary audit view above,
passed npm inventory generation and named-package checks in 0.187 seconds
(72 components), then Syft scanning in 5.312 seconds (3,451 components).
It used the same pinned scanner and Node content from upstream locally because
the new mirrors were not populated; it does not establish hosted mirror access.
The local OCI manifest was
`sha256:8457d5ec1d44c806e1baa617c061c1bdc3fa21a62b747c334a02880e777225a2`.
Authentic image-attestation issuance and discovery remain hosted-only evidence,
not established by offline mismatch fixtures or this rehearsal. No release-asset
publication, stable-framework or supported-installation claim follows.

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
