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

## Isolated product drafts

`catalogDraftContracts.ts`, `catalogProductTypeContracts.ts` and
`server/domains/catalog/catalogDraftValidation.ts` are a dark,
development-preview draft seam. Product types are installed by composition,
never supplied as draft data, and absent facts stay readiness issues.

- A quantity dimension may declare `role: "net_content"`; a type has at most
  one, and all of its units must be net-content units. A SKU option on it must
  state the same quantity as the SKU's `netContent`
  (`net_content_option_mismatch`): decimal spellings compare equal and units
  are never converted.
- `gs1:gtin` is the only accepted `gs1:` scheme
  (`trade_identifier_scheme_unsupported`), and its value needs a valid check
  digit (`trade_identifier_invalid`). One GTIN is one identity whatever its 8-,
  12-, 13- or 14-digit spelling or issuer text, so it appears once per draft
  (`duplicate_trade_identifier`).
- A `case` identifier states how many units it holds (`quantity` of at least
  2); a `unit` identifier states none or 1 (`trade_identifier_quantity_invalid`).
- A SKU without a unit-level `gs1:gtin` reports `unit_trade_identifier_missing`
  in commercial readiness.

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

<!-- openlup-doc-impact {"unit":"domain-catalog","digest":"sha256-75f0d8ff251f0c5af56c946347f27eb67b03fbbd5932a54828d5d0a9dd8db1cf","reason":"Comment-only delta. Three catalog model comments name the deployment's data modules by role and drop pointers to planning documents. No catalog model, contract or seam described here changes."} -->
