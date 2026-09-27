# Complete, credible checks for the published source tree

Status: approved implementation direction; schema authority, capability admission and release activation remain separate decisions.
Audience: contributors and the maintainer of the development-preview source tree.
Support: this plan improves preview evidence; it does not establish stable-framework, portable-database or production readiness.

## Goal

Run every shipped public test and make its result meaningful without deployment-specific history, data or configuration. A clean runner must exercise the managed installation and actual access boundaries. Fixture repairs must preserve the obligation of each test. Green checks must not depend on broadening privileges, excluding failing files or silently changing application behaviour.

The intended benefit is repeatable evaluation and contribution from public inputs, with defects found before immutable publication and deliberate adoption. An adopter retains its configuration, extensions, local measurements and deployment decisions. Public installation proof and consumer upgrade proof are separate outcomes.

## Starting evidence

The earlier reviewed CI candidate was `5f4094b73486371c872ededfb545b54cad6a5353`, based on public main `03dbbedc953b96607f1ef1fc3342847cf49aa16e`. It widens root test discovery, adds managed pgTAP and tree-wide neutrality, and uses explicit fixtures. Source release automation, bounded additive-forward admission and the managed alignment seed have already merged separately.

That local measurement found 31 failing root files and 23 failing pgTAP files out of 206 executed files. These are unresolved obligations, not an accepted failure budget. The complete local verifier failed. The evidence is dated; final acceptance requires a new serial verification on the final commit.

Code review identified missing dependency installation before the pgTAP runner imports `tsx`, different installation authority between CI and the reference setup, textual helpers being used as access proofs, a neutrality ceiling that permits regrowth, and a seller-tax fallback change mixed into fixture repairs.

## Constraints

Preserve payment/idempotency boundaries, active subscriptions and delivery obligations. Late delivery may extend a cycle but never move it earlier or stack deliveries. Never confirm an undelivered replacement.

Existing migration bytes remain immutable. New platform authority must have a concrete owner and compatibility evidence; test setup cannot grant the application the very privilege being tested. Platform code does not write adopter-owned `app` objects. No new test exclusions, skips or normalized failure exits. No neutrality allowance increase.

The public required-check configuration and release activation are maintainer decisions. The native review policy merged in PR #52 delegates technical review to independent fresh-context subscription agents in the same task. It does not grant publication authority or waive mechanical checks. This plan does not change rulesets, hooks, credentials or deployments.

## Implementation waves

1. **Runner and neutrality.** Install locked dependencies in the pgTAP job, retain pinned Node/CLI/actions and add a workflow prerequisite falsifier. Implement the [neutrality contract](public-ci-neutrality-contract.md). Repair deterministic fixtures independently. Restore the prior seller fallback behaviour; any deliberate tax-ID policy change needs its own functional change and compatibility tests.
2. **Managed authority and proof mapping.** Establish the [managed installation contract](managed-installation-proof-contract.md). Measure owners, role attributes, default and effective privileges in the current callers before selecting a profile. Map historical-file assertions to the same shipped public obligation. Do not treat SQL text as effective denial.
3. **Effective proofs and remaining failures.** Verify real role-taking positive and negative operations. Separate bare-install prerequisites from transaction-scoped behaviour fixtures. Each failing shipped test gets an equivalent executable witness or remains a named blocker. A scope decision alone does not make a test pass. Missing public RPCs or entrypoints require a minimal capability contract, not synthetic implementations in test setup.
4. **Approved corrections and compatibility.** Prepare one precise correction at a time after its authority is established. Email access, trigram operator namespace, audit invocation and absent catalogue seams are separate obligations. The current release predicate refuses general grants and function replacement; a bounded admission amendment or explicit preview hold must precede merging such corrections. Preserve old receipts and verify genuine previous-preview compatibility.
5. **Integration and delivery.** Rebase last, regenerate the publication catalogue and derived source contract, run one serial full verification and DCO on full SHAs, then report release-check reasons beyond main. Prepare two fresh-context native reviews of the exact final committed candidate, record actual execution observations, and resolve incomplete or material findings automatically within the approved scope. Obtain fresh reviews after source changes. Earlier scoped reviews are historical evidence, not final native admission. After an authorised push, stop under this task’s explicit publication instruction and request authorisation of the concrete PR. Do not claim the maintainer personally read the diff. Hosted checks follow the authorised non-draft PR; task-branch push alone does not execute them. Merge, release and adoption remain separate transitions.

## Agent ownership

Use disjoint lanes for neutrality, deterministic fixtures, commerce structural tests and subscription structural tests. Give each writer exact files. One integrator owns workflows, package/lock files, generated baseline/catalogue/contract, managed replay and shared schema helpers, documentation and Git operations.

Workers may run focused tests on existing dependencies. Dependency installation, shared database lifecycle/application and full verification are serial. Do not inspect or use another session's worktree, database or ports. Recheck merged and active work before assigning conflict-sensitive paths. Review the integrated implementation independently; planning review does not certify its code.

Fresh installation and existing-installation upgrade are separate slices. A migration-history mechanism is not required just to replay a fresh disposable CI database. An uncertain existing history must refuse automatic upgrade rather than guess or replay every forward. Do not add a general migration framework to resolve a test fixture.

## Acceptance and holds

Capture the collected test-file inventory, existing conditional skips and exclusion configuration. All current root and managed tests must execute with their raw failure semantics. Final lint, published typecheck, builds, core checks, policy/inventory, catalogue/contract equality, DCO and leak checks must pass. The [named known-red record](public-ci-known-red.md) is diagnostic evidence, not a waiver.

Unspecified installation authority, unprovable applied history, absent public capabilities, new privileges and release admission remain concrete holds. Prepare their smallest reviewable proposals before requesting decisions; unrelated local repairs may continue. Do not report complete CI while those failures remain.

Upgrade evidence must preserve existing owners/ACLs, operator choices, subscription/payment/outbox records and extensions, including interruption and restart. Fresh fixtures do not prove that preservation. Portable parity, external adoption, P1-SF and production evidence remain separate programmes.

## Implemented local checkpoint

The pgTAP dependency prerequisite and its workflow contract check are implemented. The ratchet now measures both actual-base findings and accepted allowances and binds the full four-source scanner chain. Current structural fixtures retain separate historical failures. Seller fallback behaviour matches public main. The shipped Node server now bootstraps the explicitly selected ambient settlement profile before subscription-profile composition; regression tests cover invalid input, same-profile reuse and conflicting reuse. This is a runtime boot correction exposed by coverage, not a test-only change.

Focused runtime/accounting/graph/workflow checks, neutrality CLI falsifiers, lint and published typecheck pass locally. Full root execution and managed pgTAP remain red on the listed obligations. No push, PR, release or adoption result is established by this checkpoint.

## Native review integration

PR #52's native policy is the review default. Two independent fresh-context reviewers found that the pgTAP runner accepted duplicate migration versions and did not bind replay to committed blobs. The bounded correction snapshots the committed inventory and verifies file identities, bytes and strictly increasing versions before starting the database. Focused refusal witnesses cover malformed/duplicate versions, missing/modified/untracked files, symlinks and mode changes. It adds no migration ledger or schema change.

Installation expectations now execute before synthetic configuration in the five named tests. Fixtures still support subsequent behaviour tests; their presence cannot certify installation readiness. Fixed merchandising, settlement and driver/default expectations remain explicit unresolved dispositions rather than newly declared universal defaults. The separate managed-authority decision is still held. Failed reviews and stale candidates refuse admission; repair requires new independent review of the final committed candidate.

## Simpler routes considered

Unfiltered execution with named failures is useful diagnosis but does not finish the repair. Blanket grants, fabricated historical files, silent rebaselining and omitted tests would weaken the proof. Reuse existing scanners and callers; write specifications only for shared contracts. Waves are integration checkpoints, not a requirement to create a separate PR for every slice.

## Review and plan routing

Two session-local independent planning perspectives challenged CI/neutrality and installation/adoption compatibility. The revised plan protects scanner semantics, distinguishes committed migration state from instance ownership and fixes the hosted-check sequence. This is planning evidence, not implementation or deployment approval.

The tracked `.agent-protocol.yml` references an absent template and validator. This document does not claim a native Plan Protocol pass. The maintainer explicitly authorised this public plan format for this task after the prerequisite was identified. CI, verifier and hook controls are unchanged.

Owner links: [Contributing](../../../CONTRIBUTING.md), [data and migrations](../DATA_AND_MIGRATIONS.md), [versioning](../../../.github/VERSIONING_AND_EOL.md).
