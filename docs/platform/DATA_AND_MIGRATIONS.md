# Data And Migrations

Status: maintainer page: how to change OpenLup. Reader guidance lives in the [OpenLup guide](../../packages/core/docs/guide/README.md); sections marked "Evidence" are frozen historical records.


## Data ownership

Moved to [Architecture and ownership](../../packages/core/docs/guide/concepts/architecture-and-ownership.md#data-ownership).

Native terminal replay replaces only `subscription_claim_due_renewal` while
retaining its header, ACL, frozen-input comparison and subscription-first lock
order. The subscription owner below defines the public behavior and proof.

The native `20261101223000_subscription_purchase_renewal.sql` forward records
purchase facts and renewal-attachment duties beside the existing activation
spine. Bounded definer writers avoid granting
runtime INSERT on renewal headers or method states. The new fact/event tables
explicitly revoke all table access from PUBLIC, anon, authenticated and
service_role, including access inherited from installer default grants. No table
grant or row-level-security change is added. Fixed
definer readers expose only a bounded pending-duty list and three completed
snapshot fields; the runtime never reads the method-event ledger. Their search
path is `pg_catalog, pg_temp`, and
the original activation RPC signature and commit-helper attributes are retained.
The incumbent term-line collection INSERT/DELETE grants remain unchanged.
Created functions revoke PUBLIC individually before conditional constant-string
function ACL blocks for anon, authenticated and service_role. The replaced
activation helper retains its ACL. Sandbox observation uses invoker rights
and the existing operation/outcome capabilities, without another attempt table.
The [subscription owner](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
describes the codec and retry duties.

See [retained renewal storage](https://github.com/openlup/openlup/blob/main/docs/platform/DATA_AND_MIGRATIONS.md#retained-renewal-storage).

The preview source release deliberately ships an unbound database-type seam at
`src/integrations/supabase/types.ts`; replace it with adopter-generated types
before enabling database adapters. It is not evidence of schema compatibility.

Evidence (historical record, 2026-11-13):

The native `20261101223000_subscription_purchase_renewal.sql` forward records
purchase facts and renewal-attachment duties beside the existing activation
spine. Activation commits service plus the duty; renewal header/lines/method
materialization is a separate atomic transaction. An incomplete duty remains
enumerable and does not pause service. Bounded definer writers avoid granting
runtime INSERT on renewal headers or method states. The new fact/event tables
explicitly revoke all table access from PUBLIC, anon, authenticated and
service_role, including access inherited from installer default grants. No table
grant or row-level-security change is added. Fixed
definer readers expose only a bounded pending-duty list and three completed
snapshot fields; the runtime never reads the method-event ledger. Their search
path is `pg_catalog, pg_temp`, and
the original activation RPC signature and commit-helper attributes are retained.
The incumbent term-line collection INSERT/DELETE grants remain unchanged.
Created functions revoke PUBLIC individually before conditional constant-string
function ACL blocks for anon, authenticated and service_role. The replaced
activation helper retains its ACL. Method transitions compare expected health and persist event evidence without
rewriting subscription service state. Sandbox observation uses invoker rights
and the existing operation/outcome capabilities, without another attempt table.
The [subscription owner](https://github.com/openlup/openlup/blob/main/docs/platform/ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
describes the codec and retry duties. The forward's approval inventory is
admitted with it under ordinary review;
local PostgreSQL proof does not establish that admission or a published chain.

## Retained renewal storage

The subscription-notice forward preserves the reminder ledger's renewal-day
identity and stores new queued charge facts in `subscription_reminder_ledger.renewal_at`;
subscription events supply only the legacy fallback. New pause reminders and
at-risk identities use the existing typed outbox, separate from customer command
keys, under the dedicated `subscription_notice` aggregate. Pause reminders retain pause-window UUID identity; at-risk caps count
accepted receipts and disabled outcomes across the outbox and typed legacy events.
At-risk scan days are elapsed 24-hour periods, including across session daylight-saving transitions.
The immutable outbox keys retain cause/day history after terminal payload compaction.
Resolved-pause markers use the same isolated carrier and are not deliverable kinds.
Legacy notice IDs and their delivery keys stay unchanged. Base `pause_ending`
ledger rows own their subscription/UTC end-day bucket, so a matching window
does not create another outbox identity. An unsent legacy row resolves its open
window by that same day at delivery; no match durably skips the reminder.
Operator notification rows bind a
separate critical-recipient FK; customer references retain their client FK.
Recipient-aware uniqueness admits multiple operators without colliding with the
customer notice. Existing rows default to dispatch-ineligible operator history;
only newly produced operator rows become eligible. First-attempt time bounds
ambiguous retries, and durable acceptance repair precedes horizon failure.
Operator controls need no seeded rows: absence enables a notice, and the existing
setter upserts explicit choices. Configured controls or notification recipients
remain outside the current connected-store transfer profile and refuse capture;
this existing limitation is not changed by the notice suffix.
The installed at-risk implementation retains its owner-only EXECUTE ACL. Runtime
reads use the service-only `dunning_lifecycle_scan_at_risk_service(integer,integer,integer)`
STABLE definer, pinned to `pg_catalog, pg_temp`, which delegates to that implementation.
No existing function ACL or table privilege is widened by this entry.

The package-editor forward adds an opaque nullable object constraint on
`subscriptions` and the owner-only, RLS-enabled `subscription_quote_previews`
ledger. Service-only definers record, take and accept a preview and apply future
package terms; browser roles have no execution or table access. The eight new
functions leave existing command routines unchanged. An accepted preview retains
its request, quote, totals, command key and subscription-event reference. The
accepted event also carries complete renewal `linePricing`; no per-line agreement
column or existing cycle/operation snapshot is rewritten.

Quote previews are classified `retain` for client absorption: a preview exists
only for a subscription its client owns, and subscriptions already block
absorption, so absorption never reads the owner-only preview table and refuses
through the subscription instead. Connected native-store capture owns
these rows, and restore inserts them after clients, subscriptions and subscription
events. Preview pruning retains accepted history and deletes at most 500
unaccepted rows expired more than seven days before the request time. The minimum
base-unit setting is supplied by the host installation, never seeded by this
forward. The [subscription contract](ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
owns quote composition, no-op ordering and renewal behavior. SQL installation
still requires its separate reviewed forward admission; source presence alone
is not an admitted or published installation chain.

The subsequent `20261109130000_subscription_exact_levers.sql` forward creates
only `subscription_line_edit_apply(uuid,uuid,text,uuid,text,jsonb,timestamptz)`.
It reuses the preview ledger and receipts, adds no table, column, data statement
or replacement function, pins `pg_catalog, pg_temp`, revokes PUBLIC/browser
execution and grants execution only to `service_role`. Its seven actions retain
their separate no-op and line-identity semantics. Portion acceptance binds the
configured mode/factor pair to the preview and refuses a mismatched selection.
Base mix independently checks
its fixed total; plan and portion edits replace only base rows and preserve
add-on IDs. Every real edit rewrites future renewal term lines and stores full
accepted pricing in its action event, then accepts the preview and records the
receipt atomically. Existing cycles, arrivals and frozen renewal snapshots are
not rewritten. The current selected installation plans append one unit after
the shared editor, with measured current inventories; issued prefixes remain
unchanged. See the [subscription contract](ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
for host sizing configuration and API limits.


The account-choice forward also creates the service-only
`subscription_register_renewal_purchase_with_shipping(uuid,jsonb)` and STABLE
`subscription_renewal_purchase_terms(uuid)` definers. Both pin `pg_catalog,
pg_temp`, revoke PUBLIC before conditional role ACL blocks and add no table
privileges. Registration seals optional full retained delivery/acquisition terms
in the existing purchase attachment, fixes its acquisition basis version on the
server, and compares the authorization instant with UTC microsecond identity.
The old zero-only registration and its completer remain unchanged. A completed
attachment reader exposes the retained terms; no current-settings read or
additional agreement table is introduced. Graduation uses existing subscription,
line-collection and event privileges inside the host transaction. Retained order
preparation uses existing item INSERT/DELETE and shipping-adjustment INSERT
privileges, with the existing deferred line-sum guard. The subscription owner
above defines those transaction and frozen-replay obligations.

The same forward adds the three explicitly classified absorption-policy rows for
stock waits, privacy erasures and subscription command receipts. The absorber
still refuses an unclassified client-referencing table. Classification and access
to any other earlier-row table remain that table's integration responsibility;
the forward neither widens table grants nor changes the absorber.
For a new block-classified table, the [absorption census slot shape](#closed-native-store-forwards)
provides the existing absorber with client-column access while keeping personal
payloads unreadable. Its classification and access belong to that table's forward.

## Customer account event data

The forward `20261110120000_customer_account_events.sql` creates
`customer_account_events`: UUID identity, client FK with DELETE CASCADE, event and
entity type/ID, JSON payload, occurred/created timestamps and the client/occurred
index. RLS is enabled. The service runtime receives only the client-column census
grant/policy plus EXECUTE on owned append, latest-20 metadata history, profile
update and correction-request routines. The table is explicitly block-classified
for lead absorption; a history-free lead can still absorb and replay.

Profile writes precede a separate event append; failures can leave an updated
profile without a replay event. A recorded key returns current profile state
without another write/event. Correction keys are stored without deduplication,
and ownership is through the invoice document's order. Invoice bytes and fiscal
state are unchanged. The [package recipe](../../packages/platform/README.md#customer-account-events-and-mutations)
owns validation policy and handler composition.

Payloads and client/document/key links are personal data, including free-text
reason/note/requested fields and submitted names/phone. The explicit identity
contributor requires a privileged subject reader and retain/unresolved owner
policy. Export reports unavailable coverage; unresolved disposition refuses
erasure. Retention preserves payloads and is recorded in the receipt. Existing
identity client-field clearing does not cover this table, and no automatic
retention period or deletion is supplied.

Finite connected-store transfer classifies this as an owned table and carries its
exact PostgreSQL row text, like `customer_communication_preference_events`:
both are customer-owned personal-data histories with JSON payloads. Restore inserts
account events after their client parents; populated-ledger witnesses check exact
rows on a pristine qualified target and a replay that leaves rows unchanged. This extends
the finite capture/restore inventory only; the smaller compatible-row utility's
allowlist remains unchanged. No schema/control/credential transfer or target
activation is authorized by these rows. Saved-address coverage is described below; billing tables remain
separate changes. The account migration descriptor is sparse; install the entire
selected native catalogue rather than just its two exported units.

## Saved customer address rows

`20261110190000_customer_saved_addresses.sql` adds private
`customer_saved_addresses`, exact-kind default uniqueness, a nonunique canonical
lookup index and nullable saved shipping/billing pointers on subscriptions.
Pointers use ON DELETE SET NULL; the customer delete routine refuses use by an
active or paused subscription. Selection commands are separate. Ten owned
routines cover customer reads/replay/canonical lookup/default clear/write/delete,
usage checks and subject export/erasure preparation. No existing function is replaced.

Runtime customer access is through principal/client-owned DEFINER routines with
fixed search paths and EXECUTE only for `service_role`; PUBLIC, anon and
authenticated have no table or routine access. The table is `block` classified
for lead absorption, with only the admitted client-ID census column/policy.
Saved address and event writes retain their separate-commit failure/replay rules;
see the [package recipe](../../packages/platform/README.md#saved-customer-address-book).

All row content, including canonical keys, company/tax/contact/free text,
last-use/source metadata and possible pickup history, is personal data. The
explicit saved-address privacy contributor exports all columns and erases saved
rows without relying on client clearing or cascade. Its preparation lock precedes
identity row locks; mutators recheck ownership after acquiring their DML lock, so
a waiting save cannot recreate saved rows after unlinking. Identity/subscription vetoes
and the account-event retention contributor remain separate required owners;
retained event payloads and immutable destination snapshots are not erased by
this contributor. There is no default retention period.

Finite connected transfer explicitly carries the exact classified rows, following
the account-event ledger and private parcel-contact ownership pattern. Restore
inserts addresses after clients and before subscriptions; populated-row/pointer
and replay witnesses check the result. The smaller compatible-row copier does
not admit this table. No trigger applies defaults during import, and no target
activation or credential transfer follows.

## Partner acquisition data

Partners owns the `partner_inquiry` slice of `acquisition_private.cases`, its
contacts and `partner_details`, shared command receipts, audit actor references
and keyed fingerprints. The four issued partner lifecycle/validation/locale
units already belong to each source installation plan. The R1 package adapter
calls `partner_acquisition_submit_v1`, `partner_acquisition_operator_list_v1`
and `partner_acquisition_transition_v1`; it introduces no forward, grant,
object, installation rail or SQL carrier. Install the complete selected source
catalogue through the existing runner. The sparse npm SQL assets are not a
complete partner catalogue; npm installation alone does not establish readiness.
The [installed witness](../../tests/postgres/partnerAcquisition.test.ts) executes
the current full native catalogue with a separate non-superuser login assuming
`platform_acquisition_runtime`. Its actor UUID checks do not establish host
administrator membership or hosted/other-rail behavioral qualification.

Contact email/phone, organization/name/notes, case references and original
command result projections can contain personal data. Audit retains actor and
case references; fingerprints remain protected linked evidence. Partner
export/erasure coverage is unavailable; the existing
marketing contributor must not be claimed complete for partner resources.
Do not rewrite append-only command or audit evidence. The private installation
key is secret material, never a subject-export resource. Partners must supply an
explicit resource disposition before broader privacy coverage can be claimed.
The existing transfer admission refuses nonempty acquisition business state;
this package contribution adds no supported partner transfer or erasure path.
An adopter continuing with its own existing SQL keeps those objects; consuming
this adapter does not authorize applying public migrations to that database.

## Connection roles

Moved to [Connect to PostgreSQL](../../packages/core/docs/guide/how-to/operate/connect-postgresql.md#assign-connections-by-work).

Connection composition must preserve the selected installation's principal/grant
contract; transport separation grants no runtime DDL or migrator isolation.
The qualified-v2 profile requires its declared privileged migration principal.
Qualified-admin provisioning and role-graph admission belong to
[module catalogues and installed histories](#module-catalogues-and-installed-histories).

Evidence (historical record, 2026-11-13):

The [production composition witness](../../tests/postgres/m14QualifiedComposition.test.ts)
installs/replays every selected unit through the direct endpoint, then exercises
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
Managed Storage remains empty in this journey. The separate
[managed Storage witness](../../tests/postgres/managedStorageTransfer.proof.ts)
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
patched or deleted to simulate catch-up. The [transfer architecture](ARCHITECTURE_AND_EXTENSIONS.md#existing-store-transfer-and-recovery)
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
The [notice witness](../../tests/postgres/m19NoticeIsolation.test.ts) compares all
four row sets after real connected capture/restore and repeats the restore.

Connected native restore refuses any subscription whose `configured_offer_version`
is not `classic` with `unsupported_table` for `subscriptions` before any target
data write; sized offer bindings have no transfer mapping in this preview.

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
whole-file approval historically landed separately before this SQL introduction. The two
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

## Human OMS admission

`20261110160000_oms_human_operator_admission.sql` replaces only
`oms_control_resolve_operator(uuid)`. Its SQL STABLE invoker header,
`search_path = pg_catalog`, owner and ACL remain unchanged. An existing Commerce
operator resolves through the unchanged active-control route, or through active
human `admin` membership with no control row of any state. A distributor or
revoked member does not enter the human route. No INSERT, provisioning, lock,
DEFINER or grant is added. Hosts authenticate the principal, require human admin
for hold/release and resolve before every invocation and replay.

The owner provisions each human admin's Commerce row and never deletes it:
revoke membership to withdraw access. The existing ON DELETE SET NULL on
`commerce_order_holds.created_by` would otherwise make that operator's
fulfillment-exception holds look system-created and eligible for automatic
release. This forward preserves that FK; see the [owner step](../../examples/neutral-store/README.md#commerce-operator-roster-for-hold-and-release-admission).
The starter binds hold and release with a fresh human-admin and Commerce-operator check on every command and replay.

## Additive forward release path

Moved to [Upgrade the database](../../packages/core/docs/guide/upgrade/database-migrations.md#follow-the-additive-forward-path).

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

Moved to [Upgrade the database](../../packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue).

The generated `packages/platform/sql/manifest.json` projects canonical paths,
hashes, ordering and inventory pins from `config/platform-migration-manifest.json`.
The installed-consumer gate refuses projection drift. Keep this a projection of
the canonical source; packaging issued units changes no SQL or managed rail.

The package runner admits the migration ledger only when its system-catalog
shape matches the canonical baseline ledger: a permanent heap table with the
expected owner, columns, defaults, constraints and indexes, without partition
or inheritance links, triggers, rules, row policies or extended statistics.
The fingerprint stays exact except for numeric `pg_attver` column version markers in a nonempty, one-dimensional array starting at index 1; every other attribute option refuses admission.
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

Managed risk keeps
its existing frozen baseline functions, grants and RLS. Native risk uses invoker
functions and host-provisioned permissions, with no production role/grant model
introduced by the post-order control unit. The [risk contract](ARCHITECTURE_AND_EXTENSIONS.md#risk-contracts)
records the intentional differences preserved by the contribution.


Existing native and managed migration bytes remain unchanged.

Reader guidance: [Subscription delivery alignment](../../packages/core/docs/guide/concepts/subscriptions.md#subscription-delivery-alignment).

`public.subscription_delivery_alignment_control.mode` defaults to `off`.
The complete mode set is `off`, `shadow`, `protect` and `auto_align`, selected
through `public.subscription_delivery_alignment_set_mode`.

The SQL admission control is `subscription_delivery_alignment_admit_renewal`;
the new-cycle insertion guard uses `subscription_delivery_alignment_admission_required`.
The [native renewal store](../../server/adapters/postgres/subscription/automaticRenewal.ts)
owns the static terms gate; the
[admission decorator](../../server/runtime/subscription/deliveryAlignmentRenewalStore.ts)
owns delivery admission. The supplied boundary stops at the decorator, with no
runner composer, factory or production entrypoint.

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

Provider-exception notification rules remain with fulfillment.

The new-cycle INSERT guard owns admission receipt consumption.

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

The direct truth store behind `paymentSchemaDescriptor` retains its invoker SQL
and requires the host's existing executor and privileges.

The source preview's additive sandbox-attempt forward
`20261101222000_sandbox_payment_attempts.sql` adds two private tables and four
bounded runtime routines. `payment_simulator_attempts` owns active dispatch,
replay/fingerprint and synthetic method facts; `payment_simulator_observations`
owns immutable simulated outcomes. The runtime has function execution only,
with no direct access to either table. The forward explicitly revokes all table
privileges from PUBLIC, anon, authenticated and service_role, removing
creation-time default grants to those recipients; it does not enable RLS.
This simulator forward alone supplies no real provider storage. Install the
complete selected chain, including its exact inventory; this forward alone is
not an installer. Earlier migration bytes and approvals stay unchanged.

The same forward adds `payment_truth_events.review_required_at` and a new
consistency CHECK, preserving every existing CHECK and the `open|settled` state
vocabulary. Existing OMS captured-truth visibility is preserved.
`commerce_record_settlement` and its later-only schedule rule remain unchanged.

The appended `20261114100000_payment_provider_attempt_store.sql` adds private
provider lifecycle, attempt, immutable ingress, replay receipt and transition
relations. Its service functions implement explicit intent admission, durable
preparation, same-row acknowledgement and exact-attempt result application.
Preparation commits before provider execution; ingress commits before application.
An unresolved attempt or exact durable success fences another dispatch. Aggregate
locks precede payment children, including the existing settlement and truth
entry points. Financial effects and dunning recovery retain their existing owners.
All five new tables have RLS and no runtime table privileges; service-role
execution uses pinned function paths. Capture and restore carry their rows and
restore the active-attempt pointer after its referenced attempt.

For a provider subscription-cycle failure with recorded renewal correlation,
application first calls `subscription_retry_apply_failure` under
`<apply-key>:truth`. Its immutable failure receipt binds the provider attempt,
payment, cycle, sequence, classification and observation times to the resulting
rung and schedule. Truth reuses `<apply-key>:truth:settlement`, or the original
renewal outcome's settlement transition when that same original attempt was
already refused under another key; it does not open
the generic dunning case on this path. The cycle remains `payment_pending`, and
the retry obligation owns scheduling. At this stage no provider dunning case,
notice or token handoff is composed. Attributed dunning and a real provider
renewal binding require later composition; the starter still binds sandbox
renewals only. Other truth routes and sandbox failure handoff are unchanged.
The service-only `payment_provider_retry_failure_recorded` lookup returns only
whether the intent, receipt key and exact attempt match that recorded context.
It keeps invoker truth routes from reading private provider tables directly;
browser roles retain neither lookup execution nor raw-table access.

If pause wins after local renewal preparation and before provider preparation,
not-chargeable cleanup uses the renewal outcome owner to release committed
renewal stock, and the purchase-reservation owner to release order holds.
Initial payment expiry compensates the provisional activation through checkout
compensation before expiring the order. An automatic initial-checkout sweep
that wins cancellation also terminalizes its provider lifecycle and settlement
intent; waiting preparation refuses before creating an attempt. Preparation
that wins first fences the sweep through its committed attempt.

| Historical data | Result and manual path |
| --- | --- |
| Native intent without a recorded provider lifecycle or attempt | No automatic backfill or inferred payment identity. Inspect the provider object and admit complete authority explicitly before preparing a fresh attempt. |
| Unlinked or superseded event | Ingress remains durable; application returns `payment_control_result_attempt_unresolved` or `payment_control_result_attempt_mismatch`, with no business effects. Resolve attribution through operator recovery. |
| Prepared attempt with no provider handle | Keep the attempt in flight. Missing local handles do not prove provider absence or authorize redispatch. |
| Settled intent without provider correlation | Preserve settlement and historical evidence. No synthetic provider history is created. |
| Recorded provider renewal operation without logical-cycle or exact prepared-attempt correlation | Refuse application without financial or retry effects. Resolve the missing correlation explicitly; native counters and the current active pointer cannot reconstruct it. |
| Method health without a recorded provider reference | Health supplies no charging authority. Record provider method authority through the selected method store before execution. |

Only `paymentSchemaDescriptor.preparedDurableStore` is enabled by this forward.
Method setup, absence reopening and cumulative refund remain separate capabilities;
absence auto-reopen stays off. A refund never pauses or cancels a subscription.
The [native witnesses](../../tests/postgres/paymentProviderStore.test.ts) and
[pgTAP twins](../../tests/postgres/paymentProviderStorePgtap.test.ts) exercise the
installed store without contacting a payment provider.

List payments awaiting operator review:

```sql
SELECT e.id AS payment_truth_event_id,
       i.order_id,
       o.status AS order_status,
       e.amount_minor,
       e.currency_code,
       e.source_event_id,
       e.review_required_at
FROM public.payment_truth_events AS e
JOIN public.commerce_settlement_intents AS i ON i.id = e.settlement_intent_id
JOIN public.commerce_orders AS o ON o.id = i.order_id
WHERE e.review_required_at IS NOT NULL
ORDER BY e.review_required_at, e.id;
```

Run this read-only query through the host's authorized native PostgreSQL session;
amounts are in minor currency units. It discovers review-marked events without
already knowing their IDs and excludes ordinary open events. Use the returned
`payment_truth_event_id` with the truth port's `readEvent` for effect details.
The query records no decision and creates no refund or order transition.

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
Install the full canonical chain, not these two files alone. The native read
store performs reads only; the packaged native writer calls the existing
canonical write routines without changing them.
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

The direct human-login forward's normalized-email
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

The explicit `qualified-admin` selection starts with a different issued 91-unit prefix:
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

Evidence (historical record, 2026-11-13):

Risk's Node-only `RISK_MIGRATIONS` descriptor projects the unchanged
`20260813230000_post_order_control.sql` catalogue unit, including its co-located
return/control objects. The package asset preserves the canonical SHA-256
`f24ff3ee3c1022f73162db03b8900c93614d3d6d4c6375cf4aad8a3c0f3360a7`.
It adds no installation-chain file, managed forward or reviewed-forward class.

Fulfillment appends native command and alignment units,
`20261022080000_fulfillment_command_ledger.sql` and
`20261022090000_fulfillment_delivery_alignment.sql`, after the shipping seed.
`FULFILLMENT_MIGRATIONS` projects units 5, 27, 51, 73, 74 and 76 with canonical identities and byte-identical package assets.

Payments publishes `PAYMENT_MIGRATIONS` as byte-identical projections of canonical
positions 10 (settlement), 35 (truth/reconciliation) and 56 (later-only cycle).
Each retains its canonical path, SHA-256 and package asset URL.

The direct human-login forward `20261018180000_identity_operator_challenges`
appends position 68 after invitations. Preserve every preceding file, digest and
position. The identity projection carries the same bytes and canonical position;
never install the sparse projection as a complete catalogue.

At the 27 October E2 89-unit proof-source checkpoint, the eight-case witness
specified four fixed-pin references and four fresh targets through the real
binding and built package executor. One healthy target supplied the inventory,
unsafe-session and shadow-symbol discriminators before recovering to the same
ledger; that source was still awaiting the receiving-machine run at this
checkpoint. The linked test later evolved to the four-profile 91-unit
runtime-completion witness; its dated result appears in the
[M14 runtime-completion record](https://github.com/openlup/openlup/blob/535349050419abe5122bd74fa6766c58947be3dd/docs/platform/plans/oss-m14-operations-portability.md#runtime-completion-28-october-2026).

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

The fixed `qualifiedInstallations` class requires exact whole-file approval
for four bootstrap units, an optional retained-import unit, the runtime
completion tail and the owner-path forward. Position 17
approves the shared lock and conflict completion tail described under
[Compatibility lifecycle](#compatibility-lifecycle); its active SQL is
byte-identical to that approval. Even expand-only
qualified SQL may land with its approval pins. Simultaneous machinery changes,
later repins, unknown paths and edits to issued files refuse. Trusted queue admission applies this guard to qualified SQL
changes even when their prior approval pins are unchanged. The
[inert fixtures](../../scripts/fixtures/reviewed-m14-qualified/db/platform/migrations/README.md)
retain seven exact bound units, including the
[runtime completion](../../db/platform/migrations/q2_20261028100000_runtime_capability_completion.sql)
selected before the owner-path forward. Reader preparation landed before the
sixth approval row, and that approval landed before this SQL introduction.
These are historical checkpoints, not an ordering requirement for future features.
The [restricted-bootstrap task](plans/oss-m14-restricted-bootstrap.md) has
five fixed approvals at positions 8–12. Those `qa_` fixtures remain inert
except for the selected baseline. A PostgreSQL parse failure in the approved
actor unit led to four corrected `qb_` identities at positions 13–16, after a
separate reader and approval checkpoint. The issued 91-unit restricted
prefix selects the `qa_` baseline and four
`qb_` replacements, reuses the issued completion tail, and excludes the
qualified owner-path forward. That prefix has two fixed role-mode inventories.
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
positions. Its approval binds the exact file and nine function preimages
and definitions. The active forward pins name resolution on those definitions;
the issued qualified prefix has 92 units. Earlier qualified units and their approvals
remain immutable.

Historically, delivery used three separately landed checkpoints: reader support,
then an exact pin-only approval, then the identical active SQL and its selected
manifest row. The current rule below permits class data, pins and SQL together
when main's validator already supports that capability.

The issued schema-2 manifest preserved legacy 88 units and the qualified
91-unit prefix, then appended the exact owner-path forward as unit 92. Its two
restore-bound inventories were measured independently on clean PostgreSQL16
references with migration/bootstrap aliased and distinct. The historical F90
expectations and raw evidence remain retained; reference measurements do not
establish production status/apply/replay or normal-runtime qualification. The
existing four-case production-composition witness checks both issued shapes in
the two existing role modes, then applies every current shared suffix unit through
the same runner and verifies the complete selected ledger and final inventory.
Restricted composition preserves its independent issued-prefix pin the same way;
current total and resume counts come from the selected plan. It also exercises the actual normal-runtime preparation lane
and review receipt commands, with receipt mutation, context key and neighboring
privilege refusals. Historical E-only 89-unit expectations retain their attribution.
There is no optional `withRestoreForward` field or new selection mode.
Prior source approval establishes no installation, managed-host, publication or
activation evidence.

SQL, its exact approval pins and any class data land together in the feature
pull request. CI runs its tests. Issued approvals and slots are immutable,
including their content and
positions; sealed native classes retain their existing slot prefix as described below. Shared fields, the registry schema and
immutable baselines stay unchanged. Fixed path/signature inventories, whole-file
and function hashes, preimages, statement/grant limits, ordered prefixes and
fixture/package equality still apply. A hash binds bytes; review follows the
[existing review procedure](../../CONTRIBUTING.md#native-review-and-accountability).
Applicable maintainer/delegate reads remain required.

A new validator capability lands first as its own change. Admission runs main's
validator against the candidate's own co-located change and refuses machinery
changes in that change. A change that adds SQL cannot change the validator, the
migration manifest checker, CI workflows, review or release tooling, or the test
harness. Production tooling in `scripts/agent-review-*`, `scripts/oss-*`,
`scripts/source-*` and `scripts/packages/` stays unchanged for this route, including
release entry points and preparation; test-only coverage changes remain allowed,
except the catalog test of the [closed native store forwards](#closed-native-store-forwards)
and the named files that select and run it, which that section lists.
The checker and its direct dependency closure, root manifests/lockfile and
`.github/` files also stay unchanged. Machinery changes on main since the
candidate's base do not trigger this veto. Admission reads candidate Git objects
without running candidate code.
The [documented workflow invocation limitation](DEVELOPMENT_AND_RELEASE.md#reading-results-and-recovering)
remains: candidate YAML can omit the job, so sensitive review and the applicable
maintainer/delegate read of workflow edits remain the control for that case.

Release binds each forward to its unique first-parent mainline introduction.
Its pin may first appear with the SQL and class data in that introduction
and must remain unchanged afterwards; a later
repin cannot legalize an earlier invalid installation. Unchanged means content,
list and the order of earlier entries, not the array index: approvals new at the
release head may precede the ones that introduction added, as a landing merge
places them, while earlier entries whose SQL landed before it keep content and
index. The same rule reads mainline history; for append-only order on main,
release relies on the strict registry reader's per-index identities and on
`assertNativeStoreClassTransition` in the merge queue. Existing separate
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
Reordered, extra or unknown historical inventories refuse. An approval added
with its SQL at introduction can authorize that SQL.

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
Review follows the [native review procedure](../../CONTRIBUTING.md#native-review-and-accountability).

### M10-9 attempt replay control fixtures

Evidence: historical record, 2026-11-13. Not reader guidance.

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

**Named bounded debt C94 — reviewed SQL vocabulary.** The frozen managed
SQL retains provider nouns inherited from that rail. The neutrality baseline
records the scanner's exact counts for the six existing managed fixtures and the
registry's pinned refund COMMENT: dunning continuity (`ui-13`: 2, `ui-14`: 3),
ATP (`ui-15`: 3), stock wait (`ui-15`: 6), allocator (`ui-15`: 2), refund evidence
and refund parity (each `ui-13`: 7), and the registry (`ui-13`: 1).
Each landing PR (P3b, P5, F17) adds only its own rail keys together with the files,
using these exact pinned counts per category. Any present baseline key for an
allowance path must contain exactly its pinned category counts, including during
regeneration; adding a key without the file refuses. The N6 native payment
slots 42–44 and their package mirrors retain the two reference payment adapters'
names in three ported predicates: inline-flow admission, historical channel
routing and a refund-amount rule. Each row adds only its own whole-file SHA-256
pins, exact counts and baseline keys with its files. R1's attempt-store slot and
mirror each pin `ui-13` 0→4 and `ui-14` 0→3. Its unchanged characterization fixture,
`tests/postgres/fixtures/paymentProvider/durability.sql`, pins `ui-13` 0→6 and
`ui-14` 0→1 with its own whole-file digest and baseline key. This fixture keeps
the same names until the provider-profile refactor removes them together with
the predicates; a third provider needs that refactor. Every other test or
fixture path remains refused by this extension. No other native
or package SQL path is admitted beyond these six paths and the existing
operations compatibility carrier; TypeScript and documentation remain outside
this allowance. This is vocabulary debt, not provider activation or portable-contract parity;
future neutral replacements must lower it. The [neutrality owner](../../CONTRIBUTING.md#package-policy-and-release-checks)
owns the ratchet. Its `reviewedPinnedIntroductions` allowance is a closed list of
17 paths and 22 tuples: six managed fixture/rail pairs and the registry
(13 paths/15 tuples), the operations package SQL carrier (one path/tuple), and
R1's native slot, mirror and characterization witness (three paths/six tuples).
Each SQL pin requires the complete file's SHA-256
and exact category and before/after counts, on any base. The registry instead
pins the exact refund COMMENT text because later approvals edit unrelated
registry data; extra counted vocabulary still refuses. The allowance filters
measured-base increases and parent-baseline raises, including regeneration;
candidate counts must still fit the baseline. Changed bytes, another path even
with the same digest, another category or count, and unrelated increases refuse.
Other native or package SQL paths, TypeScript and documentation cannot enter this list.
Adding any further entry is a control change reviewed under the
[native review floors](../../CONTRIBUTING.md#native-review-and-accountability). The six rail-path entries can be retired after
the F17 PR lands and the base carries the counts.

Historically, the managed runtime capability forward shipped after a separate
control approval. It changes no baseline bytes or function signature. Required service
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
The stock-evidence slot admits only
`public.fulfillment_record_stock_evidence(text,text,text,text,text,text,integer,integer)`:
matching-fingerprint replay reopens evidence and refreshes severity, quantities
and last-seen time, clearing resolution time; a fingerprint mismatch still
refuses with `23505`. An optional fourth slot fixes
the portable file `20261030110000_customer_newsletter_withdrawal.sql` to
`public.customer_communication_preferences_set_as_actor(boolean,timestamptz)`.
The preceding one-, two- and three-slot registries remain readable. Boolean
identity and this setter's `timestamptz DEFAULT now()` are parsed only for that
signature; hashes still bind the raw definition. This admission change adds no
SQL or registry pin. Prior definitions come only
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

### Closed native store forwards

`nativeStoreForwardClass` in the [reviewed registry](../../config/reviewed-platform-forwards.json)
owns exact native paths and row names supplied by its slots, and three closed function lists:
replaced functions with before-hashes, created functions with pinned search
paths, and grant-only existing functions with closed role/verb capabilities.
Only firm rows
are registered; an absent row authorizes nothing. Additional unissued inventory
may land with its SQL under the existing validator and applicable maintainer read. Set `sealed: true` in the store's
set-version preparation (S1). A sealed class stays sealed: its complete old slots
array, including unissued reservations, must remain a canonical content-equal
prefix of every later array. Only appends are allowed; editing, deleting or
inserting among those slots refuses. Issued bindings and their slots retain their content and array positions, even
while the class is unsealed. There is no slot-count maximum or second class key.
The production class is sealed from the 0.39.0 set preparation; later slots only
append after its existing slots.
Slot timestamps come from their paths and strictly increase in array order. A
new slot's time must exceed every dated migration in its introduction base,
including qualified identities; later migrations do not invalidate issued slots.
The [admission witness](../../scripts/reviewed-native-store-forward.test.ts)
uses an independent synthetic registry, never production placeholder approvals.

Feature SQL supplies `nativeStoreForwards` with whole-file and function
after-hashes. Its pull request may include class data but cannot change admission
machinery.
Every earlier slot in registry order needs unchanged landed pins;
issued native file pins must also be present unchanged.
Registry-derived slot timestamps require approval even for expand-only SQL.
The queue routes every native filename at or after the first issued slot time
through the guard, including SQL whose slot was prepared earlier. The guard
still admits ordinary unregistered expand-only migrations through their existing path. Unlisted function
signatures, drifted preimages, destructive statements, default privileges and
role statements refuse. Tables and indexes retain the existing expand-only
rules; data statements require exact head-class slot entries. CHECK and UNIQUE
replacements use the named, closed entries below. A whole-file hash does not
bypass the content checks.

`absorptionCensusTables` may list qualified `public.<table>` names with unquoted
lowercase ASCII identifiers for new
client-referencing block tables. Each listed table must be created earlier in
the same slot file. Its own `dataStatements`
must pin exactly one statement of this form, also present in the forward:

```sql
INSERT INTO public.client_absorption_policy (table_name, disposition, note) VALUES ('example_history', 'block', 'Customer history prevents absorption.');
```

For each table, exactly these two additional statements are admitted, each in
the existing constant `service_role` conditional shell:

```sql
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'GRANT SELECT (client_id) ON TABLE public.example_history TO service_role;'; END IF; END; $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN EXECUTE 'CREATE POLICY example_history_absorption_census ON public.example_history FOR SELECT TO service_role USING (true);'; END IF; END; $$;
```

The fixed policy name is `<table>_absorption_census` and must fit PostgreSQL's
63-byte identifier limit. Missing or duplicate statements, unlisted or
earlier-slot tables, other columns, roles, verbs, policy expressions or names,
WITH CHECK, non-block or missing classification, and statements outside the
conditional shell refuse. This capability grants no payload access and does
not change the fixed notice-table INSERT/SELECT exception.
The census validator checks only the slot's own statements and registry entry;
it adds neither a foreign-key parser nor a scan of earlier prefix history.
Installed foreign keys and effective privileges are PostgreSQL obligations.

Every new relation with a foreign key to `public.clients` must have an
absorption-policy row keyed by its raw `pg_class.relname` after its slot, with any
existing disposition. Quoted regclass display text is not a classification key. An
unclassified table refuses, because it would make the absorber refuse every
lead. This classification check does not grant access: unlisted `block` and
`retain` tables retain owner-only table ACLs and no column ACLs. Only listed
census tables receive the exact census privilege exception.

The [PostgreSQL catalogue witness](../../tests/postgres/nativeStoreForwardCatalog.test.ts)
independently requires a new relation, migration ownership, enabled RLS,
owner-only table ACL, exactly `client_id` SELECT for `service_role`, and exactly
the named permissive SELECT policy with `true` and no check. With that role
absent there are no column grants or policies. Its single-column `client_id`
foreign key to `public.clients(id)` and stored `block` classification are checked
in PostgreSQL as well. Every other new
relation retains the existing ACL refusals. The [absorber witness](../../tests/postgres/qualifiedRuntimeLockCompletion.test.ts)
proves block, successful absorption and replay on legacy and both qualified
installations, with payload reads and writes denied on the restricted runtimes.

An explicitly listed replacement may chain to the exact creation pin of an
earlier reviewed native-store slot, or to the immediately preceding replacement
pin. Its before-hash must equal that predecessor's after-hash. An unbound
predecessor refuses. The actual latest definition in the complete ordered prefix
must also match that before-hash; a first replacement without an earlier class
creation or replacement still binds the pre-class definition. Replacement headers
and search_path stay identical to that preimage apart from CREATE OR REPLACE, and
the PostgreSQL catalog preserves owner and ACL. Issued contents, positions and the sealed-prefix rule stay fixed.

The class-local identity reader normalizes scalar aliases, schema-qualified composite/table arguments and
arrays against exact listed signatures; earlier identity readers stay unchanged.
Token separators and case folding for closed object/type identities follow ASCII
SQL spelling; Unicode whitespace lookalikes cannot become listed identifiers or
roles. Unicode literal data remains allowed.
Argument separation respects quoted defaults, dollar literals and nested
parentheses/arrays before matching the listed types. Case-varied `OR REPLACE`
remains replacement syntax and cannot create an entry reserved for plain CREATE.
Native files opt into ASCII structural checking in the existing splitter;
older splitter modes retain their behavior. Literal, comment and dollar-body
data can contain Unicode. Conditional privilege syntax and targets use ASCII.
A backslash inside a quoted literal or identifier of the bound file refuses: the
splitter would read it as an escape, while PostgreSQL ends a standard literal at
the quote after it, so one statement for the splitter would be several for the
database. A backslash inside a dollar body is data, and the earlier files of the
prefix keep the older reading.
Adding columns or new CHECKs to an existing table retains the expand-only path.
A new table may declare foreign-key `ON DELETE CASCADE` or `ON DELETE SET NULL` actions; only those actions are masked before the default expand-only check, with all other expression and statement refusals retained.
Any slot may also list exact complete ALTER TABLE texts in
`existingTableStatements`. PostgreSQL checks target existence when applying the
plain ALTER TABLE; IF EXISTS is refused. The closed actions are ADD COLUMN, named ADD CONSTRAINT
under the existing expression checks, ALTER COLUMN DROP NOT NULL, and VALIDATE
CONSTRAINT. The restricted FOREIGN KEY ... ON DELETE RESTRICT NOT VALID form
preserves the issued purchase-reservation companions. A listed named single-column
FOREIGN KEY may also use ON DELETE SET NULL or CASCADE, with optional NOT VALID,
only after the same ordered list adds that column (including an ADD COLUMN and
named constraint companion in one ALTER). The catalogue proves the column did
not exist before the slot, the exact referenced table/key, delete action and
validation state, with prior columns, constraints and ACLs unchanged.
SET NULL/CASCADE on pre-existing columns and dropped or rewritten foreign keys
remain refused. Other drops, column type changes, renames and ownership changes
refuse even when listed. Every listed statement must appear once in order, with internal bytes unchanged; an unlisted
existing-table ALTER cannot fall through to generic ADD admission when the list
is active. The issued three purchase-reservation texts remain unchanged data.

`droppedIndexes` entries list a qualified `table`, plain index `name` and
`beforeSha256`. The hash must pin a plain CREATE [UNIQUE] INDEX of that name on
that table in the ordered prefix; a hash that pins no statement, or pins any
other statement, refuses. Each entry authorizes exactly one
`DROP INDEX public.<name>;`. Unlisted, duplicate or missing drops, quoted or
re-spelled names, IF EXISTS, CONCURRENTLY, CASCADE, RESTRICT and multiple names
refuse. The prefix history is not read lexically for the index: PostgreSQL
decides it. The catalog proof rebuilds the pinned CREATE in a savepoint and
requires the dropped index to have exactly that definition, refuses an index
that backs a constraint, and requires the index to disappear while its table's
columns, constraints, other indexes and ACL remain unchanged. Issued-slot and
sealed-prefix guards protect this inventory like the other slot fields.

The checkout recovery lifecycle forward replaces the unique live-order index
with a non-unique `(order_id, created_at DESC)` index. Customer/service checkout links
coexist until expiry, payment or explicit operator revocation, while payment-case issuance locks its pending
order before rotating links. Actor issuance retains rotation. Checkout issuance
refuses pending renewal-cycle orders; cancellation, recovery and retry
authorization keep their existing order-scoped or token-scoped revocation.

The operator-order-link forward adds the owner-only
`commerce_operator_link_receipts` table and five service-only definer routines.
Receipts retain logical operator, request, order and token identities, with no
client reference or client absorption coupling. No raw receipt-table grant is
added. Admission commits before revoke/insert; outcome commits after acknowledged
effects. Failure can therefore leave an admitted attempt, revoked old tokens or
a minted token without queued mail. The operator issuer revokes prior same-order
checkout links; customer/service issuers are unchanged. The scoped delivery
authorizer binds the active claim, exact token digest/row, order/client and
expiry, and refuses renewal cycles. Flow-specific authorization does not change
the existing reminder authorizer. See the [operator recipe](PLATFORM_PACKAGE_REFERENCE.md#operator-order-payment-links).

The checkout-wave forward adds `expired` to the native order CHECK, retaining
its `NOT VALID` state so historical rows are not revalidated. It uses retained
purchase-reservation deadlines as the canonical one-time expiry source.
Event/token capture is atomic and deduplicated by event identity; reconciliation
repairs absent capture without rotating prior links. Initial abandonment uses a
compensated provisional activation, attributed cancelled order and stricter
provider-contact refusal before the scan limit and under locks. It does not
cancel a live subscription. New functions use fixed definer search paths and
closed service execution; both replaced entry points retain their headers and
ACLs. The scoped runtime authorizer delegates to the existing owner-only check.
First-send evidence uses the existing transactional receipts, with an event,
template, recipient and profile fingerprint; outbox completion is independent.
See the [composition recipe](PLATFORM_PACKAGE_REFERENCE.md#checkout-recovery-waves-and-expiry)
for configured timing and transport-profile limits.

`checkSupersets` entries declare table, constraint, column and values;
`uniqueSupersets` entries declare table, constraint, columns and nullsNotDistinct.
The lexical validator checks only the slot's own SQL: exactly one adjacent
DROP CONSTRAINT / ADD CONSTRAINT pair per entry, with the exact listed positive
IN values (with an optional trailing `NOT VALID`) or plain UNIQUE columns and
NULLS NOT DISTINCT mode. Unlisted drops, non-adjacent pairs and mismatched
additions refuse; the general expression grammar is unchanged. The protected real-PostgreSQL catalog control proves
widening against the installed definition immediately before the slot: the old
constraint must exist in the closed CHECK or UNIQUE shape, every old value or
key column must remain, and NULLS NOT DISTINCT may be added but never removed.
CHECK validation state must remain equal: a validated CHECK stays validated, and
an unvalidated CHECK stays `NOT VALID`. PostgreSQL's `convalidated` proves that
state; only when both are unvalidated is the trailing `NOT VALID` omitted for
value-list comparison. This preserves table conventions that check new writes
without rechecking historical rows. Changing validation state in either direction
refuses. The lexical validator reads no prefix validation history.
The installed new definition must equal the entry; other constraints, columns
and triggers remain protected. No historical SQL anchor is used for these
entries. The issued account-consent `purposeCheck` retains its original preimage,
values and refusal behavior unchanged.

`createdViews` entries declare a fresh qualified name and exact CREATE VIEW
statement hash. Only plain unconditional creation is admitted, once per listed
view. OR REPLACE and conditional existence forms refuse. PostgreSQL rejects a
duplicate name; the reader does not reconstruct a prefix object catalog.
REVOKE ALL ON TABLE ... FROM PUBLIC is mandatory after creation; the
existing guarded role revokes are allowed. Every GRANT on a created view refuses.
Views gain no RLS or table-grant capability. The real catalog checks the declared
new view inventory, ownership and owner-only privileges.

`createdTriggers` entries name a fresh trigger, a qualified target table and the
exact CREATE TRIGGER statement hash. The target must exist in the prefix or be
created by an earlier plain CREATE TABLE in this same slot, owned by the migrator.
Only BEFORE/AFTER INSERT, DELETE or UPDATE
(with an optional OF column list), combined with OR, FOR EACH ROW and a
zero-argument public function are admitted. That function must be created in the
same slot, explicitly return trigger with SECURITY INVOKER and a pinned search
path, revoke PUBLIC and receive no EXECUTE grant. Conditional revokes remain
allowed. WHEN, transition relations, constraint/statement/instead-of triggers,
trigger mutation and unlisted or drifted statements refuse. Creation stays plain:
OR REPLACE and conditional existence forms refuse. PostgreSQL rejects duplicate
triggers and missing targets; the catalog witness proves prefix membership or
earlier same-slot table creation and ownership,
name freshness, enabled binding, events and owner-only function ACL.

The destination slot registers four created function signatures and pinned
search paths. Its two new tables, revokes and RLS use the existing same-file
narrowing rules below. Class data does not pin table columns, constraint/index
names, function security mode, language, defaults or return type; feature SQL's
whole-file/after-hashes and feature review retain those inventory and behavior
duties. Synthetic shape acceptance establishes no implemented destination API.

Each created function must revoke all PUBLIC privileges before its grants and
conditional blocks. SECURITY DEFINER requires the slot's exact pinned
`search_path`, such as `pg_catalog, pg_temp`. A replacement may preserve a legacy
compact `SET search_path=pg_catalog` header: extraction normalizes the assignment
for its schema-list pin only; the header itself must remain byte-for-byte equal.
New functions retain their existing spaced spelling, and no other SET grammar,
schema-token or catalogue proconfig check changes. Grant-only signatures must
exist in the pre-class native prefix and be disjoint from the replaced/created lists.
They cannot be redefined or named by a direct privilege statement. Only their
pinned conditional role/verb capabilities are admitted, without demanding a new
PUBLIC revoke. A block naming created functions still requires their revokes;
a block naming only grant-only functions does not.
The conditional DO shell requires an exact `pg_roles` existence guard around
one constant privilege EXECUTE, on admitted targets, for the same role. Function
privileges and table revokes retain one block per role, verb and object kind
(FUNCTION or TABLE). The fixed notice-table allowance below additionally admits
its grant and policy. Each listed, block-classified, same-slot census table has
two separate `service_role` conditional blocks: one for `SELECT (client_id)` and
one for its derived SELECT-only policy with `USING (true)` and no WITH CHECK.
`anon` admits revokes only; for functions, `authenticated` and `service_role`
admit revokes or EXECUTE grants. Extra statements, branches, dynamic strings and
PUBLIC grants refuse.

Only qualified tables created earlier by unconditional `CREATE TABLE public.<name>`
statements in that same slot's file may use table narrowing: bare `REVOKE ALL ON
TABLE <table> FROM PUBLIC`, conditional per-role `REVOKE ALL ON TABLE` lists, and
`ALTER TABLE <table> ENABLE ROW LEVEL SECURITY`. A table from the prefix or
another slot or an unqualified/IF NOT EXISTS creation refuses. Table grants refuse
except for the fixed notice-table allowance below and the listed census tables'
client-column SELECT allowance above. Census tables keep owner-only table ACLs
and receive only their exact column grant and derived SELECT policy.
The native paid-notice slot alone may name `insertSelectTables`, whose complete
value is pinned by the reader to `["public.subscription_notice_refusals"]`.
It is an allowance, so it may precede the table's introduction. It authorizes
nothing until that same forward creates the table earlier in its own file.
Only the following exact statements are admitted inside the existing service-role
existence shell:

```sql
GRANT SELECT, INSERT ON public.subscription_notice_refusals TO service_role;
CREATE POLICY subscription_notice_refusals_runtime ON public.subscription_notice_refusals FOR ALL TO service_role USING (true) WITH CHECK (true);
```

The notice-table inner statement includes its final semicolon; different spelling,
privilege order, an added `TABLE`, extra roles, column grants and grant options
refuse. The existing revoke and RLS-enable narrowing paths are unchanged.
The table keeps RLS enabled and only owner plus service-role SELECT/INSERT
privileges; its one policy has that role alone. With the role absent, the guarded
grant and policy do not run and the new table stays owner-only with RLS enabled.
This INSERT/SELECT allowance applies only to the named notice table.

The existing expand-only grammar and every other class retain their refusals.
Each feature PR using this narrowing must provide real-PostgreSQL proof that its
restricted runtime retains the access required by its row after the revokes/RLS;
reviewers of that feature PR must assess the proof. This control cannot supply it.

The static checks above are a first gate for ordinary mistakes, not the boundary
against deliberately evasive SQL. For function identity, security attribute,
`search_path` and privileges, the truth is the required real-PostgreSQL
[catalog test](../../tests/postgres/nativeStoreForwardCatalog.test.ts). It replays
one chain, the legacy selection's manifest units in path order with earlier bound forwards
applied cumulatively, and does not replay the `qualified-v2`, `qualified-admin` or
operator-provisioned histories. With no bound forward it replays that chain once, so
the replay itself is proved. For every bound native forward it applies the forward
and compares what PostgreSQL itself reports before and after with the slot's lists.
The catalog reads run with `search_path` pinned to `pg_catalog, pg_temp`, so neither
the forward's own `search_path` nor a temporary object named like a catalog can
capture them, and every comparison with the first user OID is typed `oid`, so an
operator a forward creates for another operand type cannot hide what it adds:

- Nothing PostgreSQL ships changes: no system function, relation privilege or column
  privilege.
- The new functions, in any schema, equal the created list; changed functions lie in
  the replaced and grant-only lists. A replaced function keeps every attribute and
  its ACL, so only its body may change. A grant-only function keeps its attributes and
  body, may gain only EXECUTE for its listed grant roles and may lose privileges only
  from its listed roles.
- A created function is owned by the migration role, keeps no PUBLIC execute and
  grants execute only to `authenticated` and `service_role`, never with a grant
  option. A definer carries its pinned `search_path`; a function whose slot pins none
  carries no `SET` at all. Its language and leakproof flag are not compared: like
  its body, they stay with the whole-file hash and the feature review.
- Existing relations of every kind, indexes and TOAST tables included, keep their
  owner, privileges, row security, options and column privileges. Only the index
  of an explicitly listed UNIQUE replacement may be replaced with its new key. A new relation of
  any kind is owned by the migration role. By default it carries only its owner's
  table privileges and no column privilege. The pinned notice table may carry
  service-role SELECT/INSERT with RLS enabled and its single fixed policy.
  A listed, block-classified, same-slot census table keeps owner-only table ACLs
  and may carry only `client_id` SELECT for `service_role`, with RLS enabled and
  its derived permissive SELECT policy (`USING (true)`, no WITH CHECK); each of
  its two statements uses its own conditional block. The comparator checks the
  exact roles, commands, predicates and absence of grant options. Unlisted
  relations retain owner-only privileges and no column ACLs, including classified
  retain/block tables. Relations and their raw names/namespaces are resolved by OID,
  so a forward
  that rewrites an existing table, for example by adding a column with a volatile
  default, replaces its TOAST relation and is refused: a known fail-closed limit,
  with a follow-up to compare TOAST relations without OID identity.
- No constraint, one PostgreSQL ships included, is dropped or rewritten, a NOT NULL
  excepted. Listed CHECKs retain their hash-bound old values in the positive IN
  form PostgreSQL deparses. Listed UNIQUE replacements retain every old key
  column and the exact declared new definition; their old indexes may be replaced.
  Other existing constraints and indexes keep the same protections.
- The guard catalogs, each read whole, do not change: `pg_namespace`, `pg_authid`,
  `pg_auth_members`, `pg_db_role_setting`, `pg_database`, `pg_default_acl`,
  `pg_event_trigger`, `pg_extension`, `pg_cast` and `pg_parameter_acl` (the
  privileges on server parameters); and, for the relations that
  existed before the forward, PostgreSQL's own included, `pg_trigger`, `pg_policy`
  and `pg_rewrite` (a view's own rule included).
  Left out of the comparison: each row's own OID, parser positions inside stored
  node trees, temporary schemas and the two transaction-horizon columns of
  `pg_database`. Every trigger that existed before the forward, an internal one and
  its enabled state included, stays as it was; additions are limited to the declared row triggers above and the
  enforcement trigger PostgreSQL creates internally for a constraint the forward
  itself adds.

The privileges it reads are those on functions, relations and their columns, schemas,
databases, default privileges and server parameters, with role membership through the
guard catalogs. The ACLs on types, languages, foreign data wrappers and servers, large
objects and tablespaces, and the operator catalog, are not read.

It runs with and without `service_role`, and its refusal cases include a function
header that hides its attribute list inside a quoted default and a file whose
backslash makes the database run statements the static reader cannot see. A native-SQL change is
refused when it also touches admission machinery, and the machinery includes the
catalog test and these named files: `tests/postgres/nativeStoreForwardCatalog.test.ts`,
`tests/helpers/postgresContainer.ts`, `vitest.config.ts`, `scripts/run-vitest.mjs`,
`scripts/ci-test-scope.mjs`, `scripts/ci-image-pull.mjs`, `scripts/ci-image-mirror.mjs`,
`scripts/disposable-docker.mjs`, `scripts/ci-vitest-duration-keys.ts`,
`scripts/coverage-summary-protocol.ts`, `src/test/setup.ts`,
`src/checkout/machine/commerceRequestCache.ts`, `config/ci-images.json`, `.npmrc`
and everything under `tests/setup/`. Code those files run, and deliberately evasive
changes, are a review duty. Function bodies, data statements, statement kinds and
object kinds beyond functions and relations stay on the whole-file hash and the
feature review.
These are admission controls, not SQL behavior or hosted qualification.

### M17 channelIngestForwards

The reviewed registry may introduce `channelIngestForwards` together with its
SQL and exact pins.
Its fixed class admits only `20261030121000_channel_retained_basis.sql` and
`20261030122000_channel_purchased_source.sql` on each native and managed rail.
The feature supplies all four exact file, function and ordered-statement pins
with the SQL introduction; an absent class remains readable in historical registries.
The checker fixes signatures, creation or replacement, preimages, headers and
ordered companions, including triggers and ACLs. Registry pins cannot widen
that inventory. PR, release and native queue checks require a binding at each
fixed path even when its SQL is expand-only and the registry is unchanged.
Complete ordered prefixes retain earlier issued same-rail pins;
release checks bind the unique introduction and refuse later repinning or
removal. Changing admission machinery together with SQL remains forbidden.
This control installs no SQL and establishes no PostgreSQL semantic proof; the
SQL introduction owns that proof. The R1 introduction appends the two
`20261030121000_channel_retained_basis.sql` and
`20261030122000_channel_purchased_source.sql` units to each selected native plan
and the managed chain. The native package assets are byte-identical projections
of their canonical units; the managed bodies intentionally differ. Native
functions retain the selected trusted migration owner and conditional service
grants when that selected role exists. They do not introduce managed closed-role
isolation into a native role graph. Managed capture uses its closed NOLOGIN
writer. Its explicit non-owner allocator EXECUTE grant is limited to the
existing service role and that closed writer; fulfillment consumption keeps its
service-only grant. The writer's catalog privileges are exactly non-grantable
SELECT on catalog SKUs, bundles and bundle components. Its role flags and
ADMIN-only installer edge grant no runtime login, SET or INHERIT path; the
actual PostgreSQL witness checks those facts independently of the static ACL
reader. Managed retained readback grants `service_role` SELECT only on
`commerce_order_items` columns `id`, `sku_id`, `quantity`, `product_snapshot`,
`order_id` and `allocation_ordinal`; it grants neither table-wide SELECT nor
access to other item columns. Canonical-grant fixtures revoke adapter defaults
before installation and verify the required read census on all four rails.
Both rails retain protected original captures outside generic source
envelopes, immutable line claims and original page receipts. Physical native
conversion remains explicitly unavailable; no native payment or stock grant is
invented. Privacy lifecycle export/erasure remains unavailable. The existing
[admission witness](../../scripts/reviewed-batch-forward.test.ts) uses synthetic
function bodies under fixed headers and exact companions to test lexical and
Git-history success and refusal boundaries.

## Disposable managed reference baseline

Evidence: historical record, 2026-11-13. Not reader guidance.

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

Moved to [Upgrade the database](../../packages/core/docs/guide/upgrade/database-migrations.md#check-application-compatibility).

Evidence (historical record, 2026-11-13):

The lifecycle-closure forward is a closed-class function update: three existing
function definitions retain their attributes and ACLs, four new invoker functions
use `pg_catalog` and conditional trusted execution, and three status CHECKs gain
`paused`, `skipped` and `cancelled` respectively. Existing status values remain
valid; no historical row is rewritten. The package mirrors the exact SQL bytes.
The outcomes projection is a nonmaterialized view over existing events with
PUBLIC/browser access revoked and no new reader grant. Its installation needs
the separately admitted class descriptor; a local SQL replay is not admission.
The fixed actor pause wrapper alone flushes `trg_commerce_orders_line_sum` inside
its existing definer context and then sets that named constraint DEFERRED. This
moves the unchanged invoker check before the wrapper returns, without altering
the constraint definition, trigger function, gateway commit role or table grants.
Other deferred constraints are not changed. Service closure calls still defer
line-sum checking until transaction completion.

The subscription-notice suffix replaces the installed producer/claim bodies
without changing their existing signatures or search paths. Its mirrored SQL
and manifest hashes must travel with the matching package set. It adds a nullable
operator recipient while preserving the customer FK, replaces uniqueness with
recipient-aware NULLS NOT DISTINCT identity, and defaults operator freshness to
false for existing history. The nullable reminder-ledger `renewal_at` column
retains new queued renewal instants without sharing customer event identities.
Existing ledger rows are never re-keyed or backfilled; their day uniqueness and
accepted receipt identities still dedupe, with typed legacy event facts retained
as a read fallback. New pause facts use the existing event carrier;
older dispatch code does not recognize those new event kinds. Upgrade the
producer and dispatcher together before enabling their schedules. No ledger
backfill, historical auto-send, reminder deletion or live activation is performed.
The separate closed class-2 reader/data admission is required before this suffix
can land; a source-only fixture application does not establish that admission.

The classic package-editor forward appends nullable subscription composition
storage, a new preview ledger and eight created functions. It replaces no served
command routine and rewrites no existing agreement, cycle or operation snapshot.
The canonical manifest and projected package SQL retain identical bytes for all
selected plans; each installation shape needs its separately measured catalogue
identity. Apply this additive schema before upgrading native account reads or
composing the editor. Old generic commands keep their existing contract.
Preview rows retain linked actor/client and accepted-event references, stay
unread by client absorption (their subscriptions block it) and travel through
the finite connected-store profile. They
have no erasure path yet. [Retained storage](#retained-renewal-storage) owns their
privilege, pruning, acceptance and renewal-pricing boundaries.


The opt-in [complete account consent choices](#complete-account-consent-choices)
forward adds a distinct actor API and expands only the native sync purpose CHECK.
It neither replaces the served newsletter routines nor backfills grants. Hosts
configure its single sync target before selecting the new API; old callers retain
their existing opt-in/withdrawal behaviour across the upgrade.

The native [paid-email forward](../../db/platform/migrations/20261101231000_native_paid_email.sql)
replaces the paid-notification trigger and promoted-draft functions, preserving
their invoker headers. The existing paid event remains; the additional mail event uses order_<UUID>,
a separate idempotency key and the native cycle/draft mode. Its mail-only block
bounds lock waits, absorbs insertion/cancellation errors and restores the
caller's timeout, so this added effect cannot roll back settlement. A missed mail
event leaves the retained paid event/order as operator-repair evidence; this is
best-effort capture, not a new durable mail obligation. Existing rows and historic
events are not rewritten. Eight existing notice, recipient, policy and reminder
routines gain conditional service_role EXECUTE, without new table privileges,
definers or changes to their bodies. The condition preserves legacy installs
where service_role is absent. Native case/notice creation remains atomic;
explicit notice-storage contention rolls back cleanly and is retried after
release. The [scheduled binding boundary](ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
and [grant assessment](plans/oss-m19-g8.md#grant-exposure-assessment) own caller
trust and contact-data exposure. The feature requires exact class data and
approval pins; local SQL proof alone does not admit it.

The staged promoted-draft port validates effective shipping and retains its canonical charge
adjustment, money equation, replay and line-allocation refusals. Where a quote
retains `shipping-threshold.v1` terms, the configured flat fee applies below the
threshold and zero applies at or above it, measured after product discounts and
excluding delivery. Currency, numeric bounds and the retained shipping amount
must agree. Quotes without these terms retain their supplied shipping amount;
hosts must supply server-produced quotes and authorize the customer separately.
Product discounts allocate only to product lines. The deferred line-sum guard
adds shipping charges and subtracts shipping-scoped discounts before comparing
with the order total; its other checks and invoker trigger header remain unchanged.
The local invoice constructor appends positive effective delivery as its own line.

The new `commerce_promotion_lock_definition(text)` is a volatile definer routine
owned by the migration role, with `search_path = pg_catalog, pg_temp`. It only
selects the named definition for update and returns its row or null. PUBLIC and
browser roles cannot execute it; only the service runtime receives EXECUTE.
The invoker draft retains definition, missing-promotion and global/customer cap
checks after that lock. Runtime callers still cannot update definitions.
These native opt-in changes do not modify a managed database or activate a host.

The existing `subscription_dunning_notifications` and
`transactional_delivery_receipts` tables can hold customer-linked delivery facts.
There is no erasure path for these tables yet. Capturing or restoring these rows
does not qualify customer-data erasure; a host must account for this limit before
using the native notice path with customer data.

### Paid-mail capture repair

Evidence: historical record, 2026-11-13. Not reader guidance.

Run this read query through the trusted runtime or operator connection to find
paid orders with a retained paid event and no mail event:

```sql
SELECT o.id AS order_uuid, o.paid_at
FROM public.commerce_orders AS o
WHERE o.status = 'paid'
  AND EXISTS (
    SELECT 1 FROM public.outbox_events AS e
    WHERE e.aggregate_type = 'commerce_order' AND e.aggregate_id = o.id
      AND e.event_type = 'commerce.order.paid'
  )
  AND NOT EXISTS (
    SELECT 1 FROM public.outbox_events AS e
    WHERE e.aggregate_type = 'commerce_order' AND e.aggregate_id = o.id
      AND e.event_type = 'commerce.order.paid.email'
  )
ORDER BY o.paid_at, o.id;
```

This identifies missing capture, not provider delivery. It can include historical
paid orders; reconcile their event history before an explicit host-controlled
repair. The query changes no row and triggers no send. Settlement replay does
not recreate a mail event omitted during the original paid transition.

The native terminal-renewal replay forward preserves the claim routine's
signature, defaults, invoker rights, search path, ownership and ACL. It moves a
matching stored succeeded/refused answer before current due eligibility, under
the same subscription-then-operation locks and full frozen-input comparison.
Changed replay input remains 23505. Cancellation permits historical terminal
readback but never new or nonterminal claims. Apply this ordered forward before
selecting that public replay behavior; the managed chain and separate adopter
native copies require their own adoption rather than changing implicitly.

The source preview's sandbox-attempt suffix adds nullable review metadata without
rewriting existing truth rows or changing the open/settled checks. Existing
non-sandbox truth does not read or require simulator storage. New sandbox truth
requires an exact durable server observation and active-attempt match; accepted
event replay retains its first fingerprint and instant after restart. Cancelled
capture is terminal operator-review evidence, excluded from reconciliation work
and the open sweep, while the order remains cancelled. See the sandbox forward
in [Module catalogues and installed histories](#module-catalogues-and-installed-histories).
The destination forward adds immutable address documents and scoped order,
subscription and shipment bindings. Both relations revoke PUBLIC, browser and
runtime table privileges and enable RLS; trusted runtime uses four bounded
definer routines with pinned search paths. Parent/client consistency is checked,
but host authorization of each parent read remains necessary. The separate saved
address book owns mutable customer rows; there is no arbitrary destination-ID
reader. Subscription defaults read
through an active purchase; renewal orders resolve their own frozen operation
reference, never the subscription's later future address. Shipment preparation
pins its first document under the native dispatch lock. Hosts compose this reader
in the existing authoritative preparation transaction before freezing requests.
The shipment destination read and command enqueue must share one transaction
on one connection; otherwise the host owns the intervening window.

A human operator can correct an unowned created/packed/label_pending current
parcel. Once a dispatch ref, command or attempt exists, the order and parcel keep
their destination and the subscription future changes with the named
applied_from_next_parcel result, including replay. The account-link orchestration
returns partial and retains that named nested result. The reference HTTP route
preserves the outcome; its older donor browser schema refuses it, so hosts must
compose the native result explicitly and show next-parcel applicability. It is not a fully applied
current-parcel result. Native customer changes future only. Open dunning does not
blanket-block address; the donor next-cycle payment lock still applies, including
a native snapshot owned before its cycle row exists. Subscription reads lock the
parent; G7 retains that writable transaction through snapshot claim. Address
changes do not move cadence, next_cycle_at, template_version, money, or delivery
alignment. Never confirm an undelivered replacement through this boundary.

The transaction records the native subscription event as account history and
one subscription.address_changed outbox row, keyed by source event UUID. Both
payloads name applicability and future destination ID, without frozen-parcel
address data. Replay bypasses both INSERTs; the outbox's unique event/key fence
also deduplicates. An outbox failure rolls back address, binding, event and receipt
writes. Delivery is asynchronous: no mail response gates money or parcel work.
The existing template mapper and explicitly composed subscription message facade
do not automatically consume the native outbox. Host mail dispatch remains
unbound; no delivered-email claim follows from enqueue.

These documents carry full postal addresses and contact phone numbers, customer names
and delivery instructions,
plus identifying parent, actor and reference strings. Hosts should use opaque
references and avoid personal data in keys/reasons. There is no destination privacy
export or erasure path; existing identity erasure does not erase these documents.
Do not claim complete privacy coverage. Privileged connected-store transfer
retains exact documents, bindings and the existing command/support ledgers under
whole-packet row/byte bounds and filtered-login refusal; it is not a subject
privacy export. Root capture/restore additions ship no npm assets. The API remains
a development-preview source candidate; full catalogue installation and explicit
host composition are required, and managed definitions remain unchanged.

The installed complete-catalogue entry preserves this lifecycle. Its generated
SQL assets are copies of issued units with unchanged canonical identities,
hashes, ordering and inventory pins, rather than new forwards. Qualified and
restricted-admin selections retain their distinct baselines and role admission;
legacy selection remains available for existing history. The required installed-consumer gate
compares the projection against the canonical manifest and exact source bytes.
See [module catalogues](#module-catalogues-and-installed-histories) and the
[installed recipe](../../packages/platform/README.md#install-the-portable-postgresql-schema).
The G4 forward adds purchase ownership to the existing inventory reservation
table. Renewal ownership becomes nullable while its UNIQUE and foreign key stay
intact; a validated exclusive-owner CHECK requires either a renewal operation
or a purchase order. Existing renewal rows need no data backfill. Purchase
release/expiry change only purchase-owned rows, and the unchanged ATP, renewal,
stock-wait and retry paths continue counting their live quantities. One command
receipt retains batch/release/cancel replay; runtime table grants do not widen. This
ownership alteration is named by the closed class control and bound by the
co-located feature pins. The receipt table revokes PUBLIC and named
runtime/browser roles separately from function ACLs; it introduces neither RLS
nor table grants. The existing reservation-table ACL stays unchanged. Local lots, locations,
balance counters and movement history are outside this slice.

The native abandoned-checkout wrapper locks the subscription root, order, intents,
simulator attempts and their evidence, in that order. A dispatched attempt returns
`cancelled: false` with `provider_attempt_in_flight` without writing a receipt or
changing the order, intent or holds. Terminal refused/expired attempts permit
cancellation; captured or indeterminate attempts retain the money refusal.
It delegates aggregate cleanup to the existing
compensation routine and purchase transitions to the existing release routine in
one transaction. Strict command receipts reject changed keyed input; paid,
captured or indeterminate evidence prevents cancellation. It rejects renewal
orders and admits no new holds on cancelled orders. No withdrawal metadata or
money effect is written. A late capture's review disposition belongs to the
preceding payment slot: it records `review_required` without reopening the
cancelled order or reclaiming its released holds.
Dedicated promotion cancellation remains unbound. Reference fields, including
keys and source references, can contain identifying strings; hosts should use
opaque references and avoid personal details in metadata and reasons. No erasure
path exists yet for retained reservation, command-receipt or compensation data.

Fresh channel capture admission binds the normalized slug through the existing
trusted scope read and the raw-source digest through its original page event.
It checks normalized buyer, address and shipping scalar types and bounds before
persistence. Page recording derives its next watermark from the expected
watermark and event times using the public millisecond comparison, retaining
the original timestamp string on ties. These checks add no runtime grant or
writer policy.

The portable account newsletter withdrawal forward changes future account
opt-outs only. Earlier opt-outs require the explicit, idempotent
[operator upgrade statement](#account-newsletter-withdrawal-upgrade); installing
or replaying the forward does not alter an existing recipient-consent row.

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
the current legacy manifest. The invoicing durable-duties forward copies
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

Before the lock and conflict completion tail, both qualified generations
refused five existing native paths on the restricted runtime with `42501`:

- native subscription lifecycle commands;
- operator recovery issue;
- platform control set and heartbeat;
- order settlement for an order with a promotion claim;
- operator lead absorption, once delivery destinations block absorption.

The first three lock a row `FOR UPDATE` on a table whose issued runtime grants
include no `UPDATE` column: renewal term lines, recovery commands and control
operations. None of these tables had row security. The claim transition
trigger appends events with a conflict target, and the issued runtime grant
there was `INSERT` only. The absorber counts a lead's delivery destinations by
client, but that table had row security and no runtime access at all.

One shared completion tail closes these gaps. It is the approved seventeenth
qualified identity. Both qualified plans select it once, after their issued
tails and at the same position among shared units, so later shared forwards
still append identically.
The completion tail itself adds no legacy unit.

The tail must follow the delivery destination forward. Its guard refuses the
whole unit unless that table exists in its created state: owned by the
installer, with row security enabled and not forced, no policy and no grant
beyond the owner. A destination grant or policy added by any other change
before the tail would therefore stop every installation.

On each of the three locked tables, the tail does the following:

- enables row security;
- keeps the existing runtime access through policies;
- admits row locks through an `UPDATE` policy whose check refuses every
  actual update;
- grants `UPDATE` on one timestamp column.

On claim events it grants `SELECT` on the two arbiter columns only. Row
security would not help there, because an arbiter also requires the new row
to pass a select policy. On delivery destinations it grants `SELECT` on the
client column and adds a runtime select policy, so the existing row security
returns a truthful count. Addresses stay unreadable, and every write stays
unavailable.

The active file is byte-identical to its approved fixture. The four qualified
installation inventories were measured again; the legacy plan and its
inventory are unchanged. The
[real-PostgreSQL witness](../../tests/postgres/qualifiedRuntimeLockCompletion.test.ts)
runs on `qualified-v2` and on operator-provisioned `qualified-admin`, with an
actual restricted runtime login. It covers:

- the four lifecycle commands through the customer command store, and the
  operator support wrapper's three, each with a receipt;
- recovery issue and replay;
- platform control set, heartbeat and their replays;
- an order settlement with a promotion claim, recording exactly one claim event
  and none on later statuses;
- operator lead absorption: a lead without destinations is absorbed and
  replayed, and a lead with one is refused naming `commerce_destinations`, with
  its rows unchanged.

It also refuses every actual update, every other claim-event and destination
read, and every destination write, and enumerates every role that reaches each
target. The guard refuses the unit for a missing, renamed, unprotected or
force-protected destination table and for any extra policy or grant on it.
Existing destination, purchase-hold, retained-renewal and notice-delivery
witnesses now apply the lifecycle commands, operator recovery issuance, the
claim sweep and absorption through the restricted runtime.

The separate `qualified-admin` generation starts with its issued 91-unit prefix
and appends current shared forwards. It is not an upgrade, relabel or migration-history conversion from
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

Evidence: historical record, 2026-11-13. Not reader guidance.

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
`20261013173001_channel_exposure_inventory_admission.sql` global controls remain
deferred. The separate M17 managed forward fills the existing ATP exposure hook
and adds channel-only stock entry without changing the M06 allocator/public
entry. Retained own exposure is credited before clamping; uncommitted renewal
demand is not fenced, as recorded in the channel contract.

Known donor-identical limits remain: SQL NULL summary state returns empty totals
rather than refusing (B12); additive-provider helper evidence lacks the cumulative branch's
signature/status/exact-attempt filter (C18). Neither changes in this landing.
Keep captured cases, payment history and receipts on rollback; disable the host
stock-wait driver first. Reverting code does not undo function replacements.
Any SQL repair requires a separately reviewed forward. No backfill, host activation
or stable upgrade claim follows from these source/probe paths.

### Native stock wait and ATP (N3)

Evidence: historical record, 2026-11-13. Not reader guidance.

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

Evidence: historical record, 2026-11-13. Not reader guidance.

The later `20261106050000_customer_command_key_isolation.sql` forward isolates
actor pause and bundle preview/apply keys as `command:` plus the SHA-256 of the
authenticated principal UUID, a colon and the exact supplied key, matching the
generic command derivation. All three actor entry points reject supplied keys
starting with `command:` as `subscription_command_reserved_idempotency_key`
(22023), including historical raw keys with that prefix.

New actor events carry `commandKeyIdentity` with derivation `principal-sha256.v1`
and the principal UUID: in the lifecycle event's nested `payload` for pause,
and directly in the bundle event payload. New quotes carry the same object in
the nullable `subscription_edit_quotes.command_key_identity` column. NULL or an
absent marker denotes legacy history; the migration neither backfills provenance
nor re-keys rows. A derived-key lookup accepts only the exact principal-bound
marker. An unmarked row at that value is ambiguous raw history and refuses as
`subscription_command_ambiguous_idempotency_key` (23505), never as a replay.
Existing generic command rows without this marker also refuse this actor lookup;
their generic receipt path remains unchanged.

After subscription ownership and its row lock are established, a non-reserved
raw key may replay only an unmarked self-service event of that same action.
Bundle replay additionally requires the matching request, accepted quote hash
and accepted event link. A different customer action at that raw key refuses
idempotency conflict; another subscription owner refuses before replay. A system
event at the raw key is bypassed, never adopted as customer history. Legacy
in-flight quotes remain usable by the matching bundle command, and only its new
event receives derived provenance. Same-action retries retain one event and one
pause window or accepted quote; no command is inferred from matching key bytes
alone.

Hashing new commands cannot remove a pre-upgrade collision. Graduation, cadence
normalization and dunning exhaustion therefore retain their original system key
when available, prefixing it with `system:` while a different event type occupies
it. Existing customer rows remain intact, including preclaimed prefixed keys.
Dunning suppresses only its own exhaustion replay. The forward preserves function
headers and ACLs; the matching TypeScript runtime supplies graduation's guard.
The [real PostgreSQL witness](../../tests/postgres/customerCommandKeyIsolation.test.ts)
covers legacy and both qualified generations, same-action replay, ownership,
reserved-prefix and ambiguous-hash refusal, cross-action conflicts and both
collision attacks. Qualified system operations
execute through their installed restricted service role; legacy system setup
uses its migration owner rather than claiming a qualified runtime.

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

The portable account newsletter withdrawal forward has no managed twin: the
managed account setter already records `marketing_newsletter` in the permission
store its evaluator reads. The portable forward connects that same account
purpose to its separate native recipient-consent store; it changes no managed SQL.

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

Evidence: historical record, 2026-11-13. Not reader guidance.

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

Evidence: historical record, 2026-11-13. Not reader guidance.

`COMMUNICATIONS_MIGRATIONS` carries byte-identical projections of the existing
canonical comms outbox, transactional receipt, communications control-plane,
native operations and account newsletter withdrawal units at positions
2, 9, 20, 70 and 88 in the legacy catalogue. The withdrawal forward follows the
issued bootstrap tails in qualified plans. Their hashes and canonical paths
are checked against the corresponding legacy manifest entries. This sparse
module projection is not an independent install chain. The full selected canonical
prefix and existing schema probes remain required. Managed receipt RPCs retain
their current service scope; direct receipts retain one role-free transaction per
operation and their accepted/failed replay boundaries.

The narrowed import moves receipt stores and their ledger contracts. Reference
mail-provider timeline/send-ledger implementations remain at their existing
owners; no provider mapping or new schema enters the package.

### Complete account consent choices

Evidence: historical record, 2026-11-13. Not reader guidance.

The opt-in native forward `20261101232000_customer_account_consents.sql` adds
`customer_account_communication_choices_as_actor(uuid)` and
`customer_account_communication_choice_set_as_actor(uuid,text,boolean,text)`.
These are actor SECURITY DEFINER boundaries: `auth.uid()` must own the supplied
client. Authenticated callers receive EXECUTE only; preference, event, evaluator
and sync tables receive no browser DML grant. A pinned `pg_catalog, pg_temp`
search path and qualified references avoid caller name resolution. Invoker
routines cannot write the deliberately ungranted preference/event tables.
The existing newsletter actor reader/setter below retain their behaviour.
Both newly created account tables revoke ALL from PUBLIC, anon, authenticated
and service_role, with RLS enabled and no browser policies. Their definer
routines retain the required access without direct caller table privileges.
Table checks bound lengths, nonblank target identifiers and the two literal copy
versions. The command refuses target control characters, derives a lowercase
SHA-256 fingerprint and constructs the exact copy version for its closed purpose
list. Privileged direct ledger writes no longer have table-level hex or
purpose/version-pair validation; trusted installation code must preserve those
rules. Customers have no direct ledger/configuration write path.

The read returns `customer.account_communication_choices.v1`, with contact and
both `marketingNewsletter` and `marketingGiftsDiscounts`. Each carries purpose,
state, granted, source, reason, capture/update time and nullable consentCopyVersion.
Absent permission is unknown; an owned client without an email returns null.
Read creates no contact or permission. Gifts/discounts is independent of launch
offer. Historical or externally changed evaluator rows retain their state and
times, with null attribution when no matching account event proves it.

The command accepts client UUID, purpose, boolean choice and idempotency key.
It returns `customer.account_communication_choice_result.v1` with permissionEventId,
nullable workId, replayed and current choices. A valid withdrawal with an owned
client and non-null stored email commits the local preference (newsletter),
evaluator denial and permission event immediately. Provider sync is optional:
no usable target or unusable email yields workId=null and no outbox/sync row.
A registration failure also rolls back only optional work for a withdrawal;
grants still require usable email/target and atomic work registration. Null
stored email and invalid command/key still refuse. A suppression always wins.
Exact replay returns the stored event ID and work ID (including null) with
current choices, without reapplying an old choice or filling in missing work.
Conflicting reuse refuses with `account_consent_idempotency_conflict` (23505).
Ownership is checked before replay disclosure.

The new `customer_account_consent_events` ledger records requested choice and
effective state separately, actor/client/email fingerprint, source/reason,
copy version, client/route attribution, capture method/time and work ID. Copy
versions are `customer_account_marketing_newsletter.v1` and
`customer_account_marketing_gifts_discounts.v1`. A current suppression retains
its state and original evaluator timestamps; an account choice never clears it.
The requested choice remains audited, and sync work requests suppress. The read
does not attribute an external suppression to a customer's grant event.

A trusted migration/admin connection configures the single
`customer_account_consent_sync_targets` row with binding, provider_kind and
enabled=true before grants or provider registration. No target is seeded or
inferred. Grants refuse missing/disabled targets or control characters in either
identifier with `account_consent_sync_target_unavailable` (55000), and unusable
email with `account_consent_email_invalid` (22023). A withdrawal records locally
without that work when either prerequisite is unavailable. Customers cannot
configure or select targets. The provider remains unaware of an unsynced denial;
enabling a target later or replaying the original key does not enqueue it.
The target is held stable through the command. Source/work IDs use the reserved
`account-consent:<permission-event-uuid>` namespace; the account-specific command
fingerprint binds its payload/target, while the aggregate and event type match
the existing native sync rail. Hosts must not register that reserved source key
through the separate TypeScript registration API.

For an unusable non-null email, the local recipient fingerprint remains SHA-256
of the normalized stored text, including an empty or otherwise invalid result;
that string is never passed to provider registration. The withdrawal also denies
recipient fingerprints previously recorded by this actor/client for this purpose,
using the existing event ledger, so correcting back to an earlier granted
address cannot resurrect its old grant. Each recipient's suppression and times
remain protected. Event metadata records `recipientFingerprints` and
`syncDeferredReason`; no extra raw email is copied into the ledger. A fresh valid
address is a separate unknown/default-denied recipient, requiring an explicit
new grant. The historical denial is retained, and replay never retargets it or
reapplies it over a later choice. Database/JavaScript case-fold limits below
still apply; there is no general automatic email-change/provider migration.

Owner-only read of locally recorded withdrawals without work:

```sql
-- account-consent-unsynced-denials
SELECT id, principal_id, client_id, purpose, recipient_fingerprint,
       metadata->'recipientFingerprints' AS recipient_fingerprints,
       source, reason, consent_copy_version, source_ref, captured_at,
       metadata->>'syncDeferredReason' AS sync_deferred_reason
FROM public.customer_account_consent_events
WHERE requested_consent = false AND work_id IS NULL
ORDER BY captured_at, id;
```

This audit query includes effective denials and retained suppressions, and may
include historical withdrawals superseded by later explicit choices. It does
not send or retry anything. Operators must reconcile current choices, usable
addresses and trusted targets before any provider action; no reconciliation
writer or automatic backfill is supplied here. Reference fields and idempotency
keys can contain identifying strings: hosts should use opaque references. No
erasure path for this consent history exists yet; transfer does not add one.

`outbox_events` and `communication_native_sync_state` remain the sole sync rail,
with the existing per-contact/target aggregate ordering and worker claims,
leases, retry limits and finalizers. The purpose CHECK additionally admits
`marketing_gifts_discounts`; host composition must classify that purpose as
marketing in its evaluator registry. Nothing here activates provider transport.
No array/jsonb parameter encoding is introduced by these SQL signatures.
The [real PostgreSQL witness](../../tests/postgres/customerAccountConsents.test.ts)
uses the restricted runtime login and `SET LOCAL ROLE authenticated` for actor
calls, covering refusal, replay, suppression, rollback and worker consumption.
Database lowercase normalization retains the locale/Unicode limits explained
in the newsletter section below; no broader normalization parity is claimed.
The native delivery-observation adapter suppresses newsletter, gifts/discounts,
launch-offer and tester consent after a bounce or complaint. The account-consent
PostgreSQL regression grants the three marketing purposes, applies each provider
hold through the restricted runtime adapter and verifies suppressed evaluator
state, callback replay and suppression retention after subsequent account grants.

### Account newsletter withdrawal upgrade

Evidence: historical record, 2026-11-13. Not reader guidance.

After installing the complete portable chain containing
`20261030110000_customer_newsletter_withdrawal.sql`, every account newsletter
opt-out atomically denies a missing or granted `marketing_newsletter` consent at
the principal's stored email fingerprint. For evaluator-accepted addresses, this
matches the evaluator when database and JavaScript lowercase normalization agree. An existing denial or suppression is unchanged;
an older caller timestamp still denies a grant without moving its timestamp
backwards. Other purposes remain untouched. Opt-in changes only the account
preference: after opt-out and back in, the evaluator still refuses until an
explicit grant is separately recorded, while account read-back shows the preference.

The setter deliberately does not copy the evaluator's address-acceptance rule
into SQL. An evaluator-refused address can receive a denial under a fingerprint
that the evaluator never reads; its answer remains refused.

The explicit trimming set matches the evaluator-accepted JavaScript whitespace
class. Case folding still uses the database's `lower()` and its locale, as the
existing acquisition path does. On the measured `en_US.utf8` image it differs
from JavaScript for Turkish `İ`, context-dependent Greek `Σ` and some newer
letters; a C-locale database also leaves `Ä` uppercase. Withdrawal and the operator
statement target the evaluator's fingerprint only where the lowercase results
agree. No case-mapping change is included here; this withdrawal path assumes a UTF8 database.

An opt-out recorded before this version does not change an existing `granted`
row until an operator runs the following statement through the direct migration
or administration connection. It denies a newsletter grant only when its timestamp
is at or before the matching false preference; a later explicit grant is kept.
The statement preserves suppression, enabled preferences and other purposes.
It is idempotent: a second run changes no row.

<!-- account-newsletter-withdrawal-upgrade -->
```sql
UPDATE public.communication_recipient_consents AS consent
SET state = 'denied',
    updated_at = GREATEST(consent.updated_at, preference.updated_at)
FROM public.clients AS client
JOIN public.customer_communication_preferences AS preference
  ON preference.principal_id = client.principal_id
WHERE consent.recipient_fingerprint = encode(sha256(convert_to(lower(btrim(client.email, E'\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')),'UTF8')),'hex')
  AND consent.purpose = 'marketing_newsletter'
  AND consent.state = 'granted'
  AND preference.marketing_newsletter_consent = false
  AND consent.updated_at <= preference.updated_at;
```

The account setter registers no external provider synchronization; compose any
provider withdrawal separately. A recorded denial stays keyed to the old email
fingerprint after an email change and does not follow a new address. The distinct
`retention_marketing` purpose requires its own explicit grant at retention creation
and claim; no packaged writer grants it, so the host capturing it also owns its
withdrawal. `marketing_launch_offer` is independent as well. The
[real PostgreSQL witness](../../tests/postgres/customerNewsletterWithdrawal.test.ts)
executes this exact statement and exercises the real actor setter and evaluator
across the selected legacy, qualified and restricted installation shapes.


### Ecommerce source and projection retention

The optional native exporter requires the complete canonical chain through
`20261111120000_communication_ecommerce_sources.sql`. The sparse
`COMMUNICATIONS_MIGRATIONS` list is not an install chain. One native database
admits one immutable exporter binding: account, environment, namespace, mapping
version and live event-time cutoff. A second binding or changed cutoff refuses;
multi-account native dispatch is outside this profile.

The existing mandatory paid source INSERT retains its payload shape and adds
`metadata.commercePaidFactV1`. A complete snapshot captures the paid order's
integer money, currency, effective item amounts, original SKU identity and
settled-intent identity. Discount splits retain ordered quantities; shipping
adjustments participate in total validation. Native renewal binds its operation
fingerprint and cycle snapshot; initial subscription purchase binds its draft
and provisional activation. An initial acquisition's subsequently attached cycle
is not renewal evidence. Unsupported or incomplete evidence records a reason
without undoing payment, and is never reconstructed from later catalogue data.
The postcommit projector checks the bound succeeded settlement transition.

Refund status unions the existing provider-status source and manual OMS operation
with one per-order status identity, without refund value. Selected lifecycle events
and refunded manual operations capture their subject at insertion. Other event
and operation types retain their existing insertion permissions without new
reads of subscription or order owners. Managed historical subscription events
map the absent captured subject to `null`; current ownership cannot reconstruct
that historical association. Checkout qualification
is one processed, token-free source fact per order, using pending-checkout age,
activation and payment-activity eligibility; email waves remain separate. Current
checkout eligibility is checked again before export. Source event times are
preserved; late commits are found by receipt anti-join, while facts before the
immutable cutoff are refused. This is not a strict remote arrival-order guarantee.

`communication_event_receipts` atomically records handoff with the new export
outbox row. The existing outbox owns claims, retries and leases; a separately
invoked export allowlist isolates provider waits from commerce. Frozen requests
and `metadata.retainPayload=true` survive uncertain effects and terminal discard.
Both compactors skip pinned payloads and retain unique keys. A dispatching or
unknown receipt requires explicit quiesced reconciliation with its exact request
digest, scope and evidence reference; identical retry additionally requires
qualified deduplication semantics and current authority. No background retry is
inferred from a lost response. Currency exponent and resolver provenance are
frozen once from the qualified host currency, never replaced during retry.
Explicit qualified retry resets the active attempt/snooze counters for one new
configured worker budget and preserves their cumulative consumed values in
`recoveryAttempts`/`recoverySnoozes`, alongside the receipt's recovery reference.

The communications privacy contributor erases frozen recipient projections and
records a subject erasure fence. It retains pseudonymous source/deduplication
identities and commercial facts; remote provider history needs its separate
owner. The reference native privacy registry includes this contributor and does
not claim full commerce or remote erasure. Connected native capture/restore
registers the binding, receipts and erasure fences, retains exact captured subject
columns through its locked owner path, and preserves pending/unknown duties.
Ordinary source edits and deletion before required handoff refuse. Restricted
runtime ACLs deny TRUNCATE (42501); migration/restore owners remain trusted and
can administer the schema. No owner-proof truncation fence is claimed.


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
source/key receipts in the money transaction. First-duty buyer capture now reads
accounting documents and customer, profile and destination rows inside that
absorbed subtransaction, bounded by its 100 ms lock timeout; it performs no
accounting document construction or provider work there. Captured settlement
and dunning recovery therefore survive capture failure. Accounting, customer and
profile lookups are plain reads; destination resolution uses its existing owner.
Capture uses a nonblocking advisory lock and a 100 ms lock timeout;
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

Evidence: historical record, 2026-11-13. Not reader guidance.

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

Evidence: historical record, 2026-11-13. Not reader guidance.

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

### Native retry timing and timed resume

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261109100000_subscription_retry_resume.sql` replaces
`subscription_retry_open_case(uuid,text,text)`,
`subscription_auto_resume_due(integer,timestamptz)` and the compatibility
`subscription_retry_apply_failure(uuid,text,jsonb)` entry, preserving headers,
invoker security, owners and ACLs. Its service-only timing overload adds a
separate final `jsonb` argument containing `backoffHours`; the original signature
delegates with `[24,72,168]`. Positive numeric offsets are hours after each
failure; array length controls exhaustion, while terminating-class semantics and
receipt-first replay remain unchanged. The native store registry pins all four
definitions and the exact forward bytes. No table, backfill or trigger is added.

The open-case fence precedes case propagation under the subscription lock and
retains terminal-cycle refusal after a later resume. Lifecycle closure already
terminalizes unpaid artifacts; this forward closes the missing-case observation
path. Timed resume uses healthy native method state and existing line, case,
cycle and order ownership relations. Paid orders are associated through their
cycle, renewal operation or activation. The follow-up
`20261109113000_subscription_auto_resume_delivered_history.sql` replaces only
`subscription_auto_resume_due(integer,timestamptz)` and chains its before-hash
to that earlier replacement. The completing follow-up
`20261109150000_subscription_auto_resume_paid_history.sql` replaces that same
function and chains its before-hash to the delivered-history replacement. The
order guard mirrors customer resume: `paid`, `fulfillment_pending` or `fulfilled`
orders block for a cycle of this subscription scheduled at `next_cycle_at`.
An associated order without a cycle blocks only for an unfinished renewal
operation (`claimed`, `reserved`, `attempt_prepared`) or activation (`provisional`).
Terminal operations (`succeeded`, `refused`) and activations (`active`,
`compensated`) do not keep that order in flight. Native shipment delivery leaves
an order `paid`; paid orders of past cycles and completed activations therefore
do not keep a timed pause open. Cancelled pause-closure orders do not block.
That follow-up retains every other guard, the event, date calculation, header
and ACL. The later `20261110105000_subscription_pause_duration.sql` replaces
auto-resume and the two-argument pause-reminder producer, chaining to their
exact replacement and creation pins. A timed pause shifts the stored next cycle
by the actual `ends_at - starts_at` duration and never brings it earlier.
Auto-resume takes `GREATEST(stored_next_cycle_at + duration, p_now)`; the reminder
uses the same shift clamped to the window end for `nextDeliveryAt` and `resumeAt`,
the date a punctual auto-resume executes. A STABLE invoker facts helper is shared
by the producer and retained-ledger delivery; PUBLIC execution is revoked and
only the service runtime receives execution. It reads existing window and cycle
facts without additional table privileges.
It removes the timed whole-cadence roll-forward while retaining all skip guards,
headers, owners and ACLs. Manual customer resume is unchanged. The
[duration witness](../../tests/postgres/subscriptionPauseDuration.test.ts) covers
reminder agreement and one ordinary renewal under replay. The
[delivered-history witness](../../tests/postgres/subscriptionAutoResumeDeliveredHistory.test.ts)
covers legacy and both qualified runtimes. Ineligible windows remain open without
writes or batch failure. Eligible windows shift the cycle monotonically, retain
one system event and close atomically. The result preserves native `skippedRows`.
The [workflow owner](SUBSCRIPTION_WORKFLOWS.md#lifecycle-and-retry) describes host
composition and the resumed-confirmation alias. The
[PostgreSQL witness](../../tests/postgres/subscriptionRetryResume.test.ts) covers
legacy and both qualified runtime generations.

### Terminal native notice refusals

Evidence: historical record, 2026-11-13. Not reader guidance.

The native lifecycle binding retains `subscription_notice_refusals` by the
original `(source, source_id)`, for event and reminder sources only. Its reason
is the existing `notice_policy_refused` code and its time is database-recorded.
A refusal is terminal, including after recipient, control or consent changes;
it never asserts a send or changes a transactional delivery receipt. The runtime
can insert and read this RLS-protected record, with no update or delete access.
Browser roles have no access. Connected capture and restore retain these opaque
source identities and their refusal times so a store move cannot send them again.
This table contains no recipient address, message content or free-form reason.


The [customer checkout-link forward](../../db/platform/migrations/20261110115000_customer_checkout_links.sql)
replaces only the actor find/issue bodies, retaining their attributes, defaults
and authenticated execution boundary. It adds an actor-owned fallback reader
and two service-only buyer routines, with no table, index, constraint or raw
DML grants. Provisional activation identity supplies initial checkout context;
a non-null native cycle refuses checkout recovery. Actor issuance preserves
prior links. Buyer issuance uses existing outbox uniqueness to commit its bucket
event and hashed token together, only for the winning event. Both check actual
time after blocking writes and roll back elapsed issuance. The additive buyer
delivery gate leaves automatic and operator authorizers unchanged. See the
[entry-point recipe](PLATFORM_PACKAGE_REFERENCE.md#customer-checkout-recovery-entry-points)
for the host authority boundary and configured deadlines.

### Checkout recovery lineage

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110170000_checkout_recovery_inspection.sql` adds nullable
`commerce_orders.recovery_root_order_id` and `recreated_from_order_id`, each with
an `ON DELETE RESTRICT NOT VALID` self-FK. Existing rows remain null; new writes
must satisfy both constraints. The partial root/created index serves the latest
reader, and the partial unique predecessor index permits one immediate replacement.
The two stable definer snapshots grant execution only to `service_role`, with no
new raw-table grants. Their [package composition](PLATFORM_PACKAGE_REFERENCE.md#checkout-recovery-inspection)
binds client ownership and separates expired inspection from payment authority.
This forward contains no recreation writer or historical backfill.

### Expired checkout preparation

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110180000_checkout_recovery_recreation.sql` adds the service-only definer
`commerce_prepare_expired_checkout_recovery(text,uuid,uuid,bigint,timestamptz)`.
It replaces no function and adds no table, lifecycle CHECK, trigger or backfill.
It uses the existing recovery lineage, draft receipt, destination, provisional
activation and sandbox payment owners. Its fixed path is `pg_catalog, pg_temp`;
PUBLIC, anon and authenticated have no EXECUTE grant. Exact linked replay precedes
fresh checks; a replacement with either lineage field already populated refuses
fresh preparation. The source payment/window checks follow blocking aggregate
locks. Runtime first payment admission also rechecks source evidence under the
source order lock before any replacement stock or payment write. A fresh initial declaration belongs to the replacement; the predecessor
is never reopened. See the [recreation composition](PLATFORM_PACKAGE_REFERENCE.md#expired-checkout-recreation)
for commercial validation, transaction binding, compensation and profile limits.

### Atomic checkout guidance read

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110220000_checkout_payment_guidance.sql` creates only
`commerce_checkout_payment_guidance_snapshot(uuid,uuid,uuid DEFAULT NULL)`.
The SQL/STABLE definer fixes `search_path = pg_catalog, pg_temp` and exposes only
service EXECUTE. It replaces no function and adds no table, trigger or backfill.
Pure joins read checkout provenance, token authority, native attempts and bounded
correlated observations/truth/readback evidence together. It neither calls a
materializing reader nor treats observed capture as completed settlement.
Current complete-installation inventories include the new function; historical
prefixes are unchanged. The [composition recipe](PLATFORM_PACKAGE_REFERENCE.md#atomic-checkout-payment-guidance)
owns capability opt-in, neutral normalization and the sandbox profile limits.

### Operator shipment evidence

Evidence: historical record, 2026-11-13. Not reader guidance.

The native `20261110230000_operator_shipment_commands.sql` forward adds three
bounded owned shipment commands and reuses the private operator receipt table.
It widens its kind CHECK, adds nullable provider identity to tracking references,
and expands reference uniqueness by provider while preserving duplicate-null
behavior. Explicit same-order reattribution retains displaced reference rows in
the private receipt; it performs no historical backfill. Existing runtime table
privileges and receipt privacy remain unchanged.

A fresh nullable operation actor column references the human principal with
`ON DELETE SET NULL`; historical actors stay null. The arrival recorder retains
its INVOKER header, owner, ACL and subscription-before-parcel lock order.
Ordinary arrival keys retain strict timestamp replay. The operator chronology
namespace permits earlier-only repair and retains the original arrival receipt.
No decision or status evidence alone calls replacement confirmation. See the
[shipment composition and limits](PLATFORM_PACKAGE_REFERENCE.md#native-operator-shipment-commands).

### Saved subscription destination selection

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110240000_subscription_saved_address_selection.sql` creates the owned
`subscription_select_saved_shipping_address` wrapper and replaces the existing
subscription destination reader, typed-address command and parcel-contact resolver
without changing their
headers, owners or ACLs. The wrapper retains principal/client ownership,
subscription-event replay precedence, shipping/both-kind validation and the
existing lifecycle/locked-cycle refusals. It persists the existing saved pointer;
a successful typed command clears it. This selection adds no column or raw DML grant;
the same forward also creates the private preference tables described below.
Only `service_role` receives EXECUTE on the new closed definer routines.

New subscription reads create an immutable snapshot of the selected saved row,
including its explicit ID and nullable recipient. Prior destination rows and
retained claims are unchanged; a future unclaimed renewal sees saved-row edits.
The public `read()` contract remains `Promise<DestinationDocument>`; the additive
`readWithSaved()` carries nullable saved snapshots. Typed address input still
requires a recipient. First parcel-contact capture preserves a null saved recipient
even with a nonempty label or current customer name; typed/legacy fallback remains
unchanged. Existing parcel contact ownership
and carrier-completeness checks remain decisive; frozen nulls are preserved.
Saved snapshots use the existing destination personal-data and finite-transfer
boundary. No new destination export/erasure path or blanket erasure coverage is
claimed. See [the package composition](../../packages/platform/README.md#saved-subscription-shipping-selection).


### Scoped customer preference data

Evidence: historical record, 2026-11-13. Not reader guidance.

The saved-selection forward also creates `customer_payment_preferences` and
`customer_delivery_preferences`, with client cascade, one row per client/scope,
recent-selection indexes, enabled RLS and owner-only raw access. Both are `block`
classified with the admitted service-role client-ID census grant and SELECT policy.
Owned definer routines provide principal/client-checked read/upsert, redacted
checkout hints, private renewal selection and explicit subject export/erasure.
PUBLIC and browser roles receive no routine or raw table access; only
`service_role` receives routine EXECUTE. Payment values and provider families are
closed, with a bijective adopter policy for public values; delivery stores the
configured provider reference separately. No account-event append, instrument or
provider action is performed by a preference save.

`commerce_prepare_subscription_renewal` is the only native fresh cycle-order
writer. Its listed replacement retains its header, ACL and complete body except
for passing new order metadata through the selector. Explicit selections are
preserved; complete subscription/any preferences precede the earliest anchor
order. No trigger is added. Claims, replay, payment selection, delivery alignment
and the monotonic schedule clamp retain their existing owners and behavior.

All preference columns, scope history and pickup/address JSON are personal data.
The required `customer-preferences` identity contributor exports exact rows and
erases by subject client, without relying on client clearing or cascade. Its
preparation lock precedes identity locks; waiting saves recheck ownership.
Other privacy vetoes and retained account events stay separately owned. No
retention period is supplied. Finite native capture/qualified restore carries exact
rows after clients, with unchanged replay. Legacy installations are capture
sources; the compatible-row copier is unchanged. Managed-source nonempty
preferences have no typed projection and explicitly refuse. See the
[composition recipe](../../packages/platform/README.md#customer-delivery-and-payment-preferences)
for the trusted checkout-client boundary, required billing-hint reader and
redacted `applied:false` defaults. No defaults are applied during import.

### Checkout attempt admission

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110250000_checkout_recovery_attempt.sql` creates the service-only
`commerce_checkout_recovery_attempt_begin(text,uuid,uuid,uuid,text,jsonb,timestamptz)`
and `commerce_checkout_inline_retry_begin(text,uuid,uuid,uuid,uuid,text,jsonb,timestamptz)`
entry points. Both fixed-path procedural definers lock the existing order and
intent, check checkout provenance and delegate to `payment_simulator_begin_attempt`.
Token payment rechecks its token identity; inline retry locks the exact active
attempt and compares its predecessor or durable transition replay. The latter
uses the existing request key/fingerprint for nonce/rail binding, without new
storage. Captured observations and renewal cycles refuse both mutations.

Only service EXECUTE is granted, after all PUBLIC revokes and grouped role
revokes. No existing function, table, trigger, column or historical row is
changed. The ordered plans append one unit containing both entry points;
current complete inventories advance while issued and released prefixes remain
fixed. See [token payment](PLATFORM_PACKAGE_REFERENCE.md#checkout-token-payment)
and [exact inline retry](PLATFORM_PACKAGE_REFERENCE.md#exact-inline-checkout-retry).

### Customer billing profile and invoice buyer data

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110260000_customer_billing_profiles.sql` adds private
`customer_orderer_profiles`: client cascade, contact/company/tax fields,
verification provenance, source, timestamps, length/enum checks, client/update
index and one-default-per-client partial uniqueness. It is `block` classified
with the exact service-role client-ID census exception. Customer CRUD/default
routines recheck the native principal/client pair. No raw profile grant exists.
Defaults, writes and account-event appends retain separate-commit failures and
stored-but-not-deduplicated request identifiers.

The simplicity pre-check rejects reusing the existing full-facts installer as
the request freeze point: request and installation are separate native calls.
The selected billing invoice-store factory uses the owned
`customer_billing_capture_invoice` transaction to delegate invoice request
ownership. Capture itself now freezes one `invoicing_buyer_snapshots` row for
every new original duty, including direct, payment-truth and sweep paths.
Selection is order facts, then default/latest profile and billing/both address,
then marked shipping fallback. Paid capture uses the order destination; handoff
capture uses the owned parcel destination. Later full fiscal composition reads
the component; the selected installer checks its retained fields before calling
the existing immutable full-facts owner. The later first-duty capture forward
below also installs this component on the native payment path. The selected
retained-source sweep calls the same atomic wrapper.
Creation eligibility is checked under the existing invoice order advisory lock;
a prior duty or document never acquires a component on replay, including an owed
duty without installed facts. Historical obligations receive no component backfill. The public
buyer contract adds optional fields only, and provider projection carries line2
and provenance without flattening or fabrication. This profile-storage forward
replaces no existing function, trigger, grant or fiscal policy.

Contact/tax/company/verification/source values, linked events and frozen buyers
are personal data. The explicit `customer-billing` contributor exports both
new tables, erases subject profiles through an owned routine after preparing
relation locks, and retains frozen buyers under the existing rule:
[Invoices are retained outside identity](IDENTITY.md#identity-personal-data),
with document export, retention and processor handling supplied by invoicing.
There is no default statutory duration or new erasure claim for financial facts.
Identity field clearing and client cascade are insufficient coverage; account
event retention remains separately owned. Other subjects remain unchanged.

Finite native capture classifies both new tables as owned rows, outside the
smaller compatible-row utility. Qualified restore inserts profiles after clients
and components after invoice duties, with exact row/replay witnesses. Legacy
is capture-only. Unsupported nonempty managed-source profile relations refuse
rather than disappear. No restore applies profile defaults, rewrites invoices,
performs fiscal/provider work or activates a target. See the
[package recipe](../../packages/platform/README.md#customer-billing-profiles-and-frozen-invoice-buyers)
for explicit ports, handler binding and the required privacy contributor.

### First-duty invoice buyer capture

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110270000_invoicing_duty_buyer_capture.sql` replaces only
`invoicing_capture_duty(text,text,uuid,uuid,jsonb,timestamptz)`, retaining its
installed header, owner, search path and ACL. It delegates to the new closed
`invoicing_capture_duty_with_buyer` routine. The latter preserves capture
validation, the order advisory lock and source/key receipts, and freezes the
existing buyer component only for its own fresh original-duty insertion.
An existing original document suppresses selection too. No duty or invoice is
backfilled, even if an older owed duty has no full facts yet.

The selection is the existing lossless billing rule: order buyer facts, then
the owned default/latest profile and billing-or-both address, then the marked
shipping fallback. The second address line and selection provenance remain in
`invoicing_buyer_snapshots`. The component and duty commit atomically; a failed
component insert rolls both back. Payment truth passes exactly its existing
inputs and keeps its existing bounded capture-fault/retry behavior. Payments
receives no account-data reader, callback or grant. There is no opt-in: first
native capture uses this rule, including the fallback when no profile exists.

Only `service_role` receives EXECUTE on the new definer routine. Its direct call
has the same fresh-insert guard, so it cannot be used to backfill a duty. Browser
roles remain denied; no raw table grant, table, trigger, status or public type
is added. The selected billing store reads the frozen component and validates
later host fiscal facts; it never rereads a mutable profile for that duty.
Edits affect later captures and cannot rewrite requested facts or issued bytes.
The existing billing privacy contributor, invoice-document retention owner and
exact finite transfer/qualified restore coverage continue to cover these rows.

A new source whose destination was never recorded refuses with the existing
`commerce_destination_unavailable` result and leaves no duty, buyer component
or source receipt. Record the owned order destination before retrying retained
capture; no address is inferred from another customer or field. Payment truth
continues to commit money and record its bounded capture fault independently.

Handoff capture must name a shipment owned by the order; otherwise it refuses
with `customer_billing_shipment_mismatch`. Destination reads use the existing
owner's locks; other buyer-selection lookups are plain reads. These reads remain
inside the payment owner's bounded, absorbed capture subtransaction when called
from payment truth.

Correct missing destination or shipment data while the capture fault remains
retryable. The sweep stops rediscovering a source after its eight-attempt ceiling
marks it `faulted`. There is no supported operator reset/requeue command: merely
recording a destination after that point does not resume the source. Escalate for
an invoicing-owned recovery procedure; do not edit or delete ledger rows to reset
it. Settled money and historical documents remain unchanged.

### Checkout recreation buyer snapshot repair (slot 28)

Evidence: historical record, 2026-11-13. Not reader guidance.

`20261110280000_checkout_recovery_buyer_snapshot.sql` replaces only
`commerce_prepare_expired_checkout_recovery(text,uuid,uuid,bigint,timestamptz)`.
Its installed header, owner, `pg_catalog, pg_temp` search path and ACL remain
unchanged. The forward adds no table, grant, trigger or backfill.

Fresh preparation copies a recorded source `invoiceBuyerSnapshot`, preserving
its JSON value exactly. A nonempty `runtimeFinalize.invoiceBuyerSnapshot` keeps
its existing precedence over the top-level snapshot; recorded empty objects
remain explicit. When neither source contains a snapshot, preparation adds no
snapshot key. Runtime metadata and lineage fields retain their existing behavior.

The first-duty buyer rule remains unchanged: an explicit object, then the owned
billing profile/address, then the marked shipping fallback. A recreated order
without explicit buyer facts can now reach those existing fallback branches.
Preparation replay never rewrites its linked replacement, and later profile or
address edits cannot change the buyer frozen by first capture. Historical orders
and previously captured duties are not repaired or reselected.
