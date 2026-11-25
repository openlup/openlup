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
`refusals`. Write fixtures as schema version 3 to check draft facts and the shape
of publication and price operations. Quantity fixtures use `{type, value, targetUnit?}`,
explicit conversion factors, and a type key and version. Request
`attribute-values` or `variant-combinations` in `requiredChecks` to require their
fixtures in each pack.

Refusal and reference records and retained options describe fixture observations.
The pack range compares the checker's Platform package version. Application and
database runtime state, price execution and publication require separate evidence and
authority. Exit 0 means supplied checks passed, 1 means an input violation, 2
means required evidence is unavailable, 64 means invalid command or inert JSON
syntax, and 74 means a load, I/O, integrity or unexpected validator failure.
Violations take precedence over unavailable evidence. JSON stdout is one
`formatVersion: 1` object. Findings retain owner codes, JSON pointers, cause, fix,
recipe, recheck and evidence. Findings sort by numeric pack index, then by
lexicographic path, then by code.
An integrity failure such as `combination_identity_integrity_failed` exits 74.
The CLI withholds raw errors when loading the module or running its validators.


For the installed starter, follow [Publish a saved catalogue draft](../build/customize-the-starter.md#publish-a-saved-catalogue-draft)
to prepare, approve, issue and read the exact saved facts.

In an extracted starter, apply this check to all the recipes below.
After each change, run `npm run typecheck` from the extracted application root.
The starter’s catalogue check is `npm run --silent catalogue:check:source`.
It checks the packs and fixtures declared in `owned/catalogue.ts`.
For a pack at another path, use the projection command in the recipe.

## Discover the grammar

Read the product type, product input and v3 draft schemas shipped with your
installed Platform version.

```sh
openlup catalogue schema --json
```

Use `decimal` with scale `0` for whole-number attributes. The report also gives
built-in units, catalogue limits, caps and refusal fixes. Product rules can
validate additional constraints during Prepare. To publish net content for a
product labelled in ml, follow [Products labelled in ml or pieces](#products-labelled-in-ml-or-pieces).
Look up a [catalogue refusal code and its fix](../../reference/refusal-codes.md#catalogue-refusal-code-fixes).

## Install a pack in the starter

Copy `pack.ts` and `fixtures.ts` from the installed [catalogue skeleton](./catalogue-pack-skeleton/pack.ts) into `owned/catalogue/`.
Import `pack` and `fixtures` into `owned/catalogue.ts` and add `{ pack, drafts: fixtures.drafts }` to `catalogueConformance.packs` alongside the shipped legacy entry.
Use `packs.flatMap<CatalogProductTypeInput>(entry => entry.pack.types)` when building the owned offline registry.
The demonstration stores `<pack.id>@<pack.version>.json` as one filename. Its UTF-8 length can be at most 255 bytes, and the ID may contain neither slash, backslash nor NUL. The skeleton ID `stationery` is valid.

With the starter's rules bundle in `owned/catalogue-rules.cjs`, run these commands from the application directory.

```sh
node --test owned/catalogue-rules.test.cjs
npm run --silent catalogue:check:source
npm run typecheck
./lifecycle up --json
```

`up` rebuilds the image containing `owned/`. In the operator draft form, use the skeleton's `fixtures.drafts[0]` JSON with title `Notebook`, type `stationery:notebook@1`, and fresh draft, product, and SKU identities. Select **Save** and **Prepare saved draft**.
If the host reports `starter_catalogue_build_missing`, restore the matching declared version and tested rules, rerun `./lifecycle up --json`, then retry the same draft action.

## New vertical

In the extracted starter, add your pack and its fixtures to
`catalogueConformance.packs` in `owned/catalogue.ts`. Use the skeleton below for
the pack and fixture fields. For a standalone pack, use these scaffold commands.

Copy the [TypeScript skeleton](./catalogue-pack-skeleton/catalogue.ts), rename its
namespace, edit `pack.ts` and `fixtures.ts`, and add each pack once in `catalogue.ts`.

```sh
mkdir -p owned/catalogue
cp node_modules/@openlup/core/docs/guide/how-to/extend/catalogue-pack-skeleton/*.ts owned/catalogue/
npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json
```

For inert checking, copy the [static JSON sample](./catalogue-pack-skeleton/catalogue.json)
to your working directory and run `npx --no -- openlup catalogue check --packs ./catalogue.json --json`.
The sample reports unavailable content evidence (exit 2).
Usual codes include `pack_type_namespace_mismatch`, `definition_unknown_field`,
`draft_input_invalid` and `conformance_subject_invalid`.

## Add attribute

Edit `pack.ts`. Add product attributes to `attributes` with `scope: "product"`.
For options that select a variant, use [Add axis](#add-axis).
In `fixtures.ts`, `attributes` fixtures call `validateCatalogAttributes` and
`prepareCatalogAttributeProjection` with `{type, input, publicationRevision,
references?}`. `input` contains `productAttributes` and `skus: [{id, attributes?}]`.
Missing required values/locales, scope, unknown keys, storage and projection-text
bounds retain exact owner diagnostics. Successful rows preserve the owner's exact
projection values; no projection is written.
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

For `advisory_variant_attribute_without_axis`, bind the attribute with an axis
if it varies by SKU and there are fewer than 16 axes. Reuse an unused compatible
dimension or add a valid one if there is room. A type holds up to 16 dimensions,
and a quantity dimension must match the attribute and use at most 32 units.
If the attribute describes the whole product, set its scope to `product` and
move the supplied values into product attributes. Otherwise keep it as a variant
attribute. This advisory is informational.

## Add unit

In `pack.ts`, move the pack's namespace string into a `const namespace`
declaration above `defineCatalogPack` and use `namespace` for the pack's
namespace field. Append this entry to the existing `units` array. Keep the
existing entries and leave `netContentUnits` as it is. Keep `integral: false`
on `openlup:g` and use `integral: true` on the count unit. Use the
[whole-gram publication recipe](#publish-net-content-in-grams) when publishing.

```ts nocheck
// This entry goes inside the skeleton's units array.
{
  code: `${namespace}:pair`,
  dimension: "count",
  integral: true,
  factor: { canonicalUnit: "openlup:piece", unscaled: "2", scale: 0 },
},
```

In `fixtures.ts`, append this entry to `quantities` using the existing `type`
binding and `pack` import.

```ts nocheck
// This entry goes inside the skeleton's quantities array.
{
  type,
  value: { dimension: "count", unit: `${pack.namespace}:pair`, unscaled: "2", scale: 0 },
},
```

Exact conversion is available; new dimensions require upstream grammar changes.
Usual codes: `definition_unit_invalid`, `definition_unit_factor_invalid`,
`definition_duplicate_unit`, `definition_net_content_invalid`,
`definition_unknown_net_content_unit`, `definition_duplicate_net_content_unit`,
`quantity_invalid`, `quantity_cross_dimension`, `quantity_fractional_count`,
`quantity_unknown_unit`, `quantity_overflow`, `quantity_not_exactly_representable`.
Combination quantities additionally refuse `unit_factor_missing` until their
installed definition declares an explicit exact factor.
Check: `npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json`.

The experimental publication rules contract includes
`validateTypedSkuAmounts({ code, netContent }, evaluation?)` for the typed
publication path. It receives the authored exact tuple and returns a boolean.
When typed publication is enabled, this hook takes precedence over
`validateSkuAmounts` for count and volume. A pack with only the gram hook must
add the typed hook before publishing those quantities. A pack with neither
hook adds no amount policy. Gram publication continues to use
`validateSkuAmounts({ code, netGrams }, evaluation?)`.

This app-side preparation keeps count and volume publication dormant. Keep
using integral grams for publication on the current installation.

## Add axis

In `pack.ts`, import `catalogVariantOptions` from `@openlup/platform/catalog`
and declare each option once. For example, add this entry to the skeleton's
`catalogVariantOptions` list.

```ts nocheck
// This entry goes inside the skeleton's catalogVariantOptions list.
{ key: "finish", kind: "choice", values: [{ id: "matte" }, { id: "gloss", labels: { en: "Gloss" } }], labels: { en: "Finish" } },
```

In `fixtures.ts`, replace the existing `options` binding with these bindings.

```ts nocheck
// These bindings replace the skeleton's options declaration.
const finish = "matte";
const selectedAxes = ["lined", "finish"] as const;
const options = { lined: { kind: "boolean", value: true }, finish: { kind: "choice", value: finish } } as const;
const skuAttributes = { lined: true, finish } as const;
```

Set the draft's `product.dimensions` and the combination fixture's `input.axes`
to `selectedAxes`. Use `attributes: skuAttributes` for the draft SKU and for
the SKU in the attribute projection fixture. The draft SKU's `options` and the
incoming combination row's `optionValues` both use the updated `options` binding.

The helper returns `attributes`, `dimensions` and `axes`. A boolean option
such as `{ key: "lined", kind: "boolean", labels: { en: "Lined" } }` has this
expanded form with the default display flags.

```ts nocheck
// These three fields show the declaration returned by the helper.
{
  attributes: [{ key: "lined", scope: "variant", valueType: { kind: "boolean" }, required: true,
    cardinality: { min: 1, max: 1 }, filterable: false, facetable: false, public: true,
    displayOrder: 0, labels: { en: "Lined" } }],
  dimensions: [{ key: "lined", kind: "boolean" }],
  axes: [{ key: "lined", attributeKey: "lined" }],
}
```

For quantity options, supply `dimension` and `units`. Keep the explicit unit
factors in the type's `units` array. If you need a distinct axis key and attribute
key, use the expanded form. For `definition_axis_mismatch`, make the two sides
match in kind and choice IDs or quantity dimension and units, or declare the
option once with the helper. For `definition_duplicate_axis_attribute`, remove
the duplicate axis assignment.

In `fixtures.ts`, `combinations` fixtures call `canonicalizeCatalogCombinationV2` and
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
New attribute kinds and dimensions are upstream work. Look up definition codes
in the [refusal code reference](../../reference/refusal-codes.md#refusal-codes).
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

## Set the Platform version range

In `pack.ts`, set `openlupRange` to the Platform versions the pack supports.
The checker evaluates `N.x`, `^N.M.P` and `>=N.M.P <N+1.0.0`, where `N+1` is
the next major version. For `advisory_openlup_range_unrecognised`, use `1.x`.
For `advisory_openlup_range_unsatisfied`, update `openlupRange` to include the
reported Platform version, or install a compatible Platform version. Rerun
the command in Recheck. Both advisories keep exit 0 when all supplied checks pass.

## Add tax class

Edit `pack.ts`: `taxClasses: [{key: "standard"}]` and
`taxClass: "standard"` on the type. The offline check verifies the class reference.
Usual codes: `definition_tax_class_invalid`, `definition_unknown_tax_class`.
Check references: `npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue/catalogue.ts --json`.

## Subscription profile

To check pack references, list the key and version in `subscriptionProfiles`
and use the same `subscriptionProfileRef` on the product type.

Include `subscriptionProfileDefinitions` to opt into native installation
checks. List at least one exact reference and list each reference once.
Declare each new profile version once, and include its exact key and version
in `subscriptionProfiles`. Use `subscriptionProfileDefinitions: []` when
every listed version is already installed. Omit the field to keep a legacy
reference-only pack. Offline conformance checks declarations and pack
membership. The installer checks which versions exist in the store.

Validate a complete declaration with `validateCatalogSubscriptionProfile`
from `@openlup/core/catalog`. Supply a profile key and version, distinct
`allowedCadences`, a versioned `policyRef`, and a lowercase SHA-256
hex `policyDigest`. Each fixed-day choice uses
`{ schemaVersion: 1, kind: "fixed_days", days: 28 }`. Use whole days from 1 to
3660 for choices and the optional `maxFixedDays`. The declaration refuses
`calendar_months` with `cadence_kind_unsupported`.

On refusal, use the field path and remedy in `issue`. For a valid declaration,
pass the returned profile to `canonicalCatalogSubscriptionProfileJson` and hash
the UTF-8 bytes with SHA-256 to derive its declaration digest. The installer
does this for each declaration. The profile and policy digests pin different
inputs. If the canonical pack manifest exceeds 1,048,576 UTF-8 bytes, split
the profile declarations across pack versions or packs.

Capture a connected store before opting in; after a profile receipt exists, capture refuses until RS-1.
After applying the complete native catalogue, roll forward from a legacy
reference-only pack by issuing a new pack version. If the old pack listed
`p@1` without declaring it, keep `p@1` on its original type, list the versions
the new pack needs, and declare `p@1` and any new versions that are absent
from the store. The first pack to install each declaration owns its receipt.
An identical re-declaration reuses that receipt. Use a new profile version
to change the declaration. The legacy pack can still replay its original
receipt.

Native cadence guards still decide whether a cadence can be written.

## Author a product

Build two version 3 draft payloads from one description with the experimental
`buildCatalogReleaseDraftV3` export in `@openlup/platform/catalog`. Pin the
installed product type version. Supply the fields and facts your installed
rules expect. The builder derives the entity IDs, document references, and
draft operations. It returns `release` and `activation`, each with a payload
and its own digest.

This example uses an installed `example:article` type with a `finish` choice
axis and rules that derive `{ derived: 12 }`. The store has reserved the internal
identifier sequences 203 and 204 for these SKUs.

```ts
import { buildCatalogReleaseDraftV3, catalogInternalGtin, type CatalogProductInput } from "@openlup/platform/catalog";

const grams = (unscaled: string) => ({ dimension: "mass", unit: "openlup:g", unscaled, scale: 0 } as const);
const finishSku = (code: string, finish: string, sequence: number) => ({
  code, title: code,
  options: { finish: { kind: "choice" as const, value: finish } },
  attributes: { finish },
  netContent: grams("100"),
  grossMass: grams("120"),
  identifiers: [{ scheme: "gs1:gtin", issuer: "example:internal",
    value: catalogInternalGtin(sequence), packagingLevel: "unit" as const, isPrimary: true }],
  sell: { oneTime: true, subscription: false },
  facts: { derived: 12 },
  logisticsRef: `example:fulfillment/${code}`,
});

const product = {
  namespace: "example",
  type: { key: "example:article", version: 1 },
  slug: "two-finishes", name: "Example article", presentation: { title: "Example article" },
  skus: [{ ...finishSku("FINISH-MATTE", "matte", 203), primary: true, minQuantity: 2 }, finishSku("FINISH-GLOSS", "gloss", 204)],
} satisfies CatalogProductInput;

const { release, activation } = buildCatalogReleaseDraftV3(product);
```

1. Save `release.payload`, prepare it, approve it, then publish it. The
   product and both SKUs are in draft status. Save the publication head.
2. After publishing the release, verify store offer readiness. In the effective
   price list, set exactly one effective `one_time` entry with a positive gross
   price at minimum quantity 1 for every SKU you will activate, including
   one-time-only SKUs. This price-entry quantity is independent of the SKU's
   `minQuantity`. Use only gross `one_time` or `subscription` entries at minimum
   quantity 1. If the list has any D2C policy history for its region and currency,
   it needs exactly one valid effective D2C revision, a positive derived
   subscription price and no effective `subscription` entry for the SKU. If it
   has no such history, set exactly one effective `subscription` entry with a
   positive gross price at minimum quantity 1. Prices and policies live outside
   both payloads.
3. Save `activation.payload` as the next revision of the same draft. Prepare
   it against the release head, approve it, and publish it. This example admits
   both SKU IDs to `classic`, each with its own logistics reference.

Missing base prices make activation Publish return
`publication_sku_price_not_ready`. The release remains the current head and
the SKUs remain in draft status. Set the prices and retry the same Publish
request. If builder input is refused, correct the field in the error's `path`
and call the builder again.

## Project published offers for display

On the server, read the experimental `readPostgresCatalogStorefrontPage` result
and call `projectPublishedCatalogOfferPage` from `@openlup/platform/catalog`.

### Verify definition receipts in your host

1. Load the server-owned pack build and the matching
   `CatalogDefinitionInstallReceipt` returned by `installCatalogDefinitions`.
   For a build with a portable rules artifact, bind the retained artifact with
   `withCatalogPublicationRules`. Check the pack ID and version and compare
   `catalogPackManifest(pack).digest` with the receipt's `manifestDigest`.
2. Build a `CatalogProductTypeRegistry` with
   `createCatalogProductTypeRegistry(pack.types)`. For each product on a governed
   `CatalogStorefrontPageResult`, use its `typeRef` to select the exact key and
   version from `receipt.types` and resolve the same pair to a
   `CatalogProductTypeDefinition` in the registry. Compute
   `catalogDefinitionDigest(type)` and compare it with that receipt entry's
   `definitionDigest`. Use only pairs that verify.
3. Pass the successful reader result and the verified `{ type, digest }`
   entries to `projectPublishedCatalogOfferPage(result, definitions)`. The
   projection also checks the digest against the product's published
   definition digest when present. It exposes own attributes marked
   `public: true` for their exact product or variant scope. Missing, conflicting
   or unverifiable type evidence yields empty attribute maps.

The projection drops the raw reader's `options` map. To display a finish
selector, declare `finish` as a public variant attribute in the installed
type, supply it in the SKU's attributes, and read it from the projected SKU.

```ts
import type { PublishedCatalogOfferPage } from "@openlup/platform/catalog";

function readFinish(page: PublishedCatalogOfferPage, skuCode: string) {
  const sku = page.products.flatMap(product => product.skus).find(sku => sku.skuCode === skuCode);
  const finish = sku?.attributes["finish"];
  return typeof finish === "string" ? finish : undefined;
}
```

Everything authored in `product.presentation` becomes public copy. The
projection carries it unchanged. The starter chooses the fields it displays
from that copy. Continue the server read with the returned cursor, even when
the current page produces no displayable SKUs.

The projected primary identifier includes `internal`. Keep internal values as
local references and omit them from external global GTIN fields. An external
consumer verifies issuance before treating a global candidate as an issued GTIN.

## Products labelled in ml or pieces

Use a `quantity` variant option in the unit on the label and supply the
matching typed attribute. In the installed type, declare the unit and its
factor, then use `catalogVariantOptions` to declare the axis. Keep publication
net content in whole grams. If you only have the label quantity, weigh the
contents or use the manufacturer's density for a volume-to-mass conversion.

For a 50 ml item with 52 g of net content, declare `openlup:g` in
`netContentUnits`, add this volume unit to `units`, and spread the axis
definitions into the type.

```ts
import { catalogVariantOptions } from "@openlup/platform/catalog";

const volumeUnit = { code: "example:ml", dimension: "volume", integral: false,
  factor: { canonicalUnit: "openlup:ml", unscaled: "1", scale: 0 } } as const;
const volumeAxis = catalogVariantOptions([
  { key: "volume", kind: "quantity", dimension: "volume", units: [volumeUnit.code], labels: {} },
]);
```

For the `VOLUME-50ML` SKU, use the following values with the same release, price,
and activation steps. This example uses a 60 g gross mass, logistics reference
`example:fulfillment/VOLUME-50ML`, and an explicit unit GTIN minted with reserved
internal sequence 205.

```ts
const volume = { dimension: "volume", unit: "example:ml", unscaled: "50", scale: 0 } as const;
const quantities = {
  options: { volume: { kind: "quantity", value: volume } },
  attributes: { volume },
  netContent: { dimension: "mass", unit: "openlup:g", unscaled: "52", scale: 0 },
  grossMass: { dimension: "mass", unit: "openlup:g", unscaled: "60", scale: 0 },
} as const;
```

The PostgreSQL publication witness checks that the stored net weight is 52 g
and that the stored variant option keeps the exact 50 ml tuple.

## Publish net content in grams

Prepare reports `catalog_publication_mass_required_until_mc5` for non-mass net content.
Publication accepts net content only as a whole number of grams.
Make `units` contain exactly one `openlup:g` entry, `{code: "openlup:g", dimension: "mass", integral: false, factor: {canonicalUnit: "openlup:g", unscaled: "1", scale: 0}}`, include `openlup:g` exactly once in `netContentUnits`, set each `skus[].netContent` to whole grams (`dimension: "mass"`, `unit: "openlup:g"`, `scale: 0` and a positive integer string of at most 40 digits in `unscaled`), and remove `role: "net_content"` from any dimension that has it while keeping its definition and SKU options otherwise intact, making room within each 64-entry limit or replacing a different `openlup:g` declaration only when the change preserves every retained unit reference.

## Review filter and facet flags

No listing or search reader consumes these flags in this version.
Keep the flags for a later version or set them to false.

## Add a unit GTIN

In a version 3 draft, Prepare reports `unit_trade_identifier_missing` when
the SKU has a code but lacks a valid unit GTIN. A SKU without a code reports
`sku_code_missing` first. The legacy version 1 and 2 preview reports
`publication_preparation_unavailable`.
Add a valid unit GTIN to the SKU. For a product without a globally assigned GTIN,
[assign an internal number](../../concepts/catalogue-and-prices.md#products-and-trade-items).
A SKU holds at most 32 identifiers, so replace one when the list is full.

## Use schema version 3 for offline fixtures

Stored version 1 and 2 drafts remain readable and cannot be published.
Prepare reports `publication_preparation_unavailable` for a stored version 1 or 2 draft.
Author offline pack fixtures as schema version 3, the newest draft schema this
checker evaluates. Use the schema required by your publication workflow for
saved drafts. Schema version 3 fixtures require `product.sharedContent`.
Check them with
`npx --no -- openlup catalogue project --trusted-packs ./owned/catalogue.ts` and
a registered `validateContent`. For an otherwise valid v3 fixture, inert
`catalogue check` reports `conformance_owner_unavailable` and exits 2.

## Rerun fixtures after definition repair

The checker skips fixture evaluation and trusted validation for a pack with
findings in its own definition. A cross-pack `definition_duplicate_identity`
finding alone still allows fixtures and trusted validators to run.
Fix the pack's definition findings first.

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
