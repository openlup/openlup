# Personal data

Use personal-data operations to export a person’s data and apply each owner’s
erasure or retention decision. Coverage and retained obligations tell you what
completion means for that subject.

[Identity](identity.md) explains contacts, authenticated principals and their
persisted links.

## Personal-data coverage

Identity's personal data includes the contact profile, principal email,
membership, invitations and their identity-owned audit history. Exports resolve
a contact or principal UUID through persisted links, never by email. Identity
exports omit opaque contact payloads and mark their fields unavailable; they
exclude challenge hashes, credentials, provider tokens and provider metadata.
Managed export additionally reports country, audit history, invitation history
and erasure receipts as unavailable.

`createPersonalDataContributorRegistry` requires explicit contributor IDs,
versions and owned resources. Each contributor describes its export coverage
and its erase, retain or unresolved obligations. Duplicate IDs refuse with
`PRIVACY_CONTRIBUTOR_DUPLICATE`. Export reports missing host-only contributors.
Erasure refuses when a required owner or the identity owner is absent. A
successful export is only as complete as its reported coverage.

Register the owners of the features your application uses. Account-event
payloads require the `account-support` contributor and an explicit retention
decision; clearing the contact profile does not clear that ledger. Native
billing data requires `customer-billing`: editable billing profiles erase while
frozen invoice buyer components remain under invoice retention. Native parcel
preparation requires `fulfillment-parcel-contacts`: private parcel and order contacts and retained correction responses
erase while payload-free erasure markers remain. A composed `risk` contributor
exports declared resources and retains facts only under an explicit policy;
missing policy or ownership blocks erasure. These obligations do not disappear
when identity erasure succeeds.

Compose `createPostgresPrivacyUnitOfWork`, `createPostgresPrivacyStore` and
`createIdentityPersonalDataContributor` on the same executor as domain vetoes;
`createPrivacyOperations` assembles the operations. Managed export uses
`createManagedPrivacyStore` with the application's structural service client.
Browser request, contributor-document and receipt shapes come from
`@openlup/platform/identity/contracts`.

### Upgrade native privacy operations

**Trust boundary.** The runtime login is the privacy authority in the database.
The HTTP handler authorizes the human administrator. The occurrence privacy
helper answers only for the requested subject. The function owner and `service_role`,
when present, can call it directly. A direct SQL call without `EXECUTE` gets a database
permission error (`42501`). On the paired native catalogue, a fresh mounted occurrence
assessment fails closed with `PRIVACY_ASSESSMENT_UNAVAILABLE` if the effective runtime
role lacks helper `EXECUTE`. The subscription veto and qualified receipt replay are
decided first and keep their own results.

Apply the complete native catalogue for the selected rollout. The installation
owner declares required contributor IDs in the same ordered forward as the owner
feature. The runtime can execute the declaration reader. Each admitted operation
reads the current set once inside its transaction.
Register working owners for every installed ID, including saved addresses,
preferences and tax evaluations in the reference composition. Keep an ID declared while its
scoped evidence remains.

Native store wrappers implement `NativePrivacyStore` and forward
`readRequiredContributorIds` and `findErasureReplay` on the held transaction.
Forward the original receipt and its covered contributor IDs. Receipt coverage
includes recognized IDs regardless of their historical versions and approvals
bound to that receipt. Inject the instance
returned by the serving module's `createPrivacyOperations` into the reference
host. Use `decoratePrivacyRoute` to wrap each guarded handler with host request
scope or lifecycle logic. Probe both operations on the exact serving build
through isolated candidate routing.

Before reopening ordinary native privacy traffic, verify all three conditions.

1. Every serving revision includes the installed-owner gate and both parts of the receipt-coverage release.
2. The complete selected catalogue includes `20261127120002_identity_privacy_erasure_reconciliations.sql`.
3. The per-store cutover is verified.

Keep the fence in place whenever a serving revision lacks either receipt-coverage part.

Native export and erasure return HTTP 503 when a declared owner is absent or
the binding, declaration or authoritative receipt evidence cannot be verified.
A matching erasure receipt that lacks required coverage returns HTTP 503 with
`PRIVACY_RECEIPT_COVERAGE_INCOMPLETE`. Update strict clients to accept
`observed`, `cause`, `fix` and `recheck` alongside `privacyCode` in `error.details`.
Direct callers receive the same four strings in `PrivacyRefusal.facts`. Follow
the fix and retry the original request. Keep new owner writers dormant through
the cutover.

Require `customer-billing` even when no invoice reader is selected: native
first-duty capture can freeze buyer components, including shipping fallback.
Account-event exports include owned ledger payloads and report unavailable
access; an absent retention decision refuses erasure. Parcel-contact export
includes corrected order contacts, retained correction responses and erasure markers and their pseudonymous retention disposition. Erased
parcel contacts cannot be reconstructed by preparation or legacy inference;
replacement resolution refuses them as invalid frozen contacts. The explicit authorized native shipment projection exposes its contact comparison;
customer reads and dispatch evidence do not expose those private snapshots. A risk contributor declares assessment/evidence/hash, blocklist, review/hold,
case-event and replay obligations through supplied read/policy ports; it adds
no retention period or remote-provider operation.

### Rehearse native privacy cutover for each store

1. List every public and private ingress for export and erasure, including the
   catch-all dispatcher, direct route wrappers, package callers, adopter jobs
   and retry intake. Record which revisions and runtime logins serve each path.
   Deny both HTTP routes in the host's deployment route policy, pause direct
   intake and retries, and keep new owner writers dormant.
   The reference wrappers are `api/bff/[...path].ts` and the two routes under
   `server/bff/admin/identity/privacy/`.
   See [the reference runtime policy](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/docs/platform/RUNTIME_AND_SELF_HOSTING.md#runtime-model)
   and the `#deployment-route-policy` binding.
2. Drain admitted requests and retry work. Check the admission counters and
   database sessions and transactions against the ingress census. Record zero
   outstanding work on old revisions, retire those revisions and verify routing
   excludes them. Keep the fence engaged through verification.
3. Apply the complete selected catalogue, including
   `db/platform/migrations/20261127120002_identity_privacy_erasure_reconciliations.sql`.
   Take a read-only, repeatable-read capture and restore it to a pristine
   disposable installation of the same profile and exact current catalogue.
   Use connected-store transfer where admitted. Its restore takes the migration
   advisory lock and locks the relation census before copying retained rows.
   For capture, the authorized restricted migrator uses the host's owner window
   when needed. Verify the sealed role graph after the window closes.
   See [connected-store transfer](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/docs/platform/migrations/compatible-data-transfer.md#compatible-data-transfer).
   The source entry points are `captureConnectedNativeStore` in
   `server/adapters/postgres/connectedStoreCapture.ts` and
   `restoreConnectedNativeStore` in `server/adapters/postgres/connectedStoreRestore.ts`.
   For qualified-admin installations, restore opens the restricted owner window itself.

   For a legacy installation or any profile where connected capture refuses,
   use an owner-managed PostgreSQL backup and restore to an isolated target.
   If a logical schema restore changes catalogue metadata, prepare the exact
   installed catalogue on the target and restore the complete backed-up data into it.
   Verify the same profile, exact catalogue inventory and runtime roles,
   including grants. Keep the fence engaged if neither path can produce an
   exact isolated copy. Disconnect the target from live routing, workers,
   dispatch and provider I/O.
4. On the isolated restore, use the exact proposed artifact and runtime role
   for each serving revision. Exercise both operations through every applicable
   ingress. Verify export and fresh erasure, a missing declared owner, and an
   unavailable prerequisite. Use a synthetic subject with an uncovered
   historical receipt. Supply fault inputs through the isolated composition
   or role grants. Keep the installed tax contributor key if fixture seeding
   goes through the fresh-receipt insert guard. Record redacted results.

   The uncovered request passes only with HTTP 503 and
   `error.details.privacyCode = PRIVACY_RECEIPT_COVERAGE_INCOMPLETE`, or the
   equivalent typed refusal for direct package intake. HTTP 200 with
   `ALREADY_ERASED` and all other results block reopening. Follow
   [the owner reconciliation procedure](#reconcile-coverage-of-a-native-erasure-receipt)
   on the restore. Retry the original subject and key and require HTTP 200
   with `ALREADY_ERASED` for the same receipt and obligations, or the same
   result from the package operation. Dispose of the target and temporary
   capture under the installation owner's custody.
5. On the live store, compare the artifact digest of every serving revision
   with the tested digest. Run read-only checks for the route and retry census,
   runtime role, catalogue identity, readiness and drain. Record the store and
   profile, applied forward and catalogue, capture and restore evidence,
   tested and live digests, runtime role, ingress and worker census, drain
   observations, redacted probe results and owner approval. Issue the reopen
   record only after every check and probe passes. Keep new owner features
   dormant until their own activation checks also pass.

#### Roll back native privacy serving

Refence and drain every ingress before routing to older revisions, and before
appending a declared owner while an older snapshot can survive. Retain the
installed declaration and required evidence. Keep newer owner writers dormant.
Verify the rollback routing and remain fenced while any serving revision lacks
the installed-owner gate or either receipt-coverage part. Repeat the cutover
checks and renew the store's approval before reopening.

## Export and erasure

For native tax evaluation, add `createTaxCalculationPrivacyContributor()` from
`@openlup/platform/identity` to the privacy registry and require
`tax-calculations` on every handler, including during issuance rollback.
Enable evaluation writes only after every native privacy handler that serves
the store includes the tax-calculation contributor.
Export includes verified evaluation outcomes. Erasure keeps only an evaluation
identifier and any pseudonymous marker needed to fence provider reference reuse.

The reference host exposes `POST /api/bff/admin/identity/privacy/export` and
`POST /api/bff/admin/identity/privacy/erase`. Both require the application's
deployment route policy under `mutation` risk; the public default returns HTTP
503 with reason `adopter_policy_required` before processing the operation.

`exportPersonalData` and `erasePersonalData` run through an injected unit of
work, registry and store. Their callers must supply an authorized human
administrator. The HTTP handlers independently require active admin
authorization and an explicitly human actor; distributor and machine actors
receive `FORBIDDEN`. Responses use `Cache-Control: no-store`. Named operation
refusals appear in `error.details.privacyCode`.

Direct erasure assesses every contributor before mutation. Missing ownership of
a populated opaque contact field returns `PRIVACY_OWNERSHIP_UNDECLARED`; declare
its owner, resource and retention disposition through `IdentityPrivacyPolicy`.
The reference subscriptions contributor holds its assessment through commit:
active subscriptions return `PRIVACY_ACTIVE_SUBSCRIPTION`, paused subscriptions
return `PRIVACY_RESUMABLE_SUBSCRIPTION`, and unknown states or failed reads
refuse with `PRIVACY_ASSESSMENT_UNAVAILABLE`. It never cancels subscriptions.

Direct identity erasure preserves contact and principal rows and the contact ID.
It replaces their emails with a reserved `erased+…@identity.invalid` pseudonym,
clears the contact's name, phone and country, and removes its direct principal
link without changing `auth_user_id`. It deletes customer and operator
challenges and unaccepted invitations, redacts retained invitation email
snapshots and identity audit free text, and revokes active membership through
the guarded revocation operation. Self-erasure of the acting administrator,
machine targets and protected last-administrator revocation refuse with
`PRIVACY_PROTECTED_OPERATOR`.

Cleanup and the receipt commit atomically. Failed writes roll back. The receipt
records contributor versions and dispositions without storing the personal
export. A lost-response retry returns the original receipt with
`ALREADY_ERASED`; reusing an idempotency key for another subject returns
`PRIVACY_IDEMPOTENCY_CONFLICT`. Unsafe effective browser-role or public receipt
access returns `PRIVACY_STORE_PRIVILEGES_UNSAFE`. Retained references and audit
receipts are pseudonymous; completion does not assert anonymization.

Use the package customer challenge adapter and account-link store to preserve
receipt checks against erased subjects. Their transaction locks serialize with
erasure. Calling raw `customer_identity_challenge_issue` or
`customer_identity_challenge_redeem` functions bypasses the adapter's receipt
fence. Erased principals cannot accept or receive invitations through the
direct lifecycle.

Managed erasure returns `MANAGED_PRIVACY_ERASURE_UNAVAILABLE` before local or
provider mutation. A managed application needs its own erasure path; the shipped
managed store supplies export only. No authentication-provider deletion is
composed. Consent, marketing audiences, order snapshots, invoices, subscriptions
and remote processors retain their own export, retention and deletion duties.
An `ERASED` identity receipt does not mean all platform data has been deleted.

Already-issued customer tokens can remain cryptographically valid until expiry.
The direct session binding allows a lifetime within its configured range; see
the [maintainer token limits](https://github.com/openlup/openlup/blob/openlup-core-v1.3.0/docs/platform/IDENTITY.md#admin-operations-and-token-limits)
for the default and accepted range.
After its link is cleared, customer `me` returns HTTP 403 /
`FORBIDDEN` with “No customer account linked to this session.” Operator
membership revocation likewise denies authorization without claiming immediate
cryptographic token revocation.

The host also injects the clock and ID source. Subject UUIDs and idempotency keys
normalize hexadecimal case. Erasure never rediscovers an unrelated principal
through the erased email. Redacting an already revoked membership reason does
not create another revocation or change its role/state.

After policy admission, HTTP refusals use 401 for missing sessions, 403 for
distributor/machine actors, 404 for missing subjects, 409 for subscription,
protected-operator or replay conflicts, and 503 for missing capability,
ownership, contributor or assessment. Failures return neither partial exports
nor adapter diagnostics. `createPrivacyExportHandler` and
`createPrivacyEraseHandler` preserve these envelopes. Any future authentication
provider erasure must disable the identity only after local cleanup commits.

The reference Settings privacy panel accepts a contact/principal UUID, shows
coverage, obligations, refusals and receipts, and requires erasure confirmation.
Starting an export clears the previous report, its heading and the last error.
Only a fresh success for the current subject and session displays a report.
Governed refusals show Observed, Cause, Fix and Recheck. Recognized code-only
refusals show their code. Other failures show “Privacy operation unavailable”.
Reports, receipts, confirmation and retry keys stay in component memory and
clear on subject or session change. Late responses from an earlier subject or
session are discarded. Exports never enter browser storage.

### Reconcile coverage of a native erasure receipt

The installation owner verifies the contributor owner's approval against the
selected store, original receipt subject and missing contributor. Keep the
original approval under local custody and assign it one UUID. Open a separate
owner session using the selected installation's owner login, including on a
single-login store. For a restricted installation, use the authorized migrator.
If the contributor needs additional owner privileges, use the host's existing
owner window and verify the sealed role graph after closing the window.

Hosts must call `reconcilePostgresPrivacyErasure` only from an owner session
and never expose it through an HTTP handler or adopter `PrivacyOperations`.

From the owner session, call `reconcilePostgresPrivacyErasure` from
`@openlup/platform/identity` with the store's owner `unitOfWork`, native
contributor `registry` and current human administrator `actor`. Pass
`{ erasure_id, contributor_id, evidence_ref }` as the second argument. The
operation commits the selected contributor's disposition with the approval
binding. Repeating the same binding returns `null`. If the binding is refused
as `PRIVACY_RECONCILIATION_APPROVAL_UNVERIFIED`, verify the original approval
in owner custody. Close the owner session and retry the original erasure
request once its required coverage is complete. Keep retained obligations
from reconciliation with the owner approval, while replay preserves the
original receipt and its obligations.

### Native coverage gaps

The shipped native export does not yet include personal data from
`account-support` account events, risk, marketing, or native acquisition evidence.
The shipped native erasure operation does not yet handle that data.

If you use these modules on native, you must handle access and erasure requests
for that data outside the shipped operations. As the data controller, you must
decide the legal basis and retention for that data. Coverage is planned.
