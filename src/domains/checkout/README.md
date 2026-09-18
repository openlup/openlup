# checkout domain

Small shared helpers for checkout idempotency. The current commerce checkout
boundary does **not** use this folder as the checkout engine: it validates body
`intent.idempotencyKey` in `src/domains/commerce` and then suffixes that key
through order, inventory, payment-control, and provider work.

## Owns / does not own
- **Owns:** compatibility exports for `@openlup/core/checkout`.
- **Does not own:** pricing, order persistence, payments (all in `commerce`/`payment`).

## Public surface (import cross-domain ONLY these)
- `checkoutIdempotency.ts` — `CHECKOUT_IDEMPOTENCY_KEY_HEADER`,
  `validateCheckoutIdempotencyHeader`.

## Header idempotency reference flow
The `Idempotency-Key` header helper is a reference contract only. If a BFF
handler adopts it, that handler must also wire the persistence workflow against
the existing `commerce_idempotency_keys` shell table with `scope='checkout'`:

- `in_progress` -> return `409` with a retry-after hint.
- `completed` -> return the cached `response_payload` for idempotent replay.
- `failed` -> require a fresh key for a force-retry.
- missing row -> insert `in_progress`, proceed with checkout work, then mark
  the record `completed`.

The current commerce checkout path does not read this header contract; it
validates body `intent.idempotencyKey` in `src/domains/commerce` and carries
that key through order, inventory, payment-control, and provider work.

The browser-facing checkout endpoint is `POST /api/bff/commerce/checkout`.
Its handler is registered under `server/bff/commerce`, while the physical
Vercel catch-all entrypoint remains `api/bff/[...path].ts`. The public server extension boundary is in
[Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md); the deployment handler and its conformance tests own the exact request, authentication, error, and replay
contract.

## Where the code lives
- Core package: `packages/core/src/checkout/` (pure helper; no server half).
- Shared/frontend compatibility: `src/domains/checkout/` re-exports the package
  by name so existing product imports remain stable before the OSS split.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
