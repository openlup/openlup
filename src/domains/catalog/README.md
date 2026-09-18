# catalog domain

Product / SKU / variant / price metadata, product composition, allergen links.
Mounted public product routes use the strict database-backed catalog projection.
The separate default-off storefront-product readback is DB-only behind
`COMMERCE_V2_CATALOG_DB_SHADOW`; it has no static fallback.

## Owns / does not own
- **Owns:** product, SKU, variant, price metadata, composition, allergen-link contracts, strict active DB-backed read ports, and reference/fixture adapters.
- **Does not own:** cart/checkout/payments, fulfillment, concrete pet allergy selections.

## Public surface (import cross-domain ONLY these)
- `catalogClient.ts` — typed public catalog BFF client.
- `adminCatalogPacksClient.ts` — typed admin catalog-pack BFF client.
- `contracts.ts` — product/allergen read contracts.
- `ports.ts` — catalog read port.
- `catalogFoundationContracts.ts` — dark, payload-free W2a SKU/document
  envelope and price-context contracts. The envelope is a row-safe persistence
  seam, not a current storefront reader or an authority cutover.
- `types.ts` — product/SKU/variant types.
- `staticProductAdapter.ts` — reference/fixture adapter; it is not a mounted
  customer-runtime fallback.

## Where the code lives
- Engine: `packages/core/src/catalog/identifiers.ts`, exposed as
  `@openlup/core/catalog` — the slug, SKU, product-id and variant-id primitives.
  They validate shape only; membership belongs to the read port, so a
  runtime-editable catalogue never needs a package release to accept a new slug.
  `slugFormat.ts` in this directory is a re-export shim over them, not a second
  copy. A format change belongs in the core package.
- Shared/frontend: `src/domains/catalog/`
- Server: neutral catalog ports under `server/domains/catalog/`, with the managed adapter at `server/adapters/supabase/catalogRead.ts`
- BFF routes: strict deployment-owned handlers exposed through
  `/api/bff/catalog/…`; legacy `server/bff/catalog/…` handlers are unmounted.

`NeutralSkuEnvelopeV1` carries only structural SKU data, immutable
product-scoped document references, identifier authority and opaque asset refs.
It must never grow a document payload or a SKU-level document override.
`CatalogSkuEnvelopeReadPort` supports exact detail lookup by SKU code or by a
product slug's declared `primary_sku_id`; the UUID lookup remains available for
compatibility. Slug lookup never guesses a primary SKU from weight, order or
sellability.

## Public navigation and availability

Use [Architecture and extension boundaries](../../../docs/platform/ARCHITECTURE_AND_EXTENSIONS.md)
for public ownership and extension seams, and the
[publication catalog](../../../config/openlup-publication-catalog.json) for the
bounded public-source inventory. A repository path establishes source existence
at the reviewed commit; a listed `/api/...` value is a logical interface
coordinate. Mounting needs separate dispatcher or registry evidence, and even a
mounted reference interface is not proof that an adopter deployment exposes it.
