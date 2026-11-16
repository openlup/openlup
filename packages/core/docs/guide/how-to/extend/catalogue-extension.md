# Catalogue extension recipes

Development preview, targeting the next package set. Use matching installed
`@openlup/*` versions and Node 24. This offline tool checks definitions,
references, exact quantities, supplied v1 draft facts and separate attribute and
version 2 combination fixtures. It grants no installation,
migration, publication or activation authority. The minimal skeleton is a fictional
stationery pack; full reference packs and installed commerce journeys remain pending.

The registry explicitly exports a default `CatalogConformanceSubject`. Each `packs`
entry contains `pack`, optional `drafts`, `quantities`, `attributes`, `combinations`
and `refusals`. Await `runCatalogExtensionConformance(subject)` when calling the
Node testing entry directly; it returns `Promise<CatalogConformanceReport>`.
Quantity fixtures contain `{type, value, targetUnit?}` and require explicit
conversion factors. All fixture type references use exactly a namespaced string
key and a positive integer version; malformed references refuse before lookup.
`requiredChecks: ["attribute-values", "variant-combinations"]` requires at least
one corresponding fixture in every pack entry. Missing fixtures return
required-evidence-unavailable (2). `taxonomy`, `tax-coverage`, `profiles`,
`promotions` and unrecognized requests still return 2 until their owners exist.
Unknown fields refuse; they are never silently passed. Do not add typed attribute
or combination fields to strict v1 drafts.

The exported subject is an executable envelope, passed directly to the checker.
Its declared inputs are read once on the original receiver into an internal plain,
frozen snapshot. Owners and the checker consume that snapshot; original objects
are not frozen or mutated. An unreadable subject declaration refuses with
`conformance_subject_invalid` (exit 1). Plain, frozen,
non-enumerable, inherited and getter-based inputs are supported, including getters
using private fields; unknown symbol keys refuse the closed subject shape. The
CLI puts its recheck command on returned findings and never copies or mutates the
subject. JSON attribute data follows the separate owner canonical rules below.

The command imports trusted code, including callbacks, without a sandbox. Modules
must not write stdout or start effects. The checker owns no database, network,
seed or publish path. Installed versions, database references/cadence, listing
capacity, publication races and legal tax-rate correctness remain runtime facts.
Exit codes: 0 satisfied within this scope, 1 violated, 2 required evidence unavailable,
64 invalid invocation, 74 loading or unexpected failure. JSON stdout is one
`formatVersion: 1` object. Every finding has a code, path, rule/cause, fix, recipe,
identical recheck command and evidence. Codes returned by trusted content validators
retain their owner meanings; they use the general draft recipe when no platform
rule record exists. Findings sort by JSON pointer, code and fixture name. Owner diagnostic paths are
appended under the fixture input; combination dot-path segments become escaped
JSON-pointer segments, including options, axes and SKU identities.

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
labels: {en: "Finish"}}]`. Metadata/reference checks are available. The separate
server owners `validateCatalogAttributes` and `prepareCatalogAttributeProjection`
are available unbound from `@openlup/platform/catalog`; they validate supplied
values, report missing publication facts as readiness issues and prepare rows
without writing. Add a separate fixture to the pack entry:

```ts nocheck
// Excerpt in fixtures.ts; the type declares a product-scoped boolean finish.
attributes: [{ type: { key: "stationery:notebook", version: 1 },
  input: { productAttributes: { finish: false },
    skus: [{ id: "00000000-0000-4000-8000-000000000001" }] },
  publicationRevision: "7" }]
```

The checker awaits the validator and passes its result to projection preparation;
all malformed values and missing required publication facts report owner codes.
The revision is fixture data, never proof of a persisted publication. Reference
resolution uses an optional trusted `references` port on this fixture, whose
`resolve` callback supplies an allowlisted offline batch. The owner's `attribute_reference_unresolved` code keeps its exact path. Missing,
failed, omitted, ambiguous or unavailable resolver evidence returns exit 2;
a single positive `dangling` or `private` answer returns exit 1. Each resolver
answer's `namespace`, `id` and `status` are read once on its original receiver into
a plain frozen record, shared by the owner and the checker. Stateful getters keep
their first values. Throwing resolvers, unreadable answer getters, non-array batches
and malformed answer fields make the batch unavailable evidence (exit 2). This
prevents an unreadable duplicate from turning a batch into a false success. Aliased
answer records are captured once while duplicate entries remain duplicates. Receiver/private-field getters are supported
when their declared fields can be read. Attribute values
outside the declared allowlist remain malformed supplied facts (exit 1). The checker uses the attribute owner's canonical JSON snapshot for both validation
and reference evidence: non-enumerable own data is retained; getters, symbols and
unsupported prototypes refuse. The checker does not contact a database to discover
references. Values remain excluded from v1 drafts;
actual publication and generation serving remain pending. A new attribute kind
is upstream work. Usual owner codes:
`attribute_projection_text_too_large`, `attribute_storage_too_large`, `attribute_values_invalid`, `attribute_value_invalid`,
`attribute_unknown_key`, `attribute_scope_conflict`, `attribute_cardinality_invalid`,
`attribute_required_missing`, `attribute_required_locale_missing`,
`attribute_reference_unresolved`, `attribute_publication_revision_invalid`.
Usual metadata codes:
`definition_attribute_invalid`, `definition_duplicate_attribute`,
`definition_facetable_not_filterable`, `definition_unknown_attribute_unit`,
`definition_duplicate_enum_value`. Check:
`npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json`.

## Add unit

Edit `pack.ts` and `fixtures.ts`: `units: [{code: "stationery:each", dimension:
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
Check: `npx --no -- openlup catalogue check --packs ./owned/catalogue.ts --json`.

## Add axis

Edit `pack.ts`, `catalogue.ts`, `fixtures.ts`: `dimensions: [{key: "finish", kind:
"boolean"}], axes: [{key: "finish", attributeKey: "finish"}]`, referencing a
variant attribute in the same type. Metadata and existing v1 validation are
available. Platform's server `./catalog` entry supplies
`canonicalizeCatalogCombinationV2` and `validateCatalogCombinationChangesV2`
for pure combination preparation. They require installed definitions and
authoritative retained facts; they do not publish. Add a separate fixture to the pack entry:

```ts nocheck
// Excerpt in fixtures.ts; finish is a variant boolean attribute and axis.
combinations: [{ type: { key: "stationery:notebook", version: 1 },
  input: { axes: ["finish"], typed: true, retained: [], incoming: [{
    skuId: "00000000-0000-4000-8000-000000000001", state: "active",
    optionValues: { finish: { kind: "boolean", value: false } }
  }] } }]
```

The checker calls the version 2 change validator with the selected type. It checks only
supplied incoming changes and retained fixture facts; it never enumerates possible
combinations or reads live capacity. Exact equivalent units share an identity;
active duplicates refuse. `retained` facts and optional `capacity` describe the
fixture, not the installation. Request `requiredChecks: ["variant-combinations"]`
to refuse when a pack entry supplies no combination fixtures.
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
`combination_digest_collision` and `duplicate_sku_id`. Use stable enum IDs and
complete options; a changed canonical identity requires a new SKU. Compare bytes
on a digest conflict and refuse both duplicates and collisions without merging.
`sku_payload_limit` bounds one incoming payload at 10,000 SKUs, separately from
configured retained product capacity (default 50,000), reported by
`product_capacity_exceeded` or `product_capacity_invalid`. Persisted incremental
publication and its authority/races remain with the publisher.
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
