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
redirect policy, feature flags, rate limiting, mail transport and route observation
remain application composition. The send-email hook remains in the reference
application for the communications boundary.

The module imports foundation modules only through `bff`, `data`, `http` and
`kernel` entries. Its source layout is flat except for the isolated contracts
subtree. Managed adapters accept structural clients; token adapters accept a JWT
library loader. Loading the server entry reads no environment, initializes no SDK
and executes no SQL. A host selects the adapter and supplies its configuration.

Customer reconciliation refuses a principal its verifier reports as unverified,
reserved machine principals, conflicting links and a principal/account email
mismatch. Verification is the composed verifier's decision: the managed verifier
also accepts `user_metadata.email_verified`, which a user can edit, so a host
mounting reconciliation composes a confirmation-only verifier. It retries the email
branch once after a concurrent create failure. The new
[`createReconcileAccountHandler`](../../packages/platform/src/identity/reconcileAccountHandler.ts)
returns those refusals as 400, 403 or 409 and has no personalization hook.

The soft-account linker attempts identity creation first, then scans the existing
directory only after an already-registered response. Both directory adapters
follow `nextPage`, compare trimmed lowercase addresses, propagate lookup failures
and refuse after 5000 scanned users. Invite side effects retain the original
request address. The invite use case still checks only the caller's role; the
HTTP authorizer separately requires active membership. Null and unknown stored
roles still normalize to admin in that authorizer. Those are characterized
compatibility behaviors, not a new authorization policy.

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
- W2/W3: [`adminConformance.test.ts`](../../packages/platform/test/identity/adminConformance.test.ts), using the real authorizer at invite/remove HTTP gates and retaining the role fallback and role-only use-case behavior.
- W4: [`inviteLookupConformance.test.ts`](../../packages/platform/test/identity/inviteLookupConformance.test.ts), covering pagination, normalization, cap, errors, effect ordering and retained request spelling.
- The imported engine, profile, session and adapter tests sit beside these witnesses; [`sql.test.ts`](../../packages/platform/test/identity/sql.test.ts) verifies canonical projection identity.

The browser runtime-schema move remains pending: the existing schemas use Zod,
but the contracts boundary admits only own-contract files and public core entries.
This candidate retains those runtime schemas in the reference application rather
than weakening that boundary. Completing that move needs an explicit boundary
choice. A concrete default schema inventory for each deployment profile also
remains to be supplied and checked after B0 integration.

## Source move map

Paths below the package column are relative to `packages/platform/src/identity/`.
Compatibility paths delegate to the package; application composition remains at
the original route/runtime paths.

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
| `server/adapters/platform/operatorTokenAdminAuth.ts` | `operatorTokenAdminAuth.ts` |
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

Existing invite/remove response strings remain byte-identical through explicit
message selection; new internal codes are stripped at the reference boundary.
No sender, base URL, locale, receipt key or observed request-ID change is intended.
The new, unmounted reconcile source can answer the five domain refusal codes as
messages, plus `Customer session required` or `Account reconciliation failed`.
Those are new endpoint-source outcomes, not an activation of a route.
