# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Stable APIs follow SemVer from 1.0.0; experimental symbols and test-support
subpaths retain their declared limits. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [1.0.0]

- Publishable on the npm `latest` dist-tag as `1.0.0`, from tag
  `openlup-core-v1.0.0`.

Label declaration occurrences as unverified public-import leads. Resolve the
selected application's reachable declared OpenLup packages and required Core
through Node's npm node_modules lookup, including workspace hoisting and linked
packages. Check selected versions against the owning npm lockfile and retain
application-only source scans. MCP reads accept only the selected package's
exact returned path and retain bounded ordinary-file and realpath checks.
Refuse Node package self-references instead of labelling checkout source as an
installed dependency.

Migration: no result fields or package exports change. Declaration hits do not
prove public imports; use the installed exports and examples. For hoisted npm
installs, use the installed-manifest executable recipe in the lookup README.

Add browser-safe exact catalogue quantities, canonical units, comparison and declared-unit conversion using decimal strings and BigInt. Inexact canonical values refuse without rounding.

Migration: additive exports on the existing catalog entry. Existing identifier schemas are unchanged. No database, subscription or capability change; target package set 0.44.0.

Add `cataloguePositionNetFromGross` and `allocateCatalogueDiscountedGrossTotals`
to the existing pricing subpath. They preserve the existing position arithmetic:
integer included-VAT net rounding and discount allocation by largest remainder,
with equal remainders resolved by input position.

Migration: These exports are additive and unbound. Existing quote arithmetic,
subscription agreements and independent invoice verification stay unchanged.
Callers explicitly compose the helpers with already validated position money
in one selected currency and preserve the original position order. The net
helper retains native integer-conversion errors; the allocator retains its
existing refusal messages. No data migration or activation is supplied.

- Mark unbound catalogue quantity, money and registry-observation symbols
  `@experimental`; retain the existing consumed quantity contract without the tag.

Migration: no runtime, signature or import change. The added TSDoc tags identify
experimental symbols for compatibility guidance.

Add opt-in catalogue definition/quantity/v1-draft checks, explicit refusal
fixtures and installed recipes with a copied stationery skeleton. Attribute/projection and combination fixtures reuse their owners; taxonomy, tax,
profile and promotion semantics remain explicitly pending.

Migration: Additive tooling for the next package set. Old imports and v1 canonical
bytes remain unchanged. The new Node-only `@openlup/platform/catalog/testing`
subpath and `openlup catalogue check --packs ./owned/catalogue.json --json` require
explicit JSON fixture text; the supplied file is never imported. No database migration, installation,
host wiring, publication or capability activation occurs. Upgrade all packages as
one exact set; an offline PASS is scoped evidence only.

Integrate attribute validation/projection and V2 combination owners into the
offline catalogue checker. Replace executable subjects with JSON text and the
copied executable skeleton with one static JSON fixture. Reference and refusal
observations are checked without invoking caller code; retained identities are
derived from fixture options and prove no persisted bytes or history.

Migration: For the unreleased 0.44.0 set, migrate module-based callers to
`await runCatalogExtensionConformance(JSON.stringify(subjectData))` and CLI files
to `openlup catalogue check --packs ./owned/catalogue.json --json`. Omit
`validateContent`; requested application content validation is unavailable (2).
Replace refusal callbacks with `observedCode` and `zeroEffects` records, reference
ports with resolution rows, and retained identity bytes with options. The single
entry retains report fields, deterministic ordering and the five CLI exits.
No SQL, publication, subscription changes or capability activation occurs.

Add optional inert catalogue registry observations to readiness, including the
`registry_missing_referenced_version` refusal for referenced type versions missing
from code or carrying a different digest.

Migration: additive `ReadinessInput.catalogRegistry` and `CatalogRegistryObservation`
exports on the existing readiness entry. Existing inputs keep their behaviour.
`complete: false` or a NULL installed definition digest yields existing `unknown`
readiness rather than treating hidden references as ready. The application owns observation and database identity; no boot hook, installer,
provider call or runtime activation is added. Target package set 0.44.0.

Document the unbound attribute owner beside the offline catalogue checker and
include its shared issue codes in the generated installed refusal-to-recipe links.
The recipe links include the per-slot UTF-8 text-index refusal
`attribute_projection_text_too_large`.
The checker retains its existing definitions, exact quantity and v1 draft scope;
attribute-value/projection integration remains pending.

Migration: documentation additions only. Existing APIs, strict v1 drafts and
checker exit/refusal behavior are unchanged. Owner availability and recipe links
grant no publication, serving or capability activation authority.

Declare per-subpath stable, experimental and test-support policies for the coherent 1.0.0 package set. Stable APIs follow SemVer with open unions and literal sets; symbols tagged `@experimental` remain outside the stable promise. Consumer evidence is explicitly first-party.

Migration: keep a default branch for unknown union and literal-set values. Check the generated maturity table for experimental and test-support subpaths before upgrading. No runtime behavior or package export changes.
- Allow intentional API snapshot updates with a new or modified package change fragment; retain changed `CHANGELOG.md` as a legacy route. Fragment contents are validated during release preparation.

## [0.43.0]

- Publishable on the npm `latest` dist-tag as `0.43.0`, from tag
  `openlup-core-v0.43.0`.

- Keep the shared fulfillment status facade and generated JSON neutral; provider dictionaries own translation. Canonical `packed` remains preferred and every historical display alias keeps its customer-step result.

Migration: shared status-map JSON no longer carries adapter trace columns. Consumers needing provider translation use adapter-owned dictionaries. Existing status tokens, ranks, effects and customer steps are unchanged.

## [0.42.0]

- Publishable on the npm `latest` dist-tag as `0.42.0`, from tag
  `openlup-core-v0.42.0`.

- Republish unchanged Core runtime, exports and SQL with the complete `0.42.0`
  package set. The reader guide adds the native payments upgrade notes.
