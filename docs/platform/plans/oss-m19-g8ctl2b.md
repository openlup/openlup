# Native notice-table class approval

## Outcome and scope

Add the existing checker-pinned `insertSelectTables` value to the unbound native
paid-notice slot after its reader has landed. The value is exactly
`["public.subscription_notice_refusals"]`. This separate class approval introduces
no SQL, feature binding, function inventory or forward hash. Every other registry
entry remains unchanged.

The only files are the reviewed-forward registry, this task record and its
publication-catalogue row. Reader semantics, tests, the catalog comparator,
package APIs, budgets and runtime behavior remain unchanged. The allowance is
inactive until the same forward creates its named table earlier in that file;
the existing exact-statement, role, privilege, RLS and policy restrictions remain.

## Authority and delivery boundary

Base: `e39c9786cce51dd6c4731ea08290fef6758f735e`. Local implementation,
verification and staging are authorized. The lead reads the exact staged delta
before DCO. No commit, submission, native prepare, review or release is part of
this stage. The later feature delivery remains separate.

## Acceptance and proof plan

Validate the main reader and class transition, run the requested approval APIs
and the trusted-main queue admission path, then the real-PostgreSQL native
catalog comparator. Run the full scanner set alone, lint, documentation policy,
secrets checks and the official pack. Package-byte delta must be zero.

The risk is accidentally modifying another slot, an issued binding or the
checker. Compare the complete registry before and after, require only the fixed
G8 property to differ, and retain the reader's existing refusal boundaries.
Execution results and exact identities belong in the maintainer read packet.

## Execution status

The main reader validates the staged registry. The requested generic
`changedForwardApprovals` and `assertForwardApproval` calls refuse class changes
by design, even without introduced SQL. The separate class-only
`assertCoLocatedForwardApproval` path passes. The requested guard-success
criterion therefore needs owner clarification; no checker change is proposed.

The smaller delivery route remains a registry-only approval after reader landing
and before feature SQL. Heavy qualification is held at this explicit check gap.

<!-- openlup-task-doc-impact {"unit":"configuration","doc":"docs/platform/CANONICAL_CONTRACTS.md","anchor":"#compatibility-posture","digest":"sha256-4b500db972d0f87b883184121950be49ec2d82b0bb16fa625b6a3414c8f36a84","reason":"The compatibility posture still separates class approval, installation and feature behavior from any stability promise. This change only selects the exact value already pinned and documented by main's reader on its unbound G8 slot. It changes no issued forward binding, function definition, SQL, package API, dependency or profile; feature SQL and installation proofs remain separate."} -->
