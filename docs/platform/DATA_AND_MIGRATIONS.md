# Data And Migrations

Status: development-preview contract. It specifies a compatibility discipline;
it does not certify a migration path or an upgrade service.

## Data ownership

The platform owns its schema, migration history, and documented data contracts.
An adopter owns tables and migrations for its own extensions in the `app` schema.
The platform never writes there; the adopter owns extension compatibility and
migration ordering. Extension data must live beside platform data through explicit foreign keys, ports, or events rather
than by editing platform rows with undocumented assumptions.

The published platform shape must expose a reproducible baseline and ordered
forward migrations. Development convenience at process startup is not a
coordination mechanism for a multi-instance deployment.

The preview source release deliberately ships an unbound database-type seam at
`src/integrations/supabase/types.ts`; replace it with adopter-generated types
before enabling database adapters. It is not evidence of schema compatibility.

## Connection roles

Use the [runtime connection recipe](RUNTIME_AND_SELF_HOSTING.md#postgresql-connection-recipe)
to separate restricted pooled request work, direct migration/admin work and
session-affine scheduler locks. Migration and privileged administration connect
directly to PostgreSQL, bypassing external transaction and session poolers. The
existing migration runner takes `{ connectionString: directConnectionString }`;
its internal `pg.Pool` leases one connection for the whole operation and its
session advisory lock. That local client pool is distinct from a proxy that
reassigns PostgreSQL backends between statements. Do not feed a pooled runtime
URL through `resolvePostgresMigrationRunnerEnv` into a migration runner: that
helper continues to read `DATABASE_URL`, with no implicit direct-endpoint lookup.
Supply the migration port explicitly through the composition root's `migrations`
binder, including when the Node host migrates before listening.

Connection separation preserves the selected installation's principal/grant
contract; it grants no runtime DDL or migrator isolation. The current
qualified-v2 profile still requires its declared privileged migration principal.
The [production composition witness](../../tests/postgres/m14QualifiedComposition.test.ts)
installs/replays all 91 selected units through the direct endpoint, then exercises
the pooled request and dedicated session-lock recipe through the restricted
runtime login. Restricted-bootstrap installation is a separate qualification
and will reuse these connection roles when it lands. Hosted endpoints remain
unqualified by this local witness.

## Compatible data transfer

The experimental [compatible-row utility](../../packages/platform/src/portability/postgresRows.ts)
transports data into an already qualified canonical target. It does not restore
managed internals, source roles/grants or `platform_schema_migrations`. Source
and target transaction capabilities remain host-owned; an opaque catalogue label
does not prove that an installation is compatible. Identical typed rows replay,
and changed retained rows refuse rather than becoming business status updates.

The [handover witness](../../tests/postgres/runM14EffectHandover.ts)
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
Managed Storage remains empty in this journey; nonempty Storage refuses until
its separate typed object projection is available. Required managed first-leg
tests use the stock-PG17 compatibility adapter; the opt-in real-source runner
repeats them on the pinned managed source and executes the complete journey.
This does not qualify an
adopter's complete writer inventory or hosted source and object policy.
Its optional catch-up mode also takes a preliminary copy while the source
changes. It discards that target selection and uses a separate fresh inactive
generation for final recapture and exact readback; no existing target rows are
patched or deleted to simulate catch-up. The [transfer architecture](ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
owns its interrupted atomic retry, source-domain access and activation evidence.

The finite native profile also admits the existing canonical catalog,
price-list and subscription-line parents of a retained subscription, and the
recipient-consent, native send/observation and communication-sync rows needed
for pending communication work. These names use the same qualified-target
catalogue, column-shape, pristine-row, locked insertion, replay and exact-census
checks as the rest of the profile; no arbitrary source table becomes writable.
The managed source extractor inventories one disposable managed snapshot,
including Auth identity metadata and Storage metadata relations. The capture
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
other settlement or idempotency states refuse transfer. Managed Storage objects are not yet transferred;
nonempty managed Storage refuses. A separate managed object projection is
required before that source state can transfer. Source-keyed terminal effects
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
The [transfer owner](ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
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

The qualified-only [retained-row unit](../../db/platform/migrations/q2_20261026140000_retained_client_subscription_import.sql)
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
whole-file approval was landed separately before this SQL introduction. The two
90-unit `withRestore` inventories from the E2+F-only candidate and the linked
[reference measurements](https://github.com/openlup/openlup/pull/404#issuecomment-6451079203)
are historical; the E-only 89-unit expectations and legacy 88-unit plan are
separate. At audited source pin `535349050419abe5122bd74fa6766c58947be3dd`, the
selected manifest includes this retained-row unit plus runtime completion in a
91-unit catalogue; the [manifest at that pin](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/config/platform-migration-manifest.json)
owns those historical hashes and inventory values. Current selections are defined
under [module catalogues and installed histories](#module-catalogues-and-installed-histories).
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
[M14 transfer outcome](plans/oss-m14-operations-portability.md).

## Additive forward release path

A development preview may append expand-only platform forwards to either chain:

- Portable PostgreSQL: `db/platform/migrations/<14-digit-version>_<name>.sql`,
  with `config/platform-migration-manifest.json` preserving the baseline and all
  previous forward rows as an exact prefix and binding the added files by SHA-256.
- Managed Supabase: `supabase/migrations/<14-digit-version>_<name>.sql` after
  the frozen `00000000000000_platform_schema_baseline.sql` baseline.

Each new version must exceed every preceding version in its own chain. Existing
migration bytes and modes are immutable. The schema-5 release inventory binds
forward bytes; the source contract binds the extended portable manifest digest.
Database types, policy registry and bootstrap SQL remain frozen for this path.
Required pull-request and merge-group self-check compares the exact event base
with the candidate commit for this append-only migration rule. The preview
producer separately compares the selected release commit with the prior preview;
the earlier check does not replace that release-time comparison.
The self-check validates the manifest's shape and history, while the portable
runner checks `objectInventorySha256` against its live selected catalogue after
applying the chain. That runtime check remains required for database acceptance.
Both gates refuse control characters other than tab and line feed in migration SQL (parser parity with PostgreSQL).

The release producer refuses destructive DDL (`DROP TABLE`, `SCHEMA`, `VIEW`,
`TYPE` or `COLUMN`, and `TRUNCATE`), renames, schema moves, ownership transfers
and writes to adopter-owned `app`. Its bounded SQL predicate accepts additive
object creation, `ALTER TABLE ... ADD`, transaction boundaries and literal
`INSERT ... VALUES ... ON CONFLICT ... DO NOTHING` seeds with a single literal
VALUES list immediately after the target name and optional plain column list.
`CREATE SCHEMA [IF NOT EXISTS] name` takes no schema elements; expand-only
statements take no `OWNED BY` clause. Quoted identifiers are not seed literals
or conflict keywords. The original `ALTER TABLE ... ADD` checks remain required
alongside expression checks. New checks only add refusals before base admission.
Type parentheses require a listed built-in modifier type; square brackets are
limited to empty `[]` suffixes at verified type positions. Array constructors
and subscripts refuse before element splitting. Procedural or dynamic SQL
and unsupported forms refuse; see [Versioning and EOL](../../.github/VERSIONING_AND_EOL.md#publish-refuse-and-recover)
for the exact admission boundary. Passing admission does not prove N-1 or live
schema compatibility. Test the actual selected chain, constraints and replay.
Expand-only admission refuses query-bearing `CREATE TABLE`, `PARTITION OF` and
`LIKE`, operator references and function calls in default, check,
generated and index expressions other than a short allowlist of side-effect-free
built-ins; it is a bounded classifier, not a general SQL analyser.

Rows that platform behaviour depends on must ship as idempotent statements in a
forward, rather than relying on a reference fixture or process startup. A missing
twin in the other chain is a documented compatibility gap, not implicit parity.

## Module catalogues and installed histories

The package runner admits the migration ledger only when its system-catalog
shape matches the canonical baseline ledger: a permanent heap table with the
expected owner, columns, defaults, constraints and indexes, without partition
or inheritance links, triggers, rules, row policies or extended statistics.
The ledger catalog shape is qualified on PostgreSQL 16 and 17; a different
major with different catalog expression trees is refused until separately qualified.
It checks this before reading applied rows, keeps the admitted relation stable
through qualified session admission and complete inventory projection, and
reads only rows belonging to the ledger itself. These checks apply to legacy
and qualified sources. Legacy
bootstrap ownership remains accepted; qualified session admission still
requires its declared migration owner. Each applied unit is recorded after a
fresh ledger check within that unit's transaction. Individual migration
transactions and exact-prefix/replay behavior remain.

Risk's Node-only `RISK_MIGRATIONS` descriptor projects the unchanged
`20260813230000_post_order_control.sql` catalogue unit, including its co-located
return/control objects. The package asset preserves the canonical SHA-256
`f24ff3ee3c1022f73162db03b8900c93614d3d6d4c6375cf4aad8a3c0f3360a7`.
It adds no installation-chain file, managed forward or reviewed-forward class.
Install the full canonical catalogue and verify its installed prefix and live
object inventory; this sparse asset is not an install chain. Managed risk keeps
its existing frozen baseline functions, grants and RLS. Native risk uses invoker
functions and host-provisioned permissions, with no production role/grant model
introduced by this unit. The [risk contract](ARCHITECTURE_AND_EXTENSIONS.md#risk-contracts)
records the intentional differences preserved by the contribution.


Fulfillment appends native command and alignment units,
`20261022080000_fulfillment_command_ledger.sql` and
`20261022090000_fulfillment_delivery_alignment.sql`, after the shipping seed.
`FULFILLMENT_MIGRATIONS` projects units 5, 27, 51, 73, 74 and 76 with canonical identities and byte-identical package assets. Install the
complete catalogue, preserve the full installed prefix and verify its live
object inventory; the sparse projections are not an install chain. Existing
native and managed migration bytes remain unchanged.

For a fresh native install, the invariant "a late delivery extends the next cycle"
is enforced automatically only when delivery-alignment control mode is
`auto_align`. `public.subscription_delivery_alignment_control.mode` defaults to
`off` for rollout safety, so installation alone does not enforce the invariant.
The complete mode set is `off`, `shadow`, `protect` and `auto_align`, selected
through `public.subscription_delivery_alignment_set_mode`. Existing cases retain
their captured mode and protection after a control change.

Enforcing modes (`protect`, `auto_align`) require the host's renewal path to call
`subscription_delivery_alignment_admit_renewal` before inserting the cycle.
The [native renewal store](../../server/adapters/postgres/subscription/automaticRenewal.ts)
retains its static terms gate. A host that composes the native automatic-renewal
runner must wrap its store port with the
[admission decorator](../../server/runtime/subscription/deliveryAlignmentRenewalStore.ts)
before selecting an enforcing mode; an uncomposed
new-cycle insertion refuses with `subscription_delivery_alignment_admission_required`.
Until the host wraps that port, native delivery-alignment mode stays `off` or
`shadow`. The supplied boundary stops at the decorator, with no runner composer,
factory or production entrypoint. Captured protection survives rollback to `off`.

In enforcing modes, a subscription whose paid history has no activation or
renewal link, such as imported data, holds every due renewal for manual review.
Operators should check for such cycles before switching modes.

The command forward adds durable dispatch/attempt/paid-handoff and observation
receipts. Atomic ACK records the native `dispatch` external reference: the `3pl`
archetype does not create an owned label, and acceptance cannot imply physical
packing. That receipt also retains the native local-cancellation refusal.
Observation persistence distinguishes received observations from recorded status
evidence; only the latter supplies local occurrence chronology. Stock movements retain opaque
keys and replay fingerprints, while sync cursor state retains coverage gaps.
Host inventory lines and authoritative contact preparation remain injected.

The alignment forward translates managed fulfillment rows to native shipments,
replacement links to `replaces_shipment_id`, and subscription identity through
order → cycle → subscription. The effective cycle ordinal
comes from renewal operation numbering or the explicit activation-order link.

[The native translation decision](plans/oss-m08-fulfillment-physical-delivery.md#native-admission-and-delivery-alignment) maps donor activation cycle 1 ↔ native activation ordinal 0, and donor
renewal n+1 ↔ native renewal n. The activation ordinal requires a cycle with no
renewal operation whose linked order is the active `subscription_activations`
row's order for the same subscription. Renewal operation numbers remain ≥1.
Admission selects the highest known paid ordinal, so activation protects the
first renewal and each later paid renewal outranks activation. Successor
artifacts have a greater effective ordinal. Other unnumbered cycles remain
unordered: paid ones require manual review at due admission without minting a
receipt; other unordered cycles prevent automatic arrival alignment regardless
of scheduled date. They neither outrank known predecessors nor silently permit
an autonomous renewal. Shadow mode observes this ambiguity without blocking.

Local pre-dispatch cancellation changes only the shipment locally: alignment
creates no hold or shipment-exception event and does not block other shipments
of the order. An undelivered, unsuperseded cancelled parcel still counts as
outstanding at renewal admission in `protect` and `auto_align`. An explicit
provider exception uses the existing fulfillment-exception hold and notification
rules; alignment observes that active hold to open a case only when control is not
`off`, the order belongs to a paid subscription cycle and the subscription is
active. One-time orders do not open alignment cases. Exception cases never
pause subscriptions.

Existing-cycle renewal and dunning
retries bypass new-cycle admission and receipts. The new-cycle INSERT guard
retains exact schedule-bound, one-use receipt consumption. Default-off control
does not erase captured protected cases. Only durable arrival can settle the
automatic route, using the latest arrival plus cadence with the outer maximum.

All new routines are invokers with PUBLIC/anon/authenticated access revoked,
including helpers and trigger routines. The initial native executor is the
existing deployment owner; no role, SECURITY DEFINER, default grant or browser
capability is added. A separate service principal requires the maintainer's
explicit least-privilege grants on routines and underlying objects; owner
execution does not establish a non-owner grant set. Receipt pruning needs DELETE
on that receipt table if such an invoker is configured. Replacement confirmation remains a note-only operator
attestation with no automatic caller or new arrival predicate. The
[arrival-only discipline](plans/oss-m08-fulfillment-physical-delivery.md#native-admission-and-delivery-alignment)
remains binding.

Payments publishes `PAYMENT_MIGRATIONS` as byte-identical projections of canonical
positions 10 (settlement), 35 (truth/reconciliation) and 56 (later-only cycle).
Each retains its canonical path, SHA-256 and package asset URL. These three assets
are not an install chain: install the complete catalogue and preserve its exact
ledger prefix. No migration or manifest row is added. `paymentSchemaDescriptor`
declares direct truth, settlement and later-only alignment supported; durable
prepared attempts, method setup, absence reopen and cumulative refund unsupported.
Refunds are purely financial and do not cancel subscriptions. The direct truth
store retains its invoker SQL and requires the host's existing executor and
privileges; descriptor presence alone does not prove installed schema readiness.

`CATALOG_MIGRATIONS` additionally projects existing canonical catalog positions
1, 8, 58, 59 and 61: read foundation, storefront attributes, document/identifier
and subscription price-policy foundation, its validation, and isolated drafts.
Each descriptor keeps the canonical path, position, digest and byte-identical
package SQL. There is no new migration, reordered history or manifest edit.
Install and observe the complete selected catalogue; these five projections do
not supply an independent installation sequence. The package envelope and draft
stores keep their incumbent SQL and refusal semantics after the source move.


Inventory publishes sparse byte-identical projections of canonical units 27
(stock evidence) and 33 (automatic renewal) through `INVENTORY_MIGRATIONS`.
Canonical paths, positions and SHA-256 remain unchanged; this adds no migration
or manifest row. Install the complete catalogue. The [M06 store matrix](plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows)
separates native observed-stock operations from managed lot-based inventory,
refusals and outstanding real-host proof. Subscription/payment/delivery writers
remain at their incumbent boundaries; these projections install no schedule.

Catalog's `BUNDLE_MIGRATIONS` projects canonical bundle units 16 and 19 with exact
catalogPath, position, SHA-256 and artifact URL. The package SQL bytes are identical
to the canonical files; this is projection only, with no new migration, manifest
row or baseline change. Unit 30 belongs to channel lines and is not included.
Install the full canonical chain, not these two files alone. The moved native
store performs reads only; existing canonical write routines remain in place.
Five real-PostgreSQL cases characterize fresh/repeat application, complete reads,
whole-set rollback and refusals, dry runs, close-and-append prices, sequential key
recognition and denied versus explicitly granted invoker access. They establish
only the incumbent native subset: the database still has no independent human-only
actor-kind gate, and no concurrent replay or mounted parity is claimed.

Promotions publishes sparse, byte-identical projections of canonical units 47 and
48: promotion claim lifecycle and its constraint-validation forward. The module's
`PROMOTIONS_MIGRATIONS` descriptor retains each canonical catalogPath, position,
SHA-256 and artifact URL. This move adds no migration, baseline change or manifest
row. Install the full canonical catalogue rather than the sparse projections.
The native executor-backed store owns only evaluator reads and bounded sweep;
claim reservation/writing remains at its existing boundary. Real PostgreSQL proof
checks fresh canonical application/replay, read-only evidence, paid/released
transitions, sweep replay/fences and unauthorized versus explicitly granted reads.
It does not establish native code resolution or native/managed eligibility parity.

Direct OIDC principals fit the existing UUID `clients.principal_id`; the
versioned issuer/subject hash adds no table, forward, catalogue position or ledger
change. The direct account-link capability uses normal reconciliation and
parameterized DML, fills only null links and refuses normalized-email ambiguity.
Privacy receipt locking prevents recreation or relinking of erased principals.
It never converts legacy links, managed auth IDs, membership or subscriptions.
The opt-in real-issuer runner installs the full catalogue, checks exact ledger
rows and proves replay and preservation of existing application state. Its
[identity recipe](IDENTITY.md#real-issuer-oidc-recipe) requires real local services.

The direct human-login forward `20261018180000_identity_operator_challenges`
appends position 68 after invitations. Preserve every preceding file, digest and
position. The identity projection carries the same bytes and canonical position;
never install the sparse projection as a complete catalogue. Its normalized-email
unique index refuses duplicates instead of merging principals. Recompute the live
selected-catalog object inventory after applying the full chain. Fresh install,
exact-prefix upgrade, replay and retention of customer, subscription and machine
links need real-database proof; there is no managed counterpart.

Identity email-trust admission changes no schema or stored identities, contact
links or subscriptions. Its conformance runner replays the complete managed
baseline and ordered forwards using `psql`, without a CLI migration ledger.
After that replay it inserts a linked subscriber fixture before checking that
settings-failure refusal and repeated reconciliation preserve its client and
subscription rows. A public-catalogue fingerprint checks public relation names
and kinds across the envelope exercises; it covers neither migration-ledger
contents nor subscriber survival across SQL replay. The committed managed chain
includes `20261018160000_identity_service_role_capabilities.sql`; the runner proves
association under those shipped grants, as described in
[identity conformance](IDENTITY.md#conformance-and-outstanding-evidence).
The identity SQL projection is not a standalone install chain.


The canonical source manifest for `db/platform/migrations` is the existing
[`config/platform-migration-manifest.json`](../../config/platform-migration-manifest.json).
Version 1 keeps one baseline, ordered forward file/hash rows and the issued
selected-catalog-v2 `objectInventorySha256`. The
[source validator](../../scripts/platform-migration-manifest.ts) also supports
version 2: the complete legacy plan and digest plus an explicitly selected
qualified fresh plan. It validates the union before normalizing either plan for
the existing package runner. Keep the immutable legacy prefix; do not create a
competing canonical manifest or add package SQL paths to the legacy plan. The
current source checkpoint carries v3: its legacy selection still has the exact
88 issued units and inventory
`cfe3a8b4fa6216f61b1cdd5f004cb0f7a967bc01d9e18ddacb2efee74742d3b3`.
The current source manifest uses version 3 with a separately selected
`qualified-admin` restricted-bootstrap plan and two fixed role-mode inventories.
Its legacy and `qualified-v2` selections retain their issued paths and hashes.
New shared forwards append as an identical ordered path/hash suffix after each
selection's issued tails; every issued prefix remains immutable.

A qualified plan has a new actual position-zero baseline, the two fixed
actor/acquisition bootstrap replacements and the fixed runtime tail after the
complete legacy ownership closure. Other legacy units retain their paths,
hashes and relative order. Its inventory distinguishes actual migration/bootstrap
aliasing and restore-binding presence. The optional retained-import tail requires
a restore binding. No observed target digest supplies an expected inventory.

The reference [PostgreSQL binding](../../server/adapters/postgres/migrationRunner.ts)
selects legacy by default. Its explicit `installation` option selects
`generation: "qualified-v2"`, one `roleMode` (`installer-managed` or
`operator-provisioned`), and actual migration, bootstrap, runtime and optional
restore login names. The binding passes identifier-only startup options through
its production pool and delegates execution to `@openlup/platform/migrations`;
it does not create a second executor. The first qualified profile requires
PostgreSQL 16 and an actual database-owner SUPERUSER migration login. Runtime
and restore are distinct, restricted, non-owner logins. Installer-managed mode
creates the fixed group roles; operator-provisioned mode requires the exact
existing flags and membership graph. Credentials and provisioning remain
host-owned; this source profile does not qualify a restricted managed host.

The explicit `qualified-admin` selection uses a different 91-unit fresh plan:
the approved `qa_` baseline, four corrected `qb_` replacements, shared legacy
forwards and the issued runtime-completion tail. It requires PostgreSQL 16,
`current_user = session_user = M`, database ownership by M, and exact prefix
and protected membership admission before principal normalization. M is a
trusted non-superuser administrator retaining ADMIN membership in six groups;
this is not isolation from M. Installer-managed M has CREATEROLE and creates
the fixed groups. Operator-provisioned M has NOCREATEROLE and receives their
ADMIN edges from the declared operator. Runtime and restore remain restricted
nonowners. The mode-specific expected inventories are fixed in the manifest,
not learned from the installation being checked. The
[local production-path witness](../../tests/postgres/m14QualifiedAdminComposition.test.ts)
applies, resumes and replays both modes with actual migration/runtime/restore
logins. Connected restore selects this generation's mode-specific manifest.
A host-declared trusted provider control plane may use a non-superuser bootstrap
login with CREATEROLE and CREATEDB and named outside elevated roles. Admission
checks that those roles do not enter the application role graph and keeps the
application ownership, runtime/restore limits and selected catalogue checks.
Only an explicit `target: "rds"`, `layout: "serial-cluster"` selection permits
provider-defined authority without an elevated PostgreSQL role flag, and only
through declared `rds_superuser` membership. Every other declared name still
requires an elevated flag, including the other seven stock RDS roles. The fixed
eight-role stock inventory is shared with the recipe freshness check.
In that RDS mode, memberships into fixed PostgreSQL predefined roles are outside
the application graph and its normalized inventory only when both member and
grantor are declared stock RDS roles. Other selections retain the elevated-role
requirement and exact predefined-role comparison. Edges into application roles
remain subject to exact comparison; this exception cannot grant a migration,
runtime or restore login provider membership. Local PG16 role emulation leaves
actual hosted privilege behavior and provider inventory for hosted receipts.

The [session admission and qualified projector](../../server/adapters/postgres/qualifiedInstall.ts)
check the actual login, owner, held lock, protected role graph, default ACLs,
runtime/restore DDL and replication capabilities before normalizing declared
principal fields. The qualified payload has its own format and leaves the issued
legacy payload unchanged. The E2 predecessor's E-only selection contains 89 ledger units and four
fixed inventories: migration/bootstrap aliased or separate, each with or without
restore. The four source references are historical derivation evidence, not
production apply/status/replay qualification. Built and installed composition,
the second role mode with changed actual names, healthy inventory mutation and
separate unsafe-session refusal remain required before claiming readiness.

The session facts and selected-catalog observation bind built-in relations,
functions, cast types, operators and collation to `pg_catalog`. This also covers
exact application overloads that can otherwise win function resolution even
when the catalog is implicitly first. Before deparsing the selected catalogue,
qualified admission requires effective schema visibility exactly
`pg_catalog, public`; it refuses a different path without changing it. This
retains the visibility under which the frozen inventories were derived. It
does not sandbox PostgreSQL's own deparser or native type-output routines.
The shared projector retains its legacy payload format and query identities;
canonical legacy bytes and existing E-only pins still require execution proof.

At the 27 October E2 89-unit proof-source checkpoint, the eight-case witness
specified four fixed-pin references and four fresh targets through the real
binding and built package executor. One healthy target supplied the inventory,
unsafe-session and shadow-symbol discriminators before recovering to the same
ledger; that source was still awaiting the receiving-machine run at this
checkpoint. The linked test later evolved to the four-profile 91-unit
runtime-completion witness; its dated result appears in the
[M14 runtime-completion record](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-operations-portability.md#runtime-completion-28-october-2026).

The experimental trusted-source `PlatformMigrationSource.assertSession` callback
runs once under the existing session advisory lock after exact-prefix validation
and before status, dry-run or pending SQL. It can refuse changed host/login facts;
it shares the source's existing database capability, not a sandbox or per-unit
provisioning boundary. For every source, the shared runner binds its advisory
lock and ledger checks to `pg_catalog` and admits the ledger's catalog shape
before reading its contents; release uses the same bound lock identity. Sources
omitting the hook skip only its session checks and retain their migration
execution semantics. The later qualified source owns its finite read-only
checks. For a fresh qualified installation with no ledger, the runner ends its
initial read-only observation, begins a read-only `REPEATABLE READ` transaction,
and rechecks ledger absence using only the catalog before the hook runs. The
hook's session facts and selected-catalog observation then share that snapshot;
a newly present ledger at the recheck is refused. An installed ledger remains
protected by its admitted relation lock through the qualified observation.
For a pending unit with an installed ledger, the runner takes the write lock
before its first catalog read in that unit transaction, then rechecks the
prefix before and after the unit SQL. The SQL retains the connection's configured
transaction isolation.

Several modules in one distribution need a deterministic migration catalogue
before they can be installed together. Declare their dependency order and
preserve each migration's identity, bytes and owner; do not infer ordering from
directory traversal or replace independent schema requirements with one nominal
package version. A tarball manifest is a projection of canonical source rows
and their digests, not a second authoring source. Copying existing SQL into a
tarball does not make it a new migration to replay. Never split, rename or edit
an issued or applied SQL unit, including one that spans several modules.

The planned foundation/identity path must prove both a fresh installation of
the complete selected catalogue and an upgrade from the exact foundation chain
to identity. The runner must match the applied ledger to the exact selected
prefix by path, hash and position before appending; missing, reordered,
duplicated or changed applied identities refuse. Preserve durable state and
prove replay and refusal through the existing package-owned required proof.
This is a future package-runner acceptance requirement, not evidence that a
multi-module runner or catalogue already exists on this branch.

An adopter with an existing store retains its own reviewed migration chain and
applied ledger. It compares required schema and migration identities with that
store and applies only compatible reviewed forwards. It does not apply a fresh
package baseline over an existing database, relabel old SQL as new, rewrite an
applied prefix or discard pending work. Fresh-install proof does not establish
that upgrade path. See [package architecture](ARCHITECTURE_AND_EXTENSIONS.md#versions-and-schema)
for the shared set and shipment boundary.

## Database test fixtures and witnesses

Disposable Docker fixtures carry `dev.disposable=1`, their owner PID and start
in host-clock epoch seconds, short hostname, Linux PID namespace and OpenLup run
ID. Only a same-host, same-namespace owner proved dead (or a recycled PID whose
start differs by more than two seconds) is reclaimable after a 60-second floor.
Uncertain ownership and unlabeled resources are retained. The root test lifecycle
runs one host sweep: `OPENLUP_DISPOSABLE_REAP=remove` by default, `report` or `off`;
CI disables the host sweep. Teardown and interrupted wrappers remove only their
own fresh run ID through the same liveness rule without the age floor, including
on CI.
The opt-in Supabase CLI and compose runners stop their own stacks once on
interruption; after SIGKILL those stacks still need reviewed manual cleanup.
The raw pgTAP runner starts one disposable-labelled stock PostgreSQL container
and removes it on every exit path it controls. An interrupted run leaves that
labelled container for the dead-owner sweep.

A selected test may supply neutral settlement, format, provider, location and
stock rows in its own transaction. Concurrency connections need the same declared
inputs. Those rows model configured examples; they must not replace policy or
control data the offered runtime requires the platform chain to install.

Execute a domain operation as its documented runtime role. A result or no-write
witness may use the database owner when direct table reads are deliberately
closed, but that observer must not become the executor of an invoker RPC.
Test-only grants, broader table access and owner execution cannot establish that
a service call works. Assert negative browser permissions and runtime behavior
separately from historical grant spellings or inherited CLI defaults.

## Exact reviewed function forwards

### Co-located SQL and approval pins

The fixed `qualifiedInstallations` class requires prior exact whole-file approval
for four bootstrap units, an optional retained-import unit, the runtime
completion tail and the owner-path forward. Even expand-only
qualified SQL uses this separate control-before-feature route: new SQL with new
pins, simultaneous machinery changes, later repins, unknown paths and edits to
issued files refuse. Trusted queue admission applies this guard to qualified SQL
changes even when their prior approval pins are unchanged. The
[inert fixtures](../../scripts/fixtures/reviewed-m14-qualified/db/platform/migrations/README.md)
retain seven exact bound units, including the
[runtime completion](../../db/platform/migrations/q2_20261028100000_runtime_capability_completion.sql)
selected before the owner-path forward. Reader preparation landed before the
sixth approval row, and that approval landed before this SQL introduction.
The [restricted-bootstrap task](plans/oss-m14-restricted-bootstrap.md) has
five fixed approvals at positions 8–12. Those `qa_` fixtures remain inert
except for the selected baseline. A PostgreSQL parse failure in the approved
actor unit led to four corrected `qb_` identities at positions 13–16, after a
separate reader and approval checkpoint. The active 91-unit restricted
generation selects the `qa_` baseline and four
`qb_` replacements, reuses the issued completion tail, and excludes the
qualified owner-path forward. It has two fixed role-mode inventories.
Its migration login is a trusted administrator retaining ADMIN membership,
not an isolated principal.
All six earlier approval rows and their byte identities remain unchanged. The runtime-completion tail grants
the existing runtime group context INSERT on its four columns, UPDATE on its
three non-key columns and DELETE, plus review-command receipt SELECT/INSERT.
Its local guard requires an unswitched installer owning both targets, the
existing restricted runtime/group binding and a declared role mode. The complete
role graph still belongs to the trusted source's preflight; the common tail
adds no SUPERUSER requirement or alternate installer. A future non-superuser
profile has its own local PG16 qualification; hosted qualification remains open.

The reader reserves the qualified owner-path forward after runtime completion,
at approval position seven before the five reserved restricted-bootstrap
positions. Its prior approval binds the exact file and nine function preimages
and definitions. The active forward pins name resolution on those definitions;
the selected plan has 92 units. Earlier qualified units and their approvals
remain immutable.

Delivery uses three separately landed checkpoints. First prepare the exact
sixth identity's reader/order support, inert fixture and refusals without
changing the five approval rows. Trusted main parses a changed registry before
the no-active-SQL return, so co-locating an expanded reader and sixth registry
row is incompatible with that existing reader. Calling the change control-only
does not bypass this parser constraint. After reader preparation is
actual main, append the exact sixth hash in a pin-only change. Only after that
approval is actual main may a feature introduce the identical active SQL and
append its selected manifest row. Keep all trusted co-location checks intact.

The active schema-2 manifest preserves legacy 88 units and the issued qualified
91-unit prefix, then appends the exact owner-path forward as unit 92. Its two
restore-bound inventories were measured independently on clean PostgreSQL16
references with migration/bootstrap aliased and distinct. The historical F90
expectations and raw evidence remain retained; reference measurements do not
establish production status/apply/replay or normal-runtime qualification. The
existing four-case production-composition witness checks both shapes in the two
existing role modes. It also exercises the actual normal-runtime preparation lane
and review receipt commands, with receipt mutation, context key and neighboring
privilege refusals. Historical E-only 89-unit expectations retain their attribution.
There is no optional `withRestoreForward` field or new selection mode.
Prior source approval establishes no installation, managed-host, publication or
activation evidence.

A PR introducing SQL in a class already admitted by its trusted comparison-base
policy may also carry that SQL's pins. Only bindings for files introduced by
that PR may change. Other entries and their list positions, shared fields,
registry schema and immutable baselines stay unchanged. The fixed path/signature
inventory, whole-file and function hashes, preimages, statement/grant limits,
ordered prefixes and fixture/package equality still apply. A hash binds bytes;
independent native review approves the complete candidate under the
[existing review procedure](../../CONTRIBUTING.md#native-review-and-accountability).
SQL risk assessment belongs in that required review, without a mandatory third
review or a new report format. Applicable maintainer/delegate reads remain required.

Changes to a class, validator, its dependencies, review/admission or release
machinery need a separate control change before using the new rule. The existing
native admission, invoked from trusted main, validates co-located data with its
own checker and refuses simultaneous machinery changes or machinery drift since
the reviewed base. Production tooling in `scripts/agent-review-*`, `scripts/oss-*`,
`scripts/source-*` and `scripts/packages/` stays unchanged for this route, including
release entry points and preparation; test-only coverage changes remain allowed.
The checker and its direct dependency closure, root manifests/lockfile and
`.github/` files also stay unchanged. Admission reads candidate Git objects
without running candidate code.
The [documented workflow invocation limitation](DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering)
remains: candidate YAML can omit the job, so sensitive review and the applicable
maintainer/delegate read of workflow edits remain the control for that case.

Release binds each forward to its unique first-parent mainline introduction.
Its pin must be valid at that introduction and unchanged afterwards; a later
repin cannot legalize an earlier invalid installation. Existing separate
control → feature histories remain valid. Pin-only preparation of future SQL
retains its existing control decision; it is not an unrelated companion of a
feature. Once introduced, migration bytes remain immutable and repairs use a
new forward. Stopping new co-located PRs must retain release support for histories
already admitted this way; reverting to parent-only approval would reject them.

The separate `batchedForwards` list approves the frozen M10/F17 packet: seven
native files and eleven managed files (18 pins). It adds no installation-chain SQL. Exact
future bytes live only in [inert fixtures](../../scripts/fixtures/reviewed-m10/).
The [registry](../../config/reviewed-platform-forwards.json) records each full
path, SHA-256, ordered statement hash and exact function identity with raw
before/after CREATE hashes. Non-function statements additionally carry their
exact SQL, including every grant target, recipient, absorption row and seed.
The checker fixes the ordered path/signature inventory separately from that data.
Current candidates require all 18 pins. Release-history comparison also reads
the exact prior 16-pin set and
the exact earlier 14-pin set (five native, then nine managed), preserving each
unchanged approval's content and fixed shape position while pending pins move and native X/Y are added.
Reordered, extra or unknown historical inventories refuse, and an approval added
in the same commit as its SQL still cannot authorize that SQL.

This batch covers four native creations (retry, commands, stock wait and the
M06 ATP/new-purchase seam), three native body replacements (allocator, late-positive stock accounting
and retry candidate payment filtering), managed seam,
stock-wait and refund-evidence creations, and the six managed replacement files.
The managed creation includes its one table, index, RLS enablement, service-only
grants and blocking `client_absorption_policy` row. The only new existing-table
column grant is `SELECT (id, retry_attempt)` on `subscription_cycles` to
`service_role`. The lifecycle-message forward replaces exactly
`private.outbox_resend_event_types()` and its two public companions, and seeds
only the enabled `subscription-stock-wait-started` / `subscription-stock-wait-resumed`
notification controls with `ON CONFLICT(slug) DO NOTHING`.

Timestamp aliases share identity within this class (`timestamptz` and
`timestamp with time zone`); raw definition hashes retain the original spelling.
The due reader chains M2 → M4 and the payment applicator M1 → F17: each later
before hash must equal the earlier after hash, and the native retry recovery and candidate readers chain N1 → X/Y. Command preview replay is folded into the uninstalled N2 fixture. Admission reads the actual
preceding rail in filename order. Per rail, pins land as a prefix in version
order: native N1 (`20261022160000`) → N2 (`20261024170000`) → N3
(`20261024180000`) → seam (`20261024183000`) → allocator (`20261024184000`)
→ X (`20261024184500`) → Y (`20261024184600`); managed M1
(`20261024155000`) → M2 (`20261024160000`) → seam (`20261024175000`) → M3
(`20261024180000`) → M4 (`20261024181000`) → M5 (`20261024182000`) → M6
(`20261024184000`) → F17 helper (`20261024185000`) → F17 parity (`20261024185100`)
→ attempt replay (`20261025090000`) → attributed advancement (`20261025090100`).
The pending pins follow the landed native `20261022195000` and managed
`20261022195100` tails. N1 and the interleaved M08/M09 units keep their bytes,
versions and ledger positions. X requires the allocator prefix.
Every earlier same-rail pin must already exist at the candidate head with its
whole-file pinned digest; a later landing cannot skip an absent pin.
Missing, duplicate or extra signatures, preimage drift, reordered chains, unpinned private objects, extra/wider grants,
changed bytes/paths and unexpected statements refuse. The native body replacements retain their headers and ACLs, including the
allocator's pre-existing PUBLIC EXECUTE default; this approval does not harden
that default. X restores a waiting obligation's released reservation to a
committed ATP-counted hold after verified late payment, with replay leaving all
tables and ATP unchanged. Y excludes paid cycles and settled intents before
LIMIT, preserving due-time/UUID order so stale waiting rows cannot starve due
unpaid work. N3 excludes waiting/stock_secured cases before LIMIT, retaining the base reader's eligibility, return shape and due-time/UUID ordering so stock waits cannot starve normal renewals. In folded N2, a raw replay of the command preview returns the stored receipt.
It preserves the apply definition, fresh preview output and all public-table
counts, columns and xmin across replay. The gate compares all 43 fresh scenarios
against the pre-fold preview body and folded N2. These pins do not install behavior or add managed parity.

The pending N2 change path quotes and applies supplied `coreLines` for plan
changes (omission retains native cadence-only expansion), normalizes a new
add-on's missing/nonpositive quantity to one, preserves cadence for add-on
commands, and compares add-on UUIDs by value. Its apply definition remains
unchanged: accepted hashes bind the complete request and the stored priced
lines become both subscription lines and future renewal terms. Portion/mode
and composition metadata have no native storage; preview no-op parity does
not replace native direct-apply lifecycle guards or receipt contracts.
N3 keeps paused current waits open, filters eligible recovery before LIMIT,
refuses inactive/superseded frozen reads, reports free availability separately
from its own reservation, and returns null without writes for closed or still
unpaid realization notifications. Paid realization still requires the existing
settlement, inventory, shipment and hold proof; it records no parcel arrival.

The donor audit references `supabase/migrations/` files
`20260711151000_subscription_generic_bundle_actions.sql`,
`20260711170020_subscription_package_changed_noop_truth.sql` and
`20260713110000_subscription_slide_next_cycle_noop_truth.sql` for N2;
`20261003123000_subscription_stock_wait.sql` and
`20261003142320_subscription_stock_wait_unpaid_discovery.sql` for N3/M3;
`20260928170000_new_purchase_stock_availability.sql` and
`20260710131002_no_cron_inventory_reservation_leases.sql` for the stock seams
and allocators; `20261009110000_subscription_dunning_active_repair.sql` for
X/Y and M4; `20260802120000_subscription_winback_positive_customer_marker.sql`
and the stock-wait donor for M5; and
`20261009111000_stripe_refund_cumulative_snapshot.sql` plus
`20261021130000_refunds_preserve_subscription_lifecycle.sql` for F17.
The later donor `20261013173001_channel_exposure_inventory_admission.sql`
adds channel exposure and shared admission machinery outside these frozen
stock-seam claims. The zero-valued exposure hooks do not establish that parity.

The lexer is only a pre-filter. The mandatory
[real PostgreSQL/pgTAP catalog gate](../../tests/postgres/reviewedBatchForwards.test.ts)
uses native PostgreSQL 16 and, for the managed rail, stock PostgreSQL 17 with
pgTAP and the managed-compatibility adapter. Per rail it applies
all committed rail files in filename order through the last pin, including
unpinned files interleaved between pins. Pins use landed or fixture bytes exactly
once; landed pins must form a prefix before the absent fixture suffix. A landed
rail file must be byte-equal to its inert fixture; an absent file uses the fixture. Each forward runs once, before and after feature landing.
It compares `pg_proc` metadata and bodies, `pg_class` and `pg_attribute` relation
and column ACLs and RLS; snapshots also compare `pg_namespace`, `pg_type`,
`pg_trigger`, `pg_policy`, `pg_default_acl`, `pg_roles`, `pg_auth_members`,
`pg_constraint`, `pg_index`, `pg_rewrite`, `pg_foreign_server`, `pg_event_trigger`,
`pg_extension` and `pg_description`, plus all public/private ordinary-table rows.
Only the pinned creations, replacements, column grant, absorption row,
notification rows and refund-function comment may change. Rollback must restore
the complete prefix. Committed plants falsify both admission and the catalog
observer, including authenticated EXECUTE on a pinned new function, an altered
native allocator ACL, and a repinned managed index on an existing table. Missing
Docker, PostgreSQL or pgTAP fails the required `test` aggregate; a lexical PASS
cannot replace this gate. The managed setup budget includes its first image pull.
These batch rules do not broaden the earlier #267, #295 or #300 classes.
Coordinator control review and two fresh reviews remain separate delivery gates.

### M10-9 attempt replay control fixtures

The inert managed fixtures
[attempt replay](../../scripts/fixtures/reviewed-m10/supabase/migrations/20261025090000_subscription_dunning_attempt_replay.sql)
and [attributed advancement](../../scripts/fixtures/reviewed-m10/supabase/migrations/20261025090100_subscription_dunning_attributed_advance.sql)
follow the exact managed tail `20261024185100`. Their donor provenance is
`20261024195559_subscription_dunning_attempt_replay.sql` and
`20261024221547_subscription_dunning_attributed_advance.sql` from the donor
adopter at `3f525051e`. The registry binds all eleven before/after edges:
nine definitions in the first fixture and two replacements in the second.
The final nine raw CREATE hashes equal the donor's current statements, including
comments within CREATE. Recovery redeem, retry scheduling, provider prepare and
the M4 due reader are untouched; native attempt-replay parity remains REGISTERED.
The managed rail now installs both files byte-identically to these inert fixtures
and registry pins. The package renewal helper carries the applied transition's
attempt through preflight, decline, action-required and replayed action-required
handoffs. `applyFailedResult.paymentAttemptId` is optional/nullable; the opener's
`failedPaymentAttemptId` is required/nullable. Absence becomes explicit NULL and
fresh eligible SQL refuses 55000. Applying a replay does not skip dunning: an
interrupted propagation still needs its canonical observation.

The managed cycle/runtime adapters send the exact field and explicit failure
class. Webhook attribution reads business-result transitions for the ingested
event and intent, refusing absent, conflicting or unreadable evidence before the
RPC. Simulator settlement preserves both canonical transition time and attempt;
none substitutes a current/prepared attempt or an event hint.

The first fixture adds nullable `failed_payment_attempt_id uuid` and
`failure_observation_result jsonb` to `subscription_dunning_cases` and the
NOT VALID FK to `commerce_payment_attempts(id)`. Two exact backfills attribute
open cases and completed historical receipts only from unique applied events;
a cached case result additionally needs its matching live token-linked receipt.
Missing/conflicting attribution remains NULL. The checker fixes those four
statement digests on this path and the six exact ACL statements: new public
entrypoints are service-only and new inner helpers also revoke service access.
No general UPDATE or DDL class is added. The second fixture replaces only the
attributed inner failure and reconciliation bodies, retaining their ACLs.

Legacy arities delegate with NULL attribution. Fresh eligible observations
refuse 55000 without writes; an exact completed legacy receipt can replay.
Attributed same/stale observations return the canonical response without case,
token, notice, schedule or class changes; absent cache refuses
`subscription_dunning_replay_unavailable`. A newer attributed rung may advance
without a previous cache, revokes older used and unused authorizations and
stores one new canonical response. Reconciliation catches only its five named
attribution/cache refusals, preserving applied payment truth and sticky evidence.

An adopter already carrying the donor history maps the schema, FK and backfill
explicitly to its existing immutable donor migrations and proves its own current
preimages. It never re-runs this backfill or forges an upstream migration identity:
raw replay has duplicate-column preimages and can overwrite newer observations.
A separately authorized host forward may restate the required functions and
restore its exact private due reader last in one transaction. This managed port supplies no host application, release or private-stock conversion.

**Native attempt-replay parity — REGISTERED, owner M10.** The native runner uses
`RenewalFailureHandoffPort`/`RenewalStorePort`, separately from this hosted
`CycleChargeFailurePropagationPort`. The native stores receive neither
`failedPaymentAttemptId` nor `paymentAttemptId`: the
[native retry handoff](../../packages/platform/src/subscriptions/postgresRetryStore.ts)
accepts the separate `RenewalFailureHandoffPort` input, not `openDunningCase` input.
Native stores do not yet implement duplicate failure-observation replay with
attempt attribution; parity remains a registered follow-up.
Closing this registration requires native same/stale canonical replay,
cache-missing refusal before writes, newer attributed advancement revoking used
and unused authority, equal-rung/missing-attribution refusal, reconciliation and
concurrency evidence. Existing native atomic receipts prove only their own graph. Rollback uses a compensating forward preserving attribution and
revocations; it never resurrects old recovery authority.

The `managedCommerceForwards` registry binds the managed commerce SQL to the
matching files under `scripts/fixtures/reviewed-m11/` and `supabase/migrations/`.
The registry and real migration rails are authoritative. Each pin requires all
earlier same-rail pins with exact bytes. Tests select each real file once,
compare it with its fixture and replay its complete real prefix. Hole, byte-drift,
header, ACL and catalog refusals preserve that boundary.
The new-purchase stock reader
(`public.inventory_new_purchase_stock_read(jsonb,timestamptz)`) runs with owner
privileges through `SECURITY DEFINER` and pinned
`search_path = pg_catalog, pg_temp`; only `service_role` may execute it.
Its ACL revokes `PUBLIC`, `anon`, `authenticated` and `openlup_mcp_reader`.
Behaviour proofs call as `service_role`, with owner access reserved for setup
and state inspection. They also prove function permission refusals for the
denied roles. ATP renewal exemption is fixed false, requests are bounded to
200 array items and a NULL as-of timestamp refuses as
`inventory_stock_as_of_invalid` (SQLSTATE `22023`). Its conservative stale flag
covers any stale provider row for the SKU; the allocator retains its stale refusal.
The stock reader's `SECURITY DEFINER` search path lists `pg_temp` last explicitly;
its application relations and routines are schema-qualified.
The other contributed definers retain their reviewed headers and search paths under the platform-wide definer posture; the stock reader's `pg_temp`-last header is stricter.
The starter creation and graduation replacements retain independent preimages,
header digests and ordered ACL pairs.
Approval-history comparisons retain the exact seven- and eight-entry prefixes
and the invoker stock-reader identity in the eight- and nine-entry inventories
for release carry-over. Candidate admission requires the complete inventory and
the owner-privilege stock-reader header; a historical invoker approval cannot
admit that reader.

The pinned function headers preserve arguments/defaults, returns, language,
security and search paths, with ordered same-file ACLs. Public entry points grant
execution only to `service_role`; private acquisition helpers grant no service
execution. Exact file, CREATE and preimage hashes bind each replacement.
The checkout receipt forward replaces only the audit action
CHECK under its pinned lock timeout, preserving its preimage actions and adding
`checkout_payment_link_mint` through the exact NOT VALID constraint replacement.
Any intervening audit-table ALTER/DROP refuses this fixed CHECK preimage class.
M09/M10 inventories remain closed.

The [managed commerce proof](../../tests/postgres/commerceManagedRail.test.ts)
checks return identity, normalized replay, concurrent duplicate requests and
complete public-row snapshots on refusal. The stock pgTAP witness requires the
stock seam, ATP subtraction, missing stock, stale reporting and input refusals
to execute as `service_role`. The starter pgTAP witness consumes the actual
provisional result through graduation, with initial cycle, line and replay checks.
The TypeScript witnesses use the managed and PostgreSQL returns adapters and the
managed finalize port, including typed acquisition conflicts, unchanged refusal
rows and 21-day provisional creation. The managed stock port exercises ATP and
propagates SQL refusals in
[`newPurchaseStockManaged.test.ts`](../../tests/postgres/newPurchaseStockManaged.test.ts).
The [catalog gate](../../tests/postgres/reviewedBatchForwards.test.ts) executes
acquisition finalize under both policy states: exact retained terms admit;
missing, stale or engine-mismatched terms refuse atomically; completed replay
preserves rows after policy changes. It retains one-time checkout and the
shared/exclusive lock protocol. Database proof grants no installation authority,
handler integration or native return parity.

Migration: configurator guests may supply an order destination without rewriting
saved preferences; preference updates require a server-proved matching account.

Migration: legacy omitted or empty country uses `platform_region_code()` for
address identity and insertion; configure the adopter's settlement region or the
fallback refuses with SQLSTATE `55000`. Neutral commands require explicit country.

Migration: return request creation requires the server-supplied principal to own
the order. Replay requires the same principal, order and normalized command;
foreign or changed commands refuse without a durable row change.

Migration: checkout payment-link receipts use the `checkout_payment_link_mint`
audit action; its service-only entry point records the operator receipt.

Migration: subscription checkout finalize validates retained acquisition terms
against effective policy while holding the shared transaction advisory lock.
Policy writers must hold the exclusive lock; changed terms refuse fresh checkout
while completed finalize replay retains its response. One-time checkout is exempt.

Migration: `commerce_subscription_acquisition_terms` reads effective acquisition
terms and refuses absent terms with `acquisition_terms_not_effective`; the
no-policy finalize compatibility branch remains available.

Migration: `inventory_new_purchase_stock_read(jsonb,timestamptz)` reads ATP with
renewal exemption fixed false, subtracting active holds, safety stock, protected
renewal demand and channel exposure. It bounds the requested array before
deduplication, refuses a NULL as-of, and reports stale provider observations.

Migration: the managed starter routines admit graduation cadences of 14, 21 or
28 days; provisional creation uses `starterIntervalDays` and the subscription
column's timezone default. Native has no twin. Rolling back below this forward
with a 21-day marker is unsupported; roll forward.

PARITY GAP — the adopter-owned opt-in `full_unedited` graduation mode, which
graduates only unedited starter terms, is not contributed. It belongs to the
subscription domain (M10 area) and is unreachable from M11 code; the adopter
keeps its own managed SQL.

**Named bounded debt C94 — M10 reviewed packet vocabulary.** The frozen managed
SQL retains provider nouns inherited from that rail. The neutrality baseline
records the scanner's exact counts for the six existing managed fixtures and the
registry's pinned refund COMMENT: dunning continuity (`ui-13`: 2, `ui-14`: 3),
ATP (`ui-15`: 3), stock wait (`ui-15`: 6), allocator (`ui-15`: 2), refund evidence
and refund parity (each `ui-13`: 7), and the registry (`ui-13`: 1).
Each landing PR (P3b, P5, F17) adds only its own rail keys together with the files,
using these exact pinned counts per category. Any present baseline key for an
allowance path must contain exactly its pinned category counts, including during
regeneration; adding a key without the file refuses. No native,
TypeScript, package or documentation allowance is added. This is vocabulary
debt for the frozen packet, not provider activation or portable-contract parity;
future neutral replacements must lower it. The [neutrality owner](../../CONTRIBUTING.md#package-policy-and-release-checks)
owns the ratchet. Its `reviewedPinnedIntroductions` allowance is a closed list of
exactly 13 paths (six fixture/rail pairs and the registry), grouping the two
dunning categories per path. Each SQL pin requires the complete file's SHA-256
and exact category and before/after counts, on any base. The registry instead
pins the exact refund COMMENT text because later approvals edit unrelated
registry data; extra counted vocabulary still refuses. The allowance filters
measured-base increases and parent-baseline raises, including regeneration;
candidate counts must still fit the baseline. Changed bytes, another path even
with the same digest, another category or count, and unrelated increases refuse.
No native rail, TypeScript, package or documentation path can enter this list.
Adding any further entry is a control change needing two independent fresh full reviews under the native review contract plus
the coordinator's control read. The six rail-path entries can be retired after
the F17 PR lands and the base carries the counts.

The managed runtime capability forward is shipped after its separate control
approval. It changes no baseline bytes or function signature. Required service
and authenticated column/helper permissions are explicit in that ordered file;
no portable twin or live upgrade compatibility is claimed. A corrected forward
also retires exactly eight legacy id-only browser policies that membership
reads would otherwise activate. Customer-own policies and own membership reads
remain unchanged; actual authenticated role tests cover cross-customer refusals.
Policy retirement is pinned to exact statements and preceding policy hashes; it
is not general permission to alter RLS.
The checker binds the fixed policy names, tables, preceding statement hashes
and ordered DROP statements separately from the function and privilege pins.
Other policy operations refuse. The original capability forward used prior
control approval; eligible later introductions may use the co-located route
above. Approval alone grants no runtime permission or actual-role proof.

Reviewed replacement is a separate admission class, not expand-only. The fixed
[allowlist](../../config/reviewed-platform-forwards.json) pins three managed
forward paths and their whole-file SHA-256 hashes in separate replacement and
creation lists. The replacement list contains only two files and permits replacement of
exactly `commerce_offer_policy_v2_readiness()`,
`subscription_create_provisional_for_checkout(uuid,uuid,uuid,uuid,jsonb)` and
`subscription_apply_starter_graduation(uuid,text,text)` in `public`. The price
setup forward also binds its two new function signatures, which must be absent
from the preceding chain. This control change installs approval data only; it
does not ship or execute those forwards.

The optional `portableReplacementForwards` list includes the exact forward to
keep active subscriptions active on dunning exhaustion (invariant repair).
Its only function is
`public.dunning_lifecycle_handle_failure(uuid,timestamptz,text,text,integer,timestamptz,text,text)`,
fixed in checker code independently of the registry. The list also binds the native
payment-terminal replacement and the stock-evidence replay replacement.
The latter admits only
`public.fulfillment_record_stock_evidence(text,text,text,text,text,text,integer,integer)`:
matching-fingerprint replay reopens evidence and refreshes severity, quantities
and last-seen time, clearing resolution time; a fingerprint mismatch still
refuses with `23505`. Prior definitions come only
from the portable baseline and earlier portable forwards in strict filename
order, as required by the manifest. Exact path, file and before/after definition
hashes must match; arguments, return, volatility, security and settings remain
unchanged. Only comments and that single `CREATE OR REPLACE FUNCTION` are
admitted under the co-located SQL/pin rule above; no privileges or other statements
are allowed. The original class-control approval added no SQL file or runtime behavior.

The separate `portableCreationForwards` class binds these portable paths and
whole-file SHA-256 digests in the same allowlist:

| Path | SHA-256 |
| --- | --- |
| [db/platform/migrations/20261022080000_fulfillment_command_ledger.sql](../../scripts/fixtures/20261022080000_fulfillment_command_ledger.sql) | `c6806906cdb0b6931b29f7a5c7c800016e98d04e6ea956f3c1e219a6cdb7e9d1` |
| [db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql](../../scripts/fixtures/20261022090000_fulfillment_delivery_alignment.sql) | `d9966ae79fe77a0feae8317dc5b46ef2d8196dd0790b1cd0ee1b06ab58061499` |

The three additional M09 creation pins are listed in the
[M09 control preparation section](#m09-invoicing-forward-design-and-control-approval) and the registry.

It admits new public tables, indexes on tables created in the file, invoker
functions, views, and row triggers. Relation, function and trigger names must
be absent from the portable baseline and preceding portable forwards; duplicate
creations also refuse. Function row arguments and returns may use tables created
in that file. Function bodies and expressions are bound by the whole-file hash;
the statement classifier does not establish their behavioral correctness.
Functions use SQL or `plpgsql` with `search_path = pg_catalog`, default or explicit
invoker security and the admitted volatility attributes. Trigger functions must
be created in the same file, accept no arguments and return `trigger`.
Table and index statements must also pass the expand-only predicate. For these
pinned new tables it accepts scalar comparison/regex operators, casts, and
foreign-key `ON DELETE CASCADE` or `ON DELETE SET NULL` actions; inheritance and
its other refused keywords remain excluded. Outside dollar-quoted bodies,
backslashes, `E'...'` and `U&` escape strings/identifiers refuse. Standard strings
and quoted identifiers use doubled quotes; multiline quoted sections and quoted
identifiers containing `;` or `$` refuse. Nested block comments and named dollar
tags also refuse: these forms are not needed by the pinned files. Any other `$`
outside strings or comments refuses; a dollar body opens only as `AS` followed
by whitespace and `$$`. Non-ASCII outside strings, comments and dollar bodies
also refuses, including in quoted identifiers. Line comments
end at the next line feed regardless of quotes inside the comment. A function
body uses `$$` and ends at its first closing `$$`; only whitespace and the
terminating semicolon may follow.
New triggers may attach to existing public tables, including
`commerce_order_holds`, `fulfillment_shipments` and `subscription_cycles`;
this admits a new trigger attachment, never replacement of an existing trigger.
The [disposable catalog proof](../../tests/postgres/reviewedPortableCreation.test.ts)
applies each pinned target exactly once after its portable prefix, using
landed bytes when present (they must equal the fixture and registry SHA-256, else
the proof fails naming the path); the fixture when absent. It checks invoker security,
new-object ACL entries, unchanged earlier relation/function definitions and the
exact explicit trigger attachments with functions created by that file.

Seed `INSERT` is admitted only into a table created in the same pinned file,
using the existing expand-only predicate: literal-only `VALUES` with
`ON CONFLICT ... DO NOTHING`, without subqueries, functions or procedural `DO`.
Inserts into pre-existing tables, `INSERT ... SELECT` and
`ON CONFLICT ... DO UPDATE` refuse.
Only `REVOKE ALL ... FROM PUBLIC, anon, authenticated` (or subsets of those
recipients), comments on objects created in the file, and `BEGIN`/`COMMIT` are
otherwise admitted. Revocation targets must also be created in that file.
Unpinned paths, changed bytes, `CREATE OR REPLACE`, `ALTER`, `DROP`,
`SECURITY DEFINER`, grants to any role (including `PUBLIC`, `anon` and
`authenticated`), references to pre-existing objects in comments or revocations,
and all other statement forms refuse. The co-located approval rule above also
applies to this existing class; it does not broaden the managed or portable
replacement classes or install runtime permissions.
The exact future file bytes are also kept as
[command-ledger](../../scripts/fixtures/20261022080000_fulfillment_command_ledger.sql)
and [delivery-alignment](../../scripts/fixtures/20261022090000_fulfillment_delivery_alignment.sql)
test snapshots; snapshots are not installation-chain entries.

[The shared checker](../../scripts/reviewed-platform-forward.ts) verifies the
immutable managed baseline hash, each old definition and each new definition.
A definition hash covers the raw `CREATE` statement through its terminating
semicolon; names and defaults remain in those bytes, while signature identity
uses argument types. Whole-file hashes additionally bind comments, grants and
all other SQL. Earlier forwards are considered when checking the old definition.
Missing or duplicate signatures, another path, and any changed byte refuse.
Both gates refuse control characters other than tab and line feed in reviewed SQL forwards (parser parity).
For managed forwards outside the pinned function bodies, only function definitions, transaction
boundaries, privileges and comments on functions defined in that same file are
accepted. Grants may target only `authenticated` or `service_role`; grants to
`PUBLIC` or `anon`, other schemas, unrelated statements and unterminated dollar
bodies refuse even if the whole-file hash was separately repinned.

The optional runtime list pins one or two additional forwards. Its first entry
pins exactly five existing functions: the `admin_clients_search_v3` and `subscription_list_due_for_renewal`
readers, and the `customer_support_absorb_lead_v1`,
`marketing_rehome_client_lead_v1` and `customer_support_correct_subject_email_v1`
invokers. Its ordered privilege statements grant only `service_role` the fixed
column-level SELECT capabilities, UPDATE on the five existing client mutation
columns and `client_id` on the three carry tables, UPDATE on only
`subscriptions.updated_at` to retain both renewal row-lock clauses, and EXECUTE on
`record_admin_audit_event`, `subscription_current_template_snapshot`, and the two
existing pure `commerce_oms_normalize_search_text` /
`commerce_oms_normalize_search_digits` helpers needed by client expression indexes.
The checker fixes the allowed tables, operations, columns and signatures
independently of the registry, including separate authenticated read/helper sets;
repinning the first runtime forward cannot admit additional capabilities,
table-wide permissions, INSERT, DELETE, TRUNCATE or an unlisted recipient.
SELECT and UPDATE are separate capabilities; duplicates within either operation
refuse. These direct service UPDATE permissions require security admission even
though they support existing invoker bodies. The subscription grant also permits
raw timestamp writes on any row; it does not confine the caller to locking.
Both renewal CTEs retain `FOR UPDATE OF s SKIP LOCKED`, with default VOLATILE
and invoker execution unchanged. The same finite forward restores authenticated profile/membership reads on
exact columns consumed by current routes and EXECUTE on the two pure OMS
normalization helpers required by existing expression indexes. Browser writes,
operator RPC execution and anonymous capabilities do not expand; existing RLS
continues to filter profile and membership rows.
Function headers must preserve the preceding definition's arguments, defaults,
return shape, volatility, execution security and settings. Attributes after the
outer dollar body refuse; only its terminating semicolon and whitespace may
follow. This control installs approval data, without shipping the runtime forward.

The optional second runtime entry admits only the identity capabilities forward,
with no functions or policy retirements. Its fixed service_role-only capabilities
are INSERT on `clients` columns `email`, `auth_user_id`, `acquisition_source` and
`lifecycle_stage`, and UPDATE on `auth_user_id`. Reconcile create/link and the
checkout soft-account link consume them; other columns keep their defaults.
Operator activation consumes INSERT on `admin_users` columns `id`, `email`,
`role`, `membership_state`, `membership_provenance` and `membership_accepted_at`;
`is_machine_actor` keeps its false default. Invitation eligibility and conflict checks consume
SELECT on `admin_users.email` alongside the first entry's membership reads.
Browser roles gain nothing; the approved identity forward now ships in the managed chain.

PR/merge-group self-check and release prepare follow the canonical
[co-located SQL/pin rule](#co-located-sql-and-approval-pins), including existing
separate control histories and refusal of later retroactive pins. Missing history
refuses; existing history, version and manifest rules still apply. The expand-only
predicate also refuses `INHERITS`, preventing a new table from inheriting an
existing one. Admission is process evidence of exact reviewed bytes, not proof
of live schema compatibility or authorization to release. Applicable control
review and affected database behavior tests remain required.

An adopter's hosted chain may already carry a managed forward under its own
migration name. Such a file is a platform companion: its leading comment block
names the forward in the line
`-- migration:platform-companion: openlup:<forward path>`, where the forward
path is the platform forward's repository path, such as
`supabase/migrations/<14-digit-version>_<name>.sql`. Where the tests and the
reference setup read the managed alignment forward, they use the platform file
when it exists, otherwise the SQL of the one companion that names it with every
marker line removed, and they refuse when none or several do.

### M12 supportAuthorityForwards

The [registry](../../config/reviewed-platform-forwards.json) has a separate
`supportAuthorityForwards` class for two fixed paths: native
`20261026120000_account_support_operator_authority.sql` and managed
`20261026120100_account_support_current_authority.sql`. The
[fixtures](../../scripts/fixtures/reviewed-m12/db/platform/migrations/README.md)
are inert approval inputs. CTL adds no canonical migration, packaged SQL or
manifest row; R4 owns those introductions under the co-located rule above.
The account-support migration export remains a sparse catalog, not an installer.

The trusted checker fixes native apply creation and native recovery/absorption
replacements in that order, with invoker headers and default/browser execution
revoked. Managed admission fixes seven ordered functions: email admission, claim,
identity guard and settlement creations, the retired combined email replacement,
account-link creation and recovery replacement. Exact headers include parameter
names/order/defaults, return/language, security mode and search path. The managed
37-statement inventory fixes three CHECK preimages/replacements, two nullable
no-default claim columns, one sequence with no non-owner privileges, the deferred
`AFTER UPDATE` constraint trigger on `auth.users`, two function comments and
service-only function execution. Email admission, claim, identity guard and
settlement preserve the donor `SECURITY DEFINER` statements with
`search_path = public, pg_catalog`. The newly DEFINER account link uses
`search_path = pg_catalog, pg_temp` and public-qualified application references.
All five explicitly revoke `openlup_mcp_reader`; only `service_role` receives
EXECUTE, except the trigger-only guard, which has no direct grant. The managed runtime
capability closure grants `service_role` column-level `clients` privileges only, so
the link body, not a wider table grant, holds the authority. The admin CHECK
retains `checkout_payment_link_mint` and adds only `operator_email_correction`;
each support kind CHECK adds only `account_link`, retaining `NOT VALID`.

Whole-file, function and ordered-statement hashes bind exact bytes; they cannot
expand that inventory. Existing M10/M11 inventories and historical readers stay
unchanged. A new support forward requires the complete same-rail prefix,
including every earlier M10/M11 pin with exact bytes. Managed M11 introductions
therefore precede the managed R4 introduction. Release admission binds each pin
at its unique first-parent introduction and refuses later repair of that pin.
Historical registries without the support class remain readable.

The [admission witness](../../scripts/reviewed-batch-forward.test.ts) exercises
trusted preparation, separate and co-located introductions, PR/merge-group
admission, release history and coherently repinned refusals. The
[PostgreSQL witness](../../tests/postgres/reviewedBatchForwards.test.ts) replays
complete prefixes, fills only an absent fixture suffix, requires canonical/fixture
and native packed-twin equality, proves the finite function/column/CHECK/sequence/
trigger/comment/ACL delta, retains the full unaffected catalog/row observer and
checks installation rollback. Its observer plants include claim, sequence,
trigger, CHECK and identity-row changes. Sequence allocation during a later
command may leave gaps; installation rollback removes a newly created sequence.
Missing Docker/PostgreSQL is a failed prerequisite, never lexical proof.

### M17 channelIngestForwards

The reviewed registry declares `channelIngestForwards: []` before SQL can land.
Its fixed class admits only `20261030121000_channel_retained_basis.sql` and
`20261030122000_channel_purchased_source.sql` on each native and managed rail.
R1 supplies all four exact file, function and ordered-statement pins with the
SQL introduction; an absent class remains readable in historical registries.
The checker fixes signatures, creation or replacement, preimages, headers and
ordered companions, including triggers and ACLs. Registry pins cannot widen
that inventory. Complete ordered prefixes retain earlier issued same-rail pins;
release checks bind the unique introduction and refuse later repinning or
removal. Changing admission machinery together with SQL remains forbidden.
This control installs no SQL and establishes no PostgreSQL semantic proof; the
SQL introduction owns that proof. The existing
[admission witness](../../scripts/reviewed-batch-forward.test.ts) uses synthetic
function bodies under fixed headers and exact companions to test lexical and
Git-history success and refusal boundaries.

## Disposable managed reference baseline

The opt-in [subscription reference](SUBSCRIPTION_REFERENCE.md) selects the
managed Supabase baseline at
`supabase/migrations/00000000000000_platform_schema_baseline.sql`. It does not
apply the separate `db/platform/migrations` portable PostgreSQL chain or claim
that the two installation paths are interchangeable. The public setup creates
one owned local Supabase project, adds `pg_trgm` in `public` and the non-login,
non-RLS-bypass `openlup_mcp_reader` role required by that baseline, and replays
the baseline transactionally, then applies the managed alignment and required policy-data forwards.
Its synthetic seed supplies only the recurring catalog item, prices, stock and
settlement settings. The compatibility alignment seed is now a no-op. Setup
does not insert a paid order or active subscription.

For accidental-attachment protection, setup records a per-installation opaque
id in the existing `commerce_settings` table and in its generated local marker.
Before that row exists, an interrupted setup can resume only on its recorded
container. A sealed setup checks the live database id before reapplying
prerequisite or seed SQL, and the selected runtime checks the same id before an
API operation. This row records development-reference ownership; it is not a
platform migration or an adopter data contract. Reusing the same database
volume preserves the identity and business state; a different database at the
same port refuses. The managed baseline and forward replay plus one local fixture do not establish N-1
compatibility or general self-hosted database support.

## Known managed-baseline alignment gap

The managed baseline creates `subscription_delivery_alignment_control` without
its singleton row. Readers coalesce an absent mode to `off`, so late delivery
does not move the next cycle. `subscription_delivery_alignment_set_mode` updates
only existing rows and can report success after updating zero rows; it does not
repair this missing prerequisite.

The managed forward seed_subscription_delivery_alignment_control, version
20260927131453, inserts the singleton with `mode = auto_align` and
`ON CONFLICT (singleton) DO NOTHING`. It repairs a missing row while preserving
any existing mode choice. Apply it after the immutable baseline; never edit the
baseline to add seed data. pgTAP reads the installed singleton and tests replay
and preservation of an operator's mode choice.

The owned disposable subscription setup applies this forward before its seeds,
including on reruns where the catalog already exists. Its matching compatibility
seed becomes a no-op. Reference verification still refuses a missing row or a
mode other than `auto_align` before either a new journey or restart proof. This
mode is the prerequisite for the monotonic late-delivery rule in
[Canonical contracts](CANONICAL_CONTRACTS.md#subscription-delivery-alignment).

The managed singleton seed has no portable twin. The native chain carries
delivery alignment in its own
[`fulfillment_delivery_alignment` forward](../../db/platform/migrations/20261022090000_fulfillment_delivery_alignment.sql),
which creates the control row with mode `off`; `auto_align` enables the
late-delivery invariant. Native store and real PostgreSQL conformance tests
cover admission and arrival alignment. These checks do not establish
installation-path parity, a complete installed late-delivery journey or a
stable upgrade guarantee.

## Legacy fresh-bootstrap role observation

The experimental `@openlup/platform/lifecycle` export
`inspectLegacyPostgresInstallRoles(db, request)` makes one fixed parameterized
SELECT through a caller-owned query handle. On PostgreSQL 16+, it observes
database/session identities, selected role flags and incident membership edges
in one statement snapshot. Memberships are inventory, not transitive ACL proof.
Driver failures are redacted rather than exposing connection diagnostics.
The statement binds catalog relations, functions, cast types and equality
operators to `pg_catalog`; an application-first session `search_path` does not
select application-defined observation functions, types or comparison operators.

Its scope is `legacy-fresh-bootstrap-role-prerequisites`. A true
`rolePrerequisitesMet` requires the declared migration login to match both
`current_user` and `session_user`, the legacy superuser/shared runtime-login
conditions, installer-managed mode, and absent bootstrap roles. SET ROLE is not
an actual login. This result does not prove schema inventory, installation
completion, object ACLs, pooling, import safety, provider support or freedom from
later concurrent changes. It executes no DDL and changes no immutable SQL.

The existing [PostgreSQL witness](../../tests/postgres/m14InstallQualification.test.ts)
observes a positive result inside a read-only transaction, actual ordinary-login
and SET ROLE refusals, and role flags/memberships. It executes the immutable
acquisition bootstrap to prove restricted-login 42501 refusal before schema/role
writes, and the immutable actor bootstrap to prove a pre-existing safe role
collision (42710) before auth writes. This finite observation does not make a
qualified installer or portable installation claim; those decisions remain
separate from both this probe and application-file upgrades.

## Compatibility lifecycle

The [recipe runner](RUNTIME_AND_SELF_HOSTING.md#recipe-conformance-runner)
composes this same released-history proof against its declared separate fresh
schema target. That route requires the actual previous 0.23.0 application
binding; the ordinary offline test keeps it optional and cannot thereby claim
compatible-code rollback. Killed child migrations receive their connection
configuration through stdin, including verified TLS, without credential-bearing
process arguments. The factored proof retains the same backfill, ledger,
retained-row and subscription assertions. The RDS branch instead admits the
restricted generation, stops its canonical runner at the prefix before the same
backfill, then exercises those assertions and actual previous application code.
That branch proves a restricted-prefix upgrade, not an upgrade from a released
restricted predecessor. The released legacy history below is unchanged.

The [released-history witness](../../tests/postgres/m14ReleasedSchemaUpgrade.test.ts)
selects the nearest published predecessor with an applicable portable data
backfill: platform 0.23.0, whose 77-unit legacy manifest is an exact prefix of
the current 88-unit legacy manifest. The invoicing durable-duties forward copies
existing settlement and shipment-operation identities into `invoicing_cutover`
so historical sources do not become new duties. It kills the canonical runner
while that unit waits inside its transaction and again after the unit commits,
then checks exact ledger replay, retained rows, and subscription alignment.
An opt-in local binding to the published 0.23.0 package exercises prior payment
code against the upgraded database. The 0.23.0 release has no qualified-v2
history, so this is a legacy upgrade witness; the separate qualified-v2 fresh
installation checks retain their own scope. Code rollback does not restore the
earlier database schema or reverse the backfilled cutover rows.

The runtime-completion forward follows the entire qualified F90 prefix, preserving
all earlier issued identities. The owner-path forward follows it as unit 92,
with two newly measured restore-bound inventories. Runtime completion provides
the existing normal-runtime preparation context writes
and review replay-receipt reads/appends. Its column grants exclude context key
updates, and receipt UPDATE/DELETE/TRUNCATE remain denied. Apply the complete
selected catalogue through the existing executor and ledger; this exact grant
completion does not authorize owner fallback, legacy relabelling or a new role mode.
The production-composition witness includes actual restricted-runtime commands
and refusals; reference inventory derivation alone does not qualify those commands.

The separate `qualified-admin` 91-unit catalogue is a fresh installation
generation. It is not an upgrade, relabel or migration-history conversion from
legacy or `qualified-v2`. Its interrupted-prefix proof resumes only the same
selected generation under the same actual migration login and fixed role mode;
replay after completion applies no units. The [local PostgreSQL 16 connected
restore witness](../../tests/postgres/m14RestrictedConnectedRestore.test.ts)
covers this generation in both role modes with emulated provider control-plane
roles. Actual hosted connected restore and hosted upgrades remain unqualified
pending separate hosted receipts.

The existing qualified target/separate-restore witness connects the native G17
observation host binding through actual restricted R. Bootstrap setup seeds the
owned domain graph and already-submitted request. R performs recovery read,
observation/status persistence, atomic ACK and exact replay; a conflicting
external ID refuses without changing the accepted row. The login is nonowner,
NOSUPERUSER and NOBYPASSRLS, without SET ROLE or recovery owner fallback.
No catalogue, SQL or grant changes. This proves neither R's new-dispatch
preparation capability nor whole-store restoration, executor fencing, provider
search completeness or effect authority.

The E2 predecessor's qualified fresh catalogue replaces the baseline and two bootstrap units,
then appends runtime sealing after the complete legacy ownership closure. Its
89-unit plan requires an actual PostgreSQL 16 database-owner SUPERUSER migrator,
distinct restricted runtime and optional restore logins, and one of four fixed
inventories for the actual migration/bootstrap and restore binding shape. It
does not change the issued 88-unit legacy plan or authorize a legacy database
to relabel its ledger. Installer-managed provisioning and operator-provisioned
roles must satisfy the same declared flags, membership and session refusals;
the [catalogue owner](#module-catalogues-and-installed-histories) describes the
production reference/renamed-target proof and its remaining execution boundary.
These source changes do not qualify a restricted managed host or establish
supported hosting.

The qualified E2+F plan appends the exact retained-row unit after runtime sealing
and requires the independently derived 90-unit restore-bound inventory for the
actual migration/bootstrap shape. It preserves the complete legacy plan and
issued SQL bytes. Restore access is limited to the two fixed domain entries;
ordinary runtime writes still execute lifecycle and alignment admission, while
retained insertion preserves history, frozen terms and outstanding obligations.
An absent restore binding refuses instead of selecting an E-only inventory.
The [compatible-transfer boundary](#compatible-data-transfer) and its production
witness distinguish registration from a proved target installation.

Managed commerce forwards scope saved-preference writes to a server-proved
matching account and bind return creation/replay to the principal, owned order
and normalized command. Checkout payment-link receipts retain operator audit
evidence; subscription finalize checks retained acquisition terms under the
policy lock. The new-purchase stock seam protects renewal demand, and starter
creation/graduation preserve the selected cadence and timezone default. Follow
the per-behavior `Migration:` actions in
[Exact reviewed function forwards](#exact-reviewed-function-forwards); these
managed contracts do not imply native parity or handler integration.

R4 introduces the frozen native `20261026120000_account_support_operator_authority.sql`
and managed `20261026120100_account_support_current_authority.sql` from
`supportAuthorityForwards`. The native SQL and packed twin are byte-identical;
the platform manifest appends one row and its inventory digest must be derived
from the real selected catalog. The account-support catalog is sparse, not an
installation chain. Complete M11 managed predecessors must precede the managed
introduction; no existing pin, historical SQL or source-release binding changes.

Native support delegates effects to M10 in one transaction with operator actor
attribution and actual owner receipts. Email/phone/link and the missing M10
subcases retain named capability refusals. Managed email retires the combined
`customer_support_correct_subject_email_v1` entry: active human callers now get
55000 `customer_support_email_correction_requires_admission`. Call admission,
claim, commit the claim-fenced identity update, then settle. A stale/expired claim
cannot commit; release leaves pending, failure stays durably failed, and original
operator attribution survives resumption. Managed linking adds audited
`account_link`; recovery gains a human fence. The four preserved donor email
definers (admit, claim, guard and settle) retain `search_path = public, pg_catalog`;
the newly DEFINER link uses `search_path = pg_catalog, pg_temp` with fully qualified
application references. All five revoke EXECUTE from PUBLIC, anon, authenticated
and `openlup_mcp_reader`. Callable entries grant EXECUTE only to service_role;
the guard also revokes service_role and remains trigger-only. The operator-authority
PostgreSQL proof calls link as service_role and compares clean and hostile
caller-session results. See the
[class inventory](#m12-supportauthorityforwards) and
[operator receipt contract](CANONICAL_CONTRACTS.md#operator-support-receipts-and-partial-links).

Migration: five existing pgTAP callers move from combined correction to the ordered
workflow without dropping their subscription/phone/namespace/absorption witnesses:
`operator_subscription_actions`, `operator_contact_correction`,
`marketing_lead_email_namespace`, `absorb_lead`; the missing-subject/null-clock
case in `runtime_capability_boundary` now calls admission. Machine and inactive
operator refusal assertions retain their prior meaning. The complete enumeration
is in the [M12 plan's R4 section](plans/oss-m12-account-support.md#r4-operator-recovery) and R4's change fragment.

The managed M10-9 forwards add attempt attribution and canonical failure-observation
state through their exact admitted DDL, deterministic backfill and service-only
overloads. Hosts must carry the applied transition's attempt into each failure
observation, including apply replay; fresh missing attribution refuses 55000.
Existing-donor schema/backfill maps to its immutable history and must never run
again. The [attempt replay contract](#m10-9-attempt-replay-control-fixtures)
owns upgrade/refusal/compensating-forward details and REGISTERED native parity.
The duplicate-observation pgTAP and real PostgreSQL attempt-replay witness cover
same/stale no-change behavior, cache refusal, advancement, historical attribution,
concurrency and reconciliation boundaries.

Migration: native `20261022195000_invoicing_seller_revision.sql` and managed
`20261022195100_invoicing_seller_revision.sql` introduce the approved CTL-M09-4
fixtures byte for byte. The native descriptor and manifest append 195000 after
192000 at position 80. Request wrappers mark newly created obligations; claim
wrappers freeze only their first-ever durable claim. Retries retain a frozen
seller; work claimed before the wrappers keeps execution-time fallback, including
an empty eligibility sidecar. Corrections capture their own seller revision.
Managed order-status reversals preserve the incumbent result and effects through
the seller request wrapper. No issued-document or historical-fact rewrite occurs.
The complete native catalogue is required; sparse package assets are projections.

The [M09 migration owner](#m09-invoicing-forward-design-and-control-approval)
records the reviewed payment-decoupling forward and its installation boundary.
For new unlinked P4 settlements, `accountingRequested` remains false even after
independent invoicing; P4 supplies no payment-event linkback writer. Historical
linked events retain their readback. Use `invoicing_duty_readback` for invoice
progress and retained settlements for late recovery.

The managed prefix now includes M1
`20261024155000_refunds_preserve_subscription_lifecycle.sql` and M2
`20261024160000_subscription_dunning_continuity.sql`, byte-equal to the reviewed
batch fixtures. M1 removes only refund-driven subscription/cycle cancellation
and activation reversal, retaining the existing stock-release guard. It does
not repair historical rows; F17 later extends refund evidence as described below.
M2 keeps exhaustion open with NULL retry, an active subscription and a repair
token. Recovery binds the consumed token, durable method, current cycle and rung;
no automatic retry follows exhaustion. Historical expired cases keep their
separate resume route. The [managed dunning proof](../../supabase/tests/subscription_dunning_continuity_test.sql)
and [refund proof](../../supabase/tests/refunds_preserve_subscription_lifecycle_test.sql)
exercise lifecycle continuity on the complete installed prefix.

The catalog gate applies every non-pin before the next pin exactly once,
including interleaved files. Docker-free tests cover native N1
and managed M1/M2 landed; CI/release admission refuses a digest-drifted M1 below M2.
M1 has no counted vocabulary; only M2 adds a C94 baseline key (`ui-13`: 2,
`ui-14`: 3), with no existing count changed.

The native `20261022160000_subscription_retry_lifecycle` forward adds three
subscription retry ledgers and nine invoker functions. Install it through the
complete ordered native manifest; its package SQL projection is byte-identical.
This is N1, the F16 repair for terminal renewal declines that previously removed
an active subscription from the due list indefinitely. It adds neither N2
commands nor N3 stock wait. Disable the retry driver before rollback and retain
the ledgers for reconciliation; do not delete refusal or payment history.

The retry ledger keeps the original operation, cycle, order, settlement, schedule
and snapshot. Retry zero is the original attempt. Failures one, two and three
schedule +24, +72 and +168 hours from each failure; four exhausts the ladder.
A terminating class can clear the retry earlier. Exhaustion leaves an open case,
null retry and active subscription. An authorized same-case token and durable
healthy-method evidence can re-offer the original obligation. Verified M07
positive evidence settles that obligation and advances its native counter once,
using the later-only schedule clamp. SQL performs no provider calls. Prepared
receipts fence dispatch even when the acknowledgement was lost.

Initial case-before-outcome handoff and subsequent retry failure are different
transaction routes. N1's `subscription_retry_open_case` requires an existing
failure row, while its initial `subscription_retry_apply_failure` can record the
terminal outcome. The package binding opens the donor-keyed existing dunning case first, then
attaches N1 bookkeeping inside the M07 terminal transaction, linking the same
case. It never applies the initial money result twice; any bookkeeping failure
rolls the terminal transaction back for safe replay. Hosts supply its
transaction executor and evidence-bound correlation; no runner is activated.


The stock-evidence replay forward `20261022165000` appends native position 76
on this catalogue and joins the sparse fulfillment projection. It replaces only
`fulfillment_record_stock_evidence`: matching-fingerprint replays reopen and refresh
the alert, clear `resolved_at`, and retain its identity, first-seen time and
historical resolver run. Mismatches still raise `23505`; legacy 0.22.0 whole-input
fingerprints are not rewritten, even after resolution. The resolver itself is
unchanged. Preserve every preceding manifest row and recompute the live
selected-catalog-v2 digest after the full chain. No managed forward is needed:
its baseline already refreshes/reopens corresponding evidence. The
[replay proof](../../tests/postgres/fulfillmentStockEvidenceReplay.test.ts) covers
fresh installation, the exact predecessor upgrade and runner replay, unchanged
ledger prefix and function ACL/header, package byte equality, lifecycle/refusals
and bounded concurrent row locking.

See the [M09 forward owner](#m09-invoicing-forward-design-and-control-approval) for managed correction v2 installation, cutover and reconciliation.

### Managed stock wait, ATP and refund parity

Migration: the managed prefix appends `20261024175000` (ATP seam), `180000`
(M3 stock wait), `181000` (M4 due reader), `182000` (M5 message scan), `184000`
(M6 allocator), `185000` (F17 evidence helper) and `185100` (F17 applicator/outbox).
Each rail file equals its frozen fixture and registry digest. The ordered managed
directory and publication catalogue are the existing install inventory; these
forwards add no native manifest or package SQL twins. M4's before-function hash
is M2's after-hash; F17 follows M1's applicator replacement. No landed pin changes.

The managed [stock-wait proof](../../supabase/tests/subscription_stock_wait_test.sql),
[unpaid-discovery proof](../../supabase/tests/subscription_stock_wait_unpaid_discovery_test.sql)
and [ATP proof](../../supabase/tests/subscription_managed_atp_test.sql) cover rollback,
restock, rotation, private bindings and one-time refusal. Existing dunning and
arrival proofs retain active service, consumed-token/method authority and the
maximum delivery clamp through a rollback to off. The
[refund lifecycle proof](../../supabase/tests/refunds_preserve_subscription_lifecycle_test.sql)
checks both first-cycle and renewal refunds against future hard/soft protection.
The [cumulative snapshot proof](../../supabase/tests/stripe_refund_cumulative_snapshot_test.sql)
checks cumulative maximum evidence, once-per-order refunded transitions, rejected
provenance and equal/older snapshot ignore/replay. Ignored snapshots can retain
receipt/event/transition bookkeeping; they create no new refund effect. Matching
stored applicator receipts return before lifecycle or stock writes. M1's lifecycle
independence survives F17; this does not mean its whole applicator body is unchanged.

Donor sources are `20260928170000_new_purchase_stock_availability.sql:26–76,200–291`
and `20260710131002_no_cron_inventory_reservation_leases.sql:15–315` (seam/M6),
`20261003123000_subscription_stock_wait.sql:51–650` and
`20261003142320_subscription_stock_wait_unpaid_discovery.sql:12–324` (M3),
`20261009110000_subscription_dunning_active_repair.sql:744–930` (M4),
`20260802120000_subscription_winback_positive_customer_marker.sql:34–81` (M5),
`20261009111000_stripe_refund_cumulative_snapshot.sql:18–85,167–952` and
`20261021130000_refunds_preserve_subscription_lifecycle.sql:18–758` (F17), all
under donor `supabase/migrations/`. Five C94-bound headers remain frozen; these
citations supply provenance without altering their bytes. Current donor
`20261013173001_channel_exposure_inventory_admission.sql` global/channel controls
are deferred, and the exposure hook remains zero.

Known donor-identical limits remain: SQL NULL summary state returns empty totals
rather than refusing (B12); additive-provider helper evidence lacks the cumulative branch's
signature/status/exact-attempt filter (C18). Neither changes in this landing.
Keep captured cases, payment history and receipts on rollback; disable the host
stock-wait driver first. Reverting code does not undo function replacements.
Any SQL repair requires a separately reviewed forward. No backfill, host activation
or stable upgrade claim follows from these source/probe paths.

### Native stock wait and ATP (N3)

The native installation prefix now includes the five approved N3/seam/allocator/
X/Y pins at `20261024180000`, `183000`, `184000`, `184500` and `184600`, each with
its byte-identical package SQL twin. N3 adds frozen waiting cases and stock-only
refusal recovery. Uncaptured refusals rotate on the existing renewal operation
`updated_at` selection stamp, so recovery failures before case creation cannot
keep occupying a bounded page. Captured waits retain their case selection stamp.
The seam subtracts hard commitments and fixed 14-day active
subscription demand from new-purchase availability. Native safety and channel
exposure remain zero. This is no advance reservation lifecycle or one-time
checkout write contract. The allocator alone uses the renewal exemption.

For a separate native runtime role, the host must explicitly grant `EXECUTE` on
`public.inventory_available_to_promise(text,text,timestamptz,boolean)` and its
helper `public.inventory_channel_exposure_quantity(text,text)`, including for
roles that reserve renewals or call N3 deficits/admission/refusal recovery.
New-purchase readers additionally need `EXECUTE` on
`public.inventory_new_purchase_stock_read(text,jsonb,timestamptz)`.
Alongside the caller's existing relation privileges, ATP requires `SELECT` on
`fulfillment_stock_current`, `fulfillment_inventory_reservations`,
`fulfillment_inventory_reservation_lines`, `subscriptions`,
`subscription_renewal_terms`, `subscription_renewal_term_lines`,
`subscription_renewal_operations` and `subscription_cycles` in `public`;
new-purchase reads also require `SELECT` on `public.catalog_skus`.
These invoker helpers have no shipped runtime grant. The allocator retains its
existing ACL, and neither X nor Y calls ATP; their existing grants still apply.

X restores released late-paid reservation lines to committed, non-expiring ATP
holds once, returning from its immutable recovery receipt before further writes.
Y excludes paid cycles and settled intents before the candidate limit. Refunds
remain financial; stock wait never pauses service or fabricates a delivery fact.
Keep these forwards and captured obligations on code rollback; disable the host
stock-wait driver first. Object inventory must come from selected-catalog-v2 on
disposable pinned PostgreSQL, never from hashing SQL source. The
[native suite](../../tests/postgres/subscriptionRenewalLifecycle.test.ts) binds
creation probes to each unit's exact path, including rollback and ACL checks;
its stock and accounting tables test behavior separately from SQL classification.
Stock recovery remains unselected until that real-PG proof is available.

### Native subscription commands (N2)

Migration: `20261024170000_subscription_command_lifecycle.sql` is the second
native subscription prefix, after N1 and the interleaved M08/M09 units. It adds the actor/key receipt table and
`subscription_command_preview` / `subscription_command_apply`, all invoker-only
with browser execution denied. Canonical and package bytes are identical.
Install the complete ordered manifest before selecting the adapter. Stop command
writers on rollback and retain receipts and accepted quotes; never rewrite
current payment/cycle/order snapshots. Existing native callers are unchanged.
N2 preview returns `noop` before catalogue repricing for equal supplied bundle
fields, existing add-on quantities (`add_addon` and `update_addon_quantity`), plan
length, native resize lines/cadence, package templates and same-UTC-day slides.
It persists only its actor/key receipt and creates
no quote, line/price write, event or template-version increment. Applying that
same command replays the stored noop receipt without writes. The TS store also
uses native preview for an unquoted direct apply, retaining only a noop
receipt; a non-noop probe rolls back before ordinary apply, preserving each
changed-state command's quote requirement or lifecycle behavior.
Raw SQL bundle apply still requires either that receipt or a quote. Changed plan
length commands quote and apply supplied core lines; omitting them expands the
stored core lines. New add-ons default missing or nonpositive quantities to one.
Add-on commands preserve the stored cadence, and quantity updates and removals
compare variant UUIDs case-insensitively. Duplicate-line refusal remains in force. The
[TS store witness](../../tests/postgres/subscriptionCommandLifecycleCases.ts)
checks catalogue drift and compares every public table, including row versions,
across preview and apply replay.

Migration note (C73, temporary limitation): managed provisional creation
(`subscription_create_provisional_for_checkout`) stamps an explicit timezone
literal equal to today's `subscriptions.timezone` column DEFAULT. An adopter who
changes that DEFAULT must also replace the function until the scheduled follow-up
forward makes it follow the DEFAULT. This change alters no managed SQL.


Fulfillment expands the native graph with new command and
alignment objects at positions 73/74. It preserves all position-0–72 identities,
existing rows and the managed graph. Upgrade the complete prefix before enabling
the new stores; sparse package assets are projections only. Default-off alignment
creates no cases during upgrade. Code rollback retains accepted dispatch proof
and already extended dates; repair those facts forward. Invoker-only owner
execution adds no browser privilege or service account. The
[module catalogue notes](#module-catalogues-and-installed-histories) distinguish
native dispatch commitment, missing correlation and future service grants.

The portable forward
`20261021120000_dunning_lifecycle_active_repair.sql` appends position 71 to keep
active subscriptions active on dunning exhaustion (invariant repair). Its exact
bytes are bound by the manifest SHA-256; it replaces only
`dunning_lifecycle_handle_failure`, with no stored-row rewrite or change to
preceding migration bytes, positions or privileges. Exhaustion leaves the case
open and repairable, with its final notice and event; it changes no subscription,
pause window or cycle dates. The [real-PostgreSQL proof](../../tests/postgres/dunningLifecycleActiveRepair.test.ts)
covers complete-catalogue fresh install, exact position-70 prefix upgrade with
existing rows, ledger replay, exhaustion/recovery and browser EXECUTE refusal.

Native shipping appends the seed-only forward
[`20261021200000_shipping_flat_rate_seed.sql`](../../db/platform/migrations/20261021200000_shipping_flat_rate_seed.sql)
at position 72. It inserts `shipping_flat_minor = 0` only when absent, preserving
an existing rate and every ACL and role membership. The named role-free shipping
lane owns fixed-key read/update statements; no service role or grant is added.
Supply the native rate port, a passing Core required-schema readiness report and
its same-database `nativeRateSchema` observation before enabling the binding.
The reference probe checks the seed's position, path and SHA-256 in the ledger,
plus the settings table and columns; later ledger entries are permitted.
Candidate labels alone prove nothing. An unmigrated schema keeps
`shipping_native_flat_rate_save_unsupported`. A missing setting row refuses with
`shipping_native_flat_rate_row_required`, never a successful zero-row update.

Native audit is unsupported and remains best effort: the incumbent handler
swallows `shipping_native_flat_rate_audit_unsupported` after a successful save.
The bundle principal ledger only accepts bundle actions; no generic portable
audit routine can record `shipping_rate_change`. No durable shipping-rate audit
is claimed. Managed rate authority remains pending and unchanged.

Old application code ignores the seeded row. Older migration runners refuse the
extended ledger, as with every forward; an application rollback does not reverse
the migration or establish older-runner startup compatibility.
[Native shipping conformance](../../tests/postgres/shippingNative.test.ts) covers
fresh install, exact pre-seed position-71 upgrade/replay, readiness, denied browser/PUBLIC
access, whole-catalog ACL/membership equality and missing-row/audit failures.

C-compose adds no SQL or manifest entry. Its direct schema requirement names the
full position-70 prerequisite, consent authority, existing outbox/receipt/control
objects and all five native tables/used columns. The host independently observes
the full installed ledger; object presence alone never substitutes for it.
Native preference persistence uses the existing consent row plus the existing
sync registration inside one owner-authority transaction. Repeated preferences
reuse work for the current permission revision and binding; state transitions
produce a new ordered event. Runtime effective-privilege refusals remain required.

Native communications appends
[`20261019200000_communications_native_operations.sql`](../../db/platform/migrations/20261019200000_communications_native_operations.sql)
at position 70. Its five CREATE-only tables store network targets, immutable
observations, a nonqueue outbox sync sidecar, notification recipients and policy
decisions. Existing consent truth and all earlier forwards remain unchanged.
Deploy the complete schema before selecting the factories; rollback of application
code leaves additive objects and prior data intact. Sparse package projections
are not an install chain. The live selected-catalogue digest is refreshed from
real PostgreSQL. [B3 conformance](../../tests/postgres/communicationsNative.test.ts)
checks exact position-69 upgrade with durable state, fresh install, runner replay,
ledger tamper refusal and clean/poisoned default and inherited ACLs. Runtime
refusal on unsafe effective privileges is required: this forward changes no grants,
functions, triggers, old objects or classifier rules.

Reference identity composition adds no SQL or ledger entries. Direct startup
requires the complete canonical catalogue through identity erasure receipts,
never the sparse seven-file package projection. Its schema inventory is a
presence check; hosts must independently observe the complete installed ledger.
Managed startup likewise needs trustworthy committed-chain observation and
separate effective-grant verification. The reviewed managed identity service-role
capabilities forward supplies client INSERT(email, auth_user_id,
acquisition_source, lifecycle_stage), UPDATE(auth_user_id), and operator
INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) plus SELECT(email). The opt-in conformance runners add no
fixture grant, and application startup adds no grants.

Reference customer browser sessions use separate storage namespaces without
migrating legacy credentials. Managed logout clears the effective SDK store
even after remote revocation fails. A failed compatibility session read returns
`null`, allowing guest checkout without a bearer; provider bootstrap still
reports the failure. These browser operations add no database session rows and
require no schema migration or rewrite of stored customer links. See the
[browser session contract](IDENTITY_BROWSER_REFERENCE.md).

The direct privacy forward `20261018190000_identity_privacy_erasures` appends
position 69 and one receipt table, with default NO ACTION references and no
functions, grants or policies. Apply it before the updated customer challenge
store and privacy operations. Its identity SQL projection is byte-identical and
retains the canonical path, digest and position. Preserve the complete earlier
manifest prefix. Fresh installation, exact position-68 upgrade, replay and the
live selected-catalog-v2 object-inventory digest require disposable PostgreSQL
verification. Schema installation alone changes no existing identity or links.

Direct erasure deletes challenges and outstanding invitations, pseudonymizes
profile and retained identity snapshots, revokes active operator membership
through the guarded authority, and clears only the selected contact's direct
principal link. It never changes `clients.id` or writes `auth_user_id` and never
cancels a subscription. Cleanup and the retained pseudonymous receipt commit in
one transaction; replay returns the original receipt. Subscription and challenge
relation locks precede subject locks, with bounded waits and full rollback on
failure. Effective inherited browser/PUBLIC receipt access refuses writes.

The package customer challenge store checks erasure receipts by both contact and
principal in the transaction that calls issue/redeem, holding an `EXCLUSIVE`
challenge-table lock through commit. Erasure takes the same conflicting lock
before subject reads and cleanup. Thus a late challenge from an issuer that read
before erasure cannot re-link through package redemption after erasure commits.
Receipt reads use `ACCESS SHARE`, compatible with erasure's receipt-table
`SHARE ROW EXCLUSIVE` lock. This guarantee covers the package adapters; hosts must
not call the raw `customer_identity_challenge_issue` or
`customer_identity_challenge_redeem` SQL functions directly. Those unchanged
functions have no receipt fence. No function replacement, trigger, RLS change or
new SQL is required for the adapter boundary.

Managed erasure refuses with `MANAGED_PRIVACY_ERASURE_UNAVAILABLE`: a managed
adopter must provide its own erasure path until a separately reviewed managed
forward and atomic persistence capability exist. The committed column grants
cannot perform full profile/membership pseudonymization. Managed export reports
inaccessible fields as unavailable. No managed SQL or privilege expansion ships
with this capability. Provider identity must be disabled rather than deleted,
because deletion could clear immutable customer auth links. No managed provider
mutation is composed here. See [identity privacy](IDENTITY.md#identity-personal-data)
for retained obligations and the limits of identity completion.

To run the opt-in managed privacy proof from the repository root, supply the
local disposable-stack API URL and service key as
`OPENLUP_MANAGED_CONFORMANCE_URL` and `OPENLUP_MANAGED_CONFORMANCE_SERVICE_KEY`.
Set `OPENLUP_MANAGED_CONFORMANCE_DATABASE_URL` to the database owner
(`supabase_admin`) connection, then run
`node --experimental-strip-types tests/postgres/identityPrivacyManaged.conformance.ts`.
Use a fresh public schema and reset the stack between proofs. The proof uses
the shared committed migration loader and omits only the psql-only pg_dump
`\restrict` and `\unrestrict` guard lines for node-postgres replay; migration
SQL and erasure permissions remain unchanged.


Operator challenges add one direct-only table and indexes, no function or
privilege grants. Issuance, activation/consumption, bootstrap and retention use
the trusted transaction lane. Before enabling direct login, verify effective
browser-role/PUBLIC privileges, including inheritance and column grants; unsafe
stores refuse runtime authentication. Browser sessions use tab storage through
the existing guarded storage boundary and do not add database session rows.


The operator invitation lifecycle preserves existing accepted membership rows and customer/principal links. Its
direct forward `20261018120000_identity_operator_invitations` appends one catalogue
unit, at position 67, and adds pending-invitation and invitation-audit tables with
default NO ACTION principal foreign keys. The byte-identical identity projection
retains this canonical identity and position. Lifecycle logic runs in trusted
server TypeScript transactions; acceptance, membership and audit settle together.
The forward uses only admitted CREATE TABLE/INDEX forms and changes no privileges.
The real PostgreSQL conformance must verify effective actor-role denial, fresh
complete-catalogue installation, exact predecessor-ledger upgrade and replay.
The object-inventory SHA-256 must be refreshed from that live catalogue with the
runner's selected-catalog-v2 projector, never guessed from SQL text.

The managed invitation route inserts active native membership immediately and
adds no SQL or RPC. It stores no pending invitation in Auth metadata and does not
activate or compensate on first entry. Identical repeats return existing active
membership without another notification; a unique insert race re-reads the winner.
Failure retains the identity for retry. Re-inviting a revoked managed operator
refuses with 409 `MANAGED_REINVITE_UNSUPPORTED`.

The managed pending/expiry lifecycle remains a compatibility gap because it needs
a transactional store. It closes later only through a separate reviewed managed
forward. This change does not broaden SQL admission, install a managed migration
or certify parity with the direct transaction protocol.

The managed chain's identity capabilities forward
`20261018160000_identity_service_role_capabilities.sql` grants `service_role`
SELECT(email) and INSERT(id, email, role, membership_state, membership_provenance,
membership_accepted_at) on `admin_users`. The insert omits `is_machine_actor`,
relying on its `NOT NULL DEFAULT false`. The opt-in
[managed conformance module](../../tests/postgres/operatorInvitationManaged.conformance.ts)
replays the complete committed managed chain into a fresh disposable local stack
with ambient default ACLs removed and adds no grant. It proves immediate
activation, repeat/concurrent recovery and revoked-member refusal under the
shipped grants. It does not establish managed/direct lifecycle parity.
The [package guide](PLATFORM_PACKAGE_REFERENCE.md#operator-invitations) gives
its local endpoints, controlled setup and exact invocation.

Runtime capability regressions execute operator and support gates as
`service_role`, including exact inactive-operator and machine-actor refusals,
missing subjects and prohibited unrelated column access. Two independent
service transactions prove renewal selection skips locked normal and retry rows
and admits them after release. The database owner only creates fixtures and
observes refused mutations. A proposed SQL overlay in a disposable database is
local behavior evidence; committed-chain replay and delivery checks remain
separate requirements.


The application-file lifecycle primitive checks caller-supplied schema ranges
without reading or changing the database. Keep that file-ownership reconciliation
separate from the actual expand/backfill/contract evidence below; its successful
apply does not prove old/new SQL compatibility or authorize a migration.

Every production-shaped schema change follows this order:

1. **Expand** with an additive, backwards-compatible schema change.
2. **Compatible deploy** code that can read the old and new shapes.
3. **Backfill** through a resumable, observable, idempotent process.
4. **Contract** in a later release after the old shape is no longer consumed.

Code rollback must remain compatible with the expanded schema. A destructive
down migration is not a rollback plan. Each stage needs a clear readback and
failure boundary; a backfill that cannot be safely retried is incomplete.

The managed forward `20261003110000_required_platform_policy_data.sql` supplies
configuration omitted by the schema-only baseline. It initially classifies 27
relations referencing clients: four marketing relations carry, account-event
history stays on the archived lead, and the other 22 block absorption. Unknown
future relations still refuse. M3 adds a blocking stock-wait classification,
bringing the current inventory to 28. Existing classifications survive replay.

The same forward installs seven disabled job controls, the four exact declared
dormant command identities and four message controls. Message controls begin
enabled to preserve the sender's existing missing-row behavior; a prior disabled
operator choice stays disabled. No job, provider or scheduler is activated.
Existing driver, metadata, note and dormant-reason choices also survive replay.
The dormant insert uses the frozen five-column relation order and literal UTC
migration timestamps; the managed regression checks that order before replaying
the actual forward. No portable twin or installation-path parity is claimed.

Database proofs execute order writing, accounting and dispatch claims as
`service_role`, and membership commands as `authenticated`. Owner readback
observes persisted state and denied writes. Legacy catalog commands stay denied;
no broader raw table DML is required to reach an otherwise inert handler.

## Contract changes

Schema constraints, stored-money representations, identifier formats, and
canonical status vocabularies are data contracts. Change them only with an
explicit compatibility path, a data migration where required, and regression
coverage for old/new reads, replay, and refusal cases.

Do not infer durable truth from a provider callback or from a browser payload.
Persist the platform's canonical fact and keep provider evidence at the adapter
boundary. See [Canonical contracts](CANONICAL_CONTRACTS.md) for the mapping and
idempotency rules that prevent duplicate or stale writes.

## Paired chains diverge, and each side must say so

Some forwards ship twice: once into the managed chain the hosted deployment
applies, and once into the public platform catalogue an adopter applies. The two
are behaviour-identical by intent, never byte-identical by accident, and **each
header states its own divergences out loud** rather than being copied from the
other. The job-control seed for `customer-diagnostic-prune`
(`20260914130000_customer_diagnostic_prune_job.sql` in both roots) is the current
worked example:

| | Managed chain | Public platform catalogue |
|---|---|---|
| Columns | five — `(job_name, enabled, active_driver, allowed_trigger_kinds, metadata)` | four — the `allowed_trigger_kinds` column does not exist here |
| Why | the v3 claim raises `platform_job_v3_control_not_configured` when the column is NULL, so a v3 job that omits it cannot claim at all | this catalogue's claim path gates on `enabled`, the driver and the lease; there is no column to write and no refusal to avoid |
| `active_driver` | `'worker'` | `'worker'` |
| Metadata | carries `requiresFlag` and the hosted-cron note | omits both: which environment variable one deployment names, and which hosted schedulers it declines to use, are not properties of this catalogue |
| RLS / grants | present elsewhere in the chain | never authored here — the managed chain's principals do not exist, so authoring them would be authoring empty shapes |

⚠️ **The nearest neighbour is the wrong model, and that is the point of writing
the header from scratch.** The `channel-order-pull` seed in the same catalogue
writes `active_driver = 'scheduler'`, which is correct for a poll whose claim
arrives as a scheduler. `customer-diagnostic-prune` claims as `worker` on every
runtime, and the portable claim refuses a driver mismatch as `inactive_driver`,
so copying `scheduler` would have made every claim this job ever makes fail. Copy
a neighbouring header's **style**; never its values.

⚠️ **A re-applied control seed must not reverse an operator.** Both sides use
`ON CONFLICT … DO UPDATE` that refreshes the driver, the allowlist where it
exists, and the metadata — and never `enabled`. An adopter who enabled a drain is
relying on it to bound their storage; one who disabled it is retaining evidence
on purpose. Neither decision may be silently undone by re-running a forward.

## Preview and stable posture

Current migration and self-host material is evaluation-oriented. The stable-framework requirements
must still prove versioned upgrades, N-1 compatibility, and the complete
expand/compatible-deploy/backfill/contract path before a stable upgrade claim is
made.

## Identity reference grants

The disposable identity reference adds no migration. Its managed installed
acceptance requires the separately reviewed forward
supabase/migrations/20261018160000_identity_service_role_capabilities.sql.
Once present, that forward supplies `clients` INSERT on `(email, auth_user_id,
acquisition_source, lifecycle_stage)` and UPDATE on `auth_user_id`, plus
`admin_users` SELECT on `email` and INSERT on `(id, email, role,
membership_state, membership_provenance, membership_accepted_at)`.
Until it is present, installed managed acceptance refuses. Existing labelled
fixture-only grants in adapter conformance remain fixtures and cannot establish
that the shipped chain supplies these permissions. The acceptance runner adds
no compensating grants and never writes a fabricated native migration ledger.

## Communications projections

`COMMUNICATIONS_MIGRATIONS` carries byte-identical projections of the existing
canonical comms outbox, transactional receipt and communications control-plane
units at positions 2, 9 and 20. Their hashes, runner positions and canonical paths
are checked against the unchanged manifest. They are a sparse module inventory,
not an independent install chain or a new forward. The full selected canonical
prefix and existing schema probes remain required. Managed receipt RPCs retain
their current service scope; direct receipts retain one role-free transaction per
operation and their accepted/failed replay boundaries.

The narrowed import moves receipt stores and their ledger contracts. Reference
mail-provider timeline/send-ledger implementations remain at their existing
owners; no provider mapping or new schema enters the package.

## M09 invoicing forward design and control approval

Status: `20261022193000` and `20261022193100` introduce the two managed
correction forwards. P4 introduces native durable duties, document effects and
payment decoupling at positions 77–79; the remaining forwards stay fixture-only.
Introduction must use exactly the pinned bytes. An unintroduced forward may carry its changed
pins in the feature under the co-located rule above. The introduced forwards
are immutable; their repair requires a new authorized forward. Existing control
approvals and their review history remain valid.

Three additional native creation pins cover durable duties, document effects and
seller revisions. New functions are invokers with `search_path = pg_catalog`;
new tables, views and functions revoke PUBLIC, anon and authenticated access.
There are no new native triggers, definers or grants. The host must explicitly
bootstrap its executor's least privileges; these fixtures grant no browser or
service principal access. Native versions are `20261022190000`,
`20261022191000`, `20261022192000` and `20261022195000`; managed versions are
`20261022193000`, `20261022193100` and `20261022195100`. M09 lands before M10
and keeps these assigned versions; verify against the landed managed prefix,
not an assumed M10 predecessor. The native P4 units occupy positions 77–79 after the installed subscription
160000 and fulfillment 165000 tail at 75/76; seller revision follows separately at 80.
Install the complete native catalogue with its preserved ledger prefix and exact
replacement preimage; sparse package projections are not an install chain.
Positional unit comments inside immutable SQL refer to its historical staging order;
use versioned filenames for identity, not those ordinals.
Canonical and packaged P4 assets equal their reviewed fixtures and pins, and the
manifest binds the full selected object inventory. No pending M10 forward or
runtime is required.

The fourth native pin is the single exact replacement of
`payment_truth_apply_terminal(uuid,text,text,timestamptz,text,text,jsonb,text,text,text)`.
Its declaration/settings and every statement outside the former accounting block
remain unchanged. That block captures an `invoicing_duties` obligation and exact
source/key receipts in the money transaction without consulting accounting
objects. Captured settlement and dunning recovery therefore survive accounting
failure. Capture uses a nonblocking advisory lock and a 100 ms lock timeout;
its subtransaction catches conflicts, permission failures and cancellation without
rolling back settlement or dunning. An append-only capture-fault marker is visible
in readback. If the payment principal lacks marker privileges, the retained paid
transition itself remains durable rediscovery evidence. Bootstrap capture and
fault-table privileges explicitly.

`public.invoicing_sweep_duties(integer)` collects retained settlement and handoff
sources and returns fact-installation leases. The host commits that short claim
transaction before calling `invoicing_prepare_facts(uuid,uuid)` for each lease,
commits its accounting transaction, then records the result with
`invoicing_finish_facts(uuid,uuid,jsonb)` in a separate short transaction. Do not
wrap these calls in a shared transaction. `invoicing_install_facts(uuid,jsonb,text)`
stages immutable facts only. This reuses the outbox claim/token/visibility pattern:
SKIP LOCKED claims, five-minute leases, eight attempts, exponential backoff from
60 seconds capped at one hour, and a visible `faulted` terminal state. Expired
claims recover without retaining order/duty locks across accounting work. Prepare
holds no explicit order row lock, bounds unavoidable database waits to 100 ms,
and preserves the incumbent deterministic document reference. Its final NOWAIT
duty lock rechecks the live fact token, wall-clock lease, unlinked request,
owed/blocked state and absent reversal; a failed recheck rolls back preparation. Host keys remain
exact in duty/receipt/metadata; the internal document operation uses the stable
duty identity so two intents may legitimately reuse a host key.
Accounting errors keep the fact revision and owed duty durable; missing host facts block
document work. The host supplies buyer, lines, money, tax, dates, references and
policy version rather than interpreting legacy zero-tax positions as fiscal
facts. Payment readback keeps `accountingRequested=false` for new unlinked
settlements; historic linked IDs and settled-event replay remain unchanged.
M09 does not write invoice evidence back into payment truth.

`public.invoicing_duty_readback(uuid)` reads an order's base and correction duties
without reading accounting tables or changing payment truth. It returns duty,
parent and document IDs, state, attempts, creation/availability/lease timestamps
and a nullable diagnostic code. Ready work reads as `owed`; processing reads as
`claimed`. Other persisted states (`owed`, `blocked`, `unknown`, `issued`,
`voided`, `unsupported`, `faulted`) remain visible. The closed diagnostic allowlist is
`missing_facts`, `legacy_facts_unproved`, `retryable`, `blocked`, `unsupported`,
`unknown`, `absent`, `faulted`; other kinds return null. Raw SQLSTATE, provider evidence and
claim tokens never enter this readback. Fact-install attempts are separate from
provider generations. `captureFaults` exposes only the latest fault row per
`(source_kind,source_id)`, with source ID, retry/fault state, attempt
count and next availability; a retained source receipt changes its readback state to
`resolved`. Raw errors remain excluded. Source capture failures
have their own eight-attempt/backoff ceiling, so one poisoned source cannot starve
later sources or fact retries. Empty orders return an empty duty list.
Execution remains restricted to the explicitly bootstrapped trusted host.

Duty and delivery claims accept a trailing optional order UUID, as does the
seller claim wrapper. The predicate runs before row locks and LIMIT, except
for the unscoped expiry of already-expired delivery receipts; targeted recovery
never leases unrelated orders. Omitting it retains batch behavior.
Clearance observations already record `not_submitted`, `pending`, `accepted`,
`rejected`, `not_required` and explicit unsupported observations; polling targets,
per-target orchestration and national mappings remain host/package work.

Policy suppression and operator skip outcomes can be retained in the existing
native effect-receipt ledger by the trusted host transaction. Source receipts
stop rediscovery; withheld fact installation keeps suppressed work unclaimable.
The host owns policy decisions, terminal outcome vocabulary and replay checks;
this SQL does not infer permission to issue from a source alone. No additional
native object or payment-truth mutation is needed for these receipts. Account
invoice history likewise uses a host query over existing order ownership,
documents, correction parent links and immutable facts; the host must authorize
the account before projection and refuse missing fiscal facts. No browser grant
or SQL history endpoint is added.

The existing `accounting_document_request_from_paid_order` and its reference
PostgreSQL adapter retain their local scope, response, document reference and
replay. Generic descriptions and zero-tax positions remain usable locally;
fiscal execution still requires proven facts and must refuse to adopt an
unproved local document rather than create a competing invoice. Fact completion
checks neutral facts and totals before adopting an unowned document. An
unsupported result requires existing document evidence and remains visible with
its diagnostic reason. At request time, reversal refuses to void an unlinked live
base document. An attempt in flight or a possibly sent or unknown request returns
`pending_readback`. After a create attempt ended `retryable`/`before_send` or was
authoritatively absent, reversal immediately voids the document, discards its
request and voids the duty if no claim or lease is in flight. A reversal stored
during processing voids the document, discards its request and voids the duty
when a create claim fails with `retryable`/`before_send`, or when authoritative
`absent` evidence confirms no remote document. A retryable readback still stays
unknown; a confirmed issue still requests one correction. Blocked duties return
terminal `unsupported`.
Initial legacy-child adoption hides only ready, pending, unattempted correction
requests. Once M09 owns a request, the [incumbent queue fence](#m09-incumbent-queue-fence)
continues through processing, expiry and failure.

Before installing, retire the incumbent issue/correction executor. Drain the
legacy managed correction worker first; reconcile any attempted or processing
legacy correction against provider evidence, recording its actual outcome before
cutover. The reference `accountingInvoicePort`, `accounting_paid_reversal_test`
and correction recovery pgTAP use v2 (`p_contract_version`,
`p_claim_attempt_count`); the adapter throws on `ok:false`. Attempted legacy
rows lacking a durable identity stay processing/failed with their original
error/payload retained, regardless of the invoice's current status.
They require provider reconciliation; an empty claim is not completion.
This adapter migration and its refusal/recovery proof are prerequisites for introducing `20261022193100`; it is not part
of fixture-only control preparation. The managed `ksefRequired` key is retained
for donor parity as a country-specific key, not a neutral native requirement.

Native correction finalization locks the parent request, child request, parent
duty and child duty before advancing the child and base accounting documents.
The native document transition updates accounting records, and its operation insert
takes a key-share lock on the order row through its foreign key; that lock order does
not remove the coupling. P4's native continuity
witness exercises dispatch while accounting work is blocked.
Managed v2 correction claim locks both joined invoice and outbox rows; its
finalizers lock invoice before outbox. Fenced finalizers also accept a parent
already `corrected` by an earlier acceptance sync when its `correctionOutboxId`
is absent or matches the claim; success still records `correction_issued` and
the delivery outbox. `correctionOutboxId` is written only on successful finalization.
For classifying hosts only, blocked, unsupported or explicitly non-retryable
`p_error` values retain `failed` with `next_attempt_at=infinity`; ordinary failures
keep their retry delay. The reference host sends `{message}`, so its failures
keep ordinary retry timing.

Registered managed-correction limit: multi-reason / late-issue compensation can
yield more than one full correction per invoice, as the incumbent does today.
The follow-up is a separately designed control change enumerating
`order_status_reversal`, `provider_issue_after_order_status_reversal` and
manual/scaffold interplay. After the `20261022193000` forward lands it must be a replacement forward;
this follow-up is outside M09.
No transaction spans provider I/O. The
existing managed order-reversal transaction still couples order and accounting
locks; these forwards do not prove the later native money/parcel isolation.
[Recovery proof](../../tests/postgres/invoicingManagedCorrection.test.ts) exercises
the real v2 adapter, rollback/reclaim, stale outcomes and browser refusal.
The shipped [pgTAP](../../supabase/tests/accounting_correction_recovery_test.sql)
adds committed-ACK loss and unchanged delivery/audit witnesses.

### M09 incumbent queue fence

M09 request rows use `available_at='infinity'` at prepare, claim and fail,
including corrections, so the incumbent queue cannot lease them. M09 also checks
request attempts/token against duty generation/token and marks drift unsupported.
Seller requests run in their own short transaction: a nonblocking per-order
advisory lock precedes the order row lock. The 100 ms lock timeout remains in
effect through duty capture and seller insertion, then the wrapper restores the
caller's timeout before returning.
The payment capture block absorbs `query_canceled` (including a client or statement
timeout arriving inside capture) so settlement/recovery can commit. Its fallback
marker insertion has its own 100 ms lock bound; host cancellation outside this
block retains PostgreSQL's ordinary behavior. Successful sweep restores the
caller's lock timeout.

The install cutover records existing settlement/handoff identities once because
these rails have no insertion timestamp and host occurrence times may arrive late.
The keyed `(source_kind,source_id)` primary-key table is filled once by the
single exactly admitted `INSERT ... SELECT ... UNION ALL ... ON CONFLICT DO NOTHING`.
No data-reading column default is admitted. Creation and seeding of this table
precede every FK-bearing invoicing table, so the history scan holds no locks on
orders or accounting tables and permits order, settlement and dispatch writes.
The subsequent FK installation still takes table locks until the install
transaction commits; schedule that shorter write pause. Sweeps use indexed `NOT EXISTS` against that set, with source/order
fault lookup and duty status/availability indexes. The automatic sweep excludes
those historical identities, whether previously
invoiced or uninvoiced, and orders with any non-void accounting document. It never
automatically backfills history. A post-install source remains collectable even
when its host occurrence timestamp predates install. Alias keys include source
kind and settlement intent (or handoff source), avoiding cross-intent key clashes.

A pre-existing limit remains: payment ingest's event readback joins
`accounting_documents`; an ACCESS EXCLUSIVE relation lock can therefore block
money readback. The new capture path removes accounting row-lock/construction
failures, not that older relation-level read dependency.

Source identities and original host keys alias one physical issue duty per order;
a correction aliases one child per parent. Facts and receipts refuse conflicting
replay. Claim locks both native request and duty in its candidate scan, persists provider identity and a
shared token/generation, and joins immutable facts. Expired or unknown creates
become readback work; only authoritative absence permits a new create. Success
settles request/document/receipt together. Late issue first persists external
identity then compensates a pending reversal atomically. Correction BEFORE facts
remain positive history while native positions carry the negative delta. No
fiscal numbering, provider transport, market policy or money writer is added.
Clearance and uncertain delivery affect document work only; unknown delivery
acceptance cannot re-enter send after lease expiry. Native delivery claims hide
claimed deliveries from the incumbent claimer with `lease_until='infinity'`,
and expired processing receipts become `uncertain` with `lease_expired`, never
eligible for repeat send. Settlement checks exact sent replay first, then refuses expired or
null leases; `failed_before_send` with `retryable:false` parks at infinity,
otherwise it backs off by a whole `retrySeconds` clamped to 60..86400 seconds
(or 900 for absent or invalid values). Source retention is a host
lifecycle obligation until capture or an explicit terminal policy receipt.

Native capture marks genuinely new base duties, including sweep capture, and
the document-effects forward marks genuinely new correction children only when
the seller request wrapper supplies `sellerPolicyVersion=invoicing.seller.v1`.
The later seller
wrappers materialize eligible seller rows; they do not make legacy work new.
The first-ever claim captures the selected host seller and revision in the same
transaction: native duty generation 1 or managed outbox attempt count 1. An
uncaptured revision remains legacy after a bare claim; a later wrapper claim
cannot freeze it. Retry preserves that
seller; new corrections have independent eligibility. A new sidecar around an
old document/request or a duty already claimed before seller freezing is legacy
and returns the execution-supplied fallback. The managed request wrapper accepts
`order_status_reversal` with the order ID, reason and nested payload, preserving
the incumbent result and effects while marking only a newly inserted correction.
For the managed `correction` branch, an unissued parent delegates to the incumbent
void path only when it is the order's latest invoice and the reason is
`order_canceled` or `order_refunded`; other parents/reasons retain scaffold
validation. New scaffold requests store `sellerRequestKey` and an original evidence snapshot
in the correction payload. Replays require the same key and evidence, excluding
`providerCreateIdentity`; conflicts raise SQLSTATE `23505`. Rows without a stored
key keep legacy replay behaviour. Native corrections always delegate to the
reversal RPC's validation and deduplication.
Issued documents and historical seller/buyer/line facts are never rewritten.

`managedInvoicingForwards` is a separate bounded admission, with three fixed
paths and ordered signature sets in the checker: new correction v2 overloads,
legacy fail-closed compatibility replacements, and new seller wrappers plus one
seller table with RLS enabled. Whole-file and function before/after hashes bind their definitions.
It preserves the donor's `SECURITY DEFINER`, `search_path = public, pg_catalog`
and EXECUTE only to service_role, with PUBLIC/anon/authenticated revokes. The
native creation class additionally admits the exact cutover seed and the
`WITH (security_invoker=true)` view form; existing managed classes are unchanged.
The managed class refuses unexpected signatures, attributes, triggers, tables,
grants or lexical forms. Native structural classification permits a new trigger
with an in-file trigger function. M09's whole-file pins exclude native triggers;
the catalog proof also verifies that these forwards add no explicit trigger
attachments to pre-existing tables.

The [registry](../../config/reviewed-platform-forwards.json) binds all seven final
fixture paths and hashes. The [catalog proof](../../tests/postgres/reviewedPortableCreation.test.ts)
applies every fixture to real PostgreSQL, preserving existing object/ACL
boundaries except the exact pinned replacements and checking native invoker
versus managed service-only attributes. Positive and refusal plants exercise
both CI and release admission. Control approval alone provides no runtime,
provider, deployment or fiscal-readiness evidence.

### P4a native store projections

`INVOICING_MIGRATIONS.native.units` projects unchanged accounting rails at
positions 7, 13 and 15 and the three pinned M09 forwards at 77, 78 and 79.
Every packaged asset is byte-identical to its canonical file. The
[M09 migration owner](#m09-invoicing-forward-design-and-control-approval) defines
installation order and prefix preservation.
The native descriptor declares child-document corrections and explicit host
fiscal facts. The separate managed descriptor names P3's base-row correction
forwards; neither descriptor claims storage or fiscal parity.

The seller-revision forwards are introduced by this change as described in the
[compatibility lifecycle](#compatibility-lifecycle). Default service activation
remains later work.

The operations package carries an unchanged projection of native forward
`20260814010000_platform_control_plane.sql` at manifest position 28. Its sparse
`OPERATIONS_MIGRATIONS` descriptor is not an install chain: install the complete
canonical native prefix, including prior job-ledger objects. Existing invoker
routines require explicit EXECUTE and underlying relation privileges, and a
current row in `platform_control_operators`. That allowlist does not grant identity
membership or domain write authority. The installed consumer proves the selected
runtime role can write controls/heartbeats while a neighboring subscription write
refuses; managed verification remains unclaimed.

The projection's whole-file SHA-256 is
`b0c8ef6424ebc6f1a84cb132c37908f4831fa40484a729c3713cfb35936559c9`.
Its existing persisted channel enum accounts for exactly one `ui-12` count.
The [neutrality owner](../../CONTRIBUTING.md#development-preview-checks) admits
only this exact package path, digest and 0-to-1 tuple with its matching baseline
key. This preserves canonical bytes without admitting other package SQL,
changing scanner patterns or raising any existing count.
