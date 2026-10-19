# auth domain

Provider-agnostic customer authentication: passwordless magic-link plus
configured social OAuth kinds, and the rule for mapping an authenticated
principal onto a customer account (auto-provision new, relink existing by
verified email, never silently duplicate).

## Owns / does not own
- **Owns:** the `CustomerAuthPort` contract, OAuth provider kinds, and the auth-reconcile contract/error codes.
- **Does not own:** session persistence, the customer account schema (`clients` is one adapter's table), email/magic-link delivery (`communications`), rate-limiting (`platform`), or any provider SDK.

## Public surface (import cross-domain ONLY these)

- `adminAuth.ts` — neutral `AdminSession` shell subset and pure provider selection.

The application composition passes its browser selection to `AuthProvider` through
the `providerKind` prop; pages consume the selected mode through the auth context. Direct operator auth
uses the browser-safe package port through the PostgreSQL HTTP adapter, persists
in tab-scoped `sessionStorage` with document-memory fallback, and rechecks `/me`
on restoration/focus. The shell maps package `accessToken` to `access_token`;
expiry and sign-out clear the auth-scoped query cache. Managed browser loading
is deferred until managed selection. See [direct human login](../../../docs/platform/IDENTITY.md#direct-human-login)
for callback, audience and delivery limits.

- `ports.ts` — `CustomerAuthPort`.
- `types.ts` — `OAuthProviderKind`, `AuthSession`, `AuthUser`.
- `contracts.ts` — `authReconcileResponseSchema`, `AuthReconcileErrorCode`.

## Where the code lives
- Browser values and provider parsing: `@openlup/platform/identity/contracts`; the old paths re-export it. Runtime Zod schemas remain in `src/domains/auth/contracts.ts` pending the isolated validator boundary.
- Server identity policy: `@openlup/platform/identity`; the former `server/domains/auth/` paths delegate there. Email-hook ports remain application source.
- Reference adapters (outside this domain):
  `src/integrations/supabase/customerAuthPort.ts` and
  `src/integrations/postgres/customerAuthPort.ts`, selected by
  `src/lib/auth/customerAuthPortFactory.ts`. Managed account linkage is separate
  under `server/adapters/supabase/`.

The domain contracts import no provider SDK or adapter. Reference adapter paths
are current source facts, not a deployment selection or a hosted-auth promise;
`src/lib/authBoundary.test.ts` enforces the adapter boundary.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.

<!-- openlup-doc-impact {"unit":"domain-auth","digest":"sha256-f3647d9c03866df6516d7b882708f91723f21b6bd888b869355a828928cbc105","reason":"Server re-export files for the reconcile engine and the auth verify-URL helper are removed and the server ports file drops identity-only re-exports nothing imports; callers import @openlup/platform/identity directly. The browser compatibility files described here are unchanged, and the email-hook ports stay application source."} -->

The [identity module owner](../../../docs/platform/IDENTITY.md) maps the import,
characterized lookup/fence differences, conformance witnesses and incomplete
readiness/schema evidence.

## Email association trust

The managed verifier now uses the confirmation timestamp; editable metadata is
not mailbox proof. Reconcile requires an injected email-trust policy before
email-based lookup/link/create. Existing principal links retain their matching
path. `EMAIL_TRUST_ENVELOPE_REFUSED` is HTTP 403 / `FORBIDDEN`;
`EMAIL_TRUST_SETTINGS_UNAVAILABLE` is HTTP 503 / `UPSTREAM_UNAVAILABLE`.
The browser schema includes both package-owned refusal codes through a local
literal tuple checked exhaustively against the package's code type. This keeps
the schema's package dependency type-only, so subscription reference builds
do not load the identity contracts entry at runtime. A contact row,
typed checkout address or soft-account link does not prove mailbox ownership.
The [identity owner](../../../docs/platform/IDENTITY.md) describes host binding,
cache limits and the explicit verifier-result-only migration option.

## Operator privacy client

`privacyClient.ts` uses browser-safe identity schemas and authenticated no-store
POSTs to the admin identity export/erase routes. It accepts contact/principal
references and a UUID idempotency key for erasure. Admin Settings mounts an
identity-only panel with explicit confirmation, coverage, named refusals, retained
obligations and receipt readback. Subject/session changes clear its in-memory
personal data and retry key, including late responses. It writes no export into
browser storage. Only a live human administrator may use either endpoint;
managed erasure explicitly refuses. See the
[identity contract](../../../docs/platform/IDENTITY.md#identity-personal-data).

## Auth email package delegation

The reference `server/domains/auth/authSendEmailHook.ts` delegates the existing
hook to `@openlup/platform/communications`, supplying the same renderer and
hidden-preview/environment observers. Content, transport and persistence remain
host inputs. Auth email DTOs/ports live in the isolated communications contracts
entry; the content-unavailable error retains its constructor identity through
the server export. Identity principal/session ports remain identity-owned.
The standard-webhook signature grammar, millisecond clock, stream-only body
reader, CORS/error bytes and template-control/send/ledger order are unchanged.
This import does not activate a hook or change an invitation's copy, dedupe or
expiry. The generic HTTP helper remains a separate protocol.
