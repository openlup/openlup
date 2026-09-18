# auth domain

Provider-agnostic customer authentication: passwordless magic-link plus
configured social OAuth kinds, and the rule for mapping an authenticated
principal onto a customer account (auto-provision new, relink existing by
verified email, never silently duplicate).

## Owns / does not own
- **Owns:** the `CustomerAuthPort` contract, OAuth provider kinds, and the auth-reconcile contract/error codes.
- **Does not own:** session persistence, the customer account schema (`clients` is one adapter's table), email/magic-link delivery (`communications`), rate-limiting (`platform`), or any provider SDK.

## Public surface (import cross-domain ONLY these)
- `ports.ts` — `CustomerAuthPort`.
- `types.ts` — `OAuthProviderKind`, `AuthSession`, `AuthUser`.
- `contracts.ts` — `authReconcileResponseSchema`, `AuthReconcileErrorCode`.

## Where the code lives
- Shared/frontend: `src/domains/auth/`
- Server (pure): `server/domains/auth/` (`reconcileAccountForPrincipal.ts`, `ports.ts`)
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
