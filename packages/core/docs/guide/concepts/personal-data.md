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
`PRIVACY_CONTRIBUTOR_DUPLICATE`. Export reports missing required contributors;
erasure refuses with `PRIVACY_CONTRIBUTOR_MISSING`. A successful export is only
as complete as its reported coverage.

Register the owners of the features your application uses. Account-event
payloads require the `account-support` contributor and an explicit retention
decision; clearing the contact profile does not clear that ledger. Native
billing data requires `customer-billing`: editable billing profiles erase while
frozen invoice buyer components remain under invoice retention. Native parcel
preparation requires `fulfillment-parcel-contacts`: private contact payloads
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

Require `customer-billing` even when no invoice reader is selected: native
first-duty capture can freeze buyer components, including shipping fallback.
Account-event exports include owned ledger payloads and report unavailable
access; an absent retention decision refuses erasure. Parcel-contact export
includes erasure markers and their pseudonymous retention disposition. Erased
parcel contacts cannot be reconstructed by preparation or legacy inference;
replacement resolution refuses them as invalid frozen contacts. Public commerce
reads and dispatch evidence do not expose those private snapshots. A risk contributor declares assessment/evidence/hash, blocklist, review/hold,
case-event and replay obligations through supplied read/policy ports; it adds
no retention period or remote-provider operation.

## Export and erasure

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
the [maintainer token limits](https://github.com/openlup/openlup/blob/openlup-core-v0.42.0/docs/platform/IDENTITY.md#admin-operations-and-token-limits)
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
Documents, confirmation and retry keys stay in component memory and clear on
subject/session change, including late responses. Exports never enter browser
storage.

