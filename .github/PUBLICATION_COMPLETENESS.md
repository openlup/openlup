# Publication completeness

## The one-time root claim

**The first public OpenLup root is a mechanically derived, fresh-history subset
of the pre-split development repository, not a hand-assembled copy.**

At that one final split, nobody decides file by file what to include. A catalog
of surface families assigns every tracked pre-split path to exactly one family,
each family is publishable or withheld, and the parentless public root contains
exactly the selected families plus declared deterministic projections. A path
that belongs to no family is a hard error, so "we forgot to publish it" and "we
quietly dropped it" are failures the act refuses.

The derived result becomes the public **platform monorepo**: framework,
official modules, reference app, and tools. It is not an adopter repository.
Velipet and every external adopter keep their application, brand, catalogue and
private extensions in separate repositories.

**After activation there is no mirror.** The public OpenLup repository is the
sole editable source for generic platform work and creates later previews and
stable releases from its own history. Velipet consumes those releases; it never
pushes generic changes back through a private-to-public sync.

## Why this is stated at all

Projects opened from a private product repository are routinely asked whether
their first public tree omitted inconvenient source. The honest answer is a
procedure and immutable receipt for that root, followed by one unambiguous
upstream. That is the pattern this file adopts; it is provenance for the split,
not an architecture for ongoing mirroring.

## How to falsify it

Before activation, receipt issuance on the exact private act SHA was procedurally contingent on four green source-only gate classes. The tracked contract binds declared inputs, and the receipt binds the resulting public commit, contract and declared drift; it contains neither gate-output artifacts nor the private source commit.

| Source-only act gate | What a red run proves is wrong |
|---|---|
| partition/readiness scanner | the partition is not total: some tracked path is unclassified, a family selector is stale, or a withheld/published boundary moved without being declared |
| split-manifest derivation | the list of what a published tree contains is not derivable from the catalog |
| split rehearsal | the published partition does not compose and typecheck on its own outside this repository |
| clean-install proof | the projected dependency manifest does not install and build from a clean state |

These are provenance labels, not public commands. After activation, run `npm run oss:published-tree -- --policy` (also `--inventory` and `--typecheck`), `npm test`, and `npm run build`; the immutable root receipt remains a public commit/contract and declared-drift readback, not an execution log.

## What is deliberately not built

**There is deliberately no recurring private-to-public mirror.** The canonical
export is a one-time activation instrument: it materializes and commits the
parentless root only after the four checks above, then produces the immutable
receipt used by the split runbook. Once public authority is activated, that
instrument has no release role; later OpenLup releases originate in the public
repository.

## Publication is not a support artifact

Completeness, release identity and support answer different questions:

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| green completeness checks | every tracked input was classified and the public tree matches the derivation | stable API, production readiness, support, or an upgrade path |
| immutable development-preview source release | exact preview bytes can be reproduced | compatibility, external-adopter support, or stable SemVer |
| future stable platform release/BOM | the named packages, images, composition and thin app form one supported artifact set | support for arbitrary branches, commits, source checkouts, ejected files, or community modules |

The source preview opened by the one final split exists initially for evaluation
and for the temporary source bridge exclusive to Velipet. That bridge is a first-party
transition necessitated by the fresh-history split, not a public adopter install
or update channel. A source checkout that happens to build is not promoted into
a supported artifact by accident.

The stable claim begins only after the `P1-SF` stable-framework gate proves the versioned BOM, thin
adopter app, public extension contracts and upgrade tooling, clean install,
typecheck, advertised build, public tests and adjacent-version upgrade. Until
then the honest label is development preview.

## What this claim does **not** say

It says nothing about whether the platform is finished or supported.

Completeness here means *the published tree is the whole of what the derivation
selects*. It does not mean the platform is feature-complete, production-ready, or
certified to self-host. Those are measured separately and are currently partial.
The live capability numerator/denominator is source-only pre-act state and is not embedded in the immutable receipt; this policy deliberately embeds no snapshot
that can drift when the capability registry changes. The candidate reproduction
path is not yet a certified supported install
(`.github/INSTALL_SUPPORT_POLICY.md`).

Reading a green completeness check as a readiness signal would be exactly the
wrong inference. A tree can be completely published and still be early.
