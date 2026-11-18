# Catalogue extension recipes

Development preview, targeting the next package set. Use matching installed
`@openlup/*` versions and Node 24. This offline tool checks definitions,
references, exact quantities and supplied draft facts through v5. It grants no installation,
migration, publication or activation authority. The minimal skeleton is a fictional
stationery pack; full reference packs and installed commerce journeys remain pending.

Native lifecycle authoring and immutable accepted references have separate
platform contracts. In an installed application, read the catalogue section of
`node_modules/@openlup/platform/README.md` with the matching package declarations.
The offline checker supplies no lifecycle, obligation-query or acceptance-barrier
qualification; its fixture observations do not infer historical subscriber bindings.

The inert JSON entry `runCatalogExtensionConformance(jsonText: string)` returns
`Promise<CatalogConformanceReport>`. Supply JSON text, parsed without a reviver.
Non-string direct arguments report `conformance_subject_invalid` (1) without
inspection or coercion; invalid JSON rejects with `SyntaxError`. The CLI reads
UTF-8 text and never imports the supplied file.

From the installed application, run:

```sh
npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue.ts --json
```

The starter's `catalogue:check:source` npm script runs the same command.
Use it only with your trusted module. It executes the module and its supplied
validators with the current process's permissions. Export an object named
`catalogueConformance` of type `CatalogConformanceSource` from the same
registry you use for runtime composition. Keep fixture imports and validators
deterministic and free of filesystem writes, network calls and database access.

Projection writes canonical JSON to a private scratch file outside the app and
calls the checker once on those bytes. The `transport` report carries the
scratch path, SHA-256, projection and checker timings, invocation count and
commands. Run `transport.recheck` from an independently prepared copy to replay
the trust-bearing check. Run `transport.replay` for the JSON-only check of that
scratch file. Content and host-policy callbacks require the trust-bearing
check and may give exit 2 in the static replay. Keep the scratch file only as
long as you need the evidence.

Each `packs` entry contains `pack` and optional `drafts`, `quantities`, `attributes`,
`combinations`, `profileChecks`, `profilePolicies` and `refusals`. The JSON subject
preserves data and artifact references and omits executable callbacks. A
supplied `validateContent` field in JSON refuses with
`definition_unknown_field`. Drafts requesting application content validation
return `conformance_owner_unavailable` (2) from the inert command. The trusted
command runs the registered callback on the same draft bytes.
Quantity fixtures contain `{type, value, targetUnit?}` and require explicit
conversion factors. Type references use a namespaced string key and positive
integer version; malformed references refuse before registry lookup. Quantity values have only
`dimension`, `unit`, `unscaled` and `scale`: the first three are strings and scale
is an integer. The shared owner retains domain, numeric and conversion bounds.

Use `requiredChecks` to require coverage in each pack. Available keys are
`quantities`, `attribute-values`, `variant-combinations`, `draft-content`,
`profiles` and `owner-refusals`. Draft content requires a current v3–v5 fixture
and the registered validator. Publication operations and price commands use
their installed payload schemas. Retained state, live publication and price
execution have separate runtime gates. Taxonomy, tax coverage and application,
and promotions return required evidence unavailable (2). Unknown subject fields
refuse. Attributes and combinations stay separate from strict v1 drafts.

Reference rows and retained options are fixture observations. A PASS does not
validate persisted identity bytes, history or database state. Installed versions,
database references/cadence, listing capacity, publication races and legal
rate correctness remain runtime facts. No database, network, seed or publish
path is supplied. Exit codes: 0 satisfied within scope, 1 violated, 2 required
evidence unavailable, 64 invalid invocation or JSON syntax, 74 filesystem or
unexpected operation failure. Only explicitly allowlisted, deliberate owner input
errors become exit 1 at the input path, retaining their stable codes. Other owner
exceptions propagate unchanged: the direct promise rejects and the CLI returns
74 with raw errors withheld. Default checker failure is 74; only an error tagged
at its `JSON.parse` site gives 64, and only owner input-denial codes give 1.
Integrity failures, including `combination_identity_integrity_failed` and legacy
`combination_digest_collision`, give 74. Closed primitive
admission prevents malformed quantity types from reaching owner coercion.
Violations take precedence over unavailable evidence.
JSON stdout is one `formatVersion: 1` object. Findings retain exact owner codes
and paths, sort by JSON pointer, code and fixture, and include cause, fix, recipe,
identical recheck command and evidence.

## New vertical

Copy the installed [pack](catalogue-pack-skeleton/pack.ts) and
[fixtures](catalogue-pack-skeleton/fixtures.ts) into
`owned/catalog-packs/<namespace>/`. Rename the namespace, edit the definitions
and fixture data, then add one pack-and-fixture entry to the runtime registry
in `owned/catalogue.ts`. Use the [registration example](catalogue-pack-skeleton/catalogue.ts)
as a template for that entry. Typecheck and run the starter’s `catalogue:check:source` script.

Use Node 24 with erasable TypeScript, relative imports ending in `.ts` and
`import type` for types. Pass `--erasableSyntaxOnly` to the starter’s `typecheck` script. For an existing app, preserve its current registry entries.
Compose consumers from the same pack objects. Compare the projected subject
against the installed registry, direct fixture source and owner outcomes
independently. The [static JSON example](catalogue-pack-skeleton/catalogue.json)
is available for the JSON-only command.

Each false capability needs a named expected refusal. With `owner-refusals`,
the checker independently runs the installed profiled prepaid refusal for
`capabilities: { prepaid: false }` and compares the code and absence of an
acceptance. Missing or unsupported owner evidence gives exit 2. The older
JSON declarations without `owner-refusals` still check record consistency.
Usual codes: `pack_type_namespace_mismatch`, `definition_key_invalid`,
`definition_unknown_field`, `draft_input_invalid`, `draft_payload_invalid`,
`conformance_subject_invalid`, `conformance_owner_unavailable`,
`conformance_refusal_fixture_missing`, `conformance_refusal_fixture_invalid`,
`conformance_refusal_fixture_mismatch`. Custom attribute kinds, quantity dimensions
and promotion benefit/target kinds require upstream changes to the closed grammar.

## Add attribute

Edit the pack’s `pack.ts` and add witnesses in `fixtures.ts`. Metadata example: `attributes: [{key: "finish",
scope: "variant", valueType: {kind: "boolean"}, required: false, cardinality:
{min: 0, max: 1}, filterable: true, facetable: true, public: true, displayOrder: 0,
labels: {en: "Finish"}}]`. Separate `attributes` fixtures call `validateCatalogAttributes` and
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
`definition_duplicate_enum_value`. Run the starter’s `catalogue:check:source` script.

## Add unit

Edit the pack’s `pack.ts`: `units: [{code: "stationery:each", dimension:
"count", integral: true, factor: {canonicalUnit: "openlup:piece", unscaled: "1",
scale: 0}}]`. Add `{type: {key: pack.types[0].key, version: pack.types[0].version},
value: {dimension: "count", unit:
"stationery:each", unscaled: "2", scale: 0}}` to quantity fixtures.
Exact conversion is available; new dimensions require upstream grammar changes.
Usual codes: `definition_unit_invalid`, `definition_unit_factor_invalid`,
`definition_duplicate_unit`, `definition_net_content_invalid`,
`definition_unknown_net_content_unit`, `definition_duplicate_net_content_unit`,
`quantity_invalid`, `quantity_cross_dimension`, `quantity_fractional_count`,
`quantity_unknown_unit`, `quantity_overflow`, `quantity_not_exactly_representable`.
Combination quantities additionally refuse `unit_factor_missing` until their
installed definition declares an explicit exact factor.
Run the starter’s `catalogue:check:source` script.

## Add axis

Edit the pack’s `pack.ts`: `dimensions: [{key: "finish", kind:
"boolean"}], axes: [{key: "finish", attributeKey: "finish"}]`, referencing a
variant attribute in the same type. Separate `combinations` fixtures call `canonicalizeCatalogCombinationV2` and
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
Run the starter’s `catalogue:check:source` script.

## Add tax class

Edit the pack’s `pack.ts`: `taxClasses: [{key: "standard"}]` and
`taxClass: "standard"` on the type. Default class references are checked now;
market-owned dated rates in `owned/market-packs/<market>/tax-table.ts`, coverage,
gaps/overlaps and tax publication await their owners. No fake rate data belongs
in this skeleton. New attribute/dimension/promotion kinds remain upstream work.
Usual codes: `definition_tax_class_invalid`, `definition_unknown_tax_class`.
Run the starter’s `catalogue:check:source` script to check references.
Requesting `requiredChecks: ["tax-coverage"]` returns 2 until its owner is available.

## Add category or collection

Request this owner in `owned/catalogue.ts`. Example request: `requiredChecks:
["taxonomy"]`. Graph/depth and collection-reference validation and publishing are
pending; there is no admitted category field to paste into current pack metadata.
Usual current code: `conformance_owner_unavailable`; future codes belong to the
taxonomy owner. New closed grammar kinds require upstream work.
Run the starter’s `catalogue:check:source` script to check availability.

## Promotion with existing grammar

In `owned/catalogue.ts`, request `requiredChecks:
["promotions"]`. Target/currency validation and publishing are pending, including
per-currency money maps; do not invent a campaign field here. New benefit/target
kinds require upstream work. Usual current code: `conformance_owner_unavailable`.
Run the starter’s `catalogue:check:source` script to check availability.

## Subscription profile

In `pack.ts`, declare a key and version in `subscriptionProfiles` and use the same
`subscriptionProfileRef` on the product type. Put the full, versioned
declaration in `subscriptionProfileDefinitions`. The experiment includes
`validateCatalogSubscriptionProfile` in `@openlup/core/catalog`
and a server-side policy binding in `@openlup/platform/subscriptions`.

Use `fixed_units` for independently chosen quantities, `units_per_day` for
declared canonical content and daily demand, or `host_policy` to bind an existing
adopter policy. Set `demandScope` to `per_line` when each product must cover the
interval independently. An exact policy can accept 56 pieces at 2/day and 140 g
at 5 g/day on the same 28-day cadence. Add `profileChecks` in `fixtures.ts` with `cadenceDays` and typed lines
containing `id`, `type`, `quantity` and any applicable demand. Pass
`profilePolicies` from the same bindings you compose at runtime. A missing
declaration gives `profile_missing` and an unmatched policy gives
`policy_binding_missing`. Use the native edit-bound probe against the candidate
database to observe installed limits.
For a live quote or edit, compose `bindAcceptance` with verified facts and
the observed installed edit bound. The existing accepted catalogue reference
carries the profile key, version and digest through payment and renewal.
Activate each lane only after its host bindings are installed and verified. Typical declaration codes include `definition_profile_invalid`,
`definition_unknown_profile_ref` and `profile_cadence_exceeds_platform_bound`.
Run the starter’s `catalogue:check:source` script.

## Upgrade a definition

Edit the pack’s `pack.ts`, keeping the old version composed. Example:
`key: "stationery:notebook", version: 2`. Every digest-covered change gets a new
version; see the installed [canonical agreements](../../concepts/architecture-and-ownership.md).
The offline checker finds duplicates and invalid metadata; it cannot compare an
installed digest or authorize replacement, migration or publication. Those remain
with the installer and later writers. New kinds/dimensions/benefits require upstream
work. Usual codes: `definition_version_invalid`, `definition_duplicate_identity`,
`definition_validator_ref_invalid`. Run the starter’s `catalogue:check:source` script.
