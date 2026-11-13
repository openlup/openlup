# Distribution evidence

Status: historical record, 2026-11-09.

Status: development-preview source tooling. No complete release outcome or
supported installation is claimed.

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

The portable rail takes sandbox payments only. Real money currently runs only
on the managed rail, so a portable real-money store without vendor lock-in is
not yet available. Read the [install policy](../../.github/INSTALL_SUPPORT_POLICY.md)
before relying on any preview profile.
