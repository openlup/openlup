# Customer identity in the reference browser

Status: development-preview reference-application behaviour. This composition
adds no package API, database object, identity transfer or release authority.
The package [identity guide](IDENTITY.md) owns server identity contracts.

The browser import inventory lists the exact built files reached through
`@openlup/platform/commerce` and its type-only contracts entry. The complete
commerce runtime is checked with a browser bundle. The Node-only
`@openlup/platform/commerce/server` entry remains outside the closed inventory;
the profile build test explicitly proves that it is refused, alongside the
Node-only pricing root. The additive `pricing/browser` entry contributes exactly
its built entry, quote primitives, acquisition validators and acquisition
contract constant, plus the existing pure shipping-terms owner. The latter lets
the strict reference quote context carry optional shipping/acquisition promises;
shipping handlers and Node HTTP declarations remain outside this closure. No
directory wildcard or other pricing implementation is admitted.
The commerce barrel also reaches pure OMS schemas and read-model helpers, plus
their core fulfillment, payment and subscription runtime dependencies. It also
exports returns request/approve/reject schemas and port types, with a factory for
host-bound request reason codes, native order-review contracts and hosted-feedback
contracts. Both identity and subscription inventories list each emitted module
in that complete browser-safe closure as an exact built path, including
`commerceReturnsPort.js`, `orderReviewContracts.js` and `orderFeedbackContracts.js`
under `packages/platform/dist/commerce/`. Returns and review
handlers, the raw-upload handler and PostgreSQL/Supabase adapters, including
hosted-feedback adapters, remain outside the closure, exposed only by
`@openlup/platform/commerce/server`.
The checkout-engine contribution adds exactly `commerce/checkoutCommandSchemas.js`,
`commerce/offerEvidenceSchemas.js` and `commerce/paymentContinuation.js` to the
identity inventory. They supply browser-safe validation and lifetime constants;
checkout execution remains outside this profile in `commerce/server`.
The subscription profile also lists the pure commerce checkout-command, offer-
evidence and payment-continuation helpers by exact built file. Its starter
expectation validator binds the existing `pricing/browser` export by identity.

## Routes and readiness

The opt-in subscription profile mounts `/sign-in`, `/account/auth/callback` and
`/account` in English, and `/zaloguj-sie`, `/konto/auth/callback` and `/konto` in
Polish. Static reference pages keep their original hydration and never initialize
customer authentication. Post-checkout sign-in navigates to the dedicated login
page. Account entry redirects an unauthenticated visitor to the matching login.

One `CustomerAuthProvider` owns login, callback and account. An account requires
both a session and a linked `/api/bff/customers/me` profile; a session alone is
insufficient. Return targets first pass the existing normalization, then must
be exactly `/account` or `/konto`. Other destinations, external origins and
callback loops return to the matching account root. Before requesting sign-in,
the page replaces the query target with that account root and saves it for the
callback, so the adapter sends the same normalized target to the BFF.

## Sign-in and callbacks

The form normalizes email and shows the same accepted notice for any accepted
request. Acceptance confirms neither account existence nor mail delivery.
Request-again, change-address and code fallback actions preserve server refusals and
rate limits. Pending operations disable duplicate submissions. Page errors are
localized and never include provider messages or account-link conflict details.

The selected managed adapter uses its SDK for magic-link callbacks and a 6–8
digit code fallback. Code verification uses the SDK
`email` flow, which accepts both first-login confirmation and returning sign-in
codes. Its supported external sign-in option is rendered only
when configured; identifiers and display descriptors come from the adapter.
The captured subscription profile forces an empty external-provider list. The
direct adapter accepts its existing opaque 16–256 character challenge token in
a text input, exposes no external sign-in, and skips managed reconciliation.
The adapter factory loads only the selected implementation. A lazy port wrapper
preserves existing synchronous session-presence callers while the provider
awaits its binding under a bounded bootstrap timeout.
The compatibility wrapper resolves a failed session read to `null`, so ordinary
checkout continues as a guest without an `Authorization` header. The provider
reads the binding directly and retains strict bootstrap failure handling.

The callback page consumes only the provider's closed outcome: success, invalid,
expired, timeout, uncertain transport, failed or unknown. Success navigates only
after the linked profile is ready. An older session cannot override a recognized
callback failure. Missing profiles show account unavailable. The adapter consumes
credentials before the provider removes callback query and fragment fields,
including failure descriptions. Raw callback input never becomes page copy.

## Browser persistence and logout

| Purpose | Key | Contents |
| --- | --- | --- |
| Managed SDK | `customer.auth.managed.v1` | SDK session encoding |
| Direct adapter | `customer.auth.direct.v1` | Session with expiry |
| Returning hint | `customer.login.hint.v1` | Only `method: email / social` and `savedAt` |

Hints expire after 60 days and are never authentication evidence. Names, email,
preview personas and industry-specific hint fields have been removed. Superseded
customer storage is removed best-effort; there is **no legacy-session migration**.
Existing reference customers sign in again once. Denied storage must not crash
the page; persistence across reload is unavailable when storage is denied.

Account reads and mutations use the provider's bearer. Query identity includes
both the principal and linked client, never the token. The reference mounts the
same `appQueryClient` that the provider clears. Logout invokes the selected port,
clears local session/profile and auth queries, closes the renewal dialog, clears
selection and returns to login. Non-null adapter events are ignored after logout
until the customer explicitly starts email, code or external sign-in again. Late
bootstrap/profile results cannot restore a logged-out account; principal changes
cannot display the preceding account. Managed logout clears the effective SDK
session store, including its memory fallback, even when remote revocation fails,
then completes SDK cleanup without a stored bearer. A fresh bootstrap remains
signed out.
This does not promise server JWT revocation or synchronous logout in every tab.

## Captured profile composition

The existing email-only request remains compatible. Optional `locale` and
`returnTo` accept the customer client's language and mounted account roots.
Captured sign-in retains `shouldCreateUser: true`, captured SMTP, same-origin JSON,
rate limits, disposable-installation checks and existing reconciliation refusals.
The only added API route is **GET `/api/bff/customers/me`**, composed with the
identity module's own-profile handler and bearer-bound customer client. The
service client is never its profile reader. No other API is activated.

Only this opt-in profile changes CSP: `connect-src 'self'` gains exactly the
validated configured auth origin (for example `http://127.0.0.1:56821`). The
server derives it from the same validated configuration it already reads.
Invalid or absent origins add nothing. `form-action 'self'` and the absence of
`frame-src` remain unchanged; no wildcard, scheme-only source or `unsafe-*`
source is added. The pre-existing `style-src 'self' 'unsafe-inline'` is unchanged.
The default static profile's CSP is unchanged.

The closed build graph adds exact page/provider and transitive dependency paths.
For the subscription build, Vite passes only the public auth URL,
public publishable key, adapter selector and empty external-provider list. It
never exposes the environment wholesale or a service credential. Build core and
platform first, then build with the owned environment; see the
[subscription evaluation instructions](SUBSCRIPTION_REFERENCE.md).

## Conformance and remaining runtime proof

The required-selection journey is
[`browserIdentity.test.tsx`](../../src/public-reference/browserIdentity.test.tsx).
It mounts the real provider, pages, router, shared query client and account with
controlled ports and BFF transport. Return-target cases use the actual managed
adapter and BFF client to assert the outgoing request body. Adapter tests cover
selection, legacy-key refusal, method-only hints and return targets. A real SDK callback test supplies
realistic callback fields and a controlled SDK transport, and checks fresh
bootstrap after returned or thrown remote logout failures. Server tests cover
localized mounts, exact CSP and bearer-bound own-profile reads.

The [browser acceptance spec](../../tests/preview/account/customer-browser-identity.spec.ts)
requires the sealed disposable installation, running subscription build/server,
local captured mailbox, installed Playwright Chromium and remaining limiter
budget. It fails on missing setup. Credential-bearing traces, screenshots and
video are disabled. Run the exact command in the subscription guide.

The [PostgreSQL proof](../../tests/postgres/customer_browser_identity.test.ts)
requires Docker and `postgres:16`. It applies the complete existing selected
catalogue, requests/redeems real challenges, signs/verifies real sessions and
reads profiles through the authenticated actor lane. Replay, expiry, cross-owner
refusal, durable client/subscription identity and unchanged migration ledger are
asserted. It adds no migration or schema-parity claim. Component checks do not replace the installation proofs.

## Selected identity profile

`OPENLUP_REFERENCE_PROFILE=identity` selects
[`identity-main.tsx`](../../src/public-reference/identity-main.tsx) and its
[closed import inventory](../../config/public-reference-identity-imports.json).
This is a disposable evaluation profile; the default static entry and the
subscription profile remain separate selections. Only the explicit public
browser auth settings are exposed to its bundle; server keys are excluded.

The selected profile mounts `/sign-in`, `/account/auth/callback` and `/account`
under the existing customer provider. The account view waits for session
bootstrap, requires the linked profile and offers logout. It neither signs up
unknown addresses nor creates a separate session store.

`/admin/login`, `/admin/auth/callback` and `/admin` mount the existing operator
pages beneath their own provider. Direct selection passes `providerKind="direct"`;
managed selection omits it. The landing page requires the provider's live
recognized role. Administrators see the existing identity privacy panel;
distributors do not. Customer and operator session state stay independent.
The callback keeps the existing authorization-before-navigation behavior.

The [identity acceptance commands](IDENTITY.md#disposable-identity-reference)
exercise these mounts against owned local services. Credential-bearing browser
artifacts and reporter output are disabled. They do not claim browser or
installation coverage merely because the bundle compiles.
