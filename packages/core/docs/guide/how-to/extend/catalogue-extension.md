# Catalogue extension recipes

Development preview, targeting the next package set. Use matching installed
`@openlup/*` versions and Node 24. This offline tool checks definitions,
references, exact quantities and supplied v1 draft facts. It grants no installation,
migration, publication or activation authority. The minimal skeleton is a fictional
stationery pack; full reference packs and installed commerce journeys remain pending.

The registry explicitly exports a default `CatalogConformanceSubject`. Each `packs`
entry contains `pack`, optional `drafts`, `quantities` and `refusals`. Quantity fixtures
contain `{type, value, targetUnit?}` and require explicit conversion factors.
`requiredChecks: ["taxonomy"]`, for example, requests a future check and returns
required-evidence-unavailable (2). All requested checks in `requiredChecks` are
currently unavailable. Unknown fields refuse; they are never silently passed.
Attribute-value/projection and cross-unit variant-combination checks await their
owners. Do not add attribute values to strict v1 drafts.

The command imports trusted code, including callbacks, without a sandbox. Modules
must not write stdout or start effects. The checker owns no database, network,
seed or publish path. Installed versions, database references/cadence, listing
capacity, publication races and legal tax-rate correctness remain runtime facts.
Exit codes: 0 satisfied within this scope, 1 violated, 2 required evidence unavailable,
64 invalid invocation, 74 loading or unexpected failure. JSON stdout is one
`formatVersion: 1` object. Every finding has a code, path, rule/cause, fix, recipe,
identical recheck command and evidence. Codes returned by trusted content validators
retain their owner meanings; they use the general draft recipe when no platform
rule record exists. Findings sort by JSON pointer, code and fixture name.

## New vertical

Copy [the skeleton](catalogue-pack-skeleton/registry.ts) into an application folder:

```sh
cp -R node_modules/@openlup/core/docs/guide/how-to/extend/catalogue-pack-skeleton owned/stationery
npx --no -- tsc -p owned/stationery/tsconfig.json
npx --no -- openlup catalogue check --packs ./owned/stationery/registry.ts --json
```

Five steps: copy; rename the namespace in `pack.ts`, `catalogue.ts` and fixtures;
edit the definitions/data; register one entry in `owned/catalogue.ts`; check:

```ts nocheck
// Excerpt: copied into the application registry, with an application-owned import.
import { subject } from "./stationery/fixtures.ts";
export default { packs: [subject] };
```

Use erasable TypeScript, explicit `.ts` local specifiers, type-only imports and no
aliases. Keep `pack.ts`, `catalogue.ts` and `fixtures.ts`; `registry.ts` demonstrates
the one registration entry. The skeleton's validator pin is illustrative and its
callback validates no content fields. Replace both with your owned artifact before
any later authorized install. Empty capabilities claim no runtime feature.
For every `capabilities: {feature: false}` declaration add a trusted refusal fixture:

```ts nocheck
// Excerpt: inject the owned refusal validator and captured effects in fixtures.ts.
{ name: "feature refusal", capability: "feature", expectedCode: "owner_unsupported",
  run: () => injectedOwner.check(),
  assertZeroEffects: () => capturedWrites.length === 0 }
```

Only the exact expected owner code plus `assertZeroEffects() === true` satisfies
it. This is instrumented evidence, not sandbox protection. Usual codes:
`pack_type_namespace_mismatch`, `definition_key_invalid`, `draft_input_invalid`,
`draft_payload_invalid`, `conformance_subject_invalid`, `conformance_owner_unavailable`,
`conformance_refusal_fixture_missing`, `conformance_refusal_fixture_invalid`,
`conformance_refusal_fixture_mismatch`. Custom attribute kinds, quantity dimensions,
and promotion benefit/target kinds require upstream changes to the closed grammar.

## Add attribute

Edit `pack.ts` and `fixtures.ts`. Metadata example: `attributes: [{key: "finish",
scope: "variant", valueType: {kind: "boolean"}, required: false, cardinality:
{min: 0, max: 1}, filterable: true, facetable: true, public: true, displayOrder: 0,
labels: {en: "Finish"}}]`. Metadata/reference checks are available; value validation
and projection are pending. A new attribute kind is upstream work. Usual codes:
`definition_attribute_invalid`, `definition_duplicate_attribute`,
`definition_facetable_not_filterable`, `definition_unknown_attribute_unit`,
`definition_duplicate_enum_value`. Check:
`npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json`.

## Add unit

Edit `pack.ts` and `fixtures.ts`: `units: [{code: "stationery:each", dimension:
"count", integral: true, factor: {canonicalUnit: "openlup:piece", unscaled: "1",
scale: 0}}]`. Add `{type: pack.types[0], value: {dimension: "count", unit:
"stationery:each", unscaled: "2", scale: 0}}` to quantity fixtures.
Exact conversion is available; new dimensions require upstream grammar changes.
Usual codes: `definition_unit_invalid`, `definition_unit_factor_invalid`,
`definition_duplicate_unit`, `definition_net_content_invalid`,
`definition_unknown_net_content_unit`, `definition_duplicate_net_content_unit`,
`quantity_invalid`, `quantity_cross_dimension`, `quantity_fractional_count`,
`quantity_unknown_unit`, `quantity_overflow`, `quantity_not_exactly_representable`.
Check: `npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json`.

## Add axis

Edit `pack.ts`, `catalogue.ts`, `fixtures.ts`: `dimensions: [{key: "finish", kind:
"boolean"}], axes: [{key: "finish", attributeKey: "finish"}]`, referencing a
variant attribute in the same type. Metadata and existing v1 validation are
available; new canonical cross-unit combination identity awaits its owner.
New attribute kinds/dimensions are upstream work. Usual codes:
`definition_dimension_invalid`, `definition_axis_invalid`, `definition_duplicate_axis`,
`definition_unknown_axis_attribute`, `definition_axis_scope_invalid`,
`definition_unknown_axis_dimension`, `definition_duplicate_dimension`,
`definition_duplicate_choice`, `definition_duplicate_dimension_unit`,
`definition_dimension_unit_mismatch`, `definition_net_content_unit_mismatch`,
`definition_multiple_net_content_dimensions`.
Check: `npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json`.

## Add tax class

Edit `pack.ts` and `fixtures.ts`: `taxClasses: [{key: "standard"}]` and
`taxClass: "standard"` on the type. Default class references are checked now;
market-owned dated rates in `owned/market-packs/<market>/tax-table.ts`, coverage,
gaps/overlaps and tax publication await their owners. No fake rate data belongs
in this skeleton. New attribute/dimension/promotion kinds remain upstream work.
Usual codes: `definition_tax_class_invalid`, `definition_unknown_tax_class`.
Check references: `npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json`.
Requesting `requiredChecks: ["tax-coverage"]` returns 2 until its owner is available.

## Add category or collection

Future files: `catalogue.ts`, `fixtures.ts`. Example request: `requiredChecks:
["taxonomy"]`. Graph/depth and collection-reference validation and publishing are
pending; there is no admitted category field to paste into current pack metadata.
Usual current code: `conformance_owner_unavailable`; future codes belong to the
taxonomy owner. New closed grammar kinds require upstream work.
Check availability: `npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json`.

## Promotion with existing grammar

Future files: `catalogue.ts`, `fixtures.ts`; request `requiredChecks:
["promotions"]`. Target/currency validation and publishing are pending, including
per-currency money maps; do not invent a campaign field here. New benefit/target
kinds require upstream work. Usual current code: `conformance_owner_unavailable`.
Check availability: `npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json`.

## Subscription profile

Edit metadata in `pack.ts`, `fixtures.ts`: `subscriptionProfiles: [{key:
"stationery:repeat", version: 1}]`, with the same `subscriptionProfileRef` on a
type. Reference checking is available. Cadence bounds, demand pools, unit
compatibility, overflow and runtime composition await the profile owner; request
`requiredChecks: ["profiles"]` for those checks. Never infer a database cadence
bound. New closed grammar kinds require upstream work. Usual codes:
`definition_profile_ref_invalid`, `definition_unknown_profile_ref`.
Check: `npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json`.

## Upgrade a definition

Edit `pack.ts` and `fixtures.ts`, keeping the old version composed. Example:
`key: "stationery:notebook", version: 2`. Every digest-covered change gets a new
version; see the installed [canonical agreements](../../concepts/architecture-and-ownership.md).
The offline checker finds duplicates and invalid metadata; it cannot compare an
installed digest or authorize replacement, migration or publication. Those remain
with the installer and later writers. New kinds/dimensions/benefits require upstream
work. Usual codes: `definition_version_invalid`, `definition_duplicate_identity`,
`definition_validator_ref_invalid`. Check:
`npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json`.
