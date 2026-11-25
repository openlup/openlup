# Starter limits

Status: current starter navigation for stable 1.x.

Read the installed guide at
`node_modules/@openlup/core/docs/guide/reference/limits.md`, or the
[current source guide](https://github.com/openlup/openlup/blob/main/packages/core/docs/guide/reference/limits.md).
It owns session/security limits, shipment projections, purchase bounds and named
refusals. The [operation catalogue](../shared/limits.ts) supplies the exact
localized explanations used by action results and the limits page.

Use the [starter verification recipe](proof.md) for current checks and the
[application README](../README.md) for installation and composition.

The [complete previous limits record](https://github.com/openlup/openlup/blob/main/docs/platform/history/neutral-store-limits-2026-11-13.md)
retains dated evidence and earlier composition checkpoints. It is not the current
limits contract.

## Published catalogue and quote

Published products display a title or localized short name and an optional
local image. Long descriptions, product details and pack contents display as
empty copy.

The native storefront and strict quote share a ceiling of 500 active sellable
SKUs. Seeded catalogue and synthetic editor rows consume that capacity.
Active sellable SKUs in other offers count too. If the storefront refuses with
`starter_catalogue_page_limit`, reduce active sellable SKUs through the
catalogue workflow, then reread and quote the same SKU. Retry a moved head from
the first page. For an invalid cursor, verify the installed reader before retrying.

Use a publication schema distinct from `quote.document.schemaId`. If an active
publication collides with the application schema, withdraw the colliding product
through the governed catalogue commands, then repeat the original quote. If a
published document fails identity, canonical encoding or digest verification,
restore the admitted revision from a verified backup and repeat that quote.

Published products can list and quote before purchase is enabled. The governed
checkout action returns `catalog_admission_quote_authority_required` while that
purchase authority is unavailable.

## Reviewed checkout total

Each fresh checkout in either purchase mode must send the reviewed
`expectedTotal` from `offer.validate`. Use a nonnegative safe integer in
minor units and its uppercase three-letter currency. For
`starter_expected_total_required` or `starter_quote_price_changed`, refresh
the review and confirm the displayed price before placing the order again.
If refresh fails, submit again to retry the review with your current details,
then reconfirm once the price renders.

A definitive total refusal retires the command key. After reconfirmation,
use a new key even if the refreshed amount and currency are unchanged.
An uncertain retry keeps the exact payload and command key.
