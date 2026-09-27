# Managed installation and access proofs

Status: approved invariants and acceptance; unresolved authority and existing-history choices require measured proposals before implementation.
Audience: contributors maintaining disposable managed-Supabase CI and the subscription reference.
Scope: these public callers, not a universal migration service or portable-database certification.

## Goal

CI and reference installation must state which authority model they prove. An instance ownership marker does not prove which forwards committed. Textual SQL inspection does not prove effective access.

## First measure the current callers

Read installation administrator, object owners, role attributes/membership, default ACL, PUBLIC access, RLS/bypass, SECURITY DEFINER owner/configuration and extension namespace after each current replay. Relate them to shipped callers and public owner documentation.

Produce a concrete object→caller→role→operation map with positive and negative obligations. If the public contract does not determine the correct authority profile, present the smallest proposed profile for maintainer decision. Do not select one by counting green tests. Keep the closed-default audit's discovered obligations visible.

Inspect the pinned CLI's actual history mechanism before designing applied-state storage. Manual baseline replay does not itself establish a digest-bound history. Table existence or a sealed local marker is not a substitute.

## Fresh installation

Select the immutable baseline and strictly ordered managed forwards. Verify the tracked candidate's identities; an immutable-release rehearsal additionally authenticates release inventory and blob digests. Local tree proof does not claim release authentication. Missing files, duplicate/malformed versions, changed history and order mismatch refuse.

A fresh owned disposable database may apply the complete selected chain transactionally under the accepted authority profile. Keep lifecycle, credentials, fixtures and teardown in their current callers; share only bounded inventory/application and authority mechanics where useful.

Test helpers receive only the rights required for assertions. They must not create a missing platform RPC or grant the application the privilege under test. Behaviour fixtures may insert synthetic actor/provider/catalogue/control rows inside a test transaction. Required platform prerequisites need a separate bare-install witness before fixture insertion.

Verify effective ownership/access through catalog readbacks, privilege functions and actual role-taking operations. Include PUBLIC and membership inheritance, browser/service roles, distinct actors where scope matters, RLS and SECURITY DEFINER behaviour. Static helpers remain structural/body checks. Every replaced assertion requires an equivalent executable witness; missing capability remains a blocker.

Fresh installation proof does not require a new durable ledger. It cannot silently convert an existing installation to the fresh authority profile.

## Existing-installation rerun and upgrade

Keep installation ownership and applied migration state independent. Before the first write, bind an owned setup to its container. A sealed setup verifies its live instance identity. Wrong directory/configuration/container/database refuses before a write.

If an existing history mechanism supports atomic identity and digest recording, reuse it. Installed versions/paths/digests must be an exact prefix of the selected chain. Apply only the missing suffix; each forward and its applied record commit atomically. A failed transaction leaves the prior prefix. Filesystem markers are reconstructible from database readback, never the sole proof of SQL commit.

If existing history cannot prove the required facts, refuse automatic legacy upgrade and prepare a bounded recovery proposal. Do not guess that a migration ran or replay all forwards. The current idempotent alignment insert does not make arbitrary future forwards idempotent. A new persistent ledger is not a test fixture and requires its own schema/release decision.

Preserve existing object owners, function security/configuration/ACL, inherited/PUBLIC rights, deliberate operator choices, subscription cycles and outstanding obligations, payment/recovery/outbox records and adopter extension objects. No writes to `app`. Authority changes require separately reviewed forwards. Never confirm delivery of an undelivered replacement.

Serialize concurrent apply to the same owned database using the existing mechanism or a bounded transaction lock; do not introduce a distributed migration service.

## Acceptance witnesses

Fresh installation: locked dependencies and pinned CLI reach all shipped pgTAP files; profile readbacks agree; bare prerequisites are independent of behaviour fixtures; effective access/refusal survives PUBLIC, membership, partial revocation and overloaded-function cases.

Existing installation: unchanged rerun, missing-suffix apply, historical digest drift, duplicate/unknown version, unavailable history, interrupted SQL, committed SQL before marker write, concurrent attempts, wrong instance identity and failed-suffix rollback. Verify existing operator and business records before and after. Unknown state means recovery-required refusal.

Rehearse authenticated previous-preview→candidate and old-code/new-schema separately from fresh fixtures. Where downgrade is unsafe, prove safe forward recovery or refusal rather than destructive down SQL.

## Concrete corrections

Write each correction's short delta contract only after caller/authority evidence exists: object/signature, before/after operations, preserved attributes, affected callers, negative tests, release admission and upgrade witnesses.

Email read access must account for sensitive extra columns and browser/DML refusal. Trigram search must preserve owner/configuration/signature/grants and avoid moving the extension. Audit invocation must resolve internal versus direct-call authority. Missing catalogue seams require a minimal public capability owner.

The current producer refuses general grants and function replacement. This specification does not admit them, broaden privileges or authorise production changes. See [data and migrations](../DATA_AND_MIGRATIONS.md), [versioning](../../../.github/VERSIONING_AND_EOL.md) and the [implementation plan](public-ci-completeness.md).
