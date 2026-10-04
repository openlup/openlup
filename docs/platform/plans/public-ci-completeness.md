# Complete observation of the published source tree

Status: maintainer-approved bounded implementation; final evidence is recorded below.
Audience: development-preview contributors and the public repository maintainer.
Purpose: expose all shipped test obligations while preserving required-main coverage.

## Outcome and scope

Published Tree CI selects every root Vitest project and every shipped managed
pgTAP file from public inputs. Failing and aborted files stay visible with a
reason, accountable triage owner and incomplete obligation. Complete observation
is useful before every platform defect is repaired; required-check success is
not a claim that the full test tree passes or that the framework is stable.

This contribution owns the workflow, command inventory, disposable pgTAP runner,
shrink-only neutrality ratchet, their falsifiers and documentation. Platform
runtime changes, SQL/ACL corrections, test-fixture repairs, historical-obligation
rewrites and installer reconciliation are deferred. No test is disabled to get
green. No live database, provider, secret, release or adopter operation belongs
to this task.

The maintainer approved staged admission before separate repairs, the matching
local verifier amendment and this task's native review registration. The local
amendment is independently reviewed as exact bytes before installation. It
preserves other task mirrors and records raw diagnostic exits; it is not a hook
bypass. Repository settings and rulesets are unchanged.

## Required and diagnostic execution

The existing six contexts remain `dco`, `typecheck`, `install-proof`, `test`,
`self-check` and `gitleaks`. `npm run test:required` preserves the former main
root-test command, including every selector and its ordering. The required test
job retains standalone subscription tests, complete core CI and the materialized
contract falsifiers, and additionally runs the neutrality CLI refusal tests.
Lint blocks `typecheck`; UI neutrality and the tree ratchet block `self-check`.

Independent `test-full` runs unrestricted `npm test`; independent `pgtap` runs
all supplied SQL tests against the committed managed baseline and ordered
forwards with Supabase CLI 2.98.2. Jobs preserve actual diagnostic exits; current
results and unresolved obligations are separated from dated historical failures
in the diagnostic record. No dependencies
on successful full-root diagnostics can prevent required core checks or pgTAP.
Actions use full commit pins and jobs retain trusted event-metadata fences,
including inherited merge-group validation and the optional `native-review`
admission job. That job depends on the six required contexts, independently of
the two raw diagnostic jobs; its activation remains the maintainer's decision.

The [known-red record](public-ci-known-red.md) is diagnostic documentation, not
an executable exception list or failure budget. New infrastructure failures,
missing dependencies, zero discovery, incomplete execution evidence and
unexplained changed failures block delivery. Historical collection or SQL aborts
must name the assertions they did not reach; selection does not prove completion.

Promoting the new diagnostic jobs to required checks is the maintainer's ruleset
decision. Release workflows retain their six required-context checks, so diagnostic
red does not itself refuse a release. Merge neither cuts a preview nor authorizes
an installation or adoption.

## Runner and ratchet contracts

The runner checks committed migration identities, bytes, modes and strictly
increasing versions before starting services. It refuses missing, modified,
untracked, duplicate or symlinked migrations. Replay is transactional in one
owned disposable CLI project, with public prerequisites, a diagnostic PostgreSQL
owner and closed default grants. Only pgTAP extension assertion members receive
test-helper execution grants. The pinned image's denial-hint formatting workaround
is verified after restart; permission identities and actual refusals remain.

Tests are copied unchanged. The runner adds no settlement parameters, provider
fixtures or application seed. Finally cleanup targets only its own project and a
cleanup failure remains visible. This measurement profile does not select the
reference installer's production authority or prove an existing-install upgrade.

The [neutrality contract](public-ci-neutrality-contract.md) preserves existing
matcher semantics and binds the four-source scanner chain. Both the actual base
and accepted ceiling constrain every path/category, so shrink followed by
regrowth fails. Baseline regeneration never authorizes higher allowances.

## Execution and ownership

1. Preserve the broad repair candidate as a recoverable ancestor; restore deferred
   paths to selected main bytes in an ordinary signed commit. A narrow final diff
   still publishes earlier commits in branch history. Scan the whole history.
2. Work in disjoint runner/contract and neutrality lanes. The integrator owns the
   workflow, package/policy, generated files, documentation, local-tool activation,
   Git and serial full measurements. Shared files have one writer.
3. Run focused required falsifiers, the preserved required coverage and independent
   full diagnostics. Record inventories, raw exits, failed/aborted files and owners.
   Diagnose infrastructure failures without accumulating platform repairs.
4. Integrate the current main last with the maintainer-authorized signed merge,
   preserve its coverage and the exact recovery ancestor, regenerate navigation,
   catalogue and derived source contract, and obtain two parallel fresh-context
   native reviews of the exact committed candidate and staged local-tool bytes.
   Consolidate material findings before repairs; retain complete prior evidence
   and use the installed protocol's closure route for eligible ordinary repairs.
   Sensitive or unknown repairs retain two reviewers; at most two automatic repair
   cycles precede regrouping. A current complete pass ends review.
5. Run the prescribed verifier and DCO on the final candidate. Inspect the fresh
   diagnostic logs after verifier execution; a required-admission exit 0 cannot
   waive a new infrastructure failure. Push only accepted evidence, then stop
   under this task's publication instruction. Opening and squash-merging the
   concrete PR require their applicable explicit maintainer instructions.

The tracked `.agent-protocol.yml` names an absent template and validator. The
maintainer previously authorized this public task-record format for this task;
no native Plan Protocol pass is claimed. Approved scope and guarantees remain
fixed while computed SHAs, measurements and execution notes evolve.

## Acceptance and simpler route

Preserve every former required selector and retained standalone step. Required
CI-infrastructure falsifiers, lint, typecheck, builds, core CI, policy/inventory,
DCO and leak checks pass. Full Vitest and pgTAP select all supplied tests and
preserve raw exits; every failure has named diagnostic ownership. Final native
review binds actual source; local-tool review binds separately staged bytes.

The existing commands, scanners and helper selftest provide this outcome without
a new failure-classification framework, skip list, migration ledger or platform
capability. Blanket grants, synthetic history and tolerated exits would falsify
proof. Requiring every platform repair first would delay the original observation
outcome and silently expand this contribution. Later repairs use the named debt
and separate compatibility/authority scope.

## Implementation evidence

The current measurement and its limitations are maintained in the
[known-red record](public-ci-known-red.md). Planning reviews do not certify the
implemented candidate; final review and execution evidence are recorded in the
pull request. This work improves evaluation and contribution evidence, without
claiming stable support, portable parity, external adoption or production readiness.

Owner links: [contribution checks](../../../CONTRIBUTING.md#development-preview-checks),
[canonical contracts](../CANONICAL_CONTRACTS.md#compatibility-posture),
[documentation maintenance](../DOCUMENTATION.md).
