# Catalogue extension recipes

Use matching `@openlup/*` versions on Node 24. An offline PASS grants no activation authority.

## Check a registered pack

In the app, use `catalogue:check:source` or its installed command.

```sh
npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue.ts --json
```

Export the runtime packs as a `CatalogConformanceSource` named `catalogueConformance`.
Projection runs their callbacks with the process’s permissions. Keep them deterministic, side-effect free and silent.

`transport` records the canonical scratch file outside the app, its SHA-256,
timings and one checker invocation. Use `transport.recheck` from a clean copy
or `transport.replay` for inert JSON. Compare the bytes independently with
the registry and source fixtures.

```sh
npx --no -- openlup catalogue check --packs ./owned/catalogue.json --json
```

Try the [static sample](catalogue-pack-skeleton/catalogue.json).
The JSON API refuses non-strings with `conformance_subject_invalid` and malformed
JSON with `SyntaxError`. Content and host callbacks require trusted projection.

Set `requiredChecks` per pack via the registration example below.
`draft-content` requires a v3–v5 fixture and its actual validator.

Exit 0 satisfies the check, 1 reports violations and 2 reports unavailable
evidence. Invalid invocation or JSON gives 64. File, integrity and unexpected
failure give 74. Violations take precedence over unavailable evidence.
Findings in the version-1 JSON report sort by path, code and fixture.
See [refusal codes](../../reference/refusal-codes.md).

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

Use explicit `.ts` paths and `import type`. Declare a refusal for each false
capability. `owner-refusals` checks the prepaid owner’s code and absence of
acceptance. Unavailable owners give 2. Usual codes include
`pack_type_namespace_mismatch` and `conformance_refusal_fixture_mismatch`.

## Add attribute

In `pack.ts`, use `{key: "lined", scope: "variant", valueType: {kind: "boolean"}}`
with cardinality and filter flags. In `fixtures.ts`, use `{type, input, publicationRevision}`.
Reference observations use `{namespace, id, status}`. Missing or ambiguous evidence
gives 2 and a unique dangling or private result gives 1 with
`attribute_reference_unresolved`. Run `catalogue:check:source`.
`attribute_scope_conflict` means move the value to its declared scope.
New value kinds require upstream work.

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

In `pack.ts`, add `taxClasses: [{key: "standard"}]` and match `taxClass` on
the type. Run `catalogue:check:source`. A missing key reports
`definition_unknown_tax_class`. Required `"tax-coverage"` or `"tax-application"`
gives 2.

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
and the type’s `subscriptionProfileRef`. Use `fixed_units` like the skeleton,
or supply `profilePolicies` for `units_per_day` or `host_policy` through trusted
source. Add `profileChecks: [{cadenceDays, lines}]` in `fixtures.ts`.
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
