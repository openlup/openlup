## Compatible data transfer

The native starter uses the checkout attempt ledger for default quotas across
processes and restarts on the same store database. Ledger rows are authoritative,
short-lived admission state.
The native connected-store profile carries the three digests and original epoch
milliseconds exactly in owner-only packets. Treat these as restricted
pseudonymous abuse-control data and keep the packets private. The ledger holds
no raw email, IP address, idempotency key, headers or request payload, and has no
client foreign key or absorption mapping.

Restore the ledger before enabling checkout under the same limit and identity
policy.

Connected-store restore admits only a packet captured on the target's exact
current qualified inventory. Any other inventory, including earlier releases
and unreleased states, refuses with `schema_conflict`. The remedy is
`capture the source and restore it with the same OpenLup version on a pristine target of the same profile; upgrade the source within its installed profile first if it is older`.
If no such target can be provisioned, connected-store restore is unavailable for that pair.
Each release cut decides whether the previous release
is admitted, with one general additive conversion keyed on that release's tables
and columns, or documents its refusal. A migration adds no
restore pin of its own. A migration that adds a captured table or a nullable
column to one registers it in the capture roster and restore order, or in that
table's additive columns, in the same change.

Restored attempts age on their
original timestamps. Admission prunes rows at the retention cutoff on each
call. Idle databases keep bounded rows
until the next call or an owner cleanup. For managed same-schema transfer use
the bounded `@openlup/platform/portability` utility. The managed-to-native
legacy projection refuses populated limiter relations outside its finite profile.

The forward starts with an empty ledger. The table owner can inspect or clean
it up. The routine runs with owner rights and grants only routine EXECUTE to
`service_role`, which qualified runtimes already inherit. For a separate native
runtime login, grant EXECUTE on `public.commerce_record_checkout_attempt(text,
text, text, bigint, bigint, bigint, bigint, bigint)` to that login, with no
table grants. Apply the forward before wiring a checkout caller.

Catalogue definitions, definition-install receipts and tax-class keys are
AUTHORITATIVE catalogue relations in the native connected-store profile. The `transfer_round_trip_matrix` covers each relation, retained v1/v2 definitions,
receipt replay, bound product references and retired tax keys. Restore
definitions before products so nullable type bindings satisfy their composite
foreign key; preserve definition bytes, digests, receipts and retired key state.
These relations contain pack metadata and no customer foreign keys, so they need
no client-absorption policy row or personal-data erasure contributor. Restore
inserts immutable versions on a pristine target; normal UPDATE and DELETE remain
refused by the definition trigger. See the
[package catalogue owner](../../../packages/platform/README.md#catalog) for explicit
install executors, readiness observations and the unbound write guard.

The native [subscription profile forward](../../../db/platform/migrations/20261124230000_subscription_profiles.sql)
adds owner-only receipts. Each key and version belongs to the first pack that
installed its declaration. An identical declaration can be reused by a later
pack. PostgreSQL binds the identity and SHA-256 digest to the stored bytes.
The installer owns canonical form and the existing native cadence guards
still govern subscription writes.

Connected-store capture refuses a store that has subscription profile receipts
with `subscription_profile_receipts_unsupported`. This check runs in the
validated read-only snapshot before row collection or size checks. A store with
reference-only catalogue receipts can still transfer. Wait for connected-store
restore support for subscription profile receipts (RS-1).

Managed-to-native retained transfer initializes only absent product `type_key`
and `type_version` fields to NULL. Supplied values, including explicit NULLs,
are preserved; the generic missing-column refusal still applies to every other
required target column. This is legacy ingress compatibility, not a managed
catalogue-definition installer.

The native definition-binding forward adds no seed or backfill. Old readers
ignore the nullable product columns, and NULL continues to mean legacy, not
mapped. The managed rail does not supply this feature; its future equivalent
needs separately authored tables, service/operator read policies and a restricted
install principal. Native owner-only invoker semantics can be expressed by
managed grants and RLS. This forward relaxes no constraints on `net_weight_g`,
`pet_type`, `kcal_per_unit`, `requires_pet_profile` or `feeding_grams_per_unit`.

Live SKU net-content and gross-mass columns are AUTHORITATIVE catalogue data,
carried in the existing `catalog_skus` capture entry and restore position. They
add no relation, customer foreign key, personal data or absorption duty. The
`transfer_round_trip_matrix` compares complete raw PostgreSQL rows, including
40-digit coefficients and scales, across capture and restore. Managed-to-native
retained transfer initializes only absent quantity fields to NULL, preserves
supplied fields and keeps the existing missing-column and exact-number refusals.

The native quantity forward adds and validates nullable group CHECKs without
changing `net_weight_g`. Old readers keep reading grams; V2 readers, the checked
compatibility projection and nullability changes belong to the later reader
stage. After migration, an explicit migration-owner call to
`backfillCatalogNetContent(installExecutor, {batchSize})` drains bounded,
ascending-ID batches. Only positive legacy grams with absent content convert;
zero stays unknown, existing quantities and gross mass are never overwritten.
No install hook runs automatically, and runtime has no backfill EXECUTE. See the
[package catalogue owner](../../../packages/platform/README.md#catalog) for the driver
and the [catalogue lock order](../CANONICAL_CONTRACTS.md#catalogue-lock-order).
The managed rail does not supply this feature. Its twin needs the same nullable
SKU groups under the managed table's grants and RLS, with an administrative
install principal and no runtime EXECUTE. Existing mandatory food-related
columns and their later relaxation remain separate from this expansion.

Product `variant_axes` and SKU `option_values`, `canonical_option_bytes` and
`combination_digest` are AUTHORITATIVE fields in existing catalogue rows, with
unchanged capture entries and restore order. Transfer compares declared axis
order, exact bytes/digests and unmapped legacy NULLs through capture, restore and
replay. Text and options follow the sensitive retained stream; there is no new
relation, direct client FK, absorption entry or subject-erasure claim.
Managed retained mapping supplies NULL only for absent new fields and preserves
supplied values and all existing missing-column and exact-number refusals.

The native axes forward adds nullable columns, object/digest-width CHECKs and
active-SKU partial uniqueness on `(product_id, combination_digest)`; it preserves
legacy rows, codes, ownership and constraints. Old readers ignore the expansion.
Future V2 readers and publications require complete typed evidence. Code rollback
keeps the expansion and retained data intact. The
[package catalogue owner](../../../packages/platform/README.md#catalog) describes
the separate V2 trusted canonicalizer and pure conflict validator; SQL storage
does not certify caller bytes or supply a publisher. Publication and lifecycle
integration, including explicit legacy mapping and incremental capacity
enforcement, remain pending. No agreement is changed or capability activated.

The managed rail does not supply this feature. Its twin needs equivalent nullable
columns, CHECKs and active-SKU partial uniqueness, preserving managed RLS and
grants with restrictive administrative writer access. Managed grants/RLS can
express the native ownership restriction. Existing format/content uniqueness
and mandatory food columns remain until their separately proven publication
and reader migration stages.

Product and SKU `attribute_values` are AUTHORITATIVE, sensitive retained data in
the existing catalogue capture entries and restore order. NULL means legacy
absence; supplied objects have an independent 1 MiB PostgreSQL rendered-text
ceiling. Canonical JSON safety checks and the aggregate draft ceiling measure a
separate boundary. No document mining, defaults or mass backfill is performed.
Old readers ignore these nullable fields; future typed readers require the V2
publication evidence. Rolling code back leaves the nullable fields and retained
values intact; do not reverse the migration or discard populated columns.

The unbound package owner now validates typed values and prepares projection
rows without database access. Each product/SKU object also passes an independent
rendered-text byte guard, including JSONB separator spaces and UTF-8 string bytes;
numeric exponent expansion is conservatively bounded. An oversized object is
refused before projection preparation with `attribute_storage_too_large` at its
owner path. A separate 2,048-byte UTF-8 limit on each projected text slot,
including the whole localized map, keeps prepared rows within the landed
unconditional composite B-tree index on the qualified stock PostgreSQL profile;
oversized slots refuse with `attribute_projection_text_too_large`. The aggregate
canonical-input bound remains separate. See the [catalogue package owner](../../../packages/platform/README.md#catalog)
for wire shapes, reference visibility evidence, exact numeric handling and
readiness refusal. This adds no migration or transfer disposition. Old readers
continue to ignore nullable values; future V2 readers require publication
evidence. Publication/digest integration and durable shadow rebuilds remain
pending, so preparation alone grants no serving or restore-rebuild capability.

`catalog_attribute_projection` is REBUILDABLE. The closed capture census records
only its owner and row count with disposition `rebuildable`, even when nonempty;
no projection row enters an authoritative payload. Restore validates that exact
disposition, refuses a projection in the carried table list and requires the
fresh target projection to be empty. Replaying restore does not restore stale
rows. Actual rebuilding and the gate before any projection consumer are later
work; this expansion enables no serving switch. The `transfer_round_trip_matrix`
compares complete product/SKU rows, command replay and populated projection
omission using real PostgreSQL. Managed retained mapping supplies NULL only for
absent `attribute_values` columns, preserving supplied values, explicit NULLs,
missing-column refusals and exact-number guards.

Free text and reference values may contain personal data and travel in the
sensitive retained stream. There is no new direct `clients` FK, so no absorption
census row is added; this change makes no new subject-erasure claim. The native
projection uses table ownership for administrative access, with RLS and no
runtime/browser access. The managed rail does not supply this feature. Its twin
needs nullable product/SKU JSONB columns with equivalent checks and the same
projection table and indexes, retaining existing grants/RLS on authoritative
rows. A restricted administrative principal owns projection maintenance; runtime
projection access remains denied until a later explicit grant/policy, and browser
roles receive no direct writes. These semantics are expressible by managed
grants and RLS. Mandatory food-column relaxation remains later reader work.
See the [package catalogue owner](../../../packages/platform/README.md#catalog) and
[catalogue lock order](../CANONICAL_CONTRACTS.md#catalogue-lock-order).

The experimental [compatible-row utility](../../../packages/platform/src/portability/postgresRows.ts)
transports data into an already qualified canonical target. It does not restore
managed internals, source roles/grants or `platform_schema_migrations`. Source
and target transaction capabilities remain host-owned; an opaque catalogue label
does not prove that an installation is compatible. Identical typed rows replay,
and changed retained rows refuse rather than becoming business status updates.
The copier admits the pinned validation-only INSERT triggers on renewal terms
and operations. They run during replay. Other enabled user INSERT triggers
require the table's restore owner.

The [handover witness](../../../tests/postgres/runM14EffectHandover.ts)
takes its final finite connected-table graph and application's complete private
`objects/tmp` capture only after its finite source writers and observed server
backends retire. The default crash-boundary mode captures with a read-only
migration-owner session. In catch-up mode the fixture closes its bootstrap
administrator pool after retiring source backends, then opens a new
bootstrap-principal session configured read-only by default for the final
capture/census and closes it afterward. This local superuser fixture step does
not qualify a restricted source-capture login; actual source and target domain
commands use the qualified restricted runtime. The existing
canonical native capture sets `row_security=off` within its snapshot so a
filtered read refuses rather than appearing empty. Capture requires a login
with table-owner or row-security bypass rights. The capture/restore adapters
retain raw PostgreSQL JSON text, pending
uploads, partial bytes, cleanup obligations and leases without copying schema,
roles, private installation-key payloads or migration history. Database and
filesystem publication are separate; both must finish before target recovery
or application startup. Source `submitting` rows remain unchanged through import;
only afterward may the existing runtime transition retain uncertainty and G1
accept verified external facts. No source normalization, forced expiry, proven
absence or complete upload is manufactured. The portable-only mode does not
qualify managed-history mapping. The opt-in `--managed-catch-up` mode composes
the finite managed typed capture/mapping with this same native import and checks
source facts against both local targets before activation. History-only rows
remain in the operator's source archive and are absent from target data.
Managed Storage remains empty in this journey. The separate
[managed Storage witness](../../../tests/postgres/managedStorageTransfer.proof.ts)
uses the finite operator-only projection described below and copies its final
filesystem objects onward through the existing portable object path. It does
not add managed objects to the three-installation journey or repeat its row
second leg. Required managed first-leg
tests use the stock-PG17 compatibility adapter; the opt-in real-source runner
repeats them on the pinned managed source and executes the complete journey.
This does not qualify an
adopter's complete writer inventory or hosted source and object policy.
Its optional catch-up mode also takes a preliminary copy while the source
changes. It discards that target selection and uses a separate fresh inactive
generation for final recapture and exact readback; no existing target rows are
patched or deleted to simulate catch-up. The [transfer architecture](../ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
owns its interrupted atomic retry, source-domain access and activation evidence.

The finite native profile also admits the existing canonical catalog,
price-list and subscription-line parents of a retained subscription, and the
recipient-consent, native send/observation and communication-sync rows needed
for pending communication work. These names use the same qualified-target
catalogue, column-shape, pristine-row, locked insertion, replay and exact-census
checks as the rest of the profile; no arbitrary source table becomes writable.
Native dunning cases, fenced notifications, reminder-ledger rows and transactional
delivery receipts are also retained. Cases precede their notifications during
restore, and accepted delivery evidence keeps its original idempotency key.
The [notice witness](../../../tests/postgres/m19NoticeIsolation.test.ts) compares all
four row sets after real connected capture/restore and repeats the restore.

Connected native restore refuses any subscription whose `configured_offer_version`
is not `classic` with `unsupported_table` for `subscriptions` before any target
data write; sized offer bindings have no transfer mapping in this preview.

Catalogue authoring data is authoritative retained data, not a projection to
rebuild. The finite native profile carries `catalog_draft_heads`,
`catalog_draft_revisions`, `catalog_draft_command_receipts` and
`catalog_draft_sku_reservations`. Restore inserts heads, then revisions, then
command receipts, then SKU reservations (whose only parent is the head).
Abandoned heads, historical revisions, payloads, command keys, fingerprints,
actor text, reserved SKU identities and timestamps retain their original values.
The existing draft history triggers guard UPDATE/DELETE only; INSERT needs no
trigger exception. Restoring these draft rows does not publish them or add
products, SKUs or prices beyond the captured live catalogue. The parameterized
[`transfer_round_trip_matrix`](../../../tests/postgres/connectedStoreCatalogDrafts.test.ts)
checks all four relations and command replay against real PostgreSQL.

The versioned draft forward at position 147 changes only `catalog_draft_apply`.
It admits v2 payloads beside unchanged v1 commands and receipts. V2 carries
attribute values and complete immediate base-price commands as immutable data;
it changes no live catalogue or commerce row. Its resume appends an open revision
copying the abandoned payload and leaves reservations and abandonment receipts
intact. These JSONB additions use the existing authoritative capture entries and
restore order, with no trigger exception or new privacy/absorption class. The
matrix covers two v2 price plans, abandonment, resume and original replay.
Apply schema first, then compatible v1/v2 readers before enabling authoring.
Rollback stops new v2 writes and retains a reader for existing v2 history.
The managed rail does not supply this feature; the
[migration note](../../../packages/platform/CHANGELOG.md#100) records its managed design.

None of these four relations references `public.clients`, so no client
absorption-policy entry applies. Revision `actor_id` is an opaque operator
identifier and can be personal data; free-form draft payloads can also contain
personal data. These retained rows belong to the same sensitive transfer stream
and host access/exclusion requirements as other owned rows. Carrying them adds
no subject export or erasure contributor: the existing
[personal-data coverage limits](../IDENTITY.md#retained-responsibilities) still
apply. No actor identifier or draft payload is rewritten during transfer.

Channel source captures, purchased-line claims and pull pages have no transfer
mapping in this profile. Native restore imports ordinary outbox rows through the
locked owner path and refuses the three protected channel evidence types before
insertion. The generic row importer retains its INSERT-trigger refusal. With the complete
channel catalogue, `outbox_events` also requires the owner path, which remains
reference-source only.
Managed capture recognizes only the complete three dormant channel registrations
as installation metadata, without carrying them into target business rows. It
checks all five columns: exact event type, owner and reason, and a shared finite
PostgreSQL installation timestamp equal in both timestamp columns. Independent
installations need not share that timestamp. An empty registration table keeps
its original unsupported-empty disposition; unknown or drifted registrations
and nonempty channel business relations still refuse.
The managed source extractor inventories one disposable managed snapshot,
including Auth identity metadata and Storage metadata relations.
The managed source extractor is reference-source code and is not part of any
published `@openlup/*` package. The capture
login must be exempt from row security and able to read every relation; a login
that row security would filter refuses instead of reading an empty source. It
projects only the finite typed obligations into a qualified canonical target. Full
managed audit and business history is not transferred: it remains in the
operator's source backup or snapshot, under the operator's access, retention
and erasure controls. The existing `retained-history` disposition identifies
source history with no remaining typed obligation; it creates no target row or
private history object. Reconciled provider settlement batches and matched
items stay in the operator's source archive while their settled money state is
carried in typed target rows. Completed source idempotency receipts stay in
that archive only after their windows expire. The operator waits until
outstanding idempotency windows expire and quiesces in-flight checkouts, then
captures. Provider payment identifiers of settled payments are carried with
the typed payment; provider reference rows of settled or terminal unpaid
payments and their raw payloads stay in the operator archive. Failed payments
are carried as typed failed settlement state; checked cancelled or expired
checkouts stay in the archive while their pending order is carried. Carried
settled transitions receive `invoicing_cutover` rows, so restored history opens
no new document duty, and carried fulfilment work can open one only when its
shipment later hands off. Issue every owed first invoice before capture, because a
carried paid order will not open one on the target. A terminal checkout reminder keeps only its key on the
carried unpaid order, so the target does not send it again; this is the one source key
that stays active. Carried subscriptions
stay at static delivery admission `blocked`: a due renewal refuses before stock or
payment and records that refusal for its schedule. Renewals of carried subscriptions
stay unsupported until a later subscription lifecycle carry, so keep the renewal job
off for them. A subscription with more than one line refuses. A number on a carried relation that a double cannot hold refuses, including
one in a column that is not carried; a JSON number's trailing zeros are not kept, so `1.50` arrives as `1.5`.
Free-form JSON (order metadata, event and outbox payloads) is copied as the source holds it, including source
IDs, so complete any source erasure first. A product with allergens set refuses, because the target catalogue
has no allergen column; a later carry adds it. Product name, description, ingredients and marketing content are
carried. Other product and SKU content columns, and order tax and net breakdowns, stay in the operator's archive.
A repeated provider event for a carried settled payment is refused as already settled, and one for an
archived checkout has no target payment to match, so let provider windows close before capture. Carried pending
work waits until the target composition has its handler. Restore refuses a packet over 10,000 rows or 64 MiB,
counting the target's own factory rows. The capture's census counts rows per relation, not per row class, so it
does not say how many became typed and how many stayed in the archive. The capture is qualified only for a source
on the pinned managed baseline: a missing carried relation or a removed column refuses, but an added or retyped
column is not detected, so requalify the transfer after any later source migration.
Any managed invoice row refuses, including issued
invoices, so a source with invoice rows cannot transfer yet. A starter-pack marker,
a synthetic test subscription, a quote line that disagrees with its price agreement
and an order item with no SKU also refuse. Nonempty unknown relations, incomplete typed obligations and
other settlement or idempotency states refuse transfer. Standard nonpublic managed Storage buckets, including
empty buckets, admit only policies whose role set is exactly `{service_role}`
or no policies. Both Storage relations must have row security enabled.
They project through the existing object path into
its private filesystem store. Local S3 probes corroborate bytes and access;
they do not establish exact S3 destination metadata. Other active Storage
semantics refuse. Source-keyed terminal effects
do not become active target command keys. Managed capture is local evidence
only; it does not qualify hosted managed data, object access or recovery.

In `--older-snapshot` mode, recovery instead reloads a persisted pre-provider-
acceptance DB packet and complete private media snapshot. Media writers have
retired and admitted dispatches are paused while this consistent boundary is
saved. The approximately 60-second age is real elapsed time. Later source
captures cannot replace this restore input. Before opening serving, the fixture
replays its independently retained later erasure obligation through the existing
restricted-runtime privacy transaction, including retained-text redaction and
authentication refusal. The older backup itself remains private and immutable.
The [transfer owner](../ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
defines its measured RPO/RTO, visible uncertainty and separate managed-source
proof boundary; this adds no schema, table admission or general backup service.

Historical insertion is not generally inert. `clients` insertion invokes
`customer_subject_capture_lifecycle_trigger`, generating new history; cycle
insertion invokes `subscription_delivery_alignment_guard_cycle_insert`, which
can consume admission or settle alignment. Order/item totals also use user
INSERT triggers. The first utility refuses all enabled user INSERT triggers,
including named constraints; it does not disable them, alter replication role,
forge admission or rewrite migration history. A full-store import therefore
still needs domain-owned import-safe routes or an approved canonical pre-data /
post-data installation design. Preprovisioned referenced parents and the exact
supported selected rows are prerequisites, not complete-store parity.

The qualified-only [retained-row unit](../../../db/platform/migrations/q2_20261026140000_retained_client_subscription_import.sql)
provides two narrow domain routes: `client_import_retained_row` accepts the 13
persisted client fields, and `subscription_cycle_import_retained_row` accepts
the eight persisted cycle fields. Each inserts an absent row, returns `false`
for an identical retained row, and refuses a differing row with `23505`.
Both refuse replication modes other than `origin` with `55000`; they do not
disable constraints or triggers or change replication settings.

The restore login receives only EXECUTE on these two SECURITY DEFINER routines.
Their sealed NOLOGIN owner receives SELECT/INSERT on clients and cycles, with
client SELECT/INSERT RLS policies. Only INSERT under that owner bypasses the
client lifecycle-history capture and cycle alignment-admission triggers. Normal
runtime INSERT and UPDATE paths retain their domain behavior; the unit grants
no UPDATE/DELETE or runtime access to the import routines. Parents, history,
frozen terms and identity mapping must still be restored through their existing
owners. These two routines are not a generic full-store restore capability.

This retained-row unit follows the initial qualified runtime-capabilities unit
in the selected manifest. Its exact source SHA-256 is
`56144f8e61b649c9d9f48458a1734abcc8bbd8d36fdc3919d90ceb1bc35d3b48`. The fifth
whole-file approval historically landed separately before this SQL introduction. The two
90-unit `withRestore` inventories from the E2+F-only candidate and the linked
[reference measurements](https://github.com/openlup/openlup/pull/404#issuecomment-6451079203)
are historical; the E-only 89-unit expectations and legacy 88-unit plan are
separate. At audited source pin `535349050419abe5122bd74fa6766c58947be3dd`, the
selected manifest includes this retained-row unit plus runtime completion in a
91-unit catalogue; the [manifest at that pin](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/config/platform-migration-manifest.json)
owns those historical hashes and inventory values. Current selections are defined
under [module catalogues and installed histories](../../../packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue).
A request without the
restore binding refuses before installation.

The [production composition witness at that pin](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/tests/postgres/m14QualifiedComposition.test.ts)
uses the actual built migration entry and default production transport. At that
source pin its four disposable PostgreSQL profiles check 91 ledger rows,
status/apply/replay, ordinary runtime writes and admission effects, restricted
restore imports, full-field precision, history/frozen-term preservation and
refusal behavior. The dated [runtime-completion result](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-operations-portability.md#runtime-completion-28-october-2026)
records the observed result. The witness and dated result cover only the selected
source and role profiles, not an adopter database, managed-host, publication,
activation or full-store restore qualification.

Managed `clients.auth_user_id` and native `clients.principal_id` need explicit
identity mapping. OIDC derives the principal from exact issuer/subject; email
equality cannot relink it. Dependent memberships, privacy receipts, history and
credential/session disposition remain part of the full
[M14 transfer outcome](../plans/oss-m14-operations-portability.md).

### Private delivery-contact transfer

The finite native graph includes `fulfillment_order_contacts` and
`fulfillment_contact_correction_receipts` after their order/client/shipment parents.
Qualified restore preserves exact rows, retained responses and payload-free erasure
markers; replay applies no correction, provider call or default selection. These
private tables have RLS and only the existing service-role client-column census
exception. They are outside the smaller compatible-row utility. The parcel-contact
privacy contributor owns their export and erasure alongside parcel contacts.

### Native destination receipt authority

The [destination receipt forward](../../../db/platform/migrations/20261125080000_commerce_destination_v2_receipts.sql)
adds a private receipt with the original scoped identity and success, an event
UUID and schema version, and finite database creation time. Fresh work uses an
owner transaction under READ COMMITTED. It takes the scoped advisory lock, the
shared privacy ledger fence, then the client lock on absence. It checks the
retained receipt again before effects. The transaction commits the receipt and
the effect together. There is no production issuer in this forward.

Lock and commit return `destination_isolation_unsupported` (SQLSTATE `22023`)
under other isolation levels. Roll back, then run the operation in a new
READ COMMITTED transaction.

The native privacy contributor exports available subject evidence and scrubs
the owner, dialect, original key and success in the authorized erasure
transaction. The retained client ID, scoped hash, request digest and audit
coordinates preserve replay identity. Subject export shows only the audit
coordinates and erased disposition after scrubbing. Retained replay returns
a null outcome. Both dispositions block lead absorption. The restricted
runtime can execute the receipt reader and privacy routines and read the
client ID for the absorption census.

The connected native profile captures the receipt as an owned row and restores
it after clients, preserving its exact evidence disposition and audit
coordinates. Use source packets from the current qualified inventory. Purge
or recapture private transfer packets that contain evidence erased after capture.

### Native checkout destination documents

The [checkout destination forward](../../../db/platform/migrations/20261125100000_commerce_destination_v2_checkout.sql)
adds private, immutable checkout snapshots and a mutable selection per
authorized owner and checkout scope. The runtime can issue and replay a
snapshot, read it by exact binding, and export or erase subject data.
Fresh issuance remains dormant in the reference host and starter.

The trusted native context supplies the installation and canonical principal,
the linked client ID, and the server-authorized checkout scope. A fresh issue
rechecks the principal link under the client lock. Use READ COMMITTED so
receipt coordination can observe a concurrent commit. Hash the tagged request
with the dialect, owner, key, purpose, scope and original address and contact
strings. The validated projection and caller time are outside that hash.
The shipping policy owner supplies the validated projection. The stored
document uses `country` and optional `subdivision`. Read and export share a
verifier that hashes stored UTF-8 bytes before decoding and checking ownership
and binding.

A selection advances to a new revision and snapshot even at equal address
bytes. Each unbound snapshot expires 24 hours after the database issue time
at millisecond precision. An exact replay keeps the first cutoff, and the
reader refuses at the cutoff. Run `commerce_destination_v2_expire` as the
migration owner with a batch size of 1–1,000. It uses database time and retires
a matching current pointer in the same transaction as its payload. Expired
rows keep owner, scope and binding for exact stale refusals. Erasure clears
those fields as well as payload and full digest and removes the subject's
selections. Expired and erased exports expose the snapshot ref, issuance
time and disposition. Verified available rows also export the document,
scope, digest and cutoff, including after cutoff until cleanup. An available
row that fails a stored-evidence check exports only the snapshot ref, issuance
time, disposition and verification status, code and field. The contributor
reports incomplete coverage. After cutoff, run the owner expiry batch and
export again. Review any rows still withheld.

Require `destination-receipts` and `destination-documents` in the same
registry used for native privacy operations. Assemble the two experimental
factories from `@openlup/platform/identity` and keep the registry installed
when issuance is disabled. Pass that same registry as `privacyRegistry` to
`destinationV2Capabilities`. Erasure uses the registry's required-owner check
before entering the privacy transaction. An authorized historical replay
of erased evidence returns the erased disposition alone.

Both relations carry through exact-current connected-store capture and
restore. The restricted runtime has only the document client-ID column for
lead absorption, which counts every disposition. Discard or recapture any
private transfer packet containing evidence erased after capture.

For an infrastructure failure, check the native app binding, database
connection and TLS, runtime CONNECT and EXECUTE privileges, and installed
migrations. Then retry the same operation.

### Policy revision close compatibility

The native `20261122140000_subscription_price_policy_close_digest.sql` forward
adds `closed_from_open` to `subscription_price_policy_revisions` and replaces
only its mutation guard. A successful one-time NULL-to-finite close sets the
marker atomically; every original digest field and the stored digest remain
unchanged. The existing overlap trigger and both native price readers use the
same shortened `[effective_from, effective_to)` window. No new lock, writer,
schedule, receipt or runtime privilege is introduced. See the
[catalogue agreements](../CANONICAL_CONTRACTS.md#catalogue-extension-agreements).

The updated policy verifier uses NULL as the digest end only when the immutable
marker records that original fact. A pre-forward row has marker false: it must
verify against its stored tuple. An already-shortened row whose tuple does not
verify refuses with `subscription_price_policy_original_tuple_unverified`.
No backfill guesses the missing end or recomputes a historical stored digest.
The migration itself does not adopt policies or enable serving. Verify retained
history with the new reader before an adopter enables any later writer; resolve
unverified originals from independently retained evidence under a separate
reviewed repair rather than rewriting their digests.

Apply the schema before the updated native readers, then verify readback before
allowing a close. Old readers continue to read unchanged revisions; they refuse
a shortened tuple whose digest covers its original NULL end. Once a close has
occurred, code rollback therefore requires readers retaining original-tuple
verification. Keep the forward and data in place; no down migration is supplied.
The marker is AUTHORITATIVE data in the existing policy capture/restore entry,
with unchanged restoration order and privacy classification. It adds no customer
foreign key or absorption duty. The parameterized
[round-trip witness](../../../tests/postgres/policyCloseDigest.test.ts) compares full
rows and commerce continuity through restore and replay.

The native `20261123192000_subscription_price_policy_close_provenance.sql`
forward rejects direct inserts of finite revisions marked `closed_from_open`
with `55000 subscription_price_policy_revision_close_provenance_requires_restore`.
An open revision with the marker set still fails the existing window check.
Use the matching connected-store restore implementation on upgraded targets.
It enables the exception only while copying policy rows in the restore
transaction and removes it before commit. The capability table must be empty
at capture and restore boundaries and is excluded from the transfer packet.
Catalogue document pointer capabilities authorize only their pointer updates.
The forward requires no backfill and the stored digest and native reader
contracts remain the same. The managed rail does not supply this guard.

Managed divergence design: the managed rail does not supply this feature.
A future twin adds the same marker and validated CHECK to the managed policy
revision table, preserves existing RLS and grants, and updates the managed
reader and mutation guard together. Administrative write grants and RLS must
restrict closes and marker writes; browser roles receive no write authority.
These permissions can express native owner-only writes without a native-only
role assumption. No food-column relaxation applies to this policy-only change.
The compatibility criterion is unchanged historical digests, the same shortened
window and named refusal for unverifiable legacy originals on both rails.

### Installed tax coverage history

`tax_coverage_revisions` is authoritative installation configuration in the
sensitive owner transfer stream. It has no parent relation. Connected restore
copies the full history, including original actor references and recorded
times. The owner appends through the
[installed coverage operation](../../../packages/platform/README.md#install-and-inspect-tax-coverage).
The runtime has execution access to the scoped reader alone. The reader's
arguments filter a trusted host's query scope.

Use opaque operator and acknowledgement references. Actor references can be
personal data. Existing identity privacy operations do not export or erase
this operator audit history. There is no customer link for absorption.

The forward is native-only. A connected settings read on the managed rail
refuses with `commerce_setting_read_unavailable`. Use a qualified native
PostgreSQL installation with a host-bound reader to inspect this history.

