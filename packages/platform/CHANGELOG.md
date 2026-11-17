# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Stable APIs follow SemVer from 1.0.0; experimental symbols and test-support
subpaths retain their declared limits. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [1.0.0]

- Publishable on the npm `latest` dist-tag as `1.0.0`, from tag
  `openlup-platform-v1.0.0`.

- Add optional effect-free `admitSubscriptionTerms` to classic, exact and sized
  subscription editor ports. It checks the full normalized base/add-on set with
  nominal plan and effective cadence before pricing or durable writes, including
  edits retaining frozen prices. Completed receipts replay before current limits
  and admission; mismatched payloads still conflict. Omitting the callback keeps
  existing behavior.
- Replace the checkout/quote/recovery/account DTO cadence caps of 90/120 days
  with positive PostgreSQL integer bounds. Historical generic SQL bundle and
  lifecycle quoting still cap cadence at 90; longer periods on those paths
  require a separate forward migration. Package/exact writers are separate.

Migration: no database migration in this change. Hosts may compose the optional
callback with adopter-owned rules; no default offer list or starter derivation
is supplied. Check date representation for the selected operation.

Add native live-SKU quantities and an explicit owner-only bounded backfill driver.

Migration: apply the complete native catalogue through `20261122110000_catalog_quantities.sql`, then call `backfillCatalogNetContent` with the install executor and batch size. Old grams and readers stay unchanged; the managed rail does not supply this feature.

Add optional effect-free full-result admission to the existing classic, exact
and sized editor ports. Supply nominal and effective cadence separately; run
before pricing and writes, including frozen-price edits. Completed receipt
replay precedes mutable limits and admission while fingerprint conflicts refuse.
Absent callback preserves behavior.

Checkout, quote, recovery and account cadence DTOs now use PostgreSQL integer
representation bounds instead of business caps of 90/120. Historical generic
SQL bundle/lifecycle paths retain their 90-day guards pending a separate forward.

Migration: no SQL or core changes. Compose the optional callback in the host and
validate resulting dates; starter offer derivation and activation remain separate.

- Clarify the offline fulfillment conformance failure for missing provider
  selection: `prepare(providerRef:null)` must return `selection_required` before
  I/O. The expected refusal and zero-I/O requirement are unchanged.

Add readonly catalogue pack descriptors, typed v1 draft authoring, declarative metadata, shared definition issues and server-computed definition/manifest digests. Catalogue quantity types now re-export Core's identical shape.

Migration: additive catalog and catalog/contracts exports. Existing definitions remain valid; v1 command bytes and quantity/option helpers are unchanged. Invalid definitions retain invalid_catalog_type_definition and now carry their first structured issue. Pack results are recursively readonly. Typed SKU options follow each product's selected dimensions, including a closed empty shape, while preserving all inline v1 SKU fields. Explicit CatalogPackDraft annotations use the second type parameter for the selected keys; list quantity unit references are checked recursively. Inherited draft fields accept readonly identifiers and asset references as well as mutable arrays. Descriptor objects are closed at authoring boundaries; retain literal reference keys when declaring arrays separately. Quantity dimensions follow their declared units. The Node catalogPackIssues helper reports closed pack shape and reference issues through the shared definition validator. Pass readonly authored drafts through catalogDraftPayloadSchema.parse before assigning them to mutable v1 draft/command DTOs. Import the runtime CATALOG_CONFORMANCE_RULES record from @openlup/platform/catalog; catalog/contracts exports the conformance codes and rule shapes as types only, keeping checker prose out of the browser bundle. Attribute values remain outside v1 drafts. No installation, publication, SQL or activation; target package set 0.44.0.

- Mark unbound catalogue extension symbols `@experimental`; retain the
  starter's consumed product-type input without the tag.

Migration: no runtime, signature, export or database change. The added TSDoc tags
identify experimental symbols for compatibility guidance; existing readers keep
their contracts.

### Added

Versioned catalogue draft payload v2, resume and stateless candidate previews.

Migration: apply the complete native catalogue through position 147 before
using v2 commands. `CatalogDraftPayload`, `CatalogDraftCommand` and their existing
schemas retain v1 behavior. New `CatalogDraftPayloadV2` and command schemas carry
typed attribute data and complete immediate positive gross one-time base-price
commands at minimum quantity one, including the wholly-null or wholly-set
expected entry ID and amount. A zero new amount refuses. Unknown payload and
command versions refuse; later versions cannot reinterpret or rewrite v2 bytes.
There are no price writes in this change.

Opt in with `createPostgresCatalogDraftStoreV2` and `createCatalogDraftHandlerV2`;
the original factories retain v1 admission and result types. These new factories return
`CatalogDraftStoredRecord` / `CatalogDraftStoredApplyResult`, whose payload is the
explicit v1-or-v2 union. Version-specific schemas remain available. `draftsFor`
adds definition-typed v2 attributes and required-key checking; the wire schema
and handler still save incomplete drafts, reporting publication readiness issues.
The async `validateCatalogDraftV2` reuses the attribute owner and optional reference
resolver. Old v1 consumers keep their exact canonical command and receipt bytes.
Stop v2 authoring before rolling back readers; old latest-record readers refuse
v2 records. Retain schema and history, and keep a compatible reader to access v2.

The v2-only `resume` command copies an abandoned draft's payload into an open
revision under the same retained reservations. Original abandonment receipts
still replay exactly, and legacy revise on an abandoned head still refuses.
No backfill or history rewrite occurs. All four draft relations remain
authoritative retained transfer data in their existing order and privacy class;
the round-trip matrix now covers v2 price plans and resume history. No new
relation, client foreign key or absorption class is needed.

`createCatalogCandidateService` prepares read-only previews through explicitly
supplied authorized readers. Its reference encodes the immutable draft revision
and expected publication identity, or known unpublished state. Reconstructing
resolves and compares the whole head including documentDigest, compares installed
and composed definition digests, and hashes the parsed canonical payload,
definition evidence and expected head. The caller's head and candidate digest
are checked by `compareCandidate`; missing price validation leaves a blocking
issue for price-bearing drafts. Publication must run reconstruction and refusal
of all issues inside its own transaction. No candidate table/cache, publisher
constructor, publication binding or capability activation is added.

Managed divergence design: the managed rail does not supply this feature.
A future twin replaces the existing managed draft apply routine with the same
version discrimination, retained receipts and resume semantics on its four
existing draft relations. It derives the actor from verified session membership,
retains their RLS/default-deny browser access and operator-session checks for
drafts. Publication retains its separate human-admin boundary and excludes
service credentials. Native
owner/runtime invoker authorization maps to managed routine grants plus RLS;
no native-only authorization role semantics are introduced. No live product/SKU
column, including industry-specific nullable fields, is changed or relaxed here.

- Add draft payload v3 for ordered publication operations, explicit eligibility,
  immutable provenance/media claims and explicit document-derived SKU cache
  effects. Freeze the shared-content extraction envelope and include every new
  field and operation order in candidate reconstruction/digests. Saving a draft
  executes no operation; publication and runtime capabilities remain unbound.

Migration: upgrade to the explicit `createPostgresCatalogDraftStoreV3` and
`createCatalogDraftHandlerV3` readers before authoring payload/commands v3.
`CatalogDraftPublicationStored*` is the additive v1/v2/v3 union; existing v1 and
v2 DTOs, parsers, handlers and adapters retain their version boundaries and exact
canonical bytes, fingerprints and original receipt replay. Unknown versions
refuse. The self-contained candidate-reference format remains v1 and resolves
immutable v3 data without an additional candidate table. V3 prices use the
unchanged positive gross one-time/minimum-one command; no scheduling, tier,
context-version or zero-price extensions are added.

The native forward expands only draft apply admission on the four existing
retained draft relations. Abandon/resume retains reservations and payloads;
there is no backfill, new relation or change to transfer order, privacy or
absorption classes. Stop v3 authoring before rolling readers back; retain a
compatible reader for v3 history. No live catalogue, price, subscription, order
or delivery fact is changed.

`sharedContent` has a closed versioned envelope for action, document,
presentation, memberships, requested modes and complete authored SKU facts;
installed validators own the opaque data within it. Provenance for the current
draft resolves from its persisted receipt rather than recursively embedding its
own fingerprint. Retained provenance uses an explicit immutable tuple and a
matching evidence claim. The publisher still verifies every claim and operation;
these input contracts provide no authorization or external readiness guarantee.

Managed divergence design: the managed rail does not supply this feature.
A future twin expands the managed draft apply routine on its existing heads,
revisions, receipts and reservations, deriving the actor from verified session
membership and preserving RLS, operator access and default-deny browser writes.
The native invoker's owner/runtime grants have an equivalent managed routine
and RLS expression; no native-only authorization semantics are introduced.
No product/SKU column is changed; industry-specific food-column relaxation
remains with the later reader/adoption boundary.

Adds an unbound native immediate base-price writer, validated preview/apply/readback
use case, PostgreSQL store and portable receipt/command contracts under pricing.
The command retains the draft-v2/v3 price-operation grammar and exact canonical
bytes. Later context, scheduling and list-lifecycle command extensions remain
reserved for a new payload version.

Migration: install the complete native catalogue through position 150,
`20261122180000_catalog_base_price_writer`, after the native readiness-input unit.
Old price readers continue reading ordinary price entries. New callers explicitly
bind a verified human administrator's session to the store and handler; the SQL
derives the actor, serializes receipt before price context, compares the expected
base and atomically closes/inserts at one database statement instant. No capability
is activated. Readiness reads native financial, agreement and audited cohort
evidence; missing proof hard-refuses independently of ordinary readiness reasons.
The existing global reason-membership aggregation defect remains unchanged: a
second invalid SKU can remain hidden by an already present aggregate price-shape
reason. This writer changes no agreed subscription money or schedule.

The catalogue-local receipt relation is authoritative transfer data. Retain its
exact fingerprints, actor metadata and responses with price history; no customer
foreign key or client-absorption rule is added. Rollback means unbinding callers;
retain committed history and receipts, and use a later expected-base command to
correct a price. Do not delete evidence or downgrade a live database.

Managed divergence design: a managed twin would use the existing managed
`price_lists`, `price_entries`, subscription, promotion and operational evidence
tables, plus a separately admitted catalogue receipt relation. Managed RLS must
deny direct receipt/price writes and expose bounded execution only to verified
active human administrators, excluding machine and revoked principals. Reconcile
the managed role/administrator authority with its incumbent policies; authorization
does not depend on a native-only role. The native readiness-input mapping and its
audited never-populated baseline delta require their managed equivalents. Existing
industry-specific catalogue columns are untouched; this price-only change needs
no relaxation. The managed rail does not supply this feature.

Stable 1.0 coordination (CD-S1-1): all new catalogue base-price writer symbols,
including contracts, schemas, handler/store ports and factories, canonical command
serialization and refusal helpers, are marked `@experimental` from their introduction.
They are outside the 1.0.0 SemVer promise. Existing catalogue readers retain their
current status. New result/kind unions and the hard-refusal reason tuple grow by
addition only (D3); no existing union member is removed or renamed.

Add unbound native offer-policy readiness inputs for the catalogue price writer.
Existing subscriptions receive the legacy policy pair and a default-false fixture
marker; future ordinary inserts default to pending acquisition. Installation
records immutable marking-time count, membership fingerprint and database time.
The separately audited, parameterless service capture inserts its baseline once.
The audited-zero admission is a deliberate platform-forced delta: “a fresh install
has nothing to protect.” It requires genuine empty marking provenance; a populated
marking becoming empty retains the empty-baseline refusal.

Migration: Apply the complete native migration catalogue. Old readers ignore the
additive evidence columns. New price-writer integration must call the read-only
input checks on its transaction before and after provisional prices, propagate
hard domain/provenance refusals, and retain ordinary acquisition reasons.
Graduation and edits that can preserve old quotes retain the governing purchase
order provenance; an event name never turns those copies into independent quotes.
Audit
the complete legacy non-fixture cohort, including paused and cancelled rows,
before explicitly invoking `commerce_capture_offer_policy_v2_legacy_baseline()`
through the existing service SQL boundary. Installation and transfer never
capture a baseline. Capture replay returns the original audit. Transfer carries
marking and baseline bytes, reconciling only the actual pristine target marking
row. Code rollback leaves the additive evidence and immutable audit in place;
never reset a baseline to make a failed comparison pass. No capability is enabled,
no application is composed, and no agreement is repriced or rescheduled.

Managed divergence design: A managed twin would reuse its existing
`public.subscriptions` policy/fixture columns and
`public.commerce_offer_policy_rollout_baselines`, add marking provenance and
implement the input checks over its managed promotions, prices, orders and
agreements. Its incumbent service grants and RLS need separate reviewed
reconciliation: marking must remain owner-written and immutable to ordinary
service DML; baselines need service SELECT/INSERT with browser and UPDATE/DELETE
denial, while capture retains the service authorization boundary. The same
semantics are expressible through managed ACLs and RLS, including explicit
handling of bypass roles. No food-column relaxation applies: this change authors
no product or SKU shape.
The managed rail does not supply this feature.

### Fixed

Preserve policy digests across a revision close.

Migration: additive native catalogue position 146 adds `closed_from_open` to
`subscription_price_policy_revisions`. The existing one-time NULL-to-finite
close sets it atomically without changing any original digest input or digest.
This single bit is sufficient because the guard admits no other close shape.
The byte-identical package asset is part of the complete migration catalogue.

Updated native readers verify the original tuple and serve the shortened
half-open window. `SubscriptionPricePolicyRevision.closedFromOpen` is optional;
legacy inputs keep their exact canonical bytes. Already-shortened legacy rows
whose stored tuple cannot verify refuse with
`subscription_price_policy_original_tuple_unverified`. No backfill guesses the
original tuple or replaces a historical digest. Apply schema first, upgrade
readers next, and verify retained history before enabling any later writer.
Old readers retain unchanged-tuple behavior but refuse newly closed revisions;
after a close, rollback must retain the new verifier. Keep schema and rows.

The marker follows the existing AUTHORITATIVE policy capture/restore class and
ordering, including byte-exact restore and replay. No new table, client foreign
key, absorption or privacy-erasure duty is added. Subscription agreements,
renewal terms and operations, orders, quantities and cycle dates are unchanged.
This repair ships unbound: no scheduler, closing command, capability or activation.

Managed divergence design: the managed rail does not supply this feature.
Its future twin adds the same marker and validated CHECK to managed
`subscription_price_policy_revisions`, preserving RLS and existing grants.
Administrative write grants and RLS express the native owner-only mutation
boundary; browser roles cannot close revisions or write the marker. The twin
must update its reader and guard together and prove original-digest verification,
shortened-window serving and legacy refusal. No native-only authorization role
is required and no food-column relaxation applies to this policy-only forward.

Add opt-in catalogue definition/quantity/v1-draft checks, explicit refusal
fixtures and installed recipes with a copied stationery skeleton. Attribute/projection and combination fixtures reuse their owners; taxonomy, tax,
profile and promotion semantics remain explicitly pending.

Migration: Additive tooling for the next package set. Old imports and v1 canonical
bytes remain unchanged. The new Node-only `@openlup/platform/catalog/testing`
subpath and `openlup catalogue check --packs ./owned/catalogue.json --json` require
explicit JSON fixture text; the supplied file is never imported. No database migration, installation,
host wiring, publication or capability activation occurs. Upgrade all packages as
one exact set; an offline PASS is scoped evidence only.

Quantity fixture type references now use the shared `catalogProductTypeRefIssues`
owner before resolution; malformed keys/versions report existing definition codes.
Refusal capability keys must be own string keys, and pack versions share the
installer's existing positive bounded integer rule. Valid inputs are unchanged;
malformed fixtures and pack versions that could pass offline now refuse.

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

Primitive quantity fields are admitted before owner handoff. Only deliberate
owner input errors in the checker's explicit code allowlist become input refusals
(exit 1 at the input path). All other owner exceptions propagate unchanged;
the direct promise rejects and the CLI returns 74 with raw errors withheld.
Default failure is 74; only the tagged `JSON.parse` site gives 64. Integrity codes
are never input-denial codes and propagate to CLI 74. API signatures, SQL and
release caps are unchanged by this checker repair.

Add native-only immutable catalogue definitions, install receipts, tax-class keys
and nullable product type bindings. Export the explicit install-role installer,
read-only registry probe and opt-in catalogue-write guard. Target set 0.44.0;
no runtime capability is activated.

Migration: apply the complete selected native catalogue including
`20261122100000_catalog_definition_binding.sql`, then explicitly call
`installCatalogDefinitions(installExecutor, pack)` with the native migration-owner
executor. Existing rows stay NULL-bound legacy, with no backfill or inferred
mapping. Old readers ignore the new nullable product columns; new readers treat
NULL as not mapped and follow the composite FK for installed versions. Managed-to-native
retained transfer supplies NULL only when a source binding column is absent;
provided values and all other missing-column refusals are preserved. SKUs
inherit the product type. `model_binding_state` is omitted because it would
repeat NULL-ness before publication is introduced. Keep installed old versions
in code while any product references them. Rolling code back leaves additive
storage and immutable install history intact; do not delete versions or undo SQL.

Applications can supply the probe result as `ReadinessInput.catalogRegistry` in
`createVerificationInput()` for `openlup verify --app`, and wrap catalogue writes
with `createCatalogDefinitionWriteGuard`. No existing store is automatically
rebound. The probe needs SELECT on both catalogue tables through table ownership
or a BYPASSRLS read role with row security inactive on both tables. Active row
security makes the observation incomplete, including empty visible results; a
missing definition remains a binding with a NULL installed digest. Either yields
existing `unknown` readiness and makes the guard refuse before the write.
Host calls after migrations, the net-content backfill driver and boot
readiness are deferred to the later V2 reader/composition stage. Explicit
type-upgrade mappings remain part of publication; this slice adds no reader V2
or publication transaction.

Managed divergence design: the managed rail does not supply this feature.
A managed twin needs the three definition/install/tax-key tables, nullable product
references and their complete-reference check, composite FK and index. Restrict
installation to an administrative migration principal and expose only the read
access the composed observer needs through grants and RLS. Runtime has no
installer EXECUTE, direct definition writes or migration-owner membership.
A same-table immutability trigger and invoker routine have managed equivalents;
no native-only authorization semantics are required. This slice changes no constraints
on `net_weight_g`, `pet_type`, `kcal_per_unit`, `requires_pet_profile` or
`feeding_grams_per_unit`. Alternative quantity readers and managed nullability
changes stay with the V2 reader stage. Definitions and receipts contain no customer foreign
keys or personal data, and transfer carries all three relations as AUTHORITATIVE metadata.

Add native-only nullable physical quantities on live SKUs and the explicit
install-role `backfillCatalogNetContent(installExecutor, {batchSize})` driver.
Target set 0.44.0; no capability or runtime composition is activated.

Migration: apply the complete selected native catalogue through
`20261122110000_catalog_quantities.sql`, then explicitly drain the backfill with
the migration-owner executor and a positive integer `batchSize`. The migration
itself does not backfill data. The driver converts positive legacy grams exactly
to mass / scale 0 / `openlup:g`, preserves native zero as unknown and never
replaces existing net content or infers gross mass. Interrupted runs resume;
replay is a no-op. Gross dimension is explicit to reject non-mass values at the
storage boundary. SQL checks complete groups, positive stored coefficients and
scale 0–12, leaving unit admission to the later publisher and installed unit
metadata. PostgreSQL `numeric(40,0)` coerces inputs before CHECK evaluation;
trusted writers enforce decimal-string integrality before sending values.

Old readers continue reading the unchanged non-null `net_weight_g`. V2 readers,
the checked compatibility projection, nullability change and host migration
wiring arrive in the later reader/composition stage. The new export is additive
and requires explicit invocation; it is not a runtime writer. Rollback leaves
nullable columns and converted content intact; do not reverse migration data.
No subscription agreement, quantity, price or schedule is changed.

Transfer carries all new columns in existing AUTHORITATIVE `catalog_skus` rows
with unchanged restore order. No new customer reference, absorption policy or
personal-data contributor is needed. Managed-to-native retained mapping fills
only absent fields with NULL and preserves supplied values and existing
refusals, including the exact-number guard.

Managed divergence design: the managed rail does not supply this feature.
The managed `catalog_skus` twin adds the same nullable groups and CHECKs, retaining
table grants and RLS. Its administrative migration principal runs an equivalent
owner-restricted invoker batch; runtime principals (including service, operator
and browser roles) receive no backfill EXECUTE or migration-principal membership.
The native design uses no authorization construct that managed grants and RLS
cannot express. Existing `pet_type`, `net_weight_g` and `kcal_per_unit` are mandatory
without defaults, `requires_pet_profile` has a default and
`feeding_grams_per_unit` is already nullable. Their non-food relaxation belongs
to the later reader stage; this forward changes none of them.

Add native-only attribute storage and the single rebuildable SKU-keyed
projection. Target set 0.44.0; everything remains unbound.

Migration: apply the complete selected native catalogue through
`20261122120000_catalog_attributes.sql` (position 144). Products and SKUs gain
nullable `attribute_values` JSONB, checked as objects with an independent
1,048,576-byte PostgreSQL rendered-text ceiling. Existing canonical JSON depth
and byte safety checks remain at the owner boundary; the later V2 draft retains
its separate aggregate canonical-byte ceiling. These byte measures differ.
Existing rows keep NULL, opaque documents remain unchanged, and no default or
backfill infers values. Old readers ignore the nullable columns; future V2
readers consume typed values with publication evidence. V1 DTOs and canonical
bytes are unchanged. Rollback leaves the expansion and data intact; do not drop
populated columns or reverse the migration.

The projection key distinguishes SKU, publication revision, attribute key,
definition version and ordinal. There is no premature publication FK, synthetic
revision, second attribute store or generation seed. The table is RLS-enabled
with owner-only access and no runtime grants. Decimal/quantity exactness must be
checked before future SQL writes because PostgreSQL numeric can coerce inputs.
Value validation and pure preparation, publication/digests/atomicity, generation
switching, serving and restore rebuilding remain pending. No capability flips,
writer bindings or subscription agreement changes are supplied.

Transfer retains product/SKU values as AUTHORITATIVE and classifies the
projection REBUILDABLE: count-only capture, no carried rows, empty-target restore
and no stale rows on replay. Managed retained mapping fills only absent new
columns with NULL before supplied rows, retaining exact-number and other
refusals. Free text/reference values may contain personal data and follow the
sensitive retained stream. No direct clients FK means no new absorption census
row; no new subject-erasure claim is made.

Managed divergence design: the managed rail does not supply this feature.
The managed twin adds nullable `attribute_values` JSONB on `catalog_products` and
`catalog_skus`, equivalent object/rendered-byte CHECKs, and one projection table
with the same key/index layout. Existing authoritative table grants and RLS
remain. The administrative migration principal maintains the projection;
runtime projection access remains denied pending a later explicit grant/RLS
policy, and browser roles have no direct projection writes. Native ownership
adds no authorization policy that managed grants and RLS cannot express.
Relaxation of existing food-mandatory columns remains the later reader stage.

Add the unbound catalogue attribute owner validator, injected allowlisted batch
reference resolution and pure preparation for the single SKU-keyed projection.
Supplied malformed values refuse; required values/locales are publication
readiness issues. Each product/SKU attribute object independently fits the 1 MiB
PostgreSQL-rendered text storage ceiling, including separator spaces and UTF-8
string bytes. Numeric exponent expansion is conservatively bounded; admitted
attribute shapes are counted exactly. Oversized objects refuse with
`attribute_storage_too_large` and the product/SKU owner path. The aggregate
canonical JSON safety bound remains separate. Each projected text slot also fits
2,048 UTF-8 bytes, including whole localized maps and list scalars, independently
of facet/filter flags. This conservative composite-index budget on the qualified
8 KiB-page PostgreSQL profile refuses with `attribute_projection_text_too_large`
before insertion; it does not depend on compressibility. Signed decimals remain strings, and Core quantity conversion
refuses inexact or overflowing canonical numeric values before SQL.

Migration: additive server exports and shared conformance codes only. Existing
V1 drafts, DTOs, canonical bytes and readers are unchanged. Compose the new owner
with installed definitions explicitly; do not pass attribute values to V1 drafts.
Old readers ignore the nullable storage introduced separately. Future V2 readers
must consume publication evidence. Shared conformance guidance and installed
recipe links include all new attribute codes beside the offline checker's codes.
The checker still checks definitions, exact quantities and v1 drafts only;
attribute-value/projection checker integration remains pending. No SQL, data backfill, runtime writer or
serving switch is included; rolling back this helper cannot rebuild or publish
stored values. LC1/LC2 still own validation/digest/atomic publication integration,
and later serving/restore work owns shadow generations and rebuilding.

The L1 required-locale witness proves readiness and the admission predicate;
it does not prove an actual publish has zero effects. Managed storage enablement
remains absent: the managed rail does not supply this feature. All capabilities
remain unbound; subscription agreements are unaffected.

Add unbound native variant axes and V2 combination identity preparation for target
package set 0.44.0. No catalogue consumer or capability is activated.

Migration: apply the complete selected native catalogue through
`20261122130000_catalog_variant_axes.sql` (position 145). Products gain nullable
`variant_axes text[]` in declared display order. SKUs gain nullable object-checked
`option_values`, `canonical_option_bytes` and a 32-byte-checked
`combination_digest`. Existing rows keep NULL: no default, inferred mapping,
empty combination or legacy digest is manufactured. Old readers ignore these
nullable fields; future V2 readers require publication evidence. The additive
code rollback leaves these columns, identities and data intact; do not drop
populated columns or reverse the migration. Existing UUIDs, codes, ownership,
history and legacy constraints remain.

The active-SKU partial unique index uses only `(product_id, combination_digest)`
with `status='active' AND combination_digest IS NOT NULL`, independently of
product state or type. SQL enforces storage and uniqueness; it does not certify
that caller-supplied bytes are canonical. `canonicalizeCatalogCombinationV2`
computes versioned canonical bytes and SHA-256 server-side from installed
definitions and complete selected options, using Core exact arithmetic and
explicit unit factors. Labels and display order do not enter combination
identity. Existing `canonicalCatalogOption`, v1 draft bytes and replay are
unchanged. `classifyCatalogCombinationConflictV2` distinguishes duplicate bytes
from a digest collision; neither case merges identities.
V2 quantity options use Core's exact decimal grammar and canonical bounds after
conversion/normalization, allowing equivalent padded coefficients up to 52 input
digits. The v1 wire schema retains its 40-digit coefficient ceiling. Canonical
integer overflow and precision loss still refuse; strict option-field closure
is preserved.
The shared conformance rule record includes the combination owner's codes and
links them to the installed axis/unit recipes. The offline checker keeps its
definitions, quantity fixtures and v1-draft scope; V2 combination fixtures and
publication are not activated by these links.

`validateCatalogCombinationChangesV2` is pure LC2 preparation over authoritative
retained facts and incoming options, with no client digest input. It preserves
omitted SKUs and withdrawal facts, requires a new SKU for an existing mapped
identity change, and refuses occupied active combinations. The 10,000-SKU
payload bound is separate from configured product capacity (default 50,000),
counting retained and incoming identities without enumerating combinations.
The publisher must bind definitions, enforce human authority, lock and validate
within its transaction, enforce persisted incremental capacity and record
immutable history. Explicit legacy conversion and the 15,768-SKU incremental
publication witnesses remain LC2 integration obligations. Direct owner SQL
uniqueness/concurrency witnesses are preparatory substrate, not a publish API.
See the canonical catalogue extension agreements and lock order; this change
adds no locking runtime, commerce caller, trigger or independently committing
publisher. Referenced identity keys must never be changed in place.

The new fields ride existing AUTHORITATIVE product/SKU capture entries and
restore order. Managed retained mapping initializes only absent fields to NULL,
preserves supplied fields and keeps existing refusals. The round-trip matrix
compares every field, bytes, legacy NULLs and axis order after restore/replay.
Text/options follow the sensitive retained stream. No new relation, client FK,
absorption entry or privacy-erasure claim is introduced.

Managed divergence design: the managed rail does not supply this feature.
Its twin adds the same nullable columns to `catalog_products` and `catalog_skus`,
with equivalent object and 32-byte CHECKs,
and active-SKU partial uniqueness while preserving existing managed grants and
RLS. Restrictive administrative writer grants and RLS can express the same
authorization as native ownership; browser roles receive no direct identity
writes. Existing format/content uniqueness remains until generic publication
parity is proven. Food-column relaxation remains a later migration. The public
release retains this divergence and supplies no managed activation.

Distinguish combination identity integrity failures from incoming SKU identity
changes in the unbound V2 combination owner for target package set 0.44.0.

Migration: handle the additive `combination_identity_integrity_failed` code for
inconsistent authoritative option identity evidence and colliding derived
digests. An incoming mapped identity change still reports
`sku_identity_change_requires_new_sku`. The earlier `combination_digest_collision`
code remains in the exported union and guidance record for compatibility;
`validateCatalogCombinationChangesV2` now reports the new integrity code for
that condition. Refusal conditions, validation order and all other behavior stay
unchanged. No SQL migration, writer activation or capability change is required.

Declare per-subpath stable, experimental and test-support policies for the coherent 1.0.0 package set. Stable APIs follow SemVer with open unions and literal sets; symbols tagged `@experimental` remain outside the stable promise. Consumer evidence is explicitly first-party.

Migration: keep a default branch for unknown union and literal-set values. Check the generated maturity table for experimental and test-support subpaths before upgrading. No runtime behavior or package export changes.

## [0.43.0]

- Publishable on the npm `latest` dist-tag as `0.43.0`, from tag
  `openlup-platform-v0.43.0`.

- Fix concurrent ecommerce-event projection and personal-data erasure by taking the receipts relation lock before subject row locks through a restricted preparation function. Recipient erasure, export, retained source facts and replay fences keep their existing behavior.

Migration: install the complete selected native chain through `20261119200000_communication_event_prepare_erasure.sql` before using the updated privacy contributor.

- Add optional neutral fulfillment capability declarations, readiness refusals and native execution probes. Existing adapter operation flags and outputs remain unchanged; no unsupported native lifecycle operation becomes implemented.
- Add selected-intake dispatch ACK composition, snapshot-only stock synchronization and compatible receipt/observation aliases.

Migration: install the complete selected SQL catalogue through `20261120100000_fulfillment_intake_channel.sql` before using the updated native dispatch store. Polling hosts pass the selected intake declaration to native ACK composition; omitted intake remains push and existing accepted receipts retain their channel.

Migration: omitted descriptor fields preserve existing behavior. Provider-owned reservations and provider-managed consumption now have explicit readiness refusals. Explicit `stockMovements: false` selects snapshots with a separate movement refusal and preserves the movement watermark; absent retains movement reads. Pass the declaration to the stock worker.

Migration: `transportSelection: "provider"` admits nullable native parcel carrier/service; saved customer preferences still require strings. PDF remains the sole supported label document format. Independent split, standalone pickup/locker, native label create/void and remote cancel requests remain named limits.

Migration: optional `receiptKey` must equal required legacy `labelKey` byte-for-byte. Neutral observation status aliases `code`/`detailCode` coexist with required legacy `primary`/`subStatus`; neutral shipment event kinds coexist with legacy order event kinds. Preserve event keys, occurrence identity and historical acceptance JSON; no backfill or receipt rewrite is supplied.

- Add native order delivery-contact resolution, latest-shipment contact comparison and fenced operator correction with exact retained replay, creation capture, privacy export/erasure and finite native transfer. Operator creation validates the resolved contact, with pre-parcel correction taking precedence over the original destination.
- Add source-specific delivery selection with injected normalized options and canonical point evidence. Provider-selected checkout/preferences remain constrained by their existing contracts.

Migration: install the complete selected catalogue through `20261121100000_order_delivery_contact_correction.sql`. Native response schemas accept older inputs without `deliveryContact` and normalize its absence to null. Select the native response schemas and authorize the OMS correction handler. Submit both the PostgreSQL digest and revision; register the updated parcel-contact privacy contributor for private order contacts and retained correction responses. Historical baselines stay null; no backfill or provider activation is performed.

- Compose replacement preparation and dispatch under the new parcel identity, retaining optional frozen line lot/expiry fields and adapter-owned sequence numbering.
- Bind retained and in-flight dispatch replay to parcel sequence and optional line lot/expiry, preserving omitted versus explicit-null metadata selection.
- Add the explicit native customer alignment row reader for the existing current-schedule mapper. Reduced list/detail retain their existing projection; overview requires host data.
- Process changed non-null arrival timestamps while preserving subscription-first locking, all-unsuperseded-arrivals admission and the monotonic once-only schedule clamp. No automatic replacement confirmation is added.

Migration: install the complete selected SQL catalogue through `20261120130000_fulfillment_alignment_arrival_chronology.sql`. Bind `createPostgresCustomerAlignmentRowsReader` from `@openlup/platform/fulfillment/native` to `readFulfillmentDelay`; authorize IDs and supply current schedules. Optional `parcelSequenceNo` is additive; adapters own any provider-facing format and existing callers default to the original parcel. Bind the selected adapter's order-identity codec to intake. Historical status alone supplies no arrival, reservation generation or inferred customer case. There is no backfill or hosted qualification.

- Add explicit native commerce creation and operator-attempt recording with cancellation composition. Local creation checks settled money, recorded order mode, contact, holds, cycle and reservations before committing a parcel; it makes no provider call.
- Fence selected native submission on succeeded same-provider operator attempts and full per-line held/committed reservation coverage. Admit initial `subscription` orders; retain the paid-cycle check only for recorded `subscription_cycle`. Replacement submission is supplied by the later native alignment composition; accepted-proof recovery remains available.
- Add selected native dispatch candidates and final admission, actual-command shadow fingerprint forwarding, draft promotion/refresh and durable neutral failed/uncertain diagnostics. Operator audit attempts remain separate from command proof attempts.

Migration: install the complete selected catalogue through `20261120110000_fulfillment_dispatch_outcomes.sql` before using these factories or the updated native dispatch store. Select `nativeDispatch: { portKey, providerRef }` or retain the existing host reader/list composition. Supply the adapter's pure `shadowCommandFingerprint` to preserve actual command identity across shadow and stage.

Migration: same-parcel/provider mapped-attempt replay returns the first attempt across draft refresh and promotion. Submitted references retain their mode and command identity. Existing dispatch outcomes stay NULL; no historical contacts, reservations, modes or acceptance proofs are reconstructed. Connected native transfers include the new private operator-attempt table.

Migration: the reference adapter preserves unreadable rejection bodies as network uncertainty, including HTTP 400. Readable definite rejections remain failed. Neither failed nor uncertain outcomes authorize automatic resubmission. No hosted provider qualification is implied.

Compose native provider ingress and leased reconciliation over the existing workers, recorded dispatch commitments, exact parcel reservations, shipment commands and job ledger. Retain first webhook envelopes, current polling tracking snapshots, closed occurrence/recovery facts and scoped holds without rewriting parcel status. Provider identity resolves first; all recorded fallback associations must agree on one order before ACK, and every match checks the adapter's outbound order identity. Delivered observations with no references retain the documented manual arrival path.

Migration: install the complete catalogue through `20261120120000_fulfillment_provider_intake.sql` before binding `createPostgresFulfillmentProviderIntake`. Adapters selecting native intake must add closed `intake` facts and retain original occurrence bytes in optional `intake.occurredAt`; missing original chronology uses receipt time. Supply the adapter-owned optional `orderIdentity` mapping when outbound merchant identity differs from the recorded order number; existing generic callers and unbound operator fallbacks remain compatible. The optional durable observation readback is additive. Historical rows are not inferred or backfilled.

Migration: typed consumers can now handle three native dispatch refusals that were already returned.

- Remove provider trace columns from the source status facade and generated JSON; adapter-owned dictionaries retain provider status translation.

Migration: shared status-map JSON carries only the neutral core map. Use adapter-owned dictionaries for provider trace requirements. Prefer canonical `packed`; historical display aliases remain accepted without changed customer-step results.

- Add the experimental `./fulfillment/testing` offline certification entry and scripted transport. Full qualification validates copied data with closed schemas and credits only independently compared invocations in one ledger. Evidence includes mode, derived profile, capability digest and port-less declarations. Host locking, durable deduplication, cancellation races, replacement and alignment remain real-PostgreSQL evidence.

- Keep executed refusal probes for non-PDF formats, label create/void, provider-side cancel, independent split, provider-owned reservations, snapshot-only movements and pickup-point/locker execution. The closed port-less list contains only courier pickup: unsupported records `probe: "no_port"`; supported fails with `capability_not_certifiable`. Callable unsupported operations need refusal witnesses. No provider behavior or SQL changes.

- Bind captured-adapter qualification to the deeply frozen original dispatch port and methods. Freeze scripted transport method slots. Derive refusal fixtures and the unchanged refusal type from the internal shared `FULFILLMENT_REFUSAL_REASONS` tuple.

- Apply readback capability and observation checks to paged rows; bind scenario aliases to their operation's existing capability guard. Snapshot and validate closed scripted outcomes once at enqueue. Refuse shared-memory buffers and views with `validation:shared_memory`.

- Check unmapped poll evidence, observation replays, provider references and diagnostics through the shared projections before qualification credit. Snapshot asynchronous outcomes once; copy synchronous throws separately.

Migration: the unreleased testing subject's label-void expectations require an exclusive `canProceed` branch; successful cleanup cannot carry a refusal. Production label-port types and baseline callers remain unchanged.

Migration: scripted fake outcomes now contain snapshot-compatible data; construct `Response` objects from copied body/status data at the injected fetch boundary. Unknown outcome fields refuse before invocation; descriptor and buffer checks mitigate accidental accessor/proxy and shared-memory misuse. Paging evidence is recorded under `readback`.

Migration: captured adapters and their nested capabilities/ports are immutable; compose a separate adapter for custom behavior. The unreleased testing subject requires an expected dispatch after prepared results and forbids dispatch/replay keys after refused preparation. Existing baseline subject types remain accepted. Baseline host-storage label reads remain available when adapter label reading is unsupported; full mode still requires an explicit refusal. The internal shared `FULFILLMENT_REFUSAL_REASONS` tuple preserves every existing reason.

Migration: existing imports and one-argument calls retain baseline mode with shared data validation. Full mode requires independent expectations for every slot and mutually exclusive sync `{ input, expected }` / `{ input, throws }` roles. Refused preparations omit dispatch/replay keys; scenario indices are distinct integers in range. Supply read-only `fake.calls` handles backed by the private log, not caller arrays. Replace snapshot worker callbacks with `snapshotOnly: true`; the runner executes the real worker with its own isolated provider/store. Profile is derived: only the captured adapter factory brand permits dispatch-only qualification, which earns no other capability certification. Supported operations need contract-positive success and typed failure; unsupported cannot stand in for the failure of a supported operation. Missing expectations and malformed branches fail validation; descriptor-based snapshots mitigate accidental proxy, accessor and hidden-property misuse. Executable methods are captured once and invoked through a captured intrinsic. Return native promises without constructor/species overrides; native-promise checks and captured `then` handling mitigate accidental redirection. Policy callbacks and optional host-store methods use the same capture boundary; their returned and thrown data is copied before use. Inputs and outcomes are copied before use and compared by kind and deep strict equality. The kit certifies adapter behaviour against honestly built data fixtures and rejects missing, malformed or contradictory fixtures and contract-violating adapter results. Deliberate accessor, proxy or overridden-intrinsic manipulation to defeat the caller's own certification is outside the threat model. These mitigations reduce accidental misuse; they are not an attestation.

Migration: existing `./fulfillment` and `./fulfillment/testing` imports, signatures and behavior stay unchanged. Shared conformance support now belongs to fulfillment internals; the testing entry re-exports the same scenario types and scripted transport.

- Replace native provider identity predicates with immutable declarative profiles, retaining existing evidence, refusal codes, validation order and replay behavior. Reference adapters carry typed profile declarations; SQL/TypeScript parity and a declaration-only third-provider witness exercise both policy variants.
- Add optional host-selected execution flow labels to the portable payment rail; omission preserves the existing composition. The second reference provider's portable composition remains unsupported.

Migration: apply the complete selected catalogue through `20261121090000_payment_provider_profiles.sql`. It replaces exactly ten functions and retains their existing privileges, including the sealed interactive body. Historical slots, witnesses, stored identities and receipts are unchanged. Arbitrary admitted providers retain their generic fallback; claims and reopening remain opt-in by profile. No mutable registry, provider activation or live qualification is introduced.

Known limits for the complete set: Provider and carrier proof is limited to fake clients, scripted adapters and offline fixtures; no live provider or carrier qualification is claimed. The starter still selects sandbox payments. The native payment rail supports the two reference providers through declarative profiles; a third provider needs a declaration plus its adapter. The supplied portable payment composition covers the reference card provider only; the second reference provider has no supplied portable composition. The included warehouse adapter is a reference example. Imports, declarations, package installation and offline certification activate no integration.

Fulfillment retains local reservations and local finished-picking consumption; provider-held reservations, provider-managed consumption, independent splits, standalone pickup-point/locker execution, native label create/void and provider-side cancellation remain unsupported. Labels are PDF only; reference-adapter label reads remain host-owned. Courier pickup has no provider-reaching port and declared support cannot earn full certification. Snapshot-only stock has no movements. Saved preferences require carrier/service strings even when native provider-selected parcels allow nulls. Native overview data requires a host reader.

Historical contacts, reservations, modes, acceptance proofs and arrival facts are not backfilled. Failed or uncertain dispatch and a lost replacement acknowledgement never authorize blind resubmission. Fulfilled parents need an authorized host workflow for replacement dispatch. Replacement creation/dispatch never confirm arrival: record actual delivery; an undelivered replacement remains outstanding. Delivered observations without admitted tracking references retain status evidence but cannot record arrival or alignment. The monotonic clamp never moves a cycle earlier or stacks deliveries.

Intake uses sequential page numbers, not opaque cursors; polling-only providers refuse webhook intake. Empty collections prove no absence. Human holds, terminal provider exceptions and evidence without usable chronology require manual handling. Native reads refuse missing destination/line snapshots. Replaying incomplete webhook transport metadata may replace polling-enriched nullable reference fields. Resolve missing or conflicting historical associations and evidence through authorized recovery; no inferred parcel, chronology or stock is supplied.

Offline certification checks honestly built fixtures and contract results; deliberate accessor, proxy or overridden-intrinsic manipulation to defeat the caller's own certification is outside its threat model. It is not an attestation of durable host behavior. Absence auto-reopen stays off by default and later dispatch requires explicit due-reopen consumption. Refund creation remains separate; refund evidence does not pause or cancel subscription service. Experimental services remain inert until explicitly composed.

## [0.42.0]

- Publishable on the npm `latest` dist-tag as `0.42.0`, from tag
  `openlup-platform-v0.42.0`.

- Add explicit native payment-method collection, reusable-reference storage, lifecycle delivery and recorded health, with scoped repair and recovery authority that freezes at dispatch. Historical mirrors are never promoted to charging evidence automatically. Retry admission and dispatch freeze bind the exact provider-method row and lock its recovery token through commit. Retry selection and preparation respect quarantine; real renewal/provider history cannot fall back to sandbox compatibility. Completed sandbox attachments with current sandbox terms preserve their lane when only the initial paid checkout used another channel; recorded references, including inactive rows, still select strict authority. Reminder production reads bounded method facts under runtime privileges; spent repair authority does not block later automatic rungs, and active expiring methods remain eligible for renewal reminders.

Migration: install the complete selected native chain through `20261114110000_payment_method_refs.sql` before composing collection or recorded-method readers. For host-composed native subscriptions without recorded refs and with real-provider history, retry, recovery, reactivation, auto-resume and upcoming reminders refuse or remain ineligible until the host records refs with `payment_method_ref_upsert` from verified evidence. Original renewal charging retains its previous method and mandate evidence behavior when no recorded reference exists, even with real-provider history. Once any reference row exists, every reader uses strict recorded authority, regardless of its status or active state. Account-support health follows the lifecycle classification even without a reference. Explicit sandbox subscriptions retain their behavior. Existing labels and token rows are not backfilled; obtain a new authorized token when recovery context is absent, select a host-authenticated setup lane and preserve outstanding retry authority. Setup callers must retain one trimmed 8–180 character idempotency key; formerly accepted short or oversized keys now refuse before ownership lookup or provider I/O.

- Correlate initial-order provider history before selecting sandbox compatibility; account health and lifecycle admission select strict authority for that history even without a reference. Original renewal evidence reads preserve their previous behavior until a reference is recorded; recorded rows in any state prevent fallback in every reader. Setup requests trim the key and enforce its 8–180 character contract before ownership lookup or provider I/O.

- Add native durable provider attempts, immutable verified ingress, replay receipts and separate payment identities. Preparation commits before provider execution; acknowledgement finalizes the same row, and unresolved or superseded attribution refuses before settlement effects.
- Add PostgreSQL persistence, webhook and recovery evidence factories. Enable only the prepared durable store capability; method setup, absence reopening and cumulative refund retain their existing limits. Historical rows are never reconstructed automatically.
- Record correlated provider renewal failures as immutable attempt-bound retry receipts before financial truth ingestion. Reuse one settlement transition and retain native obligation scheduling; provider dunning case, notice, token handoff and real renewal binding await later composition.
- Record an expiry after a decline on the same renewal attempt as a replay-safe escalation, retaining the existing failure receipt, retry stage and schedule.

Migration: install the complete selected native chain through `20261114100000_payment_provider_attempt_store.sql` before composing the ports. Hosts provide recorded provider authority and verified adapters. A refund does not pause or cancel a subscription; offline evidence does not activate a provider or a hosted journey.

Unpaid-order cancellation terminalizes provider payment authority. Recoverable
one-time and initial-subscription declines include a live checkout recovery
token in the delayed payment-failed notice. Inline response-loss replay reads
the durable transition without fresh method or purchase context.

Add the native PostgreSQL reconciliation port, atomic exact-attempt application,
attributed failure handoff, proof-backed absence reopen receipts and cumulative
refund evidence. Install the complete migration chain; absence auto-reopen stays
off, and immutable prepared dispatch receipts still require explicit due-reopen
consumption before later host execution.

Refunds preserve original settlement money, subscription service and paid-cycle
history. The native `commerce.order.refunded` event remains status-only;
financial customer messaging uses `commerce.order.refund_processed`, gated by
accepted same-currency evidence. Historical unattributed attempts and dunning
cases retain named refusal paths. Refund creation and provider activation are
outside this change.

A correlated failed webhook hands off dunning independently of its financial
result kind. If the direct result committed first, the handoff uses its original
attempt-bound failure receipt; duplicate delivery does not repeat money, retry
stages, recovery authority or notices.

- Add explicit card provider composition over native PostgreSQL payment, method-reference, reconciliation and retry owners. Prepared requests commit before dispatch; uncertain/replayed requests never dispatch again. Customer, client, order and save-card inputs and redacted finalization facts pass through the neutral factory additively.
- Bind timestamped verified ingress, immutable failure rungs, attributed dunning, recorded method replacement and evidence-gated cumulative refunds. Preserve provider time separately from first receipt; untimestamped card provider readback remains ambiguous.
- Validate addressed recorded-method authority before renewal dispatch, keep untimestamped native source/return carriers absent, replay finalized SCA refusals through the durable refusal owner, and acknowledge exact-attempt refusals for superseded or unresolved success events using their durable attribution, including unresolved redelivery after finalization.
- Keep default sandbox bindings and existing managed exports. The native rail supports the two reference payment providers; a third provider needs the provider-profile refactor. The supplied portable composition selects card provider only; live activation and the second reference provider's portable composition remain separate.

Migration: Install the complete native catalogue through `20261114120000_payment_reconciliation_refund_evidence.sql`, then explicitly compose the payment rail and renewal webhook/lifecycle/retry ports together. Historical method refs require owner-authorized registration; no automatic backfill is supplied. No SQL migration is added.

Known limits for the complete set: The native rail supports the two reference payment providers; a third provider needs the provider-profile refactor. The second reference provider's portable composition and the provider-profile refactor are deferred to a later set. Provider qualification is limited to fake-client proof; no live provider qualification is claimed. The starter still selects sandbox payments by default.
