# Tree-wide neutrality ratchet

Status: approved implementation contract; initial scanner identities require review of the concrete counting interfaces.
Audience: contributors implementing and reviewing public source checks.
Scope: development-preview tree checks using the existing core source scanner and UI neutrality patterns.

## Required behaviour

Removed neutrality debt must not return. Counts belong to an exact relative path and category; a reduction elsewhere cannot pay for an increase. Changing a matcher must not masquerade as removing a finding.

For a PR, use the event's full base SHA and record the actual checked-out candidate SHA separately from the PR head. For a main push, use the event's previous SHA. Local execution resolves an explicit full SHA or `origin/main`. Missing, malformed, unavailable or all-zero bases refuse; a parentless repository bootstrap is outside this implementation slice.

Scan all tracked text regardless of extension. Local dirty execution also scans nonignored untracked files. Inventory binary files separately. Genuine deletions are allowed; unreadable existing objects refuse. Git objects and filesystem entries must not cause the check to follow a symlink or escape the source tree. Read historical blobs as data, not historical programs.

## Count and baseline rules

- A candidate count cannot exceed either the actual base count or its accepted baseline count for the same exact path/category. Missing counts mean zero.
- Candidate baseline allowances cannot exceed the parent baseline. Baseline deletion cannot reopen bootstrap.
- Initial baseline is allowed only when the trusted base lacks one. Its `sourceCommit` equals that full base SHA and its counts equal the complete measured base tree.
- Ordinary regeneration only lowers allowances deterministically. It cannot authorise scanner changes or raise the accepted debt.
- Path keys retain exact case through SHA-256 identities. A contaminated rename introduces debt at its destination and refuses. Clean rename/deletion passes. Reintroduction is measured against the current base, not an old ceiling.
- Previously contaminated text becoming binary is not evidence of neutralisation and refuses in this slice.

For example, 3→1 passes. A later 1→2 fails even if the recorded ceiling remains 3.

## Scanner authority

Bind the complete current scanner chain by Git blob identities: `packages/core/scripts/neutrality-source-scanner.ts`, `neutrality-shell-fold.ts`, `neutrality-tree-counts.ts`, and `packages/ui/smoke/neutrality.ts`. Validate exact pin keys, supported categories and safe nonnegative integer counts. Working bytes must match pins; parent pins cannot silently change. Unchecked transitive dependencies refuse.

The first installation may add reviewed counting interfaces without changing existing matcher semantics. Review their exact diff and identities; the program cannot infer semantic safety from a diff. Preserve the current positional UI category mapping in this slice.

Baseline and scanner files remain in the scanned inventory. Use hashes and category keys for metadata rather than exemptions. A representation that manufactures new findings must be corrected.

A legitimate scanner upgrade is a separate contract change. It needs old/new semantic measurements, category mapping, attribution of newly detected existing debt and explicit admission of any revised allowance. Ordinary baseline generation cannot approve it. Do not build a general policy-migration framework in this change.

The ratchet and workflow execute from the reviewed candidate tree. Scanner pins prevent silent matcher drift under that reviewed enforcement code; they do not make candidate CI an immutable security boundary. Changes to enforcement or workflow behaviour require maintainer code review. Required status checks and their governance remain the maintainer’s responsibility.

## Acceptance witnesses

Use small synthetic Git fixtures and invoke the real CLI. Verify exit status and actionable bounded reasons for:

- shrink followed by regrowth; independent paths and categories; new contaminated extensionless files;
- correct bootstrap, wrong-source bootstrap, ordinary lowering, baseline increase/removal;
- contaminated and clean renames, deletion and reintroduction, binary inventory and text-to-binary evasion;
- matcher removal/reordering, pin drift, unchecked import, scanner failure;
- malformed or unavailable base, invalid counts/categories/JSON, unsupported objects and symlinks.

Do not replace the CLI witnesses with arithmetic helper tests alone. No new dependencies or copied public checkout are required.

Implementation owner: the neutrality lane owns ratchet code and counting interfaces. The integrator owns baseline generation, workflows and publication contracts. See the [implementation plan](public-ci-completeness.md) and [contribution checks](../../../CONTRIBUTING.md).
