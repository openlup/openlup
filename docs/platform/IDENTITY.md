# Identity import

Status: development preview, local import candidate. These entries have not been
published or activated as an adopter contract.
Audience: contributors reviewing the identity boundary and applications composing
its factories. The owner is the identity module within `@openlup/platform`.

The identity browser profile retains an exact file inventory. Commerce contracts
and browser-safe runtime files may be admitted individually when reached by the
profile; the Node-only `@openlup/platform/commerce/server` entry remains refused.
The inventory also admits the four-file `pricing/browser` runtime closure:
`browser/index.js`, `quotePrimitives.js`, `acquisitionTermsSchemas.js` and
`contracts/acquisitionTerms.js` under the emitted pricing directory. Both browser
profile builds explicitly refuse the pricing root and commerce server entry.

## Responsibility and composition

Reference hosts can pass a candidate from
[`createReferenceIdentity`](../../server/runtime/auth/referenceIdentity.ts) to
`startPublicReferenceServer({ identity })`. Startup composes the identity
contribution and its `bff`, `data`, `kernel` and `http` dependencies under the
observed platform version. The candidate's `createRoutes(ports, env)` factory receives typed customer
verification/profile, operator authorization/actions, challenge delivery, privacy
operations and email-trust bindings. It constructs the mounted handlers from
those bindings; startup requires their callable operations, rather than accepting
placeholder objects. Admin preflight uses that same operator authorizer.
The candidate wraps its selected routes with the observed deployment policy
before admission, and dispatches that exact table without generated replacements.
No additional identity routes are mounted implicitly.
The candidate dispatcher awaits its selected preflight once before each matched
admin handler, including supplied privacy handlers, and stops on refusal. The
ambient reference dispatcher retains the three-argument
`preflightAdminBffRoute(req, res, route)` call for ordinary routes. Only its two
exact default privacy mounts defer that call to their observed mutation-policy
wrapper, so policy admission precedes privacy authentication.
Startup checks the actual mounted route functions, selected adapters and
email-trust policy before listening. It preserves the complete observed package
inventory: additional packages without composed contributions refuse admission,
as do differing set versions.
The composed environment is snapshotted. Since application handlers can also
read the process environment, startup requires the candidate, host `env` and
ambient environment to agree before listening; a different bundle or credential
configuration refuses the candidate.
Missing schema or bindings refuse; unobservable migration history or unavailable
email-trust settings report `unknown`. A failed candidate does not affect a
previous listener. Identity and the legacy whole-platform outbox admission cannot
be combined through separate startup options.

The host supplies a trusted `SchemaProbePort`, expected complete migration identity
and candidate database/configuration identity. Use core's `createSchemaProbe`
with an independent migration observer. Direct observation must validate the
complete canonical ledger and its exact prefix; managed observation must bind a
completed committed-chain replay to the owned live installation and chain digest.
Object presence alone never establishes migration history or effective grants.
Without trustworthy history, the observer returns a null version. The finite
[bundle inventories](../../server/runtime/auth/identitySchema.ts) require every
identity table, used column and exact function signature and exclude the other
bundle's private objects. Direct includes subscription veto and erasure receipts;
managed includes Auth confirmation, native membership and login quotas.
Direct contacts require `principal_id`; managed contacts require `auth_user_id`
and `created_at` for oldest-contact lookup. Invitation writes require
`identity_operator_invitations.invited_by`. Public catalogue checks parse the
shipped direct catalogue and committed managed chain independently of the
requested inventory; disposable database proofs additionally probe the installed
objects, including the managed runtime's externally owned Auth schema.

`POST /api/bff/customers/reconcile-account` selects direct linked-profile readback
on the direct bundle. It authenticates the customer and reads through that
principal's actor-scoped profile port, returning `{ accountId, created: false,
linked: false }`. Request or token email never creates or associates a contact.
Missing links return `CONFLICT` with `ACCOUNT_LINK_CONFLICT`; missing or invalid
sessions return 401. The direct route reads no managed provider settings.
For `node-supabase` and `vercel-supabase`, the route reads managed settings and
applies the email-trust policy before any email-based association.

**Migration:** the mounted route previously applied managed policy even when
`PLATFORM_BUNDLE=node-postgres`. That selection now uses direct linked-profile
readback; the route's managed policy applies only to managed bundles. Existing
direct sessions must already have a linked contact; reconciliation cannot create
or repair that link by email.

Invite and remove route factories select the direct directory and invitation
store on the direct bundle, reusing the existing invitation/removal use cases.
Live human-admin authorization and store checks remain required. The invite
factory accepts a role-notification port; without delivery, a persisted invitation
returns `INVITATION_NOTIFICATION_FAILED` and preserves the pending invitation.
Retrying an existing pending invitation returns `ALREADY_INVITED` without retrying
notification delivery.
Managed routes retain immediate active membership. All routes remain behind
`#deployment-route-policy`; public default denial precedes input or binding
construction. This startup seam adds no disposable profile, browser mount or
mailbox. Mounted fresh-install acceptance still requires application composition.


Direct PostgreSQL human operators use the dedicated operator challenge store,
not customer recovery. The browser-safe identity contracts export strict challenge
and session schemas plus `OperatorBrowserAuthPort`; the server entry exports the
operator store, session service, verifier, authorizer and HTTP handler factories.

Creating a client/contact records commerce contact data. Creating an auth user
provisions an authentication principal. Neither a typed address nor the soft-account
link proves mailbox ownership. Reconcile may mint a contact for an existing
authenticated principal; it does not mint that auth user.

Managed verification requires `Boolean(user.email_confirmed_at)` from the
provider-authenticated `getUser` result. Editable `user_metadata.email_verified`
does not qualify.
Existing confirmations are not rewritten; their historical provenance is unknown.

`reconcileAccountForPrincipal(store, input, emailTrustPolicy)` and
`createReconcileAccountHandler({ verifier, store, emailTrustPolicy })` require an
explicit policy. Matching existing principal links return before assessment.
Every email lookup, conditional link, new contact and create-conflict retry is
inside the assessed operation. Missing, malformed or throwing bindings fail
closed. Reserved principals, unverified email and mismatched existing links
retain their earlier refusals.

The managed default uses `createManagedEmailTrustPolicy` with the verifier's
configured origin and public key. It reads `/auth/v1/settings`, refuses redirects,
requires boolean `mailer_autoconfirm` and a boolean `external` map, and trusts
only disabled automatic confirmation and explicitly declared enabled non-email
providers. Unknown enabled providers also require declaration. The server-only
`IDENTITY_EMAIL_VERIFYING_PROVIDERS` is comma-separated, trimmed and lowercased;
unset/blank means an empty allowlist. Wildcards, empty entries and malformed
identifiers refuse configuration. A declaration is the adopter's assertion that
the provider verifies email, not a certification by the platform.

Valid safe or unsafe settings cache for 60 seconds; unavailable or malformed
settings cache for 5 seconds. Each immutable policy instance coalesces concurrent
requests. The deadline is 3 seconds including body consumption, limited to 64 KiB.
Every completed assessment aborts outstanding transport, including an unread
error response body.
A failed refresh never reuses expired trust. Configuration changes can therefore
take up to 60 seconds to affect admission in an already serving process.

`EMAIL_TRUST_ENVELOPE_REFUSED` maps to HTTP 403 / `FORBIDDEN`;
`EMAIL_TRUST_SETTINGS_UNAVAILABLE` maps to HTTP 503 / `UPSTREAM_UNAVAILABLE`.
The two browser-safe constants/types are exported by `identity/contracts`;
runtime schemas remain in the reference boundary. Responses expose
neutral codes, not settings bodies, tokens or another principal's identifier.

**Migration:** adopters retaining today's verifier-result rule explicitly bind
`createVerifierResultOnlyEmailTrustPolicy()`. It disables settings assessment
but still requires the verifier's `emailVerified` result. Managed reference
bindings use the stricter default. The direct bundle retains its existing
mailbox challenge and signed-session verifier (`email:null`, unverified), without
direct email reconcile or JWT email claim consumption.


The server entry is `@openlup/platform/identity`; its source is
[`packages/platform/src/identity`](../../packages/platform/src/identity/index.ts).
The separate `identity/contracts` entry contains browser value types, the customer
auth port and provider-list parser. Browser hooks, pages, environment readers,
redirect configuration or an explicit resolver override, feature flags, rate
limiting, mail transport and route observation remain application composition. The send-email hook remains in the reference
application for the communications boundary.

The module imports foundation modules only through `bff`, `data`, `http` and
`kernel` entries. Its source layout is flat except for the isolated contracts
subtree. Managed adapters accept structural clients; token adapters accept a JWT
library loader. Loading the server entry reads no environment, initializes no SDK
and executes no SQL. A host selects the adapter and supplies its configuration.

Customer reconciliation refuses a principal its verifier reports as unverified,
reserved machine principals, conflicting links and a principal/account email
mismatch. Verification is the composed verifier's decision. The managed verifier
requires `email_confirmed_at` and ignores editable `user_metadata.email_verified`.
The reference source `server/bff/customers/reconcile-account.ts` selects
actor-scoped linked-profile readback for `node-postgres`. Its managed branch
composes the managed email-trust policy; the direct branch never constructs the
managed verifier, clients or email association.
A host mounting managed reconciliation
must inject a policy as described above; confirmation alone does not establish
the installation's email-trust envelope. The token verifier reports every
principal as unverified. The engine retries the email
branch once after a concurrent create failure. The new
[`createReconcileAccountHandler`](../../packages/platform/src/identity/reconcileAccountHandler.ts)
returns those refusals as 400, 403, 409 or 503 and has no personalization hook.

Customer soft accounts provision new auth users with `email_confirm:false`.
The commerce contact and soft-account link are not mailbox proof.
`createSupabaseClientAuthLinkStore(client, emailTrustPolicy)` requires the injected
policy on `ClientAuthLinkStore`. The linker assesses it before create-first
provisioning or existing-identity lookup by email. An unsafe envelope returns
`{ ok:false, code: "EMAIL_TRUST_ENVELOPE_REFUSED", message }`; unavailable,
missing, malformed or throwing policies return `EMAIL_TRUST_SETTINGS_UNAVAILABLE`.
These are non-fatal soft-account outcomes: callers can complete commerce without
an identity link. No identity or link is created on refusal. Matching existing
links return before assessment, preserving replay without a new association.
The reference managed adapter always binds the settings-reading policy, even
when the bundle environment selects direct storage.
Customer magic links retain `shouldCreateUser:false`: first-login mailbox proof
confirms the already provisioned principal. Unknown-address login creates no user.
Neither a failed conditional link nor a failed write deletes the created identity;
a retry recovers it through the existing duplicate lookup. Existing links and
subscription references remain unchanged.

**Migration:** soft-account provisioning requires a trusted envelope: automatic
email confirmation off and all enabled non-email providers explicitly declared
email-verifying. With automatic confirmation on, anonymous signup can confirm an
existing unconfirmed user and obtain its session without mailbox proof. Bind the
policy in the managed store and expose it on custom `ClientAuthLinkStore`
implementations; an adopter may explicitly select verifier-result-only policy
when its own trust boundary supplies that guarantee. The selected Auth installation must deliver and verify first-login
mail for an existing unconfirmed user. Run the joint Auth/mail conformance command
below before adopting this behaviour. Existing users are not rewritten or
retroactively unconfirmed; no SQL projection, migration or ledger changes.

The soft-account linker attempts identity creation first, then scans the existing
directory only after an already-registered response. Both directory adapters
follow `nextPage`, compare trimmed lowercase addresses, propagate lookup failures
and refuse after 5000 scanned users. The invite use case and HTTP authorizer require active human membership. Only stored `admin` and
`distributor` roles authorize. Null and unknown roles return
`FORBIDDEN` (HTTP 403), with or without a route-specific role restriction.
The reference profile adapter returns `{ isAdmin: false, role: null }` for these
rows, and its magic-link eligibility refuses them. The magic-link handler still
records quota before eligibility and returns the padded, non-enumerating
`{ accepted: true }` response without sending. Adopters wanting legacy mapping
must perform it in their own adapter before the package receives the role;
identity exposes no fallback setting.
Invitation lookup and new identity creation use trimmed lowercase addresses;
existing durable principal, membership and customer addresses remain untouched.
Issuance requires an active human administrator. The direct lifecycle store also checks this authority inside its transaction.

Both managed contact stores find mixed-case stored addresses using the
normalized input. Literal matching means an anchored, escaped `imatch` database
prefilter followed by exact equality of `email.trim().toLowerCase()` with that
input. Escaping keeps `_`, `%`, backslash and `*` literal; the exact comparison
rejects Unicode lookalikes widened by the database's case-insensitive regex.
Each store has one private helper that selects email and fetches at most ten candidates.
Soft linking preserves ascending creation order and chooses the oldest accepted
row. Reconciliation accepts a single exact row and throws the existing
`PGRST116` multiple-row error when more than one is accepted, before any link or
create. Missing email is never accepted. A match outside the candidate bound is
not selected: soft linking can return `CLIENT_NOT_FOUND`, while reconciliation
can attempt creation and retain its existing create-failure retry/error path.
Structural clients must implement `filter(column, "imatch", value)` and bounded
array results for both lookups. Both managed bundles share these stores.
The direct challenge adapter calls `customer_identity_challenge_issue`;
its existing portable SQL already normalizes the input at line 105 and compares
`lower(email) = v_email` at line 113 of
`db/platform/migrations/20260814090000_customer_selfservice_recovery.sql`.
Direct profile reads select by principal ID, not email. No direct application SQL
needs correction, and no existing migration or package projection is changed.

Managed admin preflight re-derives machine status from the membership row and
refuses non-GET/HEAD methods unless the host's explicit write-route list permits
them. A missing method is a write. The direct bundle keeps its operator-token
exemption. The reference application supplies the characterized write-route list.

Handler factories construct the foundation BFF responder themselves. The customer
profile factory requires the host response schema, retaining its selected currency
policy without putting that policy in identity. Applications
may supply the observed request-ID reader; they do not replace the responder.
Invite/remove use cases return stable error codes. Invitation bindings expose typed conflict reasons and preserve the selected bundle result: direct pending invitations carry their deadline, while managed invitations return active membership. Receipt field mapping stays in reference composition. Mail sender and origin remain inputs to the application's mail
adapter; the package has no default sender or deployment URL.

## Magic-link redirect policy

Both `createCustomerMagicLinkHandler` and `createAdminMagicLinkHandler` default to
[`createMagicLinkOriginResolver`](../../packages/platform/src/identity/authVerifyUrl.ts).
`redirectOrigins` is an ordered allowlist of HTTP(S) scheme, host and port origins.
The first entry builds the link; subsequent entries never act as fallback for an
invalid primary. Every entry must parse as an origin without credentials, path,
query, fragment or backslash. Surrounding whitespace and a root trailing slash
are normalized. An empty list or any invalid entry refuses with
`UPSTREAM_UNAVAILABLE` / HTTP 503 and details reason
`magic_link_origin_not_configured`. This is a server configuration error, checked
after request validation and before client construction, quota calls, eligibility
lookups, OTP sending or a direct session challenge. The refusal receives the
existing 400 ms padding floor and does not depend on the requested identity.

The default resolver never reads Host, X-Forwarded-Host, Origin, Referer or
forwarded scheme headers. The reference customer binding supplies a one-origin
allowlist from nonblank `APP_BASE_URL`, falling back only when absent or blank to
`CUSTOMER_AUTH_REDIRECT_ORIGIN`. The admin binding uses `APP_BASE_URL` with
`SITE_URL` as that compatibility fallback. No new environment variable is added.
Configured origins containing a path, credentials, query or fragment must be
replaced with origins. Invalid primary values never fall through to compatibility
configuration. Local, development, preview, staging and production all require
an explicit origin; configure a loopback HTTP origin explicitly for local work.
In particular, a customer request in a labelled non-production environment with
no origin now refuses instead of mailing a forwarded-host link. Admin requests
lose the same fallback, including the implicit local-host fallback. Cases that
previously skipped sending and returned accepted for bad or missing origins now
return the configuration error before consuming quota. The direct customer
session branch also requires origin configuration before issuing a challenge.
Default static/reference route admission remains unchanged.

Customer return paths pass through
`normalizeMagicLinkReturnPath` before being put in the callback query. It accepts
root-relative same-origin paths, normalizes URL dot segments and preserves safe
query/fragment data. Absolute, protocol-relative, backslash, control-character,
encoded separator/control and nested-percent escape forms are omitted, so the
callback uses its default landing page. A normalization that produces a leading
`//` is also omitted. Application request schemas may impose narrower path rules
and still return 400 before this step. Callback paths remain host-supplied.

`resolveOrigin(req)` remains the existing explicit override: adopters can keep
passing their current resolver, and its origin policy remains theirs. Valid
configured requests retain each handler's existing quota, eligibility,
non-enumerating accepted response and padding. The neutral conformance witness is
[`authVerifyUrl.test.ts`](../../packages/platform/test/identity/authVerifyUrl.test.ts);
the reference route tests pin configuration precedence and the new refusal.

## Email-trust schema readiness
`emailTrustPolicy` is a required port. `identityEmailTrustReadiness`
returns core readiness issues with `module: "identity"`, subject
`emailTrustPolicy`, existing code `OPENLUP_E_PORT_MISSING`, and the precise
refusal in `observation`. The host helper `assessIdentityReadiness` maps safe
settings to `ready`, unsafe settings to `unsatisfied`, unavailable settings to
`unknown`, and configuration errors to `OPENLUP_E_ENV_MISSING`. These helpers
are available for host composition; `startPublicReferenceServer({ identity })`
invokes `assessIdentityReadiness` during candidate admission before listening.


## Operator invitation lifecycle

The direct bundle stores pending invitations; the managed bundle activates
membership immediately. These are distinct public contracts.

Direct issue returns HTTP 200 with `INVITATION_CREATED`, `ALREADY_INVITED` or
`INVITATION_REISSUED`, principal ID, invitation ID, `membershipState: "invited"`,
role, issue time and deadline. A repeat retains its attempt and sends no mail.
Different pending roles, active membership and inconsistent identities return
409 with `INVITATION_ROLE_CONFLICT`, `MEMBERSHIP_ALREADY_ACTIVE` or
`IDENTITY_CONFLICT`. Expired and cancelled attempts can be reissued with a new
notification ID. Notification failure returns 503 with the persisted invitation
ID; retry returns `ALREADY_INVITED` without another notification.

`OperatorInvitationStore` owns direct issue, read, acceptance and removal.
`acceptOperatorInvitation(principalId)` is a trusted server command: its principal
must come from verified sign-in, never a browser target or requested role. It
is not connected to direct machine authentication; direct human login remains
unmounted. Pending invitations confer no access. Active membership takes
precedence over expiry; an old accepted attempt cannot restore revoked access.
The direct TTL defaults to 604800 seconds, with integer bounds 60..2592000.
Direct hosts must invoke `readOperatorInvitationTtl` (or the pure
`parseOperatorInvitationTtl`) before effects and pass its result into identity;
the reference managed invite runner does not enforce this direct-only setting. Lazy expiry uses the serialized
database clock, includes equality with the deadline and records one system audit
event. No expiry job or notification retry command is added.

Direct storage uses the two additive tables in forward
`20261018120000_identity_operator_invitations`, canonical catalogue position 67.
Each command runs in one existing owner-authority PostgreSQL transaction and
serializes by normalized email. Actor and target memberships lock in principal
order before authorization, preventing reciprocal lock upgrades. Membership,
acceptance and audit commit together. Reactivation uses the existing local guard
setting, lifecycle update and separate role update. Revocation retains
`platform_revoke_human_membership` and its last-administrator guard. Principal
creation/reuse commits separately before issuance; failures retain the identity
and customer link. The forward changes no grants or policies.

Managed issue inserts an active `admin_users` membership immediately with
invitation provenance and the current acceptance timestamp. It omits
`is_machine_actor`, relying on the database's `NOT NULL DEFAULT false`.
HTTP 200 returns principal ID, role, `membershipState: "active"` and
`MEMBERSHIP_CREATED` or `ALREADY_ACTIVE`, without invitation ID or expiry fields.
An identical repeat returns existing membership without updating its role,
provenance or acceptance time and sends no second notification. A unique-key
insert race re-reads the winner instead of failing; role differences return
`INVITATION_ROLE_CONFLICT`, inconsistent identities or machine targets return
`IDENTITY_CONFLICT`, and revoked membership returns
`MANAGED_REINVITE_UNSUPPORTED` (HTTP 409).

Managed invitations store no pending, accepted, expired or cancelled attempt in
Auth metadata. Authorization and the public admin `me` route only read active
native membership; neither activates on first entry nor runs compensation.
The admin `me` route retains the `mutation` deployment-risk classification and
is refused by the default public deployment policy before membership lookup.
Neither authorization nor membership lookup requires a service key for invitation state. Managed removal retains
its actor-authenticated revocation RPC and self/machine-target and
last-administrator refusals. Magic-link eligibility requires active native
membership with a stored `admin` or `distributor` role; metadata never qualifies
an invitee. Quota, padding and the non-enumerating accepted response remain.

Failed insertion retains any provisioned identity for retry. A provider duplicate
race reuses the existing principal. When the provider rejects an already-registered
address before sending mail, the concurrent loser sends no provider invitation
mail; only the membership-insert winner sends the role notification.
Notification failure returns 503 with BFF code `UPSTREAM_UNAVAILABLE` and
`error.details` containing `identityCode: "INVITATION_NOTIFICATION_FAILED"`,
`membershipState: "active"`, `principalId` and `role`; retry
returns `ALREADY_ACTIVE` without resending. No failure deletes an auth identity,
principal or customer link. Managed operators appear in the active settings list
as soon as insertion succeeds.

The reference browser validates both active managed results and complete direct
pending results, including their distinct outcome codes. Managed role mail
describes active membership without a deadline or first-entry activation copy.
Its delivery and timeline key is `admin-membership:<principalId>:<role>`;
direct mail retains its invitation-attempt key and pending deadline.

**Migration:** direct hosts adopting pending invitations apply the new direct
forward and compose trusted human acceptance and TTL parsing. Existing
memberships and customer/principal links are preserved. Managed activation stays
immediate; managed consumers now parse the active-membership result and its
`MEMBERSHIP_CREATED`/`ALREADY_ACTIVE` codes instead of message-only success.
Duplicates return existing membership instead of `ALREADY_ADDED`, and
notification failure returns 503 `INVITATION_NOTIFICATION_FAILED` with active
membership retained. Managed pending/expiry remains a compatibility gap requiring
a separate transactional store and reviewed forward. No managed SQL, RPC or
grants are introduced.
The managed chain's identity capabilities forward
`20261018160000_identity_service_role_capabilities.sql` grants `service_role`
SELECT(email) and INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) on `admin_users`. The opt-in local conformance replays
the complete committed chain with ambient default ACLs removed and adds no grant.
It proves immediate activation, repeat/concurrent recovery and revoked-member
refusal under the shipped grants. It does not establish managed/direct lifecycle
parity.
See [data compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle) and the
[package invocation](PLATFORM_PACKAGE_REFERENCE.md#operator-invitations).

## Identity migration continuity and readiness

[`IDENTITY_MIGRATIONS`](../../packages/platform/src/identity/sql.ts) records the
canonical path, SHA-256 digest and runner position of seven complete units, at
positions 11, 12, 29, 60, 67, 68 and 69, including operator challenges at 68 and
privacy erasure receipts at 69. The package SQL files retain every canonical byte.
They are a projection for inspection and host migration composition, not a
standalone chain: earlier foundation migrations and intervening units still
matter. Never apply a package projection on top of an already applied canonical
unit, change its identity or use the direct chain against a managed store.

[`createIdentityContribution`](../../packages/platform/src/identity/contribution.ts)
retains artifact kind `rail` and identifies module `identity` as a `capability`,
with its two provided entries and foundation dependencies. The host must supply
an independently identified `requiredSchema`; managed and direct stores have
different objects. This candidate does not invent one combined schema inventory.
For an explicitly supplied identity candidate, reference startup installs the
contribution through `createIdentityContribution` with the bundle-specific
`requiredSchema` selected by `createReferenceIdentity`.
It uses the readiness module field (`PackageManifest.module`) directly.

## Conformance and outstanding evidence

Native privacy and operator-upgrade fixtures select the unchanged legacy plan
through the canonical manifest reader before constructing their upgrade
prefixes. The qualified v2 catalogue therefore does not replace their issued
identity SQL, ledger positions or legacy inventory expectations.
Email-trust unit witnesses are `managedIdentityVerifier.test.ts`,
`emailTrustPolicy.test.ts`, `reconcileAccountForPrincipal.test.ts`,
`reconcileAccountHandler.test.ts` and `identityReadiness.test.ts` in the
package identity test directory. Reference bindings test policy selection,
retained reference refusals and standalone readiness assessment.

The opt-in real Auth/mail/database proof is:

```sh
node tests/postgres/runIdentityEnvelopeConformance.mjs --phase email-trust
node tests/postgres/runIdentityEnvelopeConformance.mjs --phase joint
```

It requires Node 24, npm 11.19.0, Docker with a running daemon, Supabase CLI
2.98.2, installed dependencies (including the existing SDK and TS loader), built
core/platform artifacts, the complete unchanged committed managed migration
chain, a writable temporary directory and free loopback port blocks. CLI images
must be available or downloadable in the supervisor's environment. Missing
prerequisites, startup, assertions and cleanup fail nonzero; nothing skips.

The runner reuses the pgTAP committed-chain reader and subscription configuration
and prerequisites. It starts separate owned confirmed, auto-confirm and external
provider installations with Auth, API, database and captured mail enabled, removes
inherited default grants before replay, and applies the complete committed managed
chain, including `20261018160000_identity_service_role_capabilities.sql`. That
forward supplies the service-role client creation and linking capabilities, plus
operator activation inserts and invitation email reads. The runner proves
association under the shipped grants without adding fixture-only grants.
It tests real editable metadata against cleared confirmation, auto-confirm and
undeclared-provider 403s, actual captured mailbox proof, cache expiry followed by
a settings-only loopback fault and 503, unchanged contacts on refusals, and an
existing linked subscriber preserved across the settings-failure refusal and
repeated reconciliation. Every successful handler response is followed immediately
by a database read of its returned contact ID, requiring the verified principal's
normalized email and `auth_user_id`. Both confirmed and declared-provider scenarios
also associate a pre-existing unlinked contact and require its original ID.
The subscriber fixture is inserted after committed-chain
SQL replay, before those operations. A public-catalogue fingerprint compares
public relation names and kinds before and after the envelope exercises; the
subscriber check also compares its full client and subscription rows. The stack
uses `psql` and has no CLI migration ledger. These checks establish neither
migration-ledger preservation nor subscriber survival across SQL replay.
Package handlers exercise
the precise mappings; the ordinary disposable profile's stricter earlier guard
continues to reject unsuitable installations. No OAuth request is made.
`--phase joint` additionally provisions a linked unconfirmed soft account through
the managed package adapter, observes a null confirmation timestamp in Auth,
and invokes the customer magic-link package handler with the reference route's
real clients, schemas, quota and padding. It consumes the captured local email's
actual verification link, requires confirmation of the same user, rejects replayed
and invalid verification material, and checks that provisioning replays retain
customer/auth IDs and subscription references. An unknown address receives the
same accepted response without sending mail or creating an auth user or contact.
Automatic-confirmation installations refuse soft provisioning and existing-email
linking; anonymous signup may create its own session but cannot acquire a contact
link through the refused operation.  No admin-generated
link, mocked delivery or owner-written confirmation substitutes for mailbox proof.
No CI workflow, default suite or root script activates this runner.

`server/runtime/auth/emailTrustBinding.test.ts` exercises the runner's database
assertions offline with synthetic Auth/mail responses and a contact-store fixture;
it does not replace the disposable database proof.


The repository's existing `packages/platform` required selector and Vitest node
project include `test/identity/**` without a new selector or coverage exception.
The witnesses are:

- Customer row isolation: [`identity_customer_own_rows_test.sql`](../../supabase/tests/identity_customer_own_rows_test.sql), run by the existing managed-schema pgTAP harness. It pins the reference schema's grants as they are today. Two customers each see only their own client, address, orderer profile, payment preference and account event; `authenticated` holds SELECT on those tables (on clients, column-level). The customer SELECT policies on pets, orders, order items, subscriptions, subscription lines and cycles have no `authenticated` grant behind them, so those reads are refused with SQLSTATE 42501. Anonymous reads are refused with 42501 on the customer tables and return zero rows on the three subscription tables, which hold a seeded row per customer.
- Admin authorization: [`adminConformance.test.ts`](../../packages/platform/test/identity/adminConformance.test.ts), using the real authorizer at invite/remove HTTP gates. The invite/remove matrix includes two additive refusal rows: an active member with a null role and an active member with an unknown role each receive 403 before either action. The witness also pins those refusals with or without a role restriction; the invite use case also requires active human membership.
- Directory lookup: [`inviteLookupConformance.test.ts`](../../packages/platform/test/identity/inviteLookupConformance.test.ts), covering pagination, normalization, cap, errors, effect ordering and normalized invitation lookup without membership insertion.
- Soft-account provisioning: [`managedClientAuthLink.test.ts`](../../packages/platform/test/identity/managedClientAuthLink.test.ts) covers unconfirmed creation, create-first duplicate recovery, conditional linking that preserves competing and unrelated contacts, link failures without identity deletion and retries. [`customerMagicLinkHandler.test.ts`](../../packages/platform/test/identity/customerMagicLinkHandler.test.ts) pins existing-user-only sending, padding and the same accepted response for send success, unknown identity and transport failure.
- Contact matching: [`softLinkConformance.test.ts`](../../packages/platform/test/identity/softLinkConformance.test.ts) exercises both actual managed stores through soft linking and reconciliation with mixed-case rows, literal-match refusals, explicitly returned dotless-i and long-s lookalikes, oldest exact selection and multiple-exact-row refusal. The imported [`managedAccountLinkStore.test.ts`](../../packages/platform/test/identity/managedAccountLinkStore.test.ts) query fixture supports `imatch` filtering and the bounded array lookup.
- The imported engine, profile, session and adapter tests sit beside these witnesses; [`sql.test.ts`](../../packages/platform/test/identity/sql.test.ts) verifies canonical projection identity.

The browser runtime-schema move remains pending: the existing schemas use Zod,
but the contracts boundary admits only own-contract files and public core entries.
This candidate retains those runtime schemas in the reference application rather
than weakening that boundary. Completing that move needs an explicit boundary
choice. Reference identity candidates select a concrete managed or direct schema
inventory through `identityRequiredSchema` and check it during startup admission.

## Source move map

Paths below the package column are relative to `packages/platform/src/identity/`.
The table records where each source came from. A former server path that only
re-exported the package and was imported only by identity code has been removed;
those importers use `@openlup/platform/identity` directly. Three type and adapter
re-exports stay while other modules still import them:
`server/domains/platform/adminAuth.ts`, `server/domains/customers/customerAuth.ts`
and `server/adapters/supabase/customerMe.ts`. They go when those modules move onto
the identity entry. Former paths that still compose application policy, and the
documented browser compatibility files under `src/domains/auth/`, remain;
application composition stays at the original route/runtime paths.

| Former source | Package source |
| --- | --- |
| `src/domains/auth/{types,ports,providerList}.ts` | `contracts/{types,ports,providerList}.ts` |
| `src/domains/auth/contracts.ts` | DTOs in `contracts/contracts.ts`; runtime schemas still pending |
| `server/domains/auth/{ports,reconcileAccountForPrincipal,authVerifyUrl}.ts` | `{ports,reconcileAccountForPrincipal,authVerifyUrl}.ts`; email-hook ports stay in the application |
| `server/domains/platform/{inviteAdminUserUseCase,removeAdminUserUseCase,adminAuth}.ts` | `{inviteAdminUserUseCase,removeAdminUserUseCase,platformAdminAuth}.ts` |
| `server/_lib/admin-domain/auth.ts` | `adminAuthorization.ts`, `machineActorWriteFence.ts`; route lists, environment and SDK factories stay in composition |
| `server/_lib/customer-domain/auth.ts` | `customerAuthorization.ts`; client constructors stay in composition |
| `server/runtime/auth/adminAuthBinding.ts` | `adminAuthBinding.ts`, `adminPreflight.ts`; operator-store composition stays in the application |
| `server/runtime/customers/{customerIdentityBinding,customerSessionBinding}.ts` | `{customerIdentityBinding,customerSessionBinding}.ts` |
| `server/adapters/supabase/{identityVerifier,accountLinkStore,adminAuthVerifier,customerMe}.ts` | `{managedIdentityVerifier,managedAccountLinkStore,managedAdminAuthVerifier,managedCustomerMe}.ts` |
| `server/adapters/supabase/adminUserActionPort.ts` | `managedAdminUserGateways.ts`, `adminUserActionPorts.ts`; sender, origin, mail transport and receipt mapping stay in the application |
| `server/adapters/supabase/clients/clientAuthLink.ts` | `managedClientAuthLink.ts`; operator email-correction composition stays in the application |
| `server/adapters/jwt/{customerIdentityVerifier,customerSessionIssuer}.ts` | `{customerIdentityVerifier,customerSessionIssuer}.ts`, with `jwtLibrary.ts` for host injection |
| Former platform adapter `operatorTokenAdminAuth.ts` | `operatorTokenAdminAuth.ts` |
| `server/adapters/postgres/{customerRecovery,customerMe}.ts` | `{postgresCustomerRecovery,postgresCustomerMe}.ts`; communication preferences stay in the application |
| `server/domains/customers/{customerAuth,customerMeHandler}.ts` | `{customerAuth,customerMeHandler}.ts`, with local profile contracts and ports |
| Customer magic-link and verify-OTP route bodies | `customerMagicLinkHandler.ts`, `customerVerifyOtpHandler.ts` |
| Admin magic-link, me and user-action route engines, formerly in `server/domains/platform/{adminMeHandler,adminSettingsHandlers}.ts` | `adminMagicLinkHandler.ts`, `adminMeHandler.ts`, `adminUserHandlers.ts` |
| New neutral reconcile-account engine | `reconcileAccountHandler.ts`, composed by `server/bff/customers/reconcile-account.ts`; no default route-table activation |
| Existing identity unit tests | `packages/platform/test/identity/*.test.ts`; mixed application-composition tests remain by their bindings |

## Observable reference differences
Managed verification requires confirmation, adds managed settings reads
with bounded latency and process caching, and introduces the two 403/503
association refusals and browser error codes. The managed Node subscription
candidate retains its existing startup admission without an explicitly supplied
identity candidate; supplying one adds identity and email-trust readiness checks
before listening. The new server-only
provider allowlist defaults to empty. The captured reconcile route retains its
generic 403 response for policy refusals and its empty provider allowlist.
The captured profile retains its stricter
installation guard and can return its generic 503 before the package gate.
Existing matching links and sessions survive envelope refusal. No route is
newly mounted or historical identity/link rewritten by the email-trust policy.
Customer soft-account creation now leaves the auth user unconfirmed; first login
through the existing customer magic-link path confirms that same user after
mailbox proof. The linker now returns a stable non-fatal refusal before provisioning or linking
by email when the envelope is unsafe or unavailable. The reference store reads
managed settings regardless of the bundle environment. Matching existing links
and subscription IDs remain unchanged. This tree contains no checkout or paid-order
retry caller of the linker; those commerce integrations require adopter composition. Existing-user-only login, non-enumerating responses and
padding remain unchanged.


The import intentionally brings in create-first identity resolution, the paged
normalized invite lookup and the managed machine-write fence. The first two
change provider-call order and which existing identity is found; lookup errors
now propagate instead of being ignored by the old invite gateway. A directory
cap can surface `Error: auth_user_lookup_cap_exceeded`; an already-registered
identity that cannot be found throws `auth_user_registered_but_unresolved`.
Managed machine writes outside the supplied allowlist now return 403 with
`Human operator required` and `machine_actor_write_refused`. Direct operator
writes retain their exemption.

Managed contact linking discards regex-only Unicode lookalikes. When an older
lookalike and an exact normalized contact are returned together, soft linking
selects the oldest exact contact. A lone lookalike now produces
`CLIENT_NOT_FOUND` for soft linking; reconciliation follows its existing
no-contact creation path. Multiple exact reconciliation candidates still raise
a lookup error, surfaced by the managed reconcile handler as
`Account reconciliation failed`. Both managed lookups stop at ten candidates.

Managed invitation responses now expose active membership and explicit 409
identity reasons. The new direct responses include pending lifecycle fields and deadlines.
Notification receipts retain their reference field names; identical repeats send
no further mail. Node bindings retain package result codes. A new identity gets
the provider invitation before membership insertion; failed writes retain that
identity. Sender, base URL and request-ID selection stay in application composition.
Managed authorization, removal and the public admin profile source keep their
actor bindings; no service binding for lifecycle metadata is introduced. Operators enter the active settings
list immediately; first entry does not activate or compensate membership.
The managed reconcile branch can answer the two email-trust policy refusal codes and
the original five domain refusal codes as messages,
plus `Customer session required` and `Account reconciliation failed`.
These endpoint-source outcomes do not activate a route.

## Direct human login

Select `PLATFORM_BUNDLE=node-postgres` on the server and
`VITE_OPERATOR_AUTH_PROVIDER_KIND=direct` in the application browser build. Its
composition root passes that configured value to `AuthProvider` as `providerKind`.
Absence preserves managed authentication; other nonempty values refuse.
The reference dispatcher mounts `POST /api/bff/admin/platform/magic-link`,
`POST /api/bff/admin/platform/verify-otp` and `GET /api/bff/admin/platform/me` for
the direct bundle. Every mounted operator handler passes through the observed
route boundary and the deployment route policy: challenge issuance, redemption
and `me` all use the admin mutation risk classification. The public default refuses
all three with HTTP 503 and `adopter_policy_required` before parsing input or
creating authentication bindings. A direct-bundle adopter must supply its
`#deployment-route-policy` implementation to enable login and operator
authorization, using the same policy mechanism as other admin mutation routes. Bundle selection alone does not enable authentication writes.
The default static reference mounts none of these routes. The bounded static and
subscription evaluation builds do not mount the admin shell; adopters must supply
that application composition.
When an application mounts the supplied admin shell, its login page offers email
links and a pasted token instead of a password or numeric code. Managed login and password callbacks keep their existing flow.

### Challenge delivery and redemption

An existing principal is eligible with an active `admin` or `distributor`
membership, or a live pending invitation with one of those roles. A challenge
creates no principal, customer or membership. Unknown, revoked, disallowed and
limited requests return the same `{ accepted: true }` response with a 400 ms
floor. The handler sends acceptance before invoking mailbox transport, so slow
or failed delivery cannot lengthen the observable response for eligible addresses.
The request still awaits delivery after sending the response; it does not launch
an untracked background task. `createOperatorSessionService.requestChallenge`
accepts an optional asynchronous acceptance callback, called after issuance for
every eligibility result and before delivery. Custom HTTP hosts must use it to
send their padded generic response before transport. Delivery errors retain that
accepted response and log only the neutral
`operator_challenge_delivery_failed` code. Database or configuration failures
return `UPSTREAM_UNAVAILABLE` (503).

Each challenge uses 32 random bytes encoded as 43 base64url characters. Only the
SHA-256 hash and normalized-email fingerprint persist. The database serializes
issuance per principal: one per rolling minute, five per rolling hour, including
consumed challenges. Tokens expire after ten minutes; requesting another leaves
other unexpired tokens valid. Redemption rechecks current email and eligibility,
activates a pending invitation using the existing trusted lifecycle command, and
consumes the challenge in that same transaction. Exactly one redemption succeeds.
Already-active operators can request and redeem new challenges without a pending
invitation. Repeat login preserves membership role, provenance and acceptance
time, and does not create or accept another invitation.
Expiry equality, replay, changed email or lost eligibility returns generic
`UNAUTHORIZED` (401). Invalid envelopes return `BAD_REQUEST` (400).

Authentication writes require same-origin JSON. Origins come only from the
strict configured `APP_BASE_URL` / `SITE_URL` resolver, never request headers.
Compose a separate `CustomerChallengeDeliveryPort` instance for operators via
`createOperatorSessionBinding`; its default discards without logging tokens.
For the reference dispatcher, use
`createReferenceBffDispatch(env => createOperatorSessionBinding(env, delivery))`
and mount that returned dispatch function. A caller-supplied canonical operator
route handler is preserved under the same deployment policy boundary; it is
never shadowed by the default discard binding. The host owns the lifetime of
bindings supplied through its route table; factory-created bindings close after
each request.
Injected delivery builds `/admin/auth/callback#operator_token=…` using the
configured application origin. Interactive sign-in needs injected delivery;
there is no default mailbox or mail transport.

### First-administrator bootstrap

With trusted database credentials and the complete migrated catalogue, run:

```sh
PLATFORM_BUNDLE=node-postgres node --experimental-strip-types \
  server/runtime/auth/operatorIdentityCommand.ts \
  bootstrap-first-administrator --email admin@example.invalid
```

The command locks the membership and invitation tables, refuses any existing
human membership or invitation with `OPERATOR_BOOTSTRAP_ALREADY_INITIALIZED`,
and creates an `admin` invitation. It may reuse one unambiguous principal without
changing its ID or email. The invitation records the principal as `invited_by`
and the bootstrap audit records a system actor. It authenticates nobody and
issues no token. First sign-in follows normal invitation activation. No startup
or HTTP bootstrap exists; revoked authority is never resurrected by this command.

The bootstrap invitation lasts seven days. An expired invitation cannot redeem a
challenge, and rerunning bootstrap still refuses with
`OPERATOR_BOOTSTRAP_ALREADY_INITIALIZED`, even when no administrator has signed
in. If another active human administrator exists, use the normal direct invitation
issue operation to reissue the expired attempt for the same principal. If none
exists, there is no shipped bootstrap reset or unauthenticated recovery command:
the database owner must follow the deployment's audited recovery procedure before
login can resume. Preserve principal IDs, customer links and invitation/audit
history; deleting rows to rerun bootstrap or extending a deadline by hand is not
a supported recovery route. Challenge pruning cannot renew an invitation.

### Sessions and authorization

Configure nonempty, distinct `OPERATOR_IDENTITY_AUDIENCE` and
`CUSTOMER_IDENTITY_AUDIENCE`. Operator sessions reuse the existing ES256 issuer,
key ID, private JWK and public JWKS settings, with an exact scalar operator
audience and a fixed 900-second lifetime. Verification requires integer `iat`
and `exp`, no future issuance and a positive lifetime of at most 900 seconds.
Customer and dual-audience tokens cannot authenticate an operator. JWT role
claims grant no authority: each protected request requires a live active
membership and an allowed role (`admin` or `distributor`), then the route's role
allowlist. Human authorization returns the verified human principal and
`isMachineActor: false`. Authority-read failure refuses; it never becomes machine
authority. Exact configured machine credentials retain their existing authorizer.
Human login needs no machine credential and does not enable otherwise machine-only
capabilities. Customer identity and subscription ownership do not change.

The shell maps `accessToken` to its neutral `access_token` session subset.
The direct adapter stores the session in `sessionStorage`, with document memory
fallback when storage is denied. There is no refresh token. Restoration and
window focus recheck `/me`; expiry and sign-out clear authentication and its query
cache. A focus check clears the session on an authorization refusal (HTTP 401/403
or a profile without an allowed operator role). A network failure or upstream
outage retains the current tab session until a later check or its existing expiry;
protected server requests still require live authorization. Restoration and focus
reads never cancel a redemption in progress,
including when the provider and callback mount together under StrictMode.
Explicit sign-out or another successful redemption still supersedes the old attempt.
The hook consumes the port's guarded state notifications and waits for its
session and admin state check before reporting successful code verification.
Both pasted-token login and the callback link therefore enter the protected
admin shell after authorization completes, including when `/me` is delayed.
It never signs out on a stale authorization response.
An older check cannot clear an established newer session or cancel its pending
redemption, regardless of which response completes first.
A copied bearer remains usable until expiry or membership revocation.
The callback removes its token fragment before asynchronous work and redeems once
under StrictMode. Managed SDK initialization stays behind managed selection.

### Retention and recovery

With the same direct environment, run:

```sh
node --experimental-strip-types server/runtime/auth/operatorIdentityCommand.ts prune-challenges
```

Each invocation deletes at
most 500 challenges whose expiry is more than 24 hours old, ordered by expiry
and ID with locked-row skipping. Repeat bounded invocations as needed; there is
no new scheduler. Live challenges and recent rate-limit history are retained.
Signing failure after redemption leaves the challenge consumed and activation
committed. Request another challenge; never delete an identity, relink a customer
or reverse activation as compensation.

### Installation and verification limits

Apply the complete selected catalogue including
`20261018180000_identity_operator_challenges`, at position 68. Its package SQL
projection is byte-identical, not a second install chain. The new normalized-email
unique index refuses duplicate principal emails; diagnose and resolve the conflict
without silently merging identities. The forward creates only a table and indexes,
with no privilege grants. Runtime issuance, redemption and authority reads refuse
unexpected browser-role or PUBLIC table/column privileges, including inherited
grants. Verify the runtime credentials and actor-role denial against the actual
installation. No managed migration is required.

Fresh installation, exact predecessor-ledger upgrade, replay, transaction races,
retained links and live object inventory require real PostgreSQL proof. Source
unit checks and SQL admission do not establish those outcomes or general upgrade
support. The cold installed consumer imports both identity entries without optional
peers and exercises the new store's explicit missing-peer refusal.

The [operator database conformance](../../tests/postgres/operatorIdentityUpgrade.test.ts)
checks consumed-challenge rate limits, expired tokens, email changes, revocation
and effective browser privileges. Its pruning witness seeds live and recently
expired challenges alongside older rows, then checks their retention after each
bounded batch. Fixture timestamps share a statement timestamp so their lifetimes
respect the same ten-minute constraint as issued challenges.

## Identity personal data

`@openlup/platform/identity/contracts` exports strict contact/principal subject
references, versioned contributor documents, erasure receipts and named privacy
refusals. Each contributor declares `ownedResources` alongside its ID and version. `createPersonalDataContributorRegistry` registers explicit owners and
versions at composition; duplicate IDs refuse, missing required contributors
remain visible on export and refuse erasure. Every assessment completes before
any contributor mutates data. An assessment failure rolls the transaction back.
Identity never discovers another domain by email or cancels a subscription.

`exportPersonalData` and `erasePersonalData` accept an authorized human
administrator and an injected unit of work, registry, store, clock and ID source.
The reference composition registers identity and a subscriptions veto in the same
direct transaction. A `SHARE` relation lock on subscriptions holds the assessment
through commit, including protection against concurrent insertion or activation.
`active` refuses with `PRIVACY_ACTIVE_SUBSCRIPTION`; `paused` refuses with
`PRIVACY_RESUMABLE_SUBSCRIPTION`. Unknown states and failed reads refuse with
`PRIVACY_ASSESSMENT_UNAVAILABLE`. Subscriptions are read only.

Resolve a subject through `clients.principal_id` on direct, or the persisted
`auth_user_id` on managed. Equal email addresses do not join customer and operator
principals. Direct erasure preserves `clients.id`, never writes `auth_user_id`,
and deletes neither contact nor principal rows. It replaces email with a unique
reserved `erased+<id>@identity.invalid` address, clears first/last name, phone and
country, and clears the direct customer principal link. All customer challenges,
including consumed rows, and the linked operator challenges are deleted. Pending,
expired and cancelled invitations are deleted; accepted invitation email snapshots
and identity-owned audit free text are redacted. Active membership is revoked
through `platform_revoke_human_membership`; self-revocation, machine-principal and
last-human-admin protections remain binding. Redaction of an already revoked
membership reason uses the existing lifecycle guard without changing state or
role or creating another revoke event. An erased principal cannot receive
or accept another invitation. A new unrelated principal is never matched by an
old email through this privacy operation.

The identity contributor owns these profile fields and lifecycle/audit records.
It treats other populated contact columns as opaque. `IdentityPrivacyPolicy`
requires an explicit owner/resource/retain declaration for each such field;
otherwise erasure returns `PRIVACY_OWNERSHIP_UNDECLARED`. The reference declares
retention only for `lifecycle_stage` and `acquisition_source`. Nonempty metadata,
external references and future undeclared fields therefore refuse. Export omits
opaque payloads and reports those fields as unavailable; it excludes challenge
hashes, provider metadata, credentials and provider tokens. Each contributor
reports its own coverage rather than claiming a complete platform export.

The direct forward `20261018190000_identity_privacy_erasures` adds a single retained
pseudonymous receipt table. The same transaction performs identity cleanup and
inserts the receipt with contributor versions and dispositions, without storing
a personal export. Subject UUIDs and idempotency keys normalize hexadecimal case. A lost-response
retry returns the original receipt and
`ALREADY_ERASED`; a key bound to a different subject refuses with
`PRIVACY_IDEMPOTENCY_CONFLICT`. Browser/PUBLIC effective table or column access
to the receipt store refuses erasure with `PRIVACY_STORE_PRIVILEGES_UNSAFE`.
Relation locks precede contact/member locks; bounded lock and statement timeouts
roll back failed writes. The package customer challenge adapter holds an `EXCLUSIVE` lock on
`customer_identity_challenges` from before its receipt check through issue/redeem
and transaction commit. This conflicts with erasure's `EXCLUSIVE` challenge lock;
a waiting operation reads the committed receipt before calling the SQL function.
It refuses receipts for either the contact or principal, including challenges
inserted by a stale issuer after cleanup. Receipt reads take `ACCESS SHARE`, which
is compatible with erasure's receipt-table `SHARE ROW EXCLUSIVE` lock, avoiding a
reverse lock-order wait. The erasure re-link guarantee applies to the package
adapters. Hosts must not call raw `customer_identity_challenge_issue` or
`customer_identity_challenge_redeem` SQL functions directly: those retained
functions do not fence erasure receipts.

Managed export selects only granted contact/membership columns and provider-admin
identity fields. Country, audit/invitation history and receipts are unavailable;
missing subscriptions coverage is explicit. Managed erasure refuses with
`MANAGED_PRIVACY_ERASURE_UNAVAILABLE` before local or provider mutation. A managed
adopter must provide its own erasure path until reviewed permissions and atomic
persistence exist. No provider deletion is composed. The provider erasure port
supports disabling an identity after committed local success; managed erasure
does not reach that port.

### Admin operations and token limits

Both `POST /api/bff/admin/identity/privacy/export` and
`POST /api/bff/admin/identity/privacy/erase` require live admin membership and an
explicitly human actor, including in the handler for the direct bundle. Both
routes retain deployment-policy risk `mutation`. Like invite, remove and admin
`me`, direct and managed routes return 503 with reason `adopter_policy_required` under the
public default before reading the request body or query. Direct and managed adopters reach
these routes only through their `#deployment-route-policy` binding, the same
policy mechanism used by every admin mutation route. Once that policy admits
them, managed export reports incomplete coverage and erasure refuses with
`MANAGED_PRIVACY_ERASURE_UNAVAILABLE` before any local or provider mutation.
The shipped reference dispatcher mounts both privacy routes for direct and managed
bundles without caller-supplied route entries, with the observed mutation policy enforced before
authentication or privacy bindings are created. Supplied route entries cannot
bypass this boundary. Admin preflight runs after policy admission, and the
handler rechecks human-admin authority. After admission, missing
sessions return 401; distributor or machine actors return 403; missing subjects
return 404; live-subscription, protected-operator and idempotency conflicts return
409. Capability, ownership, contributor and assessment refusals return 503.
The existing BFF error details carry `privacyCode`; no adapter diagnostics or
partial exports are returned on failure. Responses use `Cache-Control: no-store`.

Admin Settings mounts an identity privacy panel accepting a contact/principal
UUID. It displays coverage, obligations, named refusals and the committed receipt.
Erasure requires confirmation. Documents, confirmation and the retry key live in
component memory and clear when the subject or session changes, including when
an older request completes later. No export is stored in browser storage.

Already-issued tokens can remain cryptographically valid until expiry. Direct
operator tokens last at most 900 seconds; customer TTL remains configured
(default 3600 seconds, permitted range 300–86400 seconds). Revoked membership
fails live operator authorization. The unlinked direct customer `me` returns
403 / `FORBIDDEN`, “No customer account linked to this session.” This is not a
claim of immediate cryptographic token revocation.

`prune-challenges` now processes at most 500 operator and 500 customer challenges
per invocation, only when expiry is strictly older than 24 hours. It preserves
recent rate-limit history and introduces no scheduler.

### Retained responsibilities

| Owner | Current identity-erasure boundary |
| --- | --- |
| Consent and marketing | History, suppression and remote audiences remain with their owner; no reset or remote deletion is inferred. |
| Invoices | Retained outside identity; their owner supplies document export, retention and processor handling. |
| Subscriptions | Read-only veto and status export only; full export and lifecycle/provider retention require their owner. |
| Orders | Retained outside identity; snapshots and remote fulfilment/payment obligations require their owner. |

These are visible outstanding obligations, not successful erasure contributors.
Identity completion never means all platform data was erased. See
[data compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle) for installation
requirements and [the package guide](PLATFORM_PACKAGE_REFERENCE.md#personal-data)
for composition. Disposable database proof is selected through
`tests/postgres/operatorIdentityUpgrade.test.ts`; the local managed proof is
`tests/postgres/identityPrivacyManaged.conformance.ts`. It loads the committed
managed migration chain through the shared loader and omits only psql's pg_dump
`\restrict` and `\unrestrict` guard lines for node-postgres replay. Its database
URL must use the database owner (`supabase_admin`) connection; see the package
guide for the three local disposable-stack settings and invocation.


## Disposable identity reference

The opt-in identity profile has a separate browser entry and closed import
inventory. It mounts the existing customer login/callback provider and the
operator login/callback provider, with separate session ownership. Its account
page requires a linked customer profile; the operator landing page requires a
recognized live role and exposes privacy controls only to administrators.
Direct operator composition passes `providerKind="direct"`; managed composition
omits that selector. The public static and subscription profiles retain their
existing entrypoints and import inventories.

Managed customer links return through
`/account/auth/callback?returnTo=%2Faccount` with SDK credentials in the browser
fragment. The reference server accepts the encoded query on that declared path
and serves the identity document before the browser consumes the callback.
Encoded pathnames and traversal remain refused. Direct code-form login does
not navigate through this callback request.

The server shell accepts an explicit identity runtime containing the mounted
route functions, ownership profile and the existing candidate, port bindings and
schema observer accepted by `admitReferenceIdentity`. Callable typed ports build
those functions through `createRoutes(ports, env)`; admission and HTTP dispatch
use that same policy-wrapped table and its operator preflight. Request-scoped
customer readers retain their verified actor, and operator actions retain their
bearer across asynchronous work. The candidate snapshots the complete host
environment, which must also match the ambient environment before listening.
Admission must complete before listening. The shell does not manufacture schema history,
route readiness or email-trust evidence; the selected identity composition owns
those checks and the direct reconcile/invitation bindings. Without that
composition the opt-in acceptance command refuses before provisioning. The
runner uses the direct ledger or its completed owned managed replay as history,
then probes the selected bundle's actual schema objects: direct contacts use
`principal_id`, while managed contacts use `auth_user_id`. The disposable bundler
observes package identities from its actual module graph, including any additional
loaded packages; an external unresolved platform package leaves the inventory
incomplete. Merely installed workspaces are not loaded module observations.
Every observed package still needs a matching version and contribution.
Both invitation paths
capture role notifications locally; direct challenges use the private mailbox,
and managed authentication uses the owned local mail service.

The disposable profile declares its public key with signing use (`use: "sig"`),
the ES256 algorithm and the configured key ID, as required by the strict identity
verifier. Direct operator session construction validates this metadata before
issuing a challenge. Customer challenge issuance and redemption do not validate
the public verification key; customer profile reads do.

Direct delivery reuses `createCapturedCustomerChallengeDelivery` with a local
filesystem sink. Each run creates a private mailbox directory (`0700`) and
exclusively created message files (`0600`). Customer opaque tokens, operator
callback fragments and role notifications have separate message kinds. Reading
and writing recheck installation ownership; symlinks and unsafe file modes
refuse. There is no HTTP mailbox endpoint. Treat the run directory as
credentials and remove it with its owned installation.

Run the complete, opt-in installed reference proofs from the repository root:

```sh
node tests/identity/runAcceptance.mjs --bundle node-postgres
node tests/identity/runAcceptance.mjs --bundle node-supabase
```

Both commands require the composed identity runtime, installed Node 24 and npm
11.19.0, Docker and installed browser tooling. The direct command requires a
cached `postgres:16` image. Managed execution additionally requires installed
Supabase CLI 2.98.2; its owned migration replay includes the committed identity
service-role capabilities forward.
Missing prerequisites fail; neither command silently skips. Each run owns a
random installation id, allocated ports, build directory and captured mail.
Identity acceptance and conformance runners stop only their owned CLI or compose
project on SIGINT/SIGTERM, once across the signal and finally paths, within a
30-second cleanup budget. The direct PostgreSQL acceptance fixture also carries
the [disposable owner labels](../../CONTRIBUTING.md#test-scope-and-diagnostics);
after SIGKILL, CLI and compose stacks still require reviewed manual cleanup.

The direct and OIDC conformance databases store disposable data on `tmpfs`, preventing the image's
anonymous data-volume allocation even if startup is interrupted. Cleanup
discovers partial direct containers by the current run's unique owner label,
verifies their identity and removes them with their anonymous volumes.
Only the disposable rendered configuration sets `[auth.rate_limit]`
`email_sent = 20`, giving the customer, operator and invitee sign-ins an hourly
email budget with margin. The shared reference configuration keeps its defaults.
Rendering preserves other settings and refuses ambiguous rate-limit declarations.
Before each managed login email request, the acceptance helper checks captured
mail for that address, including invitation mail. It waits only until the latest
message's `Created` timestamp plus the rendered `[auth.email] max_frequency`
window and a 100 ms margin. An omitted setting uses the pinned CLI's one-second
default. First requests and already elapsed windows add no delay; a refusal after
the wait still fails the journey without retrying. This timing applies only to
the disposable acceptance journey.
Before issuing challenges, the runner verifies container identity and ownership
labels and checks every published port in both Docker inspection views. The direct
database accepts only explicit `127.0.0.1` and `::1` bindings; empty, wildcard and
other host addresses refuse, including on secondary ports. The reference HTTP
server binds to `127.0.0.1` in both bundles. The direct mailbox remains a filesystem
sink without a listening socket.

The managed stack's ports, including its mail-capture API, are published by the
Supabase CLI 2.98.2 on all host interfaces for the duration of the run. The stack
holds only synthetic identities and must run on a host not reachable from
untrusted networks. The CLI provides no publication-bind setting. Managed
containers must have the run's project label, and every published host port must
be inside the runner's allocated block (base through base + 10, inclusive).
An unexpected port or unavailable binding data refuses acceptance. Ownership
rechecks repeat the bundle's publication check.
The managed API and database connection targets must use `127.0.0.1` or `[::1]` at the allocated API and database ports, without connection-query overrides.
Cleanup checks container identity and labels; cleanup failure fails the run and
retains the directory for recovery.

Acceptance supplies its owned query pool to direct customer profile reads through
the existing actor-gateway injection seam, so the composed runtime borrows that
pool instead of opening an application-cached pool. Teardown closes the HTTP
server, waits for mounted route work (including binding cleanup after a response),
then ends the query pool before stopping the database. Idle-pool errors observed
during assertions fail acceptance after cleanup; late disconnect events during
teardown are handled without an unhandled error event. Query, route and cleanup
failures still fail the run.

The runner registers the TypeScript loader without a scoped import namespace
so the build tooling's CommonJS builtin imports resolve on Node 24. A fast
module-loading check runs without provisioning services:

```sh
node tests/identity/runAcceptance.mjs --bundle node-postgres --check-module-graph
```

This check loads the same acceptance module graph as the installed proof; it
does not establish database or browser acceptance. The complete commands retain
all prerequisite refusals.

The proof invokes mounted customer sign-in/reconcile, operator sign-in,
invitation/redemption/revocation, denial and identity privacy operations, then
browser login, reload and logout. Direct privacy exercises active/paused
subscription veto and receipt replay. Operator browser login requests its link
through the mounted login form and follows captured mail; logout and subsequent
protected navigation must render the login form again. Managed privacy expects
export with its existing coverage limits and a no-mutation erasure refusal. These commands do
not replace the separate complete-catalogue upgrade and adapter conformance
suites or establish successful managed erasure.

The required profile-isolation tests run without Git history or a predecessor
variable. They build the separate closed profiles, check their generated HTML
entries and import inventories, and require explicit identity selection. Default
and subscription graphs must exclude identity-only files and resolve
`#deployment-route-policy` to the public closed policy even if no built module
uses the alias.

Byte compatibility with a predecessor is a separate opt-in proof. From the
repository root, after building core and platform, run either command:

```sh
node --import tsx tests/identity/acceptance.conformance.ts --profile-predecessor --base "$OPENLUP_STACK_BASE"
OPENLUP_STACK_BASE="$OPENLUP_STACK_BASE" node --import tsx tests/identity/acceptance.conformance.ts --profile-predecessor
```

Supply the full predecessor commit in `--base` or `OPENLUP_STACK_BASE`. The proof
refuses a missing base, an invalid commit or a non-ancestor; it never defaults to
HEAD or skips. It compares default and subscription build settings, generated
HTML and public auth settings, every reachable first-party build input, package
resolution inputs and the subscription import inventory with that predecessor.
This service-free proof is outside Vitest and the required test selectors.

## Opt-in OIDC access tokens

`createOidcIdentityVerifier` is separate from the existing static customer and
operator session verifiers. Compose `createOidcComposition(env)` explicitly in
a direct `node-postgres` host, retaining one binding for its lifetime. Supply
`IDENTITY_OIDC_ISSUER`, `IDENTITY_OIDC_CUSTOMER_AUDIENCE` and a distinct
`IDENTITY_OIDC_OPERATOR_AUDIENCE` through the host's existing environment reader.
The host loads its installed JWT library lazily; the package has no JWT-library
runtime dependency. Construction and import perform no network access.

Discovery pins the exact issuer and a same-origin JWKS URL. HTTPS is required;
only an explicit test option permits literal loopback HTTP. The verifier accepts
RS256 or ES256 JWT access tokens with a bounded nonempty `kid`, a valid signature,
exact issuer and configured API audience. Configure API audiences independently
of RP client identifiers so ID tokens cannot serve as API credentials. Customer
lifetimes are at most 3,600 seconds; operator tokens require one scalar audience
and at most 900 seconds. Integer `iat` and `exp` are required, `nbf` is enforced,
clock tolerance is zero and equality at expiry refuses. Only signed top-level
`email` and literal boolean `email_verified: true` supply identity email.
Roles, groups and editable metadata convey no authority.

Direct principals use SHA-256 over UTF-8 `openlup:oidc-principal:v1` followed by a
NUL byte and `JSON.stringify([issuer, subject])`. The first 16 digest bytes receive
UUID version 8 and RFC variant bits. Golden vectors freeze this mapping; email,
audience, signing key and refresh never change it. Normal reconciliation with
an explicit verifier-result-only email-trust policy may create a contact or
fill a null `clients.principal_id`. This policy is the host's assertion that its
issuer verifies email. Ambiguous normalized email matches refuse. Existing links
are never replaced, and erased principals cannot be recreated or relinked;
receipt-before-contact locking serializes writes with privacy erasure. No auth
user, mapping table, subscription mutation or migration is introduced.

Operator authentication uses the separate audience-bound verifier and the
existing direct membership store on every request. Only active human `admin`
or `distributor` members authorize, subject to route roles; pending, absent,
revoked and machine identities refuse. Trusted setup provisions the derived
principal ID, then the existing invitation/acceptance lifecycle supplies
membership. Login never links by email or creates membership. Existing randomly
identified operators require explicit administrative migration outside this
composition. Managed bundles refuse raw upstream composition with
`OIDC_NATIVE_SESSION_REQUIRED`; retain native federation, native auth IDs,
email-trust policy, actor tokens and native membership there.

JWKS selection accepts RSA/RS256 and P-256/ES256 public signing keys within the
configured algorithm allowlist. `use` may be `sig` or absent; absent `alg` is
inferred from the key type and curve. Encryption keys, unsupported algorithms
and incompatible key types/curves are ignored. Certificate metadata such as
`x5c`, `x5t` and `x5t#S256` does not change selection. The set must contain at
least one usable signing key, with bounded key IDs unique among usable keys.
Malformed sets, private key material and invalid signing key parameters refuse.
Before discovery or key lookup, bounded compact JWS parsing requires JSON-object
headers and payloads, refuses algorithms outside the configured allowlist and
returns `OIDC_ISSUER_MISMATCH` for an unverified issuer that is not the exact
configured string; these checks only refuse, and signature verification and all
verified claim checks still determine admission.

Discovery expires within one hour and JWKS within five minutes. `max-age` and
`Age` can shorten these bounds; `no-store` prevents reuse. `no-cache` instead
limits reuse to 30 seconds, matching the minimum JWKS refresh interval; shorter
explicit freshness bounds still apply. Readiness and verification can use that
freshly fetched set, then must revalidate it at expiry. Each
fetch rejects redirects and has a three-second deadline including its streamed
body, capped at 64 KiB. Concurrent loads coalesce. Every JWKS attempt, successful
or unsuccessful and including initial loading, starts a 30-second refresh
window. Unknown kids inside it refuse without another fetch. A successful refresh
replaces the set atomically. A removed key is refused once the cached set expires
or a successful refresh replaces it; a failed forced refresh before expiry leaves
the previous unexpired set usable until its existing expiry. Expired cached sets
are never used after a failed refresh. Known-key signature failure does not
trigger another fetch. Token `jku`/`x5u` values never choose a transport destination.

`verifyToken` returns a detailed `OIDC_*` refusal from `OIDC_FAILURE_CODES`.
Hosts import this constant and `OidcFailureCode` from
`@openlup/platform/identity`; the browser-shared
`@openlup/platform/identity/contracts` entry excludes OIDC refusals.
Configuration, discovery and JWKS validity have
separate codes from transport/library unavailability, unknown/rate-limited kids,
issuer/audience mismatch, invalid signature, expiry/activation/lifetime and
subject/email refusals. The `IdentityVerifierPort` facade returns null for
credential refusals and throws a sanitized availability error for unavailable
dependencies. Existing handlers retain 401 `UNAUTHORIZED` and 503
`UPSTREAM_UNAVAILABLE` envelopes. Reconciliation and membership keep their
existing conflict and `FORBIDDEN` outcomes.

Readiness reports discovery reachability/validity and fresh loaded keys with
check/expiry timestamps, distinguishing `ready`, transport `unknown` and invalid
`unsatisfied`. Register `binding.oidcVerifiers` on the existing reference
identity ports so startup admission includes these observations. The binding's
customer routes use the observed deployment-policy wrapper with risk `mutation`;
profile reads use authenticated actor scope containing only the verified UUID.
Default launch, passwordless routes, browser provider choices and managed login
remain unchanged. Only the explicitly composed OIDC recipe gains external-token
reconcile/profile access, readiness, bounded rotation and live membership auth.

## Real-issuer OIDC recipe

From the repository root, build core/platform, then run:

```sh
node tests/postgres/runOidcIdentityConformance.mjs
```

This opt-in command requires Node 24, npm 11.19.0, Docker Compose, installed
Playwright Chromium, cached PostgreSQL 16 and the exact cached issuer image in
[`docker-compose.identity-oidc.yml`](../../docker-compose.identity-oidc.yml).
It never pulls images or installs dependencies. The recipe uses Keycloak
26.0.7 with the immutable OCI index digest committed in that compose file; the
runner verifies repository digest and running image identity before use. It
owns a unique disposable project, private temporary credentials, synthetic
realms/users/clients and loopback-only published ports. Ownership and network
checks bound cleanup to its resources; a failed prerequisite refuses the run.
Do not point this command at an existing database or an external issuer.

The private run directory links to the checkout's installed `node_modules`, as
identity acceptance does, so the built server runtime can resolve external
dependencies. Normal cleanup removes the link with the temporary directory.

The real issuer provides authorization-code/PKCE tokens, refresh, signing-key
administration and logout. The RP checks state and nonce and owns an HttpOnly,
SameSite session cookie. Ending that session clears retained credentials and
cookie; an in-flight refresh cannot restore it. Issuer logout separately prevents
refresh. A copied stateless access token remains valid until expiry; the verifier
refuses it at expiry, while membership revocation denies the next operator call.

The runner applies the complete canonical PostgreSQL catalogue and checks its
ledger, runs reconcile and own/cross-customer reads, provisions a derived operator
through the invitation lifecycle, then checks active, restricted and revoked
membership. It exercises real token expiry/refresh, new signing kids, removed
keys after cache expiry, foreign realm, wrong audience and unverified email.
The removed-key probe advances the verifier clock past the JWKS cache bound;
token expiry and refresh checks use wall time and real issuer tokens. Replay must
leave the ledger and legacy contact, active subscription, administrator and
machine rows unchanged.
These assertions require an actual successful run; unit tests with synthetic
keys do not certify an issuer. The recipe certifies only the direct composition,
not managed federation or production hosting. The existing customer-own-row
pgTAP witness remains required separately.

## Auth email implementation ownership

The existing Auth Send Email hook now delegates to the communications capability.
Identity still owns verification URL construction and principal/session policy.
The reference shim supplies the same renderer and environment observers, while
content, transport and persistence remain injected. The hook retains its existing
CORS and error bytes, stream-only reader, signature dialect/clock, template-control
before send, and ledger before success behavior. Only the Auth email port slice
moves to communications contracts; no identity implementation or SQL changes.
