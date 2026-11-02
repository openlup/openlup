# Complete installed PostgreSQL migration chain

Status: implementation and focused proof complete; committed native review and the lead's reserved canonical verification remain.

Outcome: an isolated application installing the platform tarball can install and
inspect the complete portable schema through `@openlup/platform/migrations`,
without a repository checkout. This closes the missing installed-chain gap.

Scope: deterministic generated projection of the canonical migration manifest
and exact SQL bytes into the package; move existing generation selection and
catalog admission behind the existing migrations entry; retain repository
facades and their behavior. Cover qualified-v2 and qualified-admin, and evaluate
legacy inclusion. Packaging existing identities is not a new migration.
No SQL changes, new forwards, alternative executor or application CLI. The managed adopter chain is untouched.
No provider qualification, application activation, publication, hosted resources,
credentials or settings are authorized.

Authority: the accountable maintainer assigned this bounded implementation and
supervision under the programme lead. Local edits, proofs, later DCO commits,
submission, receipt posting and merge are delegated for the accepted programme
and path list, subject to the current required gates. The lead coordinates order
and cap reads. No release dispatch is granted. The stabilized API, measured cap packet and exact three-line package boundary
inventory update were accepted before sign-off, subject to the explicit-selection
amendment described below. After passing native review, stop for the lead's final verification allocation. This continuation authorizes no push, PR or queue. The programme's prerequisite release
line was verified when read at task start.

Code base: bb0008481a11267ec6dbe3e7e531299777cddc19.
Policy revision: bb0008481a11267ec6dbe3e7e531299777cddc19
(fetched and checked again 2026-11-01 before the read boundary). Dedicated worktree `oss-m19-r0`, branch
`codex/oss-m19-r0`. Follow current [agent rules](../../../AGENTS.md),
[contribution and review policy](../../../CONTRIBUTING.md) and
[data owner](../DATA_AND_MIGRATIONS.md).

Acceptance and proof: compare packaged paths, hashes and order with the canonical
manifest; reject generated drift and missing/tampered units by name. A real
packed artifact in an isolated consumer installs fresh PostgreSQL 16 in both
role modes, reports every selected unit applied, and reruns without applying
anything. Existing m14 selection/composition proofs retain their meaning.
Measure actual packed/unpacked bytes and files, propose actual plus a justified
reserve for the remaining programme, times 1.02, for the lead's read packet.
Complete focused checks, policy/typecheck/lint, API checks, two independent
fresh-context native reviews and later full verification before delivery.

Risk and smallest adequate approach: preserve the existing runner, options,
selection/admission and projection logic; package a generated immutable copy of
existing history rather than introduce another catalogue or install mechanism.
The main risks are changed catalog identity, generation selection, artifact
resolution and lost host admission. Exact-byte comparison, existing selection
proofs and real packed consumer refusal/replay tests distinguish these failures.

Evidence and remaining work: canonical byte comparison passes for all three
plans: legacy 91 units (39 previously absent), qualified-v2 95 (44 previously
absent, 672,309 source bytes), qualified-admin 94 (43 previously absent).
The generated union adds the exact assets needed by those plans. No canonical
manifest, source migration or managed migration changed. Legacy ships because
it is the existing facade default and full canonical validation covers the union;
omitting it would require a new divergent validator or change the default.

The pre-build canonical manifest tooling remains its authoring owner because
publication policy runs before package dist exists. The packaged selection and
validator are an exact generated copy checked together with the manifest and
SQL; this avoids a private package-source import from repository tooling and a
second editable implementation. The four adapter files are public-entry facades.

The required existing cold-consumer batch checks projection drift and owns four
fresh PostgreSQL 16 installed-artifact witnesses. Executed results:

| Evidence | Result |
| --- | --- |
| Pinned dependency installation and Core/Outbox/Platform builds | PASS |
| Structural ast-grep checks and migration declaration snapshots | PASS |
| Generated manifest, source-selection copy and exact SQL bytes | PASS |
| Drift regression (manifest, selection source, tampered/missing SQL) | PASS |
| Isolated ordinary-package consumer, qualified-v2 installer-managed / operator-provisioned | PASS: 95 applied, canonical hashes/order, named missing/tampered refusal, no-op rerun |
| Same consumer, qualified-admin installer-managed / operator-provisioned | PASS: 94 applied with the same assertions |
| Real tarball files compared with staged source/build origins | PASS |
| Staged secret scan | PASS |
| Facade option lookup/refusal regression | PASS: 3 cases (two original facade cases and one package-selection refusal) |
| Existing repository migration runner | PASS: 10 cases |
| Existing package boundary witness | PASS: all 2,834 cases with the exact approved three-line inventory update |

Real pack comparison uses the exact task base's platform source, built with the
same compiler and unchanged dependency set, against the candidate:

| Measure | Base | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Packed bytes | 2,102,771 | 2,312,171 | 209,400 |
| Unpacked bytes | 9,809,502 | 10,949,381 | 1,139,879 |
| Files | 2,840 | 2,910 | 70 |

Accepted caps: 2,485,000 packed bytes, 11,955,000 unpacked bytes and 3,173
files. The directed reserve is 120,000 packed bytes (code 75,000, SQL/assets
35,000, docs 10,000), 770,000 raw bytes (code 545,000, SQL/assets 175,000,
docs 50,000) and 200 files (180 code, 20 SQL/assets). Apply 1.02 and round byte
caps up to 5,000 and file caps up to an integer; retain the larger existing
docs-file cap of 10. Code caps: 1,970,000 packed bytes and 3,039 files; docs:
75,000 packed bytes and 10 files. Packed headroom over the measured base is
382,229 bytes. The foundation stream supervises the worker; the lead and
coordinator own programme sequencing and the overall size picture.

The coordinator independently checked all 103 packaged SQL units byte-for-byte,
the projected canonical catalogue, unchanged qualified installation and selected
catalogue projection logic, and cap arithmetic. The accepted pre-amendment
identity is head `bb0008481a11267ec6dbe3e7e531299777cddc19`, staged tree
`d1503f7ad5638313393320b40a22af437b1827ff`, 75 files, and staged binary diff
SHA-256 `a37df8ce4695eb1fd2d53615ebf602582659d2ea240ee41451385d2ec4d33423`.
Legacy shipping and the bounded package-boundary inventory update were accepted.
The only path beyond the original brief is
`packages/platform/test/packageBoundary.test.ts`; its exact approved patch has
SHA-256 `380774bfa652be4b869599c0a8d167b524c379bc125fe9b62b8fb0c2a05fc6fb`.

The required amendment makes `installation` mandatory in the package factory's
options type and refuses a missing selection by name before catalogue or pool
work. The repository facade retains its original undefined-to-legacy behavior,
null refusal and admission order. One added regression exercises this new
refusal; the isolated npm consumer also exercises it before any catalogue or
connection work. README, related public summaries and declarations agree with
the explicit installed API. No SQL, canonical history or managed rail changes.

The amended payload identity, captured before updating this evidence record,
is staged tree `3dc76e89bf588b78a25f6ab746986d168e9e3d92`, 76 files, staged binary diff SHA-256 `0e0579cf45d15b0082fc8de992a2c426a8205b2cd5899f916e45f464eb14cbb6`;
the amendment patch from the accepted tree has SHA-256 `8ea7f8c2f17550e70909208bebd0b35feaaf5903d432f5886b555420a3d2da52`.
This separation avoids a self-referential tree digest. Final committed head/tree
and native execution evidence are retained in ignored task evidence and the
supervisor handoff.

The final tarball is SHA-256
`d1927bfba30b7031372ec6a6d85010977417933b0d4f13b7e83625100285d405`.
Its four fresh installed-consumer PostgreSQL 16 cases pass: 95 qualified-v2 or
94 qualified-admin units in both role modes, exact canonical paths/hashes/order,
all-applied status, named missing/tampered unit refusals and zero-unit reruns.
The missing package selection refuses by name before catalogue or pool work.
Accepted caps and all seven reserve calculations still match; artifact inventory
and generated projection checks pass. Both unchanged M14 suites were rerun:
four qualified-v2 and two qualified-admin cases pass. All ten existing runner
cases and the three facade/package regressions pass. Published-tree typecheck
passes with zero unresolved edges and consumer errors. Lint passes with zero
errors and the same 33 warnings outside this delta; ast-grep passes. The final
staged secret scan, API snapshot check and documentation fingerprints are
retained with focused logs under ignored task scratch. Four no-impact trailers
are recomputed for this source before the DCO commit; post-commit policy must
pass before counted review. Canonical
verification is reserved for the lead's named PR. No review repair cycle has
been consumed, and no external write has occurred.

Self-retro: source package imports would make pre-build policy depend on absent
dist or violate the public import boundary. Keep the existing tooling owner and
check an exact generated package copy; do not add a loader or suppress the rule.
Forward option reads rather than spread an options object: inherited fields and
deferred refusal order are observable at the existing facade. The new two-case
regression protects that boundary. The canonical actor SQL's trailing blank line is preserved: ordinary diff-check
flags that issued byte sequence; the check with only blank-at-EOF disabled passes.

Read-revision self-retro: changing only cap metadata still changed the compressed
tarball by three bytes. Repack and measure the actual final artifact, and retain
prior runtime proof only after an exact comparison of its runtime/SQL bytes.

Amendment self-retro: the first scratch test launcher omitted the local binary
path; repair the launcher rather than alter tests. More consequentially, a
parallel pre-lint build removed dist while an M14 child imported it. Serialize
package builds and installed-module PostgreSQL witnesses; the serialized rerun
passes all six M14 cases. Keep the original failed logs as execution evidence.
The final artifact proof and measured caps remain tied to the exact tarball,
not to an unmeasured rebuild. No useful source simplification beyond reusing the
existing runner and moving only the default to the facade was found.
