# checkout domain

Small shared checkout helpers. The current commerce checkout boundary does
**not** use this folder as the checkout engine: it validates body
`intent.idempotencyKey` in `src/domains/commerce` and then suffixes that key
through order, inventory, payment-control, and provider work.

## Owns / does not own
- **Owns:** `checkoutPaymentMethods.ts`, the closed set of payment methods a
  buyer can choose at checkout.
- **Does not own:** pricing, order persistence, payments (all in `commerce`/`payment`).

## Public surface (import cross-domain ONLY these)
- `checkoutPaymentMethods.ts`.

The checkout path does not use an `Idempotency-Key` header contract, and
`@openlup/core` no longer exports one.

The browser-facing checkout endpoint is `POST /api/bff/commerce/checkout`.
Its handler is registered under `server/bff/commerce`, while the physical
Vercel catch-all entrypoint remains `api/bff/[...path].ts`. The public server extension boundary is in
[Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md); the deployment handler and its conformance tests own the exact request, authentication, error, and replay
contract.

## Where the code lives
- Shared/frontend: `src/domains/checkout/`.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
