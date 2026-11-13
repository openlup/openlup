# Identity import

Status: maintainer page: how to change OpenLup. Reader guidance lives in the [OpenLup guide](../../packages/core/docs/guide/README.md); sections marked "Evidence" are frozen historical records.
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

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#magic-link-destinations).

The reference customer binding supplies a one-origin allowlist from nonblank
`APP_BASE_URL`, falling back only when absent or blank to
`CUSTOMER_AUTH_REDIRECT_ORIGIN`. The admin binding uses `APP_BASE_URL` with
`SITE_URL` as its compatibility fallback. Invalid primary values never fall
through to compatibility configuration. Default static/reference route admission
is unchanged.

Evidence (historical record, 2026-11-13):

`resolveOrigin(req)` remains the existing explicit override: adopters can keep
passing their current resolver, and its origin policy remains theirs. Valid
configured requests retain each handler's existing quota, eligibility,
non-enumerating accepted response and padding. The neutral conformance witness is
[`authVerifyUrl.test.ts`](../../packages/platform/test/identity/authVerifyUrl.test.ts);
the reference route tests pin configuration precedence and the new refusal.

## Email-trust schema readiness

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#customer-sign-in-and-email-trust).

The reference host helper `assessIdentityReadiness` composes email-trust
readiness during `startPublicReferenceServer({ identity })` candidate admission,
before listening.

## Operator invitation lifecycle

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#operator-invitations).

Direct storage uses the two additive tables in forward
`20261018120000_identity_operator_invitations`, canonical catalogue position 67.
Commands use the existing owner-authority PostgreSQL transaction lane,
serialize normalized email and lock actor/target memberships in principal order.
Membership, acceptance and audit share a commit. Reactivation uses the existing
local guard, lifecycle update and separate role update; revocation retains
`platform_revoke_human_membership`. Principal creation commits separately.
The forward changes no grants or policies.

The reference browser validates active managed and complete direct pending
results. Managed role mail uses `admin-membership:<principalId>:<role>` as its
delivery/timeline key; direct mail retains its invitation-attempt key.

Managed pending/expiry needs a separate transactional store and reviewed forward.
The managed identity-capabilities forward
`20261018160000_identity_service_role_capabilities.sql` grants `service_role`
SELECT(email) and INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) on `admin_users`; insertion relies on the false
`is_machine_actor` default. No pending attempt is stored in Auth metadata.
The reference managed invite runner does not enforce the direct-only TTL setting.

See [data compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle) and the
[package invocation](PLATFORM_PACKAGE_REFERENCE.md#operator-invitations).

Evidence (historical record, 2026-11-13):

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
Evidence: historical record, 2026-11-13. Not reader guidance.

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
2.122.0, installed dependencies (including the existing SDK and TS loader), built
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
Evidence: historical record, 2026-11-13. Not reader guidance.

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
Evidence: historical record, 2026-11-13. Not reader guidance.
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

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#direct-human-login).

The reference composition selects `PLATFORM_BUNDLE=node-postgres` and browser
`VITE_OPERATOR_AUTH_PROVIDER_KIND=direct`, passing `providerKind` to `AuthProvider`.
The dispatcher mounts the direct magic-link, verify-otp and `me` handlers through
the observed admin-mutation deployment-policy wrapper before input parsing or
binding creation. The default static reference mounts none of them; the bounded
static and subscription builds omit the admin shell.

### Challenge delivery and redemption

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#challenge-delivery-and-redemption).

The reference dispatcher receives its separate operator delivery binding through
`createReferenceBffDispatch(env => createOperatorSessionBinding(env, delivery))`.
Caller-supplied canonical handlers retain the deployment-policy wrapper and are
not shadowed by the discard binding. Route-table bindings retain host lifetime;
factory-created bindings close after each request. The request awaits delivery
after sending acceptance instead of launching an untracked task.

The injected delivery builds `/admin/auth/callback#operator_token=…` using the
strict `APP_BASE_URL` / `SITE_URL` origin resolver.

### First-administrator bootstrap

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#first-administrator-bootstrap).

The repository's trusted database maintenance entrypoint is:

```sh
PLATFORM_BUNDLE=node-postgres node --experimental-strip-types \
  server/runtime/auth/operatorIdentityCommand.ts \
  bootstrap-first-administrator --email admin@example.invalid
```

Its implementation locks membership and invitation tables and records the new
principal as `invited_by`, with a system actor in the bootstrap audit.

### Sessions and authorization

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#sessions-and-authorization).

The reference shell maps `accessToken` to its neutral `access_token` session
subset. Managed SDK initialization remains behind managed selection.

### Retention and recovery

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#retention-and-recovery).

The repository's direct maintenance entrypoint is:

```sh
node --experimental-strip-types server/runtime/auth/operatorIdentityCommand.ts prune-challenges
```

Its bounded database batches use expiry/ID ordering with locked-row skipping.

### Installation and verification limits

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#installation-and-verification-limits).

The operator challenge forward is
`20261018180000_identity_operator_challenges`, at catalogue position 68. Its
package SQL projection is byte-identical. The normalized-email unique index
refuses duplicate principal emails. The forward adds only a table and indexes,
without privilege grants or a managed migration.

Evidence (historical record, 2026-11-13):

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

Moved to [Personal data](../../packages/core/docs/guide/concepts/personal-data.md#personal-data-coverage).

The reference composition registers identity and a subscriptions veto on one
direct executor, holding a `SHARE` relation lock on subscriptions through commit.
Its opaque contact retention declares only `lifecycle_stage` and
`acquisition_source`. The Node host also registers `customer-billing` and
`fulfillment-parcel-contacts`; account-event registration remains host composition.
The native-store transfer carries parcel snapshots and erasure markers.

The direct forward `20261018190000_identity_privacy_erasures` adds the retained
receipt table. Relation locks precede contact/member locks with bounded lock
and statement timeouts. The package customer challenge adapter holds an
`EXCLUSIVE` challenge-table lock before receipt checks through commit, conflicting
with erasure's lock. Receipt `ACCESS SHARE` stays compatible with erasure's
`SHARE ROW EXCLUSIVE` lock. Redacting a revoked membership reason uses the
existing lifecycle guard without a state/role change or another revoke event.

See the [billing data owner](DATA_AND_MIGRATIONS.md#customer-billing-profile-and-invoice-buyer-data)
and [risk contract](ARCHITECTURE_AND_EXTENSIONS.md#risk-contracts) for source
capture, restore and portability boundaries. Managed erasure needs reviewed
permissions and atomic persistence; no managed forward or provider deletion is
composed here.

### Admin operations and token limits

Moved to [Personal data](../../packages/core/docs/guide/concepts/personal-data.md#export-and-erasure).

The reference dispatcher mounts direct and managed privacy routes without
caller-supplied entries. Its observed mutation policy precedes body/query reads
and binding construction; supplied entries retain that wrapper. Admin preflight
follows policy admission, with a handler-level human-admin recheck.

The Settings panel keeps documents, confirmation and retry keys in component
memory keyed by subject/session, guarding late responses. The repository
`prune-challenges` command processes separate operator and customer batches.

### Retained responsibilities

Moved to [Personal data](../../packages/core/docs/guide/concepts/personal-data.md#export-and-erasure).

See [data compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle) for
installation ownership and [the package reference](PLATFORM_PACKAGE_REFERENCE.md#personal-data)
for source composition.

Evidence (historical record, 2026-11-13):

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
Supabase CLI 2.122.0; its owned migration replay includes the committed identity
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
Supabase CLI 2.122.0 on all host interfaces for the duration of the run. The stack
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

## Guest checkout contact resolution

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#guest-checkout-contact-resolution).

The registrar uses the existing restricted native client INSERT/SELECT, bounded
profile/metadata UPDATE and receipt SELECT capabilities. Profile initialization
inserts permitted columns then uses a guarded UPDATE in the same transaction.
`INSERT ... ON CONFLICT (lower(email)) DO NOTHING` precedes a fresh lookup, with
5-second lock and 15-second statement timeouts. Receipt-before-contact SHARE
locking matches the account-link boundary. No SQL, grants or challenge-function
change is introduced. Exact shapes remain in the
[identity API reference](../../packages/platform/api/identity.api.md).

## Opt-in OIDC access tokens

Moved to [Identity](../../packages/core/docs/guide/concepts/identity.md#opt-in-oidc-access-tokens).

The reference `createOidcComposition(env)` recipe explicitly selects the direct
`node-postgres` bundle and reads issuer/customer/operator audiences through the
existing environment reader. Its host lazily loads the installed JWT library.
Reference ports register `binding.oidcVerifiers` for startup admission; customer
routes retain the observed mutation wrapper and actor-scoped profile reads.
Existing randomly identified operators need an explicit administrative migration.
Default launch, passwordless routes, browser choices and managed login are unchanged.
Exact types remain in the [identity API reference](../../packages/platform/api/identity.api.md).

Evidence (historical record, 2026-11-13):

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

For an explicitly disposable hosted test issuer, use the same recipe runner:

```sh
node tests/postgres/runM14RecipeConformance.mjs --target hosted-oidc \
  --credentials /external/hosted-oidc.env --receipt /new/hosted-oidc-receipt.json
```

The external owner-only mode-600 file contains JSON with `schemaVersion: 1`,
`target: "hosted-oidc"`, `disposable: true`, a neutral `region`, `issuerOrigin`
(a public HTTPS origin without credentials, path, query or fragment),
`issuerImage` (the exact Keycloak image above) and a synthetic `adminPassword`
of at least 24 characters for `conformance-admin`. The operator provisions the
dedicated issuer and ACME TLS first and independently records its running digest.
This declaration is destructive test authority, not discovery of a safe target.
The runner refuses an undeclared, mutable-image or non-HTTPS target before
connection. It verifies certificate chain and hostname with the ordinary trust
store; it supplies no custom CA or insecure TLS option to Node or Chromium.
The child receives private inputs through stdin and suppresses raw output.

This mode reuses all lifecycle assertions below against the hosted issuer;
PostgreSQL and the browser remain local disposable supporting fixtures. It creates
unique synthetic realms, removes its confirmed creations and verifies their
absence on success or lifecycle failure. A failed provisioning request can leave
an unconfirmed realm; removing the dedicated operator-owned issuer also removes
that residual state. The runner tears down its local database stack.
Operator-owned issuer containers, TLS files and listeners require separate
teardown and absence readback; the receipt records that boundary. Effort measures
the witness separately from operator provisioning and cleanup. Only `oidc` and
`hostedRecipes["10I"]` become PASS; unrelated sections remain pending. The claim
is "hosted OIDC recipe receipt (single synthetic issuer on a test VM)", without
production qualification or an SLO. This source runner adds no installed npm API.

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
The removed-key probe waits past the five-minute upper JWKS cache bound using
real elapsed time, then distinguishes removed-key refusal from token expiry;
token expiry and refresh checks also use wall time and real issuer tokens. Replay must
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
