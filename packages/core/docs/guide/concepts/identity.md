# Identity

Use identity to distinguish a commerce contact from a signed-in person and to
control customer and operator access. This page explains the proof needed to
sign in, link an account and exercise an operator role.

## Contacts, principals and authority

A contact holds commerce details such as email, name and phone. A principal is
the identity authenticated by a verifier. A stored link associates the principal
with a contact; operator membership separately grants a role. Entering an email
address, creating a contact or linking a soft account does not prove mailbox
ownership or grant operator access.

The direct PostgreSQL store links customers through `clients.principal_id`.
Managed authentication uses `clients.auth_user_id`. Privacy resolution follows
that persisted link rather than joining people by equal email addresses. A
customer and an operator with the same email are not automatically the same
privacy subject.

Server composition uses `@openlup/platform/identity`; browser contracts use
`@openlup/platform/identity/contracts`. The application supplies delivery through
an email provider, credentials, routing, redirect policy and request limits.
Selecting a bundle does not supply that application policy. In the reference
host, direct operator login requires an adopter
deployment route policy: their `mutation` classification returns HTTP 503 with
reason `adopter_policy_required` under the public default, including for operator
`me`.

Supply SDK clients or loaders, feature admission, request-ID observation, rate
limits, message text, sender and deployment URLs in server composition. Factories
use the foundation BFF envelope. `IdentityJwtLibrary.jwtVerify` implementations
must accept optional `currentDate?: Date` and `clockTolerance?: number` options
and return `{ payload: IdentityJwtClaims }`; the claims shape permits additional
string-keyed claims. The package loads the injected JWT library on use.

Managed contact lookup uses an anchored, escaped `imatch` prefilter followed by
exact `email.trim().toLowerCase()` comparison, with at most ten candidates.
Soft linking selects the oldest accepted contact; reconciliation requires one
accepted contact and rejects multiple matches. A match beyond the bound is not
selected. Injected query clients must implement `filter(column, "imatch", value)`
and bounded array queries. Supply `emailTrustPolicy` on custom
`ClientAuthLinkStore` implementations. Legacy operator-role mapping belongs in
your adapter before passing the role to identity; null or unknown roles return
HTTP 403 / `FORBIDDEN` without a fallback.

## Customer sign-in and email trust

Direct customer sign-in issues an opaque challenge for an existing contact.
The package stores a token hash and delivers the token through the injected
delivery port. Redemption consumes the challenge, establishes the contact's
principal link and issues a signed session. The ordinary direct reconcile route
only reads the authenticated principal's linked profile: it cannot repair a
missing link by request or token email and returns `CONFLICT` with
`ACCOUNT_LINK_CONFLICT` when no link exists.

Managed soft-account provisioning creates an unconfirmed authentication user
with `email_confirm: false`. Customer magic links use `shouldCreateUser: false`:
the authentication service must deliver and verify first-login mail for that
existing unconfirmed user. An unknown address receives the generic accepted
response without being signed up through this path. A failed contact link keeps
the provisioned identity available for retry.

The managed verifier trusts `email_confirmed_at` from its authenticated
`getUser` result. Editable metadata such as `user_metadata.email_verified` is
not mailbox proof. Before a new email-based association, both reconciliation
and soft-account provisioning require an explicit `emailTrustPolicy`.
`createManagedEmailTrustPolicy` permits association only when automatic email
confirmation is disabled and every enabled non-email provider is explicitly
declared email-verifying. That declaration is the application's assertion about
its providers, not a platform certification.

An unsafe policy returns `EMAIL_TRUST_ENVELOPE_REFUSED`; unavailable, malformed,
missing or throwing policy bindings return `EMAIL_TRUST_SETTINGS_UNAVAILABLE`.
The reconcile handler maps these to HTTP 403 / `FORBIDDEN` and HTTP 503 /
`UPSTREAM_UNAVAILABLE`, respectively. Soft provisioning returns a non-fatal
failure without creating an identity or link; the commerce caller decides how
to continue. A matching existing link returns before the policy assessment.

The managed policy caches valid safe or unsafe settings for 60 seconds and
unavailable settings for five seconds. A failed refresh never reuses expired
trust. Configuration changes can therefore take time to affect a serving
process. `identityEmailTrustReadiness` reports a refused policy as
`OPENLUP_E_PORT_MISSING`, module `identity`, subject `emailTrustPolicy`, with the
precise email-trust code in `observation`. The reference admission helper distinguishes unsafe
settings (`unsatisfied`), unavailable settings (`unknown`) and configuration
errors (`OPENLUP_E_ENV_MISSING`).

`createVerifierResultOnlyEmailTrustPolicy()` is an explicit alternative when the
application supplies the email-verification guarantee itself. It skips settings
assessment; reconciliation still requires the verifier's `emailVerified` result.
Reconciliation refuses unverified email with `NO_VERIFIED_EMAIL`, reserved
principals with `RESERVED_PRINCIPAL_REFUSED`, mismatched linked email with
`PRINCIPAL_EMAIL_MISMATCH`, and competing links with
`EMAIL_OWNED_BY_OTHER_PRINCIPAL` or `ACCOUNT_LINK_CONFLICT`.

Checkout and paid-order retry must explicitly call the soft-account linker if
they need provisioning. It attempts creation first, recovers normalized duplicate
identities and writes the link conditionally. Existing-link replay precedes
policy assessment; failed linking retains the provisioned identity. For managed settings assessment,
`IDENTITY_EMAIL_VERIFYING_PROVIDERS` is a server-only, comma-separated declaration
with an empty default. Malformed declarations refuse configuration.

## Magic-link destinations

The customer and admin magic-link factories default to
`createMagicLinkOriginResolver`. Supply `redirectOrigins` as an ordered list of
HTTP(S) origins containing only scheme, host and optional port. Whitespace and a
root trailing slash are normalized. Credentials, other paths, queries,
fragments and backslashes refuse configuration. Every entry must be valid; the
first builds the link and later entries cannot rescue an invalid first entry.
The default resolver never derives a destination from request headers.

An empty or invalid origin list returns HTTP 503 / `UPSTREAM_UNAVAILABLE` with
reason `magic_link_origin_not_configured`, after request validation and before
client construction, quota or identity lookup, sending, or a direct customer
challenge. Even local use needs an explicit origin. An injected
`resolveOrigin(req)` overrides this default, making its policy the application's
responsibility.

Customer `returnTo` accepts only a same-origin root-relative path.
`normalizeMagicLinkReturnPath` normalizes dot segments and preserves safe query
and fragment data. It omits absolute or protocol-relative destinations,
backslashes, controls, encoded separators and nested escapes, leaving the
callback's default landing page. Application request validation can be narrower.

Origin-configuration refusal retains the 400 ms padding floor independently
of the requested identity. The host supplies callback paths. A return-path
normalization that would produce a leading `//` is omitted as unsafe.

## Operator invitations

Issuing an invitation requires an active human administrator and an allowed
target role, `admin` or `distributor`. Invitation lookup normalizes email by
trimming and lowercasing. Creating or reusing an authentication principal is
separate from granting membership; failed issuance does not delete that identity
or a customer link.

Direct invitations remain pending and confer no access. Results carry
`membershipState: "invited"`, the invitation ID and deadline, with
`INVITATION_CREATED`, `INVITATION_REISSUED` or `ALREADY_INVITED`. An identical
pending repeat preserves its attempt and sends no notification. A different
pending role returns `INVITATION_ROLE_CONFLICT`; an already active target returns
`MEMBERSHIP_ALREADY_ACTIVE`; inconsistent or erased identities return
`IDENTITY_CONFLICT`. Expired or cancelled attempts can be reissued. Direct
hosts parse the invitation lifetime before effects: the default is seven days,
with integer bounds from 60 to 2592000 seconds; invalid values throw
`operator_invitation_ttl_invalid`.

`acceptOperatorInvitation(principalId)` is a trusted server operation whose
principal must come from verified sign-in. A browser-supplied target or requested
role cannot authorize acceptance. Expiry includes equality with the deadline.
Acceptance activates membership and records the lifecycle event atomically;
active membership takes precedence over an old invitation's expiry. An accepted
attempt cannot restore revoked access.

Managed invitations instead create active native membership immediately.
`MEMBERSHIP_CREATED` and `ALREADY_ACTIVE` carry `membershipState: "active"` and
no pending deadline or invitation ID. Matching repeats and concurrent insert
losers preserve the existing role and provenance without a second notification.
Role differences return `INVITATION_ROLE_CONFLICT`; revoked members return
`MANAGED_REINVITE_UNSUPPORTED`. First entry does not activate membership, and
authentication metadata does not substitute for the active native membership.

Notification failure returns `INVITATION_NOTIFICATION_FAILED` with HTTP 503
after persistence. The direct invitation stays pending; managed membership stays
active. Retrying returns `ALREADY_INVITED` or `ALREADY_ACTIVE` without resending.
Treat the failure as a delivery problem, not as proof that membership was undone.

Compose `createDirectOperatorInvitationStore` with a parsed lifetime from
`readOperatorInvitationTtl` or `parseOperatorInvitationTtl`, and
`createDirectOperatorIdentityDirectory` for separate principal creation.
`OperatorInvitationStore` owns issue, read, acceptance and removal.
`OperatorInviteResult` distinguishes pending direct results from active managed
results; matching runtime schemas are in the server entry and browser result
types are in `identity/contracts`. Managed callers use
`createInviteAdminUserGateway().activateMembership` through
`runInviteAdminUserUseCase` and must parse structured results rather than
message-only success. Managed pending invitations and expiry are not supplied.

Successful issue returns HTTP 200 with principal ID and role; pending results
also include issue time and deadline. Role/identity conflicts, already-active
direct membership and unsupported managed reinvitation return HTTP 409.
Notification failure preserves the direct invitation ID or active managed
principal/role; the BFF envelope reports `UPSTREAM_UNAVAILABLE` with identity
code `INVITATION_NOTIFICATION_FAILED`. There is no notification-retry command
or expiry worker. Direct expiry is evaluated lazily using the database clock
and records one system audit event. Managed removal keeps self, machine-target
and last-administrator refusals; magic links require an active known role.

## Direct human login

The reference browser selects direct operator auth through
`VITE_OPERATOR_AUTH_PROVIDER_KIND=direct`; the server uses
`PLATFORM_BUNDLE=node-postgres`. An absent browser choice preserves managed auth;
other nonempty values refuse. Bundle selection alone does not enable login.
When composed, the operator login page offers an email link or pasted token;
bounded evaluation builds do not supply the admin shell.

### Challenge delivery and redemption

Direct operators use their own challenge store and session audience, separate
from customer recovery. `createOperatorSessionService` permits a challenge only
for an existing principal with active allowed membership or a live invitation
for an allowed role. Issuance creates no principal, customer or membership.
Unknown, revoked, ineligible and limited addresses receive the same
`{ accepted: true }` response with a 400 ms floor.

`createOperatorAuthHandlers` sends that response before awaiting delivery.
Custom HTTP hosts must use the service's acceptance callback for the same
ordering. Slow or failed mailbox transport therefore does not extend the
eligible response; delivery failure records only
`operator_challenge_delivery_failed`. Database and configuration failures return
`UPSTREAM_UNAVAILABLE`. Delivery must be injected: the default capture port
discards the challenge when no sink is supplied. Authentication writes require
same-origin JSON against the configured application origin.

Operator challenge tokens contain 32 random bytes encoded as base64url; only their
SHA-256 hash and normalized-email fingerprint persist. The store allows one
challenge per rolling minute and five per rolling hour per principal, including
consumed challenges. Challenges expire after ten minutes; a new request does not
invalidate other live challenges. Redemption rechecks current email and
eligibility, activates a pending invitation and consumes the challenge in one
transaction. Exactly one redemption succeeds. Active operators can sign in
again without creating another invitation or changing membership history.
Expiry, replay, changed email or lost eligibility return `UNAUTHORIZED`;
malformed request envelopes return `BAD_REQUEST`.

The browser callback consumes `/admin/auth/callback#operator_token=…`, removes
the token fragment before asynchronous work and redeems once, including repeated
component mounting. The token is 43 base64url characters. Challenge delivery and
session signing use injected structural ports; `OperatorBrowserAuthPort` and
strict challenge/session schemas are available from `identity/contracts`.

### First-administrator bootstrap

A trusted host can call `bootstrapFirstAdministrator({ email })` on
`createPostgresOperatorIdentityStore` using privileged database credentials.
Bootstrap refuses any existing human membership or invitation with
`OPERATOR_BOOTSTRAP_ALREADY_INITIALIZED`. It creates an `admin` invitation,
reusing an unambiguous principal when possible, and records a system audit event.
It issues no session or token: the first administrator must complete normal
mailbox sign-in and invitation acceptance. Bootstrap is not an HTTP or startup
operation.

The bootstrap invitation expires after seven days. Expiry does not reopen
bootstrap. Another active human administrator can reissue through the normal
invitation lifecycle; otherwise the database owner needs an audited recovery
procedure. There is no shipped bootstrap reset. Preserve principal IDs, customer
links and invitation history rather than deleting rows or changing deadlines
to repeat bootstrap.

### Sessions and authorization

Configure distinct nonempty `OPERATOR_IDENTITY_AUDIENCE` and
`CUSTOMER_IDENTITY_AUDIENCE`. The direct operator binding issues ES256 sessions
with an exact scalar operator audience and a 900-second lifetime. Verification
requires integer issue and expiry times, no future issuance and a positive
lifetime no longer than 900 seconds. Customer tokens and tokens with an audience
array cannot authenticate an operator.

Each protected human request reads current membership. Only active `admin` or
`distributor` members authorize, further restricted by the route's allowed
roles. Token roles and customer ownership confer no operator authority; a
membership-read failure does not grant access. Human authorization returns
`isMachineActor: false` and does not grant machine-only capabilities.

The reference browser adapter keeps the session in `sessionStorage`, with memory
available if storage fails. It has no refresh token. It rechecks operator `me`
when restoring a session and clears a current session on authorization denial,
expiry or sign-out. A transport outage can retain the current tab's session;
protected server requests still need live authorization.

Window focus also rechecks `me`. A denial (HTTP 401/403 or an unsupported role)
clears the current tab session; a network or upstream failure preserves it until
another check or expiry. Restoration and focus checks cannot cancel an in-flight
redemption or clear a newer session. Sign-out or a newer successful redemption
supersedes the old attempt. Pasted-token and callback login report success only
after the session and live admin-state checks finish. The browser clears its
query cache on expiry or sign-out. Customer identity and exact machine
credentials retain separate authorization.

### Retention and recovery

If signing fails after redemption, challenge consumption and membership
activation have already committed. Request another challenge; do not reverse
activation or delete an identity as compensation. A copied bearer token can
remain cryptographically valid until expiry, but membership revocation denies
subsequent operator authorization.

The operator and customer stores expose bounded `pruneChallenges` operations:
each deletes at most 500 rows whose expiry is strictly more than 24 hours old.
Recent expiry and rate-limit history remain. The application schedules cleanup;
pruning does not renew invitations.

### Installation and verification limits

Use the complete selected database catalogue, not the identity SQL projections
as an independent installation chain. Direct human login requires the operator
challenge schema; erasure and the customer challenge adapter also require
erasure receipts. Operator issuance, redemption and membership reads refuse
unsafe effective browser-role or public access to the challenge store with
`operator_challenge_store_privileges_unsafe`. Verify the installation's actual
credentials and grants; importing the API does not establish database readiness.

Personal-data export and erasure follow the persisted identity links. See
[Personal data](personal-data.md) for coverage, retention and token limits.

## Guest checkout contact resolution

`createPostgresContactClientRegistrar` resolves an unverified guest email into a
contact for an admitted purchase. `ensureContactClient` finds or creates a row
without a session or principal assignment. Keep `clientId` internal to that
purchase and never expose `created` or `linked` to the browser: they reveal
account existence. Resolving a linked contact grants no access to its profile
or past commerce data. Signed-in checkout must use the verified session's owned
contact instead.

Email is trimmed and lowercased without dot or plus-tag folding. Lookup uses
exact `lower(email)`, so a space-padded legacy row is not a canonical match.
Concurrent calls share the canonical contact, with only the insert winner
reporting `created: true`. Invalid email returns `contact_client_email_invalid`;
invalid shape, provenance or lifecycle stage returns
`contact_client_input_invalid`. Extra fields, including a principal ID or an
arbitrary metadata patch, refuse.

Optional profile defaults initialize new contacts and replace nonempty defaults
only on still-unlinked contacts. Empty, null and absent values never clear an
existing value. Optional journey input replaces `metadata.checkout` while
preserving other metadata keys. Existing unlinked rows refresh `updated_at`;
linked rows remain unchanged, including when sign-in links the row before the
guarded update. Existing acquisition source and lifecycle stage are preserved.
Journey metadata needs its own privacy disposition; it gains no automatic
retention exemption.

A matched contact or principal with an erasure receipt returns
`account_erased_refused`. Erasure frees the original email by pseudonymizing the
old contact; a later purchase at that address can create a fresh contact without
recovering the erased shell or its history. Receipts refuse the erased subject,
not every future use of its former email.

The host owns checkout admission, requester quotas, field validation, terms and
cleanup of unpurchased contacts. Contact creation and order creation are separate
transactions, so a failed order can leave an unlinked contact. The registrar
installs no public endpoint, automatic challenge delivery or marketing consent;
downstream writers still need their own authority and erasure checks.

Construct the server-only registrar with `{ connectionString }` and close its
pool with `close()`. `ensureContactClient` returns
`{ ok: true, clientId, created, linked }` or `{ ok: false, code }`; operational
errors reject and roll back. Call it at purchase submission after checkout
admission, terms, quotas and bounded request/concurrency checks, rather than
on each configurator render. An unverified buyer can enter another person's
email: the new purchase can belong to that contact without granting existing
account access.

`profileDefaults` accepts optional nullable `firstName` and `lastName` (at most
80 characters each), `phone` (64) and `country` (2). The registrar does not
normalize these values or freeze them as an order's delivery contact.
`journey` requires an `idempotencyKey` of 8–160 characters, `locale` of 1–35
and mode `one_time` or `subscription`. Its checkout metadata contains
`lastIntentIdempotencyKey`, locale, mode and `clientMatchReason` of
`client_created` or `client_match_exact_email`; absent journey preserves metadata.
Raw email is bounded to 320 characters; acquisition source is nonempty trimmed
text with a raw limit of 100; lifecycle stage is `lead`, `customer` or `inactive`.

The separate account-link lookup trims stored email and can return
`account_normalized_email_ambiguous` for a space-padded legacy row beside its
canonical peer. The email challenge can still sign in the canonical contact.
The registrar does not repair those legacy identities. Retaining journey facts
under an explicit privacy policy never reconnects a fresh contact to erased
history.

## Opt-in OIDC access tokens

`createOidcIdentityVerifier` explicitly verifies access tokens from an OpenID
Connect issuer; it does not replace the static session verifiers automatically.
Supply the host's JWT library loader and keep a verifier binding for the host's
lifetime. Import and construction do not fetch discovery or keys. The direct
reference composition requires an issuer and distinct customer and operator API
audiences. Managed composition refuses raw upstream tokens with
`OIDC_NATIVE_SESSION_REQUIRED`; use its native federated sessions and membership.

Discovery must return the exact configured issuer and a same-origin JWKS URL.
HTTPS is required except for an explicit literal-loopback test option. Tokens
need a bounded nonempty `kid`, an allowed RS256 or ES256 algorithm, a valid
signature, the exact issuer and the configured API audience. Configure API
audiences separately from relying-party client identifiers so ID tokens cannot
serve as API credentials. Customer lifetime is bounded to 3600 seconds; the
reference operator verifier requires a scalar audience and at most 900 seconds.
Integer `iat` and `exp`, no future issuance, `nbf` enforcement and zero clock
tolerance apply; equality at expiry refuses.

Only signed top-level `email` and literal boolean `email_verified: true` supply
verified email. Roles, groups and editable metadata grant no membership.
`deriveOidcPrincipalId` deterministically derives a UUID from the exact issuer
and subject pair; email, audience and signing-key changes do not change it.
With an explicit email-trust policy, normal reconciliation may create a contact
or fill an empty principal link. Ambiguous normalized email matches refuse;
existing links are never replaced and erasure receipts prevent resurrection.
Operator login never links by email or creates membership: trusted setup must
provision the derived principal and use the invitation lifecycle. Each request
still checks live active human membership and route roles.

JWKS selection admits compatible public RSA or P-256 signing keys in the
configured algorithm allowlist. Encryption keys and unsupported algorithms are
ignored; malformed sets, private key material, unusable signing parameters and
duplicate usable key IDs refuse. Token `jku` or `x5u` values never choose a
network destination.

Discovery caches for at most an hour and keys for at most five minutes; response
cache directives can shorten these bounds. `no-store` prevents reuse and
`no-cache` caps reuse at 30 seconds. Fetches reject redirects and bound both
deadline to three seconds and body size to 64 KiB. Concurrent loads coalesce.
Every key-fetch attempt
starts a 30-second refresh window, so unknown keys during that window refuse
without another fetch. A successful refresh replaces the set atomically. A
failed forced refresh may leave the old unexpired set usable until its original
expiry; expired keys are never reused after failure. A known-key signature
failure does not trigger another fetch.

`verifyToken` returns a detailed refusal from `OIDC_FAILURE_CODES`, including
`OIDC_ISSUER_MISMATCH`, `OIDC_AUDIENCE_MISMATCH`, `OIDC_TOKEN_EXPIRED` and
`OIDC_EMAIL_UNVERIFIED`. The `IdentityVerifierPort` facade returns null for
credential refusals and throws a sanitized availability error for unavailable
dependencies; HTTP handlers retain `UNAUTHORIZED` and `UPSTREAM_UNAVAILABLE`
envelopes. Readiness separately observes valid discovery and fresh loaded keys;
it does not certify an issuer's operation or the application's login flow.

For the exact callable contracts, see the
[identity API reference](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/identity.api.md)
and [browser contracts](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/identity-contracts.api.md).
The [package surface reference](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/README.md#package-surface)
owns capability maturity.

Configure `IDENTITY_OIDC_ISSUER`, `IDENTITY_OIDC_CUSTOMER_AUDIENCE` and
`IDENTITY_OIDC_OPERATOR_AUDIENCE` in the direct host. Principal derivation hashes
UTF-8 `openlup:oidc-principal:v1`, a NUL byte and `JSON.stringify([issuer, subject])`
with SHA-256, then takes 16 bytes and sets UUID version 8 and RFC variant bits.
Preserve that mapping when provisioning operator principals; existing random
operator IDs are not migrated automatically.

A signing key may omit `use` or use `sig`; an absent `alg` is inferred from key
type and curve. Certificate metadata does not affect key selection. Compact-JWS
headers and payloads must be bounded JSON objects before discovery; preliminary
algorithm/issuer rejection grants no authority before signature and claim checks.
Readiness reports discovery validity and loaded keys with check/expiry timestamps:
`ready`, transport `unknown` or invalid `unsatisfied`. Import `OIDC_FAILURE_CODES`
and `OidcFailureCode` from the server identity entry; browser contracts exclude
OIDC refusals. Detailed codes distinguish configuration, discovery and key
validity from unavailable transport/library dependencies, unknown or rate-limited
keys, issuer/audience mismatch, invalid signatures, time/lifetime and subject/email
refusals. Register verifier observations in the host's readiness composition.
