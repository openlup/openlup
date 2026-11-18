Adds experimental typed catalogue serving for native publication. The listing,
detail, quote and editor readers resolve the same installed publication and
document evidence. They distinguish an empty catalogue from unreadable or
inconsistent authority. Sale-unit price selection stays with the existing price
authority. Retained customer order and stock-wait display can carry the
exact content from a versioned accepted reference; the order line and stock
deficit still count sellable units. Structured Product data derives weight
only from explicit mass, while the product-registration adapter uses gross
mass supplied for packaging.

Migration: apply the complete native catalogue through
`20261123230000_catalog_quantity_serving.sql`. Verify installed type versions,
then opt in to the V2 serving reader with the intended types and offer version.
The native writer stores exact net content and independent gross mass. Existing
positive gram quantities still read through V1. A valid typed quantity without
an exact positive signed integer gram projection requires V2. The existing
migration-owner backfill converts only known positive grams. It preserves
unknown legacy zero values. The write-time compatibility check applies to
the governed projection of a published SKU. Legacy editor cache records keep
their existing shape. Qualified native restore runs the same check before
verifying exact retained row contents.
Existing drafts, publication history, order lines and agreed prices retain
their original representation. Native stock-wait hosts opt into typed
readback with `retainedContent: "v2"`, or supply the renewal codec when
composing typed notices.

Managed divergence design: add the nullable quantity columns with an exact
gram compatibility check and allow the managed product-type-specific columns
to be null when a different registered type supplies the required facts.
The existing managed publication authority and its RLS and role grants remain
the authority. A managed writer would maintain the new projection atomically
with its selected head and membership. Historical order and stock-wait
snapshots keep their existing bytes and gain a typed display fact only for new
accepted lines. The managed rail does not supply this feature.
