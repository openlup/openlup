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

<!-- openlup-doc-impact {"unit":"domain-auth","digest":"sha256-f25e1e3b41dad3096070405d6c8774e113769332de199a5f4ad0fc6920afc26f","reason":"Comment-only delta. The verify-URL builder and its test name a downstream operator probe and a retired Edge copy by role instead of by path. The auth contracts and flows described here are unchanged."} -->

The [identity module owner](../../../docs/platform/IDENTITY.md) maps the import,
characterized lookup/fence differences, conformance witnesses and incomplete
readiness/schema evidence.
