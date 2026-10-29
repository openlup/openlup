# M14 D32 — managed identity, history and privacy mapping

Status: development-preview task record; phase 2 authorized by CD-M14-19 and
the two clarifications resolved by CD-M14-21 (29 October 2026). M14/D32 remains
open. The coordinator's maintainer API/security-control read accepted staged
tree `e8d14d9c6a98fd80435ccc1f564dfb3c15681578` before DCO.

## Outcome, scope and authority

The finite outcome is an explicit managed-source to portable-target mapping of
customer/operator identity, retained history and privacy state, with a bounded
cut-over for source-keyed replay/dedupe and no secret transfer or account linking
by email alone.
Use the existing [connected restore](../../../server/adapters/postgres/connectedStoreRestore.ts)
and [identity ports](../../../packages/platform/src/identity/ports.ts), with
representative synthetic local fixtures. Preserve exact issuer/subject
provenance, contact IDs, erased/redacted values, receipts, actor distinctions,
active subscriptions and retained obligations. Reject ambiguous, incomplete or
conflicting mappings before publication.

The accountable maintainer authorized this bounded D32 item 7. Coordinator
decision CD-M14-19, under delegated master §1.0 autonomy, selects option 2 for
the **new transfer capability**: exact issuer/subject mapping, immutable opaque
history, preserved redaction/erasure, quiesced source writes before cut-over,
and explicit refusal of the whole target acquisition command surface during an
operator-declared finite drain. Afterwards commands use the target key as new;
no source secret moves. This changes no existing source command or identity verifier
behavior and accepts no regression. The reason is that a fresh installation key
cannot verify opaque source-keyed digests, while reconstructing redacted input
would violate privacy. An explicit refusal preserves the truth of the retained
history and blocks accidental duplicate effects.

The active supervisor is the single writer; the M14 coordinator owns shared
coordination. The grant covers local implementation/proof, DCO, independent native
review, push/PR/receipt and queue merge after required gates. A changed identity
or replay semantic requires an owner decision first; API/security-control changes
require the stabilized maintainer read before DCO. No release dispatch, credentials,
signed-in browser, settings, deployment, production or hosted managed source is
authorized. Objects/ACL transfer and complete connected catch-up belong to item 8.

Source base and freshly fetched instruction revision are separately recorded as
`56322b88eafa1a3518ce573e718c67ccd3631c3a` (equal at task start). Applicable rules:
[agent guide](../AGENT_GUIDE.md), [contribution instructions](../../../CONTRIBUTING.md#instruction-freshness-and-handoffs)
and [AI contribution policy](../../../.github/AI_CONTRIBUTION_POLICY.md).
The [transfer record](oss-m14-existing-store-transfer.md) and
[programme record](oss-m14-operations-portability.md) retain wider acceptance;
this task cannot narrow that denominator or certify a hosted identity provider.

## Acceptance and proof plan

1. Map verified source issuer/subject, native customer/operator references,
   identity history and privacy state through existing restore and identity
   seams. No new identity verifier, generic ETL framework or secret migration.
2. The cut-over control refuses every target acquisition command for the
   operator-declared drain, with retry-after and finite maximum; an explicit
   end or the maximum opens a new target-key namespace. It never compares a
   retained source digest under the target key.
3. Execute real PostgreSQL proofs through the mapping/restore composition for
   distinct issuers/subjects, same-email unrelated actors, collision/conflict and
   missing-evidence refusals; erased identities cannot relink or resurrect data.
4. Prove source-key replay before cut-over, target refusal during the drain,
   explicit and maximum end, and new target-key commands afterwards. Verify
   that retained opaque history, privacy state and target key stay unchanged.
5. Complete cheap contract/policy/neutrality/scanning checks, affected proofs and
   required lint; stabilize any read packet before DCO, then two fresh FULL
   reviews (one considering a simpler sufficient solution), canonical verification
   and authorized PR/queue delivery. Existing resource and retry limits apply.

The smallest adequate alternative is a fixed explicit translation feeding the
existing restore and identity owners, with one shared refusal on existing
acquisition command bindings. It avoids a source-held comparison service, new
database control table or issuer alias.

## Phase 1 semantic inventory

| Boundary | Existing meaning and consequence for mapping |
| --- | --- |
| Customer principal | [Managed verification](../../../packages/platform/src/identity/managedIdentityVerifier.ts) returns the native user UUID; [managed account links](../../../packages/platform/src/identity/managedAccountLinkStore.ts) use `clients.auth_user_id`. [Direct links](../../../packages/platform/src/identity/postgresAccountLinkStore.ts) use `clients.principal_id`. The mapping must carry an explicitly evidenced source issuer/subject and preserve `clients.id`; a UUID or matching email alone cannot supply that provenance. |
| Issuer and subject | The [frozen OIDC derivation](../../../packages/platform/src/identity/oidcPrincipal.ts) identifies the exact pair. Keeping that function and explicitly translating source references needs no algorithm change. Changing either pair member gives a different identity. Treating a new issuer/subject as the old account, preserving the raw managed UUID as an OIDC principal, or adding a login alias would change identity semantics and needs an owner decision. [Ordinary reconciliation](../../../packages/platform/src/identity/reconcileAccountForPrincipal.ts) is not an issuer-migration route. |
| Operator authority and attribution | Managed `admin_users` and direct human principals/memberships have separate [authorization owners](../IDENTITY.md#opt-in-oidc-access-tokens). Translate only evidenced human identity, role and lifecycle relationships, including invitation/audit/actor references; never infer membership from email, token roles or a machine actor. Re-keying an actor also affects request fingerprints that contain that actor ID; retained actor provenance cannot silently become a new request identity. |
| Erasure and redaction | [Direct receipts](../../../db/platform/migrations/20261018190000_identity_privacy_erasures.sql) bind contact, principal, actor and idempotency key. Translate those bindings consistently with their history, retain contributor dispositions and already-redacted values, and keep the existing receipt-based re-link refusal. [Managed privacy](../../../packages/platform/src/identity/managedPrivacy.ts) exposes neither historical receipts nor successful erasure; an export alone cannot prove that history. Missing evidence must refuse, never be replaced by invented successful erasure or reconstructed personal data. This preserves existing privacy semantics. |
| Installation key | The [qualified acquisition foundation](../../../db/platform/migrations/q2_20260816140000_acquisition_case_foundation.sql) generates one private key and computes `sha256(key || domain/payload || key)`. [Capture](../../../server/adapters/postgres/connectedStoreCapture.ts) excludes its payload, and [restore](../../../server/adapters/postgres/connectedStoreRestore.ts) preserves the independent target key tuple. Neither is a key-translation or historical-comparison capability. Keeping both contracts leaves old and new fingerprints in different domains. |
| Tester and partner commands | The foundation's submit/transition and [partner submit/transition](../../../db/platform/migrations/20260817110000_partner_acquisition_lifecycle.sql) recompute keyed command fingerprints before comparing retained receipts. Unchanged logical retries against copied receipts conflict under a fresh key. Transition fingerprints also bind actor IDs. Accepting the idempotency key alone would lose conflicting-request refusal; rewriting the stored digest requires the original canonical request, including fields not retained after redaction. |
| Dedupe and abuse windows | Tester/partner contact dedupe and requester/email quota keys use that same installation key. Copying their opaque fingerprints does not preserve future lookup: an old contact may evade dedupe and a request may get a fresh quota bucket. Recomputing only surviving contact data omits withdrawn/redacted identities and unavailable requester inputs. Resetting either meaning is a semantic change. |
| Survey and newsletter history | [Survey evidence and newsletter consent events](../../../db/platform/migrations/20260817130000_acquisition_survey_newsletter_evidence.sql) compare keyed command fingerprints; survey response evidence is keyed too. The original survey payload need not be retained. Consent recipient fingerprints, however, are unkeyed normalized-email SHA-256 and must remain unchanged with their suppression chronology; they must not be swept into a blanket re-key operation. |
| Other replay ledgers and credentials | Preserve exact domain operation/provider/outbox keys, results and conflicts through their owners. Do not change a ledger's established recognition rule or globally rewrite hashes. Sessions, challenge material, signing/provider/ingress secrets are not transferable identity/history evidence; their lifecycle disposition must be explicit. No proposed alias, key fallback, replay reset or credential import is implemented. |

The decisive gap is future comparison of opaque retained keyed values after the
key changes. Byte equality of exported history cannot prove that comparison.
The current fixed capture also refuses nonempty acquisition-private history;
expanding retained source coverage is necessary implementation work, but does
not itself solve the semantic gap or authorize a new comparison policy.

## Decision and implementation boundary

CD-M14-19 replaces the earlier options packet. CD-M14-21 fixes its operational
boundary: retained source receipts may replay under the source key before
quiescence, but the target refuses every acquisition command after cut-over until
the operator ends the declared drain or its configured maximum elapses. Then
all commands use the independent target key, with no legacy replay promise.
The refusal identifies the affected scope and retry time without echoing payload
or personal values. The host proves quiescence and cut-over; configuration alone
does not certify those events.

The previously observed acquisition command, survey and newsletter receipts are
append-only, with no expiry found in their SQL. CD-M14-21 therefore chooses a
finite operator-declared drain, bounded by an explicit configured maximum.
After cut-over the target refuses the whole acquisition command surface during
that drain, with an actionable retry-after. An operator may end it explicitly;
otherwise the maximum ends it. Subsequent commands are new under the target
key. Source receipts remain immutable history and are never re-verified. Item 8
must retain them outside the target's active keyed command/dedupe lookup tables;
putting source-keyed receipts in those tables would make a new target-key command
conflict after drain and break the selected namespace boundary.
This cut-over applies only to the new transfer capability; existing source SQL
and issuer/subject derivation do not change. The host must establish quiescence,
consistent deployment configuration and the actual cut-over instant.

Managed `admin_audit_events` has historical actor/target emails, origin, entity,
request and idempotency fields absent from the native membership audit table.
CD-M14-21 assigns full-row retention to item 8, respecting erasure/redaction.
Item 7 maps only the native revoke-audit subset, preserves a stable source-row
reference and refuses publication on mapped-field conflict. The native subset
cannot certify item 8's full archive; the host must retain it before activation.

## Execution, handoff and self-retro

Dedicated branch: `codex/oss-m14-identity-mapping`. Initial `npm ci` completed.
Main `92cc5e17ae2c7b28b25ed5c1f2843d5f3373331d` was merged first as
signed-off commit `ee2c7cecb66f07457f6b8381d4c4d8c00b0ff0f9` before
phase 2 changes. The current instruction pin is
`e5ba63ab1e77643968d79ec0c37e3bfdbea8d90a`, separately from the prior
review base `92cc5e17ae2c7b28b25ed5c1f2843d5f3373331d`. That main
revision changed `CONTRIBUTING.md`, so native carry-over failed and the active
supervisor merged it before another full review. The coordinator accepted the
first API/security-control read of tree `e8d14d9c` and the second read of
repair tree `7a84048e` before their DCO commits. Native cycle 1 and two
completed, non-passing candidate evaluations are retained. No queue retry has
been consumed. Canonical verification, PR, receipt and queue remain outstanding.

Working checks on the current cut-over/audit source: the selected real-PG suite
passed five of five cases, including source replay, target drain refusal with no
command write, explicit and maximum drain ends, new target-key command,
audit-subset conflicts and preserved erasure. The two affected BFF suites passed
eight of eight tests. Test TypeScript, ast-grep, publication policy, inventory,
both neutrality checks, redacted Gitleaks history and staged diff, and final
lint passed (0 errors, 33 existing warnings). The shared load gate delayed lint
while another M14 supervisor's canonical verification rerun was active; it did
not authorize concurrent heavy stages. The tree has no final stamp.

Phase 1 self-retro: tracing future keyed lookup, rather than only exported row
equality, exposed the owner dependency before migrations, fixtures or broad
verification. The sufficient simplification was a source-only semantic
assessment; no comparison service, alias registry or replay fallback was added.
Phase 2 self-retro so far: JSON row sorting made a position-based test candidate
select the erased rather than linked customer, producing one avoidable failed
run. Selecting by explicit managed ID fixed the assertion and passed in real PG.
The simpler check is to assert source identity by key whenever a snapshot is
sorted; no new harness or helper is warranted. CD-M14-21 resolved the two
behavior choices through the existing BFF command paths and one shared finite
configuration check, without a service or audit archive table in item 7. The
source-audit UUID serves as the native row ID and explicit source reference;
item 8 still owns full-row retention. No delivery qualification is claimed
before read, review and final verification.

Initial native review found two mapped-state conflicts in the accepted API:
`D32-AUDIT-REVOKER-CONFLICT` (membership revoker differed from audit actor)
and `B1` (an erased operator could retain active membership and live email).
The first repair compares the revoker fields and requires erased operators to
be revoked, redacted and reason-free; a redacted operator without a receipt also
refuses. The real-PG fixture now proves those refusals and the valid redacted
operator mapping. Its first run failed because a test helper looked only at the
compatible table list; it now reads the existing owned list too, and the suite
passes 5/5. These repairs enforce the accepted conflict and erasure criteria;
they add no new transfer semantics or control. Final native review and the
canonical gate remain outstanding.

Regroup after two completed candidate evaluations (initial tree `e8d14d9c`
and repair tree `d40cda5e`): the same approved outcome still has three material
gaps. The first two conflict/erasure findings closed on the repair tree, but
review then found a future drain start extending refusal beyond its maximum,
partner transition authorizing before drain refusal, and extra erasure receipt
fields being silently dropped. The cause is incomplete edge validation at the
three existing boundaries, not missing transfer machinery. The simpler route is
to reject a future start as invalid target configuration, move the one transition
guard ahead of authorization, and require the exact supported receipt fields.
The next discriminating step is a focused BFF test and real-PG projection test:
they must show invalid future-start refusal, no auth/port call during drain, and
unknown receipt-field refusal without altering valid redacted mapping. Lesson:
boundary edge gaps in a fixed mapper/control → validate the existing input and
ordering directly before adding another mechanism.

The second repair applies those three checks at the existing seams. The affected
BFF suites pass 9/9 and the real-PG connected transfer suite passes 5/5 on the
working tree. A future start is an invalid serving-target configuration, so it
fails closed with an operator action instead of claiming a drain longer than
its configured maximum. New native review and final verification remain due.
