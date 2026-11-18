# Catalogue extension recipes

Development preview for matching `@openlup/*` versions on Node 24. PASS covers
only the supplied offline checks and grants no activation authority.

## Check a registered pack

From the installed application, run the starter’s `catalogue:check:source` script
or the installed command it wraps.

```sh
npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue.ts --json
```

Export `catalogueConformance` as a `CatalogConformanceSource` using the runtime
pack objects. The command trusts the module and runs its callbacks with the
process’s permissions. Keep them deterministic, side-effect free and silent.

`transport` records the canonical scratch file outside the app, its SHA-256,
timings and one checker invocation. Use `transport.recheck` from a clean copy
or `transport.replay` for inert JSON. Compare the bytes independently with
the registry and source fixtures.

```sh
npx --no -- openlup catalogue check --packs ./owned/catalogue.json --json
```

Try the [static sample](catalogue-pack-skeleton/catalogue.json). The JSON command
and `runCatalogExtensionConformance(jsonText)` read data only. Non-strings give
`conformance_subject_invalid`, malformed JSON throws `SyntaxError`, and
executable fields refuse. Application content and host callbacks require trusted evidence.

Entries contain `pack` and optional `drafts`, `quantities`, `attributes`,
`combinations`, `profileChecks`, `profilePolicies` and `refusals`. Require
coverage per pack with `quantities`, `attribute-values`, `variant-combinations`,
`draft-content`, `profiles` or `owner-refusals` in `requiredChecks`.
`draft-content` requires a v3–v5 fixture and its actual validator. The installed
schemas admit publication operations and price commands.

| Exit | Result |
| --- | --- |
| 0 | Supplied checks satisfied |
| 1 | Owner or input violation |
| 2 | Required evidence unavailable |
| 64 | Invalid CLI invocation or malformed JSON |
| 74 | File, loading, integrity or unexpected failure |

Violations take precedence over unavailable evidence. JSON stdout contains one
`formatVersion: 1` object. Findings sort by JSON pointer, code and fixture, and
carry cause, fix, recipe, evidence and the exact recheck command. For the full
code inventory, see [refusal codes](../../reference/refusal-codes.md).

## New vertical

1. Copy [pack.ts](catalogue-pack-skeleton/pack.ts) and
   [fixtures.ts](catalogue-pack-skeleton/fixtures.ts) to
   `owned/catalog-packs/<namespace>/`.
2. Rename the namespace.
3. Edit the definitions and fixture data.
4. Register one entry in `owned/catalogue.ts` using the
   [registration example](catalogue-pack-skeleton/catalogue.ts). Keep older
   registrations composed.
5. Typecheck with `--erasableSyntaxOnly` and run `catalogue:check:source`.

Use explicit `.ts` paths and `import type`. Declare one named refusal per false
capability. `owner-refusals` checks the prepaid owner’s code and absence of
acceptance. Other owners return 2. Legacy JSON checks declaration consistency.
Usual codes include `pack_type_namespace_mismatch` and
`conformance_refusal_fixture_mismatch`.

## Add attribute

In `pack.ts`, declare the attribute on its type. The skeleton uses
`{key: "lined", scope: "variant", valueType: {kind: "boolean"}}` with cardinality
and filter flags. In `fixtures.ts`, use `{type, input, publicationRevision}` where
`input` supplies `productAttributes` or `skus: [{id, attributes}]` as applicable.
Attribute references use `{namespace, id, status}`. One resolved observation
supports fixture validation. Missing or ambiguous evidence gives 2 and a unique
dangling or private result gives 1, both with `attribute_reference_unresolved`.
Run `catalogue:check:source`. Other usual codes include `attribute_scope_conflict`
and `definition_facetable_not_filterable`. New value kinds require upstream work.

## Add unit

In `pack.ts`, declare `{code, dimension, integral, factor}` with an explicit
decimal factor to a canonical unit. In `fixtures.ts`, use
`{type, value: {dimension, unit, unscaled: "2", scale: 0}, targetUnit}`.
Run `catalogue:check:source`. Usual codes include `definition_unit_factor_invalid`,
`quantity_cross_dimension` and `quantity_not_exactly_representable`. New
dimensions require upstream work.

## Add axis

In `pack.ts`, pair a dimension with an axis, such as
`{key: "lined", attributeKey: "lined"}`. In `fixtures.ts`, supply
`{type, input: {axes, typed, retained, incoming}}` with `skuId`, `state` and
`optionValues` per row. Run `catalogue:check:source`. Usual codes include
`definition_unknown_axis_attribute` and `duplicate_combination`.
Changed identity needs a new SKU. New option kinds need upstream work.

## Add tax class

In `pack.ts`, add `taxClasses: [{key: "standard"}]` and `taxClass: "standard"`
on the applicable type. Run `catalogue:check:source` to check the reference.
A missing key reports `definition_unknown_tax_class`. Market rate application
and coverage are unavailable. Requesting `"tax-coverage"` or `"tax-application"`
in `owned/catalogue.ts` under `requiredChecks` gives 2.

## Add category or collection

Request `requiredChecks: ["taxonomy"]` in `owned/catalogue.ts`. Run
`catalogue:check:source` to see the availability result. Graph, depth and
collection reference checks are unavailable and give `conformance_owner_unavailable`
(2). Taxonomy fields need the upstream schema.

## Promotion with existing grammar

Request `requiredChecks: ["promotions"]` in `owned/catalogue.ts`. Run
`catalogue:check:source` to see `conformance_owner_unavailable` (2).
Target, currency and publishing owners are pending. New benefit and target
kinds require upstream work.

## Subscription profile

In `pack.ts`, declare `subscriptionProfiles`, `subscriptionProfileDefinitions`
and the matching type `subscriptionProfileRef`. The skeleton uses `fixed_units`.
For daily demand, use `units_per_day` and the matching `profilePolicies` binding.
For a pinned `host_policy`, supply the actual callback through trusted source.
In `fixtures.ts`, add `profileChecks: [{cadenceDays, lines}]` with each
line’s `id`, `type`, `quantity` and any applicable demand.
Run `catalogue:check:source`. Usual codes are `profile_missing`,
`policy_binding_missing` and `profile_cadence_exceeds_platform_bound`.
Use the database bound separately for native quote or edit readiness.

## Upgrade a definition

In `pack.ts`, keep the prior version composed and add the new version of the
same key. Update `fixtures.ts` for the new definition. Run
`catalogue:check:source`. Usual codes include `definition_version_invalid`,
`definition_duplicate_identity` and `definition_validator_ref_invalid`.
Compare with the actual installed digests at upgrade time. New closed grammar
kinds require upstream work.
