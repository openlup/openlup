Adds experimental typed catalogue serving for native publication. The listing,
detail, quote and editor readers resolve the same installed publication and
document evidence. They distinguish an empty catalogue from unreadable or
inconsistent authority. With an explicit market price context, listing and
detail resolve effective sale-unit money using the existing price authority
in the same database snapshot. A missing price disables the applicable
purchase mode. Retained customer order and stock-wait display can carry the
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

The managed twin adds exact canonical quantities and a checked nullable gram
projection to the existing `catalog_skus` row. The existing product document
pointer remains authoritative. The migration keeps the incumbent mandatory
columns and role policies for unbound compatibility. The optional managed
content projection verifies document ownership and rejects inconsistent gram
facts. Host activation and the legacy-column relaxation require a separate
managed compatibility transition.

Before applying the neutral starter's managed-file upgrade, use the candidate's
catalogue upgrade step to reconcile the original owned registry and catalogue
labels. The new registration specifies the definition install, scope and draft
type for the selected configuration. The host receives the existing legacy
quote path and can opt in to the same installed serving reader for checkout
and edit. Preserve frozen admission facts from `buildCatalogAdmissionFromServing`
for the accepting transaction to recheck.
