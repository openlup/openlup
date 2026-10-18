# Identity import

Status: development preview, local import candidate. These entries have not been
published or activated as an adopter contract.
Audience: contributors reviewing the identity boundary and applications composing
its factories. The owner is the identity module within `@openlup/platform`.

## Responsibility and composition

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
also accepts `user_metadata.email_verified`, which a user can edit, and the
unmounted reference source `server/bff/customers/reconcile-account.ts` composes it,
as the contributing adopter's route does. A host that mounts reconciliation
replaces it with its own verifier that trusts only a confirmed address (for
example, `email_confirmed_at`); the package ships no such verifier, and the token
verifier reports every principal as unverified. The engine retries the email
branch once after a concurrent create failure. The new
[`createReconcileAccountHandler`](../../packages/platform/src/identity/reconcileAccountHandler.ts)
returns those refusals as 400, 403 or 409 and has no personalization hook.

The soft-account linker attempts identity creation first, then scans the existing
directory only after an already-registered response. Both directory adapters
follow `nextPage`, compare trimmed lowercase addresses, propagate lookup failures
and refuse after 5000 scanned users. Invite side effects retain the original
request address. The invite use case still checks only the caller's role; the
HTTP authorizer separately requires active membership. Only stored `admin` and
`distributor` roles authorize. Null and unknown roles return
`FORBIDDEN` (HTTP 403), with or without a route-specific role restriction.
The reference profile adapter returns `{ isAdmin: false, role: null }` for these
rows, and its magic-link eligibility refuses them. The magic-link handler still
records quota before eligibility and returns the padded, non-enumerating
`{ accepted: true }` response without sending. Adopters wanting legacy mapping
must perform it in their own adapter before the package receives the role;
identity exposes no fallback setting.

Both managed contact stores find mixed-case stored addresses using the
normalized input. Literal matching means an anchored, escaped `imatch` database
prefilter followed by exact equality of `email.trim().toLowerCase()` with that
input. Escaping keeps `_`, `%`, backslash and `*` literal; the exact comparison
rejects Unicode lookalikes widened by the database's case-insensitive regex.
A shared private helper selects email and fetches at most ten candidates.
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
Invite/remove use cases return stable error codes and select the injected message
table. The reference bindings retain their existing response text and receipt
field mapping, select the existing notification locale and omit the new internal
error-code field. Mail sender and origin remain inputs to the application's mail
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

## Schema continuity and readiness

[`IDENTITY_MIGRATIONS`](../../packages/platform/src/identity/sql.ts) records the
canonical path, SHA-256 digest and runner position of four complete units, at
positions 11, 12, 29 and 60. The package SQL files retain every canonical byte.
They are a projection for inspection and host migration composition, not a
standalone chain: earlier foundation migrations and intervening units still
matter. Never apply a package projection on top of an already applied canonical
unit, change its identity or use the direct chain against a managed store.

[`createIdentityContribution`](../../packages/platform/src/identity/contribution.ts)
retains artifact kind `rail` and identifies module `identity` as a `capability`,
with its two provided entries and foundation dependencies. The host must supply
an independently identified `requiredSchema`; managed and direct stores have
different objects. This candidate does not invent one combined schema inventory.
The contribution is not installed in the reference readiness composition here.
It uses the readiness module field (`PackageManifest.module`) directly.

## Conformance and outstanding evidence

The repository's existing `packages/platform` required selector and Vitest node
project include `test/identity/**` without a new selector or coverage exception.
The witnesses are:

- W1: [`identity_customer_own_rows_test.sql`](../../supabase/tests/identity_customer_own_rows_test.sql), run by the existing managed-schema pgTAP harness. It pins the reference schema's grants as they are today. Two customers each see only their own client, address, orderer profile, payment preference and account event; `authenticated` holds SELECT on those tables (on clients, column-level). The customer SELECT policies on pets, orders, order items, subscriptions, subscription lines and cycles have no `authenticated` grant behind them, so those reads are refused with SQLSTATE 42501. Anonymous reads are refused with 42501 on the customer tables and return zero rows on the three subscription tables, which hold a seeded row per customer.
- W2/W3: [`adminConformance.test.ts`](../../packages/platform/test/identity/adminConformance.test.ts), using the real authorizer at invite/remove HTTP gates. The invite/remove matrix includes two additive refusal rows: an active member with a null role and an active member with an unknown role each receive 403 before either action. W3 also pins those refusals with or without a role restriction; the invite use case itself still checks only the caller's role.
- W4: [`inviteLookupConformance.test.ts`](../../packages/platform/test/identity/inviteLookupConformance.test.ts), covering pagination, normalization, cap, errors, effect ordering and retained request spelling.
- Contact matching: [`softLinkConformance.test.ts`](../../packages/platform/test/identity/softLinkConformance.test.ts) exercises both actual managed stores through soft linking and reconciliation with mixed-case rows, literal-match refusals, explicitly returned dotless-i and long-s lookalikes, oldest exact selection and multiple-exact-row refusal. The imported [`managedAccountLinkStore.test.ts`](../../packages/platform/test/identity/managedAccountLinkStore.test.ts) query fixture supports the bounded array lookup.
- The imported engine, profile, session and adapter tests sit beside these witnesses; [`sql.test.ts`](../../packages/platform/test/identity/sql.test.ts) verifies canonical projection identity.

The browser runtime-schema move remains pending: the existing schemas use Zod,
but the contracts boundary admits only own-contract files and public core entries.
This candidate retains those runtime schemas in the reference application rather
than weakening that boundary. Completing that move needs an explicit boundary
choice. A concrete default schema inventory for each deployment profile also
remains to be supplied and checked after B0 integration.

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
a lookup error, surfaced by the unmounted reconcile handler as
`Account reconciliation failed`. Both managed lookups stop at ten candidates.

Existing invite/remove response strings remain byte-identical through explicit
message selection; new internal codes are stripped at the reference boundary.
No sender, base URL, locale, receipt key or observed request-ID change is intended.
The new, unmounted reconcile source can answer the five domain refusal codes as
messages, plus `Customer session required` or `Account reconciliation failed`.
Those are new endpoint-source outcomes, not an activation of a route.
