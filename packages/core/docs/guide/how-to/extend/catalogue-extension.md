# Catalogue extension recipes

Use matching installed `@openlup/*` versions and Node 24. Check an application-owned
pack with `catalogue project --trusted-packs`. The module exports
`catalogueConformance`, whose `packs` list pairs each authoring pack with its
fixtures. Keep its imports and fixture setup silent and offline. Build the
authoring registry lazily from the same packs. The module and its imports run
with the operator's process permissions, so use this command only with trusted code.

The CLI writes deterministic UTF-8 JSON, with sorted keys and original array
order, to a private scratch directory. The CLI resolves symlinks and requires
scratch to be outside the working directory and every ancestor of the trusted
module with a `package.json`. The CLI reads the file back and checks those bytes once. Registered content validators must return
synchronously. The report gives the file, SHA-256, timings, checker invocation
count, recheck and inert replay commands. The scratch file can be deleted after replay.

`catalogue check --packs` reads inert JSON regardless of the file suffix.
The Node entry `runCatalogExtensionConformance(jsonText: string)` returns a Promise
and refuses non-string arguments without inspection or coercion. JSON definitions
omit `validateContent`. Replay reports unavailable content evidence and still
runs the other draft owner checks. `requiredChecks: ["draft-content"]` requires
at least one admitted fixture per pack that calls its content validator.

Each pack accepts `drafts`, `quantities`, `attributes`, `combinations` and
`refusals`. Drafts use the v1–v3 schemas and draft owners. Version 3 checks
operation and price shape. Quantity fixtures use `{type, value, targetUnit?}`,
explicit conversion factors, and a type key and version. Request
`attribute-values` or `variant-combinations` in `requiredChecks` to require their
fixtures in each pack.

Refusal and reference records and retained options describe fixture observations.
Installed state, price execution and publication require separate evidence and
authority. Exit 0 means supplied checks passed, 1 means an input violation, 2
means required evidence is unavailable, 64 means invalid command or inert JSON
syntax, and 74 means a load, I/O, integrity or unexpected validator failure.
Violations take precedence over unavailable evidence. JSON stdout is one
`formatVersion: 1` object. Findings retain owner codes, JSON pointers, cause, fix,
recipe, recheck and evidence, ordered by path, code and fixture.
An integrity failure such as `combination_identity_integrity_failed` exits 74.
The CLI withholds raw errors when loading the module or running its validators.

## New vertical

Copy the [TypeScript skeleton](./catalogue-pack-skeleton/catalogue.ts), rename its
namespace, edit `pack.ts` and `fixtures.ts`, and add each pack once in `catalogue.ts`.

```sh
mkdir -p owned/catalogue
cp node_modules/@openlup/core/docs/guide/how-to/extend/catalogue-pack-skeleton/*.ts owned/catalogue/
npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json
```

For inert checking, copy the [static JSON sample](./catalogue-pack-skeleton/catalogue.json)
and run `npx --no -- openlup catalogue check --packs ./owned/catalogue.json --json`.
For a capability declared `false`, record a refusal observation such as

```json
{"name":"feature refusal","capability":"feature","expectedCode":"owner_unsupported","observedCode":"owner_unsupported","zeroEffects":true}
```

The checker compares the codes and requires zero effects in the record. Requesting
`requiredChecks: ["owner-refusals"]` reports unavailable evidence until an owner
can execute that refusal. Usual codes include `pack_type_namespace_mismatch`,
`definition_unknown_field`, `draft_input_invalid`, `conformance_subject_invalid`,
`conformance_refusal_fixture_missing`, `conformance_refusal_fixture_invalid` and
`conformance_refusal_fixture_mismatch`.

## Add attribute

Edit `pack.ts`. Metadata example: `attributes: [{key: "finish",
scope: "variant", valueType: {kind: "boolean"}, required: false, cardinality:
{min: 0, max: 1}, filterable: true, facetable: true, public: true, displayOrder: 0,
labels: {en: "Finish"}}]`. In `fixtures.ts`, `attributes` fixtures call `validateCatalogAttributes` and
`prepareCatalogAttributeProjection` with `{type, input, publicationRevision,
references?}`. `input` contains `productAttributes` and `skus: [{id, attributes?}]`.
Missing required values/locales, scope, unknown keys, storage and projection-text
bounds retain exact owner diagnostics. Successful rows preserve the owner's exact
projection values; no projection is written. Attribute values stay outside v1 drafts.
`references` is an optional array of `{namespace, id, status}` observations.
One unique `resolved` row supports fixture PASS; absent, omitted, duplicate or
`unavailable` evidence yields 2. Unique `dangling` or `private` yields 1.
All unresolved references retain `attribute_reference_unresolved` and its owner
path. Actual publication and generation serving remain pending. A new attribute
kind requires upstream work. Usual owner codes:
`attribute_projection_text_too_large`, `attribute_storage_too_large`,
`attribute_values_invalid`, `attribute_value_invalid`, `attribute_unknown_key`,
`attribute_scope_conflict`, `attribute_cardinality_invalid`, `attribute_required_missing`,
`attribute_required_locale_missing`, `attribute_reference_unresolved`,
`attribute_publication_revision_invalid`.
Usual metadata codes:
`definition_attribute_invalid`, `definition_duplicate_attribute`,
`definition_facetable_not_filterable`, `definition_unknown_attribute_unit`,
`definition_duplicate_enum_value`. Check:
`npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json`.

## Add unit

Edit `pack.ts`: `units: [{code: "stationery:each", dimension:
"count", integral: true, factor: {canonicalUnit: "openlup:piece", unscaled: "1",
scale: 0}}]`. Add `{type: {key: pack.types[0].key, version: pack.types[0].version},
value: {dimension: "count", unit:
"stationery:each", unscaled: "2", scale: 0}}` to `quantities` in `fixtures.ts`.
Exact conversion is available; new dimensions require upstream grammar changes.
Usual codes: `definition_unit_invalid`, `definition_unit_factor_invalid`,
`definition_duplicate_unit`, `definition_net_content_invalid`,
`definition_unknown_net_content_unit`, `definition_duplicate_net_content_unit`,
`quantity_invalid`, `quantity_cross_dimension`, `quantity_fractional_count`,
`quantity_unknown_unit`, `quantity_overflow`, `quantity_not_exactly_representable`.
Combination quantities additionally refuse `unit_factor_missing` until their
installed definition declares an explicit exact factor.
Check: `npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json`.

## Add axis

Edit `pack.ts`: `dimensions: [{key: "finish", kind:
"boolean"}], axes: [{key: "finish", attributeKey: "finish"}]`, referencing a
variant attribute in the same type. In `fixtures.ts`, `combinations` fixtures call `canonicalizeCatalogCombinationV2` and
`validateCatalogCombinationChangesV2` with `{type, input}`. Input contains
`axes`, `typed`, `retained`, `incoming` and optional `capacity`. Each row has a
nonempty string `skuId`, `state: "draft" | "active" | "withdrawn"` and
`optionValues` (object or null). Incoming options may be omitted to preserve a
retained fixture's values; retained options are required. Rows are closed and
admitted before the typed owner; malformed rows report `conformance_subject_invalid`
at the row pointer. Retained JSON never contains identity bytes: identities are
derived from options internally. No Cartesian product is enumerated. Fixture PASS
does not validate stored identity bytes or history. With supplied fixtures,
`requiredChecks: ["variant-combinations"]` checks this owner offline.
New attribute kinds/dimensions are upstream work. Usual codes:
`definition_dimension_invalid`, `definition_axis_invalid`, `definition_duplicate_axis`,
`definition_unknown_axis_attribute`, `definition_axis_scope_invalid`,
`definition_unknown_axis_dimension`, `definition_duplicate_dimension`,
`definition_duplicate_choice`, `definition_duplicate_dimension_unit`,
`definition_dimension_unit_mismatch`, `definition_net_content_unit_mismatch`,
`definition_multiple_net_content_dimensions`.
The combination owner also reports `axis_not_installed`, `duplicate_axis`,
`option_not_selected`, `option_missing`, `option_invalid`,
`sku_identity_change_requires_new_sku`, `duplicate_combination`,
`combination_identity_integrity_failed` and `duplicate_sku_id`. Use stable enum IDs and
complete options; a changed canonical identity requires a new SKU. Compare bytes
on a digest conflict and refuse both duplicates and collisions without merging.
Inconsistent authoritative bytes/digests and digest collisions are integrity
failures: investigate them without changing retained identities. The earlier
`combination_digest_collision` code remains in the exported union and guidance
record for compatibility; the owner now emits `combination_identity_integrity_failed`.
`sku_payload_limit` bounds one incoming payload at 10,000 SKUs, separately from
configured retained product capacity (default 50,000), reported by
`product_capacity_exceeded` or `product_capacity_invalid`. Persisted incremental
publication and its authority/races remain with the publisher.
Check: `npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json`.

## Add tax class

Edit `pack.ts`: `taxClasses: [{key: "standard"}]` and
`taxClass: "standard"` on the type. Default class references are checked now;
market-owned dated rates in `owned/market-packs/<market>/tax-table.ts`, coverage,
gaps/overlaps and tax publication await their owners. No fake rate data belongs
in this skeleton. New attribute/dimension/promotion kinds remain upstream work.
Usual codes: `definition_tax_class_invalid`, `definition_unknown_tax_class`.
Check references: `npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json`.
Requesting `requiredChecks: ["tax-coverage"]` returns 2 until its owner is available.

## Add category or collection

Request evidence in `catalogue.ts`. Set `requiredChecks:
["taxonomy"]`. Graph/depth and collection-reference validation and publishing are
pending; there is no admitted category field to paste into current pack metadata.
Usual current code: `conformance_owner_unavailable`; future codes belong to the
taxonomy owner. New closed grammar kinds require upstream work.
Check availability: `npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json`.

## Promotion with existing grammar

In `catalogue.ts`, set `requiredChecks:
["promotions"]`. Target/currency validation and publishing are pending, including
per-currency money maps; do not invent a campaign field here. New benefit/target
kinds require upstream work. Usual current code: `conformance_owner_unavailable`.
Check availability: `npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json`.

## Subscription profile

Edit metadata in `pack.ts`: `subscriptionProfiles: [{key:
"stationery:repeat", version: 1}]`, with the same `subscriptionProfileRef` on a
type. Reference checking is available. Cadence bounds, demand pools, unit
compatibility, overflow and runtime composition await the profile owner; request
`requiredChecks: ["profiles"]` for those checks. Never infer a database cadence
bound. New closed grammar kinds require upstream work. Usual codes:
`definition_profile_ref_invalid`, `definition_unknown_profile_ref`.
Check: `npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json`.

## Upgrade a definition

Edit `pack.ts`, keeping the old version composed. Example:
`key: "stationery:notebook", version: 2`. Every digest-covered change gets a new
version; see the installed [canonical agreements](../../concepts/architecture-and-ownership.md).
The offline checker finds duplicates and invalid metadata; it cannot compare an
installed digest or authorize replacement, migration or publication. Those remain
with the installer and later writers. New kinds/dimensions/benefits require upstream
work. Usual codes: `definition_version_invalid`, `definition_duplicate_identity`,
`definition_validator_ref_invalid`. Check:
`npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json`.
