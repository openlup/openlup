Adds experimental typed catalogue serving for native publication. The listing,
detail, quote and editor readers resolve the same installed publication and
document evidence. They distinguish an empty catalogue from unreadable or
inconsistent authority. Sale-unit price selection stays with the existing price
authority.

Migration: apply the complete native catalogue through
`20261123230000_catalog_quantity_serving.sql`. Verify installed type versions,
then opt in to the V2 serving reader with the intended types and offer version.
The native writer stores exact net content and independent gross mass. Existing
positive gram quantities still read through V1. A valid typed quantity without
an exact positive signed integer gram projection requires V2. The existing
migration-owner backfill converts only known positive grams. It preserves
unknown legacy zero values. Qualified writer roles need EXECUTE on
`public.catalog_legacy_net_grams(uuid,text,pg_catalog.numeric,integer,text)` alongside the
catalogue writer's existing privileges and visibility of bound definitions.
Existing drafts, publication history, order lines and agreed prices retain
their original representation.

Managed divergence design: add the nullable quantity columns with an exact
gram compatibility check and allow the managed product-type-specific columns
to be null when a different registered type supplies the required facts.
The existing managed publication authority and its RLS and role grants remain
the authority. A managed writer would maintain the new projection atomically
with its selected head and membership. Historical order and stock-wait
snapshots keep their existing bytes and gain a typed display fact only for new
accepted lines. The managed rail does not supply this feature.
