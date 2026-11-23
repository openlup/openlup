# Data And Migrations

Status: maintainer page: how to change OpenLup. Reader guidance lives in the [OpenLup guide](../../packages/core/docs/guide/README.md); frozen historical evidence (2026-11-13) is archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md).

Quick navigation: [Find current SQL definition](#find-the-current-sql-function-definition) · [Additive forward path](#additive-forward-release-path) · [Database fixtures & witnesses](#database-test-fixtures-and-witnesses) · [Exact reviewed forwards](#exact-reviewed-function-forwards) · [Co-located SQL & pins](#co-located-sql-and-approval-pins) · [Closed native store forwards](#closed-native-store-forwards) · [Compatible data transfer](#compatible-data-transfer) · [Compatibility lifecycle](#compatibility-lifecycle) · [Archived evidence](history/data-and-migrations-evidence-2026-11-13.md)

## Find the current SQL function definition

From the repository root, print the portable manifest's baseline followed by its
ordered forwards, then search declarations for the exact function name:

```sh
node --input-type=module -e 'import { readFileSync } from "node:fs"; const m = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")); for (const unit of [m.baseline, ...m.forward]) console.log(unit.file);'
rg -n -i '^[[:blank:]]*CREATE[[:blank:]]+(OR[[:blank:]]+REPLACE[[:blank:]]+)?FUNCTION[[:blank:]]+(public\.)?subscription_auto_resume_due[[:blank:]]*\(' db/platform/migrations
rg -n -i '^[[:blank:]]*DROP[[:blank:]]+FUNCTION[[:blank:]]+(IF[[:blank:]]+EXISTS[[:blank:]]+)?(public\.)?subscription_auto_resume_due[[:blank:]]*\(' db/platform/migrations
```

No matching DROP exits 1; that is not a declaration-search failure. Read complete
statements, including multiline headers. Compare full signatures, not just names:
overloads are separate functions. Follow CREATE/replacement and DROP statements
in manifest order, ignoring files outside the selected chain. For qualified
installations, select that generation's baseline/forwards through the manifest
selection used by the runner. For a partly applied database, stop at its exact
applied ledger prefix. Managed SQL has its own baseline and ordered forward
chain; never mix the two rails. Calls, GRANTs and dated evidence do not identify
the current definition.

At this revision the last portable declaration of
`subscription_auto_resume_due(integer,timestamptz)` is in
[`20261114110000_payment_method_refs.sql`](../../db/platform/migrations/20261114110000_payment_method_refs.sql).
Its date assignment takes `GREATEST(stored_next_cycle_at + pause_duration, p_now)`;
it does not move the cycle earlier. Read its guards and writes as well as the
assignment. Earlier declarations describe earlier prefixes. Verify behavior
through the [pause-duration witness](../../tests/postgres/subscriptionPauseDuration.test.ts)
and the [recorded-method witness](../../tests/postgres/paymentMethodRefsPgtap.test.ts),
rather than requiring any particular textual spelling of the clamp.
Installed readers follow the
[package-local lookup](../../packages/core/docs/guide/upgrade/database-migrations.md#find-the-current-function-definition).

## Native outbox partial indexes and atomic label/address RPCs

The [outbox active partial indexes forward](../../db/platform/migrations/20261124100000_outbox_active_partial_indexes.sql)
(mirrored byte-for-byte in `@openlup/platform/sql` and `@openlup/outbox/sql/0002_outbox_active_partial_indexes.sql`)
adds three partial indexes on `public.outbox_events` scoped to active rows
(`pending`, `processing`, `failed`) so `outbox_claim_batch` and
`hasPendingEventType` stay bounded by active rows even when terminal rows are
retained indefinitely.

The [atomic label and address upsert forward](../../db/platform/migrations/20261124110000_shipment_label_and_address_upsert_atomic.sql)
adds two additive RPCs:

- `public.fulfillment_record_label_atomic(text,uuid,text,text,jsonb,timestamptz)`
  (`SECURITY INVOKER`, `SET search_path = public, pg_catalog`) executes the
  `packed` -> `label_pending` -> `label_created` transitions and optional
  `label` evidence recording in one transaction while preserving the historical
  `:packed`, `:label-pending`, `:label-created`, and `:label-evidence`
  idempotency keys.
- `public.customer_saved_address_upsert_atomic(uuid,uuid,text,text,boolean,text,uuid,text,jsonb,jsonb,timestamptz)`
  (`SECURITY DEFINER`, `SET search_path = pg_catalog, pg_temp`) executes
  ownership verification, idempotency replay, optional default clearing,
  canonical lookup, address write, account event append, and final read in one
  atomic transaction, rolling back default clearing and address writes on
  failure.

Both functions revoke `PUBLIC`, `anon`, and `authenticated` privileges and
conditionally grant `EXECUTE` to `service_role`.

## Native fulfillment shipment lock order

The [shipment lock-order forward](../../db/platform/migrations/20261124090000_fulfillment_advance_shipment_lock_order.sql)
replaces `public.fulfillment_advance_shipment(text,uuid,text,jsonb,timestamptz)`
in place with the same signature, `SECURITY INVOKER` posture, ACLs and pinned
`public, pg_catalog` search path. When a shipment belongs to a subscription
cycle, it acquires `FOR UPDATE` on the parent `public.subscriptions` row before
locking `public.fulfillment_shipments`, matching the canonical delivery-alignment
lock order (`subscriptions` -> `fulfillment_shipments` ->
`subscription_delivery_alignment_cases`) and preventing `40P01` deadlocks against
concurrent renewal admission. One-time shipments (`subscription_cycle_id IS NULL`)
skip the subscription lock and retain identical transition, refusal and
idempotency behavior.

## Native activation edit window

The native `20261123120000_subscription_edit_window_activation.sql` forward adds
an invoker activation entry point and commit helper with `_with_edit_window`
suffixes. Their optional final integer defaults to NULL, which explicitly uses
72, matching the column default; explicit input must be 1–720 and refuses
with `subscription_activation_edit_window_invalid` before writes. The value is
stored in the initial subscription INSERT. Existing rows, cycle dates and edit
fences are unchanged. Completed activation replay retains the stored value.

A defaulted overload of the existing name makes PostgreSQL reject legacy calls
as ambiguous even with typed arguments. The distinct names preserve existing
function identities. This forward never redefines or changes privileges on
either predecessor: their bodies, owner, ACLs and search paths remain identical.
Old activation and repair callers retain their existing behavior and column
default of 72. Each new function contains its predecessor's body with the edit
window input; the new entry point uses the new commit helper. Neither legacy
function calls the new functions, and neither new function calls a predecessor.
Both new functions use SECURITY INVOKER with the pinned `public, pg_catalog`
search path. They revoke PUBLIC privileges, conditionally revoke anon and
authenticated, and conditionally grant EXECUTE to service_role using the admitted
constant `pg_roles` blocks. Opting in requires EXECUTE on both new functions;
service_role receives it where present, and owner-run self-host installations
have it as owner. The TypeScript binding calls the unchanged predecessor when
`editWindowHours` is omitted. The starter always passes its owned
`subscriptionCreation.editWindowHours`, including 72, so it opts in.
The mirrored package SQL and three native manifest selections bind the same
bytes; only current inventories are remeasured.

The managed chain has no native `subscription_activate_from_captured_payment`
equivalent. Its separate `subscription_activate_from_paid_checkout_order` uses
managed payment intents and subscription composition; it still supplies 72.
That separate boundary and its provisional/starter path are unchanged here.
The [activation witness](../../tests/postgres/subscriptionActivationEditWindow.test.ts)
proves default and legacy compatibility, zero-write refusal, frozen replay and
the existing command edit fence. A 72-hour cutoff closes earlier than 24 hours,
as the installed fence subtracts stored hours from the next cycle instant.

## Native renewal stock protection

The [renewal credit aggregation forward](../../db/platform/migrations/20261123147000_inventory_atp_aggregate_renewal_credits.sql)
groups live renewal holds by subscription and scheduled cycle before matching
due demand. The calculation credits only holds for the exact cycle that still
needs stock, floors each subscription at zero, and leaves hard holds, channel
exposure and renewal priority intact. The function retains its signature,
privileges and search path. Callers retain their existing transaction and stock
row locking.

The [inventory validation forward](../../db/platform/migrations/20261123142000_inventory_renewal_protection_validation.sql)
creates `public.inventory_renewal_protection_validate(jsonb)` and replaces the
body of `public.inventory_renewal_protection_days()`. The validator preserves
the revision text and normalizes the horizon to an integer. Invalid input and
malformed stored JSON retain SQLSTATE `22023` and
`inventory_renewal_protection_policy_invalid`. The reader still returns 14
for an absent row and retains its owner, ACL and pinned search path. Where
`service_role` exists, it has permission to execute both the validator and the
horizon reader. Both qualified runtime profiles inherit that grant.

For a custom runtime role with a direct horizon-reader grant, the validator
grant is optional for ATP. Add it for connected settings validation or preview
(substitute the host's role):

```sql
GRANT EXECUTE ON FUNCTION public.inventory_renewal_protection_validate(jsonb) TO runtime_role;
```

The pure validator reads no table. Direct calls without the validator grant
raise SQLSTATE `42501`.

`inventory_new_purchase_stock_read` calls native ATP inside a single STABLE
statement, so ATP reads settings and stock against the same snapshot. Its
TypeScript `readInstalled` entry takes only the SKU list.

The [preview forward](../../db/platform/migrations/20261123152000_inventory_new_purchase_stock_preview.sql)
adds `public.inventory_new_purchase_stock_preview(text,jsonb,timestamptz,jsonb)` for
proposed-horizon estimates. It uses caller stock permissions and the existing
validator, with EXECUTE granted to `service_role` where that role exists. For a
custom connected preview role, grant EXECUTE on this function in addition to its
existing stock and validator privileges.

Update the preview function in the same change as the installed availability
computation, as enforced by the parity witness in
[inventoryRenewalProtectionPolicy.test.ts](../../tests/postgres/inventoryRenewalProtectionPolicy.test.ts).

## Data ownership

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

The source tree deliberately ships an unbound database-type seam at
`src/integrations/supabase/types.ts`; replace it with adopter-generated types
before enabling database adapters. It is not evidence of schema compatibility.

Frozen historical record (2026-11-13) archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#data-ownership-archived-evidence).

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
Both registration functions use owner-only SQL units for locking, validation
and storage, and the shipping variant uses an owner-only unit to normalize
retained facts. A completed attachment reader exposes the retained terms; no
current-settings read or additional agreement table is introduced. Graduation uses existing subscription,
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

Connection composition must preserve the selected installation's principal/grant
contract; transport separation grants no runtime DDL or migrator isolation.
The qualified-v2 profile requires its declared privileged migration principal.
Qualified-admin provisioning and role-graph admission belong to
[module catalogues and installed histories](../../packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue).

Frozen historical record (2026-11-13) archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#connection-roles-archived-evidence).

## Native base-price writes

The unbound native base-price writer follows the readiness-input unit in the
complete catalogue at position 150. Its [package projection](../../packages/platform/src/catalog/sql.ts)
is a sparse descriptor, not an install chain. The migration adds a catalogue-local
receipt relation and human-session preview/apply routines. No catalogue or
subscription row is backfilled and no capability is activated. Existing readers
retain ordinary price-entry storage; new callers explicitly bind the
[pricing use case](../../packages/platform/README.md#pricing).

Receipts and price history are authoritative connected-store transfer data.
Capture and restore exact command keys, fingerprints, actor metadata and original
responses; a restored completed command replays before target reads. The receipt
relation contains no customer foreign key. Runtime/browser table access remains
denied; the bounded routines derive the active human administrator from the
verified session. Readiness only selects and hard-refuses unavailable native
proof, including cohort membership and historical order protection.

The writer preserves the existing ordinary-reason aggregation defect. A reason
already present before a write does not block another occurrence of that reason;
hard evidence failures are exceptions and cannot be bypassed this way. See the
[writer witnesses](../../tests/postgres/catalogBasePriceWriter.test.ts) for
rollback, replay, provisional-write visibility and a committed change preserving
native subscriber money through renewal, edit reads and actual resume.

The managed rail does not supply this feature. Its twin needs separate SQL
admission and equivalent administrator/RLS, input-provenance and receipt controls
over incumbent managed tables; it must not infer historical evidence from a
current catalogue head. Industry-specific managed catalogue columns are unaffected.

## Native catalogue purchase admission

The base and promoted draft routines share scoped receipt verification and
classify fresh demand using installed catalogue facts. Fresh governed demand
returns `catalog_admission_quote_authority_required`. The component assertion
checks current owner evidence and provides no purchase authority. The three
checkout-owner definitions are owned by the migration principal, pin
`pg_catalog, pg_temp` and grant no application role execution. The private
draft entry keeps fresh governed purchase unavailable.
`catalog_admission_runtime_checkout(text,text,uuid,jsonb)` grants EXECUTE only
to `service_role`, and only when that role exists. Nothing calls the routine
yet. It refuses every invocation with SQLSTATE `55000` and
`catalog_admission_quote_authority_required` before reading or writing purchase
data. The existing checkout-owner controls supply no governed checkout authority.
Draft replay checks the original owner and receipt before fresh admission
advice. Fresh recovery refuses at the lineage writer when the original order
retains an acceptance or when live classification finds governed demand in its
lines; either condition alone refuses.

The managed rail does not supply governed purchase admission, and its drafts remain legacy-only.

Both draft routines replay a saved receipt first, under the request key's
transaction advisory lock and the receipt row lock, and take no catalogue lock
for it. Fresh work then runs
`catalog_admission_check_legacy_draft(text,jsonb,uuid,boolean)`, which takes
the same locks whatever its last argument: the client row and the selected SKU
rows `FOR KEY SHARE`, then `SHARE` on `public.catalog_products` until the
transaction ends. A promoted draft takes these locks before validating its
money. The `SHARE` lock waits while a publication holds the catalogue fence.
If that wait exceeds the caller's `lock_timeout`, the draft returns `55P03`.
After a completed wait at `READ COMMITTED`, a draft whose demand the
publication made governed returns `55000` before any money validation. At
`REPEATABLE READ` or `SERIALIZABLE` the checker also locks the selected parent
product rows `FOR NO KEY UPDATE`. That guard returns `40001` when a publication
changed the product row after the caller's snapshot; retry the draft in a new
transaction. Only the publisher locks with `NOWAIT`, and its fence returns
`55P03` while a fresh draft holds the `SHARE` lock. A direct checker call with
`false` or `NULL` now also takes these row locks and refuses in a read-only
transaction with `25006`.

The private submit member binds the original authenticated request to the native
draft receipt. The existing deferred order and receipt checks protect committed
evidence and preserve nullable historical acceptance. A restore preserves both
the original proof and historical absence.
Unbind callers to roll back use; retain committed receipts/history and correct a
price with a subsequent expected-base command.

### Admission fence lock order

The native fence runs under `REPEATABLE READ`. Mixed writers take commerce
guards before catalogue locks. Catalogue-only writers take no client locks.

1. The fence pins its snapshot with the exclusive nonce advisory lock, then
   takes the exclusive key advisory lock. The destination `prelock` takes
   ledger `SHARE`, client `FOR KEY SHARE`, selection, policy and service guards,
   then document. Lock rows in ascending key order within each group. Returned
   keys can bound those locks.
2. The fence locks the receipt `FOR UPDATE`, then client, sorted SKUs and
   sorted revisions `FOR KEY SHARE`. The client's mode matches the hook's.
   It locks `catalog_products` and `price_lists` in `SHARE`, takes the exclusive
   transaction advisory lock for each sorted list/SKU pair, then takes
   `price_entries` in `SHARE`. Price apply takes the same advisory lock.
3. After all locks, run the visibility probe. Start `read` with native
   authenticated replay, then evaluate fresh owner facts under the same locks.
   `catalogAdmissionFence.ts:223–250`,
   `20261125010000_catalog_purchase_admission.sql:2–24,58–94`.

On hook expiry, the fence discards the writer connection and releases the
probe. The fence key is released within the hook budget plus the wall margin
plus two round trips of the writer connection. Writer connection latency
delays delivery of the timeout settings and the lock request to PostgreSQL.

- **Erasure.** The privacy store takes the ledger in `SHARE ROW EXCLUSIVE`,
  then the identity challenge relation in `EXCLUSIVE` before its subject locks.
  Destination erasure locks the client `FOR UPDATE`, removes selections and
  updates documents. `postgresPrivacy.ts:10–24,46–52`,
  `20261125100000_commerce_destination_v2_checkout.sql:369–383`.
- **Destination receipt and issuance.** The receipt takes its scoped exclusive
  advisory lock, ledger `SHARE`, and, for a fresh receipt, client `FOR UPDATE`.
  Issuance takes those guards before inserting the fresh document, upserting the
  selection and committing the scoped receipt. Expiry takes ledger `SHARE`, then
  client, selection and document `FOR UPDATE`, in client and snapshot order.
  `20261125080000_commerce_destination_v2_receipts.sql:102–132,136–195`,
  `20261125100000_commerce_destination_v2_checkout.sql:139–148,220–231,398–419`.
- **Stage B publication.** It takes candidate and command advisory guards, then
  sorted draft heads `FOR NO KEY UPDATE`. Publish takes `SHARE ROW EXCLUSIVE
  NOWAIT` on `catalog_products`, `catalog_skus`, `catalog_sku_identifiers`,
  `catalog_product_document_revisions` and `catalog_attribute_projection` in that
  order, including through the restricted projection helper. Product, publication
  head and sorted SKU rows follow with `FOR NO KEY UPDATE NOWAIT`.
  Later, the unrestricted path claims price receipts in key order and takes
  sorted exclusive list/SKU advisory locks before staging and applying prices.
  The restricted path uses the atomic price apply routine for each operation.
  Both verify effective entries `FOR NO KEY UPDATE`. After applying prices and
  verifying entries, the restricted path takes sorted exclusive list/SKU
  advisory locks before checking readiness. This includes effective-list
  contexts for SKUs without a price operation.
  `catalogPublicationCommands.ts:133–172,214–221,249–258`,
  `catalogPublicationProjection.ts:80–86,184–215,266–295,403–406,458–466`,
  `q2_20261123192500_catalog_publication_authority.sql:15–21,92–105`.
- **Base price.** Apply claims the receipt by insert or existing-row
  `FOR UPDATE`, takes the exclusive list/SKU advisory lock, and locks the open
  entries `FOR NO KEY UPDATE` before closing and inserting rows. Preview
  writes `price_entries` within a subtransaction and rolls it back.
  `20261123191000_catalog_publication_commands.sql:191–221,281–289,323–331,362–374`,
  `20261122180000_catalog_base_price_writer.sql:539–552`.

### Accepted catalogue references and archive

The purchase and edit owners may save an accepted SKU revision alongside their
receipts. The reference resolves against the revision's issuing publication,
including its document, type definition, options and net content. A nullable
same-SKU foreign key protects the template binding. Unbound rows retain NULL.
Deferred checks reconcile staged order and edit records with their companions
at commit. Transfer carries both the accepted references and their companions.

Register renewal purchase facts using the accepted draft's SKU codes and
quantities. Native completion uses those stored lines to create an empty
subscription's first template and bind its accepted revisions before completing
the attachment. A worker recovering a pending attachment uses the same
completion with the original order ID.

The freeze owner saves acceptance beside the snapshot and binds it to the
operation fingerprint. Renewals keep the existing v1 and v2 pricing formats.
The renewal owner still uses subtotal less discount plus shipping, with no
tax term. The quote owner still carries gross prices and one VAT rate where
required by the sized-plan quote. Destination references remain opaque.
Catalogue checks use the stored owner evidence and compare SKU identity and
quantities. Governed SKU facts carry physical quantities and base prices stay
with the pricing owner.

An edit or full starter graduation that rewrites template or retained lines
without a new acceptance clears the template revision bindings and retained
acceptance in the owner's transaction. An operation already frozen retains
its original acceptance on replay.

| Refusal | Remedy |
| --- | --- |
| `catalog_accepted_reference_invalid` | Supply a schema-2 accepted reference with exactly the supported fields. |
| `catalog_accepted_reference_mismatch` | Capture the reference from the SKU revision's issuing publication. |
| `catalog_retained_revision_unavailable` | Recover the issuing publication and SKU revision from the retained catalogue. |
| `catalog_acceptance_invalid` | Supply a schema-2 acceptance with 1 to 100 distinct SKU identities and codes. |
| `catalog_acceptance_line_mismatch` | Register matching purchase lines from the persisted draft, preview and apply a fresh edit quote, or rebuild the snapshot from the current due subscription. Follow the SQL hint for the operation that refused. |
| `catalog_acceptance_receipt_mismatch` | Use this order's persisted draft receipt and its original key. |
| `catalog_acceptance_snapshot_mismatch` | Use the stored renewal operation, its original acceptance and its frozen snapshot. |
| `catalog_acceptance_snapshot_immutable` | Replay the renewal operation with its original acceptance and frozen snapshot. |
| `catalog_acceptance_immutable` | Replay the owner command with its original acceptance and evidence. |
| `catalog_acceptance_order_missing` | Persist the order and its draft receipt before attaching the acceptance. |

The archive census reads active and paused templates and retained terms,
pending activation and attachment, frozen and recoverable renewals, outstanding
orders, undelivered leaf replacements, stock waits and unconsumed graduation.
Outstanding or ambiguous evidence refuses archive. A complete empty census
still returns `catalog_archive_barrier_unavailable` until the admission barrier
is qualified.

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
[package catalogue owner](../../packages/platform/README.md#catalog) for explicit
install executors, readiness observations and the unbound write guard.

The native [subscription profile forward](../../db/platform/migrations/20261124230000_subscription_profiles.sql)
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
[package catalogue owner](../../packages/platform/README.md#catalog) for the driver
and the [catalogue lock order](CANONICAL_CONTRACTS.md#catalogue-lock-order).
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
[package catalogue owner](../../packages/platform/README.md#catalog) describes
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
canonical-input bound remains separate. See the [catalogue package owner](../../packages/platform/README.md#catalog)
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
See the [package catalogue owner](../../packages/platform/README.md#catalog) and
[catalogue lock order](CANONICAL_CONTRACTS.md#catalogue-lock-order).

The experimental [compatible-row utility](../../packages/platform/src/portability/postgresRows.ts)
transports data into an already qualified canonical target. It does not restore
managed internals, source roles/grants or `platform_schema_migrations`. Source
and target transaction capabilities remain host-owned; an opaque catalogue label
does not prove that an installation is compatible. Identical typed rows replay,
and changed retained rows refuse rather than becoming business status updates.
The copier admits the pinned validation-only INSERT triggers on renewal terms
and operations. They run during replay. Other enabled user INSERT triggers
require the table's restore owner.

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
[`transfer_round_trip_matrix`](../../tests/postgres/connectedStoreCatalogDrafts.test.ts)
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
[migration note](../../packages/platform/CHANGELOG.md#100) records its managed design.

None of these four relations references `public.clients`, so no client
absorption-policy entry applies. Revision `actor_id` is an opaque operator
identifier and can be personal data; free-form draft payloads can also contain
personal data. These retained rows belong to the same sensitive transfer stream
and host access/exclusion requirements as other owned rows. Carrying them adds
no subject export or erasure contributor: the existing
[personal-data coverage limits](IDENTITY.md#retained-responsibilities) still
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
under [module catalogues and installed histories](../../packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue).
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

### Private delivery-contact transfer

The finite native graph includes `fulfillment_order_contacts` and
`fulfillment_contact_correction_receipts` after their order/client/shipment parents.
Qualified restore preserves exact rows, retained responses and payload-free erasure
markers; replay applies no correction, provider call or default selection. These
private tables have RLS and only the existing service-role client-column census
exception. They are outside the smaller compatible-row utility. The parcel-contact
privacy contributor owns their export and erasure alongside parcel contacts.

### Native destination receipt authority

The [destination receipt forward](../../db/platform/migrations/20261125080000_commerce_destination_v2_receipts.sql)
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

The [checkout destination forward](../../db/platform/migrations/20261125100000_commerce_destination_v2_checkout.sql)
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
[catalogue agreements](CANONICAL_CONTRACTS.md#catalogue-extension-agreements).

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
[round-trip witness](../../tests/postgres/policyCloseDigest.test.ts) compares full
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
[installed coverage operation](../../packages/platform/README.md#install-and-inspect-tax-coverage).
The runtime has execution access to the scoped reader alone. The reader's
arguments filter a trusted host's query scope.

Use opaque operator and acknowledgement references. Actor references can be
personal data. Existing identity privacy operations do not export or erase
this operator audit history. There is no customer link for absorption.

The forward is native-only. A connected settings read on the managed rail
refuses with `commerce_setting_read_unavailable`. Use a qualified native
PostgreSQL installation with a host-bound reader to inspect this history.

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
release. This forward preserves that FK; see the [owner step](../../packages/core/docs/guide/how-to/build/customize-the-starter.md#provision-operator-rosters).
The starter binds hold and release with a fresh human-admin and Commerce-operator check on every command and replay.

## Additive forward release path

A release may append expand-only platform forwards to either chain:

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

### Sealed native catalog publication history

The [membership read forward](../../db/platform/migrations/20261124120000_catalog_publication_reads.sql)
adds a service-executable page and owner-only evidence helpers. The page uses
the caller's statement snapshot. Its cursor binds the latest sealed issue
across governed products. See the installed
[catalogue entry](../../packages/platform/README.md#read-governed-offer-memberships)
for paging and refusal behavior.

The [readiness forward](../../db/platform/migrations/20261124140000_catalog_publication_readiness.sql)
adds a batch read executable by the service role. The snapshot and price
helpers are owner-only.
Outside a `READ COMMITTED` read-write transaction it refuses before locking.
Otherwise it takes `SHARE` on `catalog_products`, which conflicts with the
publication writer's first lock, and reads in a separate statement snapshot.
For each selected product, it uses the current-publication reader's matcher to
compare the live product and its SKU roster with the sealed evidence. A
mismatch refuses the batch.
It writes nothing. See the
[catalogue entry](../../packages/platform/README.md#read-activation-readiness).

**Qualified publication authority**

The [catalogue read grant](../../db/platform/migrations/20261124180000_catalogue_read_grant.sql)
requires the cluster login and the database's exact qualified-v2 publication
authority ledger entry. See the [closed native store grant shape](#closed-native-store-forwards)
for the pinned functions and ledger check.

| Installation profile | Effect on `openlup_catalog_publication` |
| --- | --- |
| Qualified-v2 bootstrap migrator | Grants both read entry points |
| Qualified-v2 separate migrator | Grants both read entry points |
| Legacy | No-op |
| Qualified-admin installer-managed | No-op |
| Qualified-admin operator-provisioned | No-op |

Both qualified-v2 role modes receive the grants. Where provisioned,
`service_role` retains both reads.

The [`catalog_publication` forward](../../db/platform/migrations/20261123190000_catalog_publication.sql)
adds native publication history.
The publication, SKU revisions, operator receipts, and candidate decisions are
immutable retained history. The head holds the latest issue for each governed
product. Native transfer carries all five tables and restores them through the
same deferred constraints as owner inserts. It carries the existing document value through an explicit column
projection. A document enters publication by its exact reference and the
opaque bytes of its original draft operation. Pointer capabilities are
transaction-local and must be empty on capture.

The publication assertion checks the exact document and draft evidence, the
candidate's current approval, the immediate predecessor, the resolved SKU
roster, response size and the original command result. Approval records the
expected product and SKU facts. An issue must match those facts, and the latest
issue must also match the live product and SKU projections, including the legacy
whole-gram net weight that quote readers serve, so it publishes net content in whole
grams at scale 0. A candidate with an issue keeps its approval, so a later
revocation refuses and needs no action. Decision transitions
use the existing draft head to serialize with issuance, including before the
product exists. Capture and exact restore replay apply the same read-only
admission checks. Live product and SKU facts use the retained projection decoders.

Runtime roles, application principals and roles they can assume cannot insert,
update, delete or truncate any of these six relations. The schema owner,
migration role and superuser are trusted with destructive operations. The pinned
row constraints still protect owner inserts, changes to saved history and
retargeting of pointer authorization at commit or when made immediate. A saved
command result has an immediate size bound. The deferred receipt, decision and
publication events use the same checked text before comparing the original
result. Invalid saved result text refuses the entire transaction. Work on
an issue scales with the predecessor roster and issued SKU facts, with a sort
for canonical order. SKU, receipt, head and pointer events use their indexed
keys. Deferred triggers run per affected row, including in bulk restore. The live SKU event decodes each changed facts value.
Decision events use the candidate and event-order index to check adjacent
transitions and the candidate's current decision.

A product can retain up to 10,000 SKUs. Native transfer also limits a packet to
10,000 rows across its retained tables, including both live and retained SKU
rows. A product that fits the read limit can therefore exceed the transfer
limit. Exact reads bind the stored issue,
document and original result by key. Admission and selected reads use the same
native product and SKU checks. Stored reads do not re-run preparation rules,
such as the refusal of a copied authored document. Data sealed outside the
writer path is the importer's responsibility. Current and legacy reads select observation
fields for the bounded roster. A full page checks at most 100 SKU sizes and
loads only the selected SKU revisions, up to the 8 MiB response limit.

Apply the complete native chain before binding native publication reads.
The [publication commands forward](../../db/platform/migrations/20261123191000_catalog_publication_commands.sql)
adds an owner-only recorder for operational decisions and issuance. It appends the
issue, receipt, head and outbox event in the transaction that applies the approved
effects. The same deferred admission checks validate those writes at commit.

Publication reserves canonical GTINs across issuers for marked identifiers and
reserves option combinations across all statuses for published SKUs. The
identifier marker is nullable. Existing rows retain their issuer-scoped
keys. New publication checks existing identifiers under the catalogue relation
fence. A later unmarked legacy write may share a GTIN with another issuer.

A managed implementation can use the same relations, composite keys and
deferred checks, with owner-only writes under row-level security and
session-derived human membership. Category-specific storage remains with the
adopter. The managed rail does not supply this feature.

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
owns delivery admission. The native composer
[`createNativeSubscriptionBinding`](../../packages/platform/src/subscriptions/nativeSubscriptionBinding.ts)
wraps its renewal store with that decorator, so a host composing the native
runner through it gets delivery admission installed.

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

The published `@openlup/platform` package includes the sandbox simulator export and its
matching native forward, `20261101222000_sandbox_payment_attempts.sql`. That
additive forward adds two private tables and four bounded runtime routines.
`payment_simulator_attempts` owns active dispatch, replay/fingerprint and
synthetic method facts; `payment_simulator_observations`
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
Sandbox dispatch and observation keep their native order-then-intent fence,
leaving the subscription and renewal-operation roots free so lifecycle commands
reach their existing `NOWAIT` busy refusal before the sandbox transaction commits.
All five new tables have RLS and no runtime table privileges; service-role
execution uses pinned function paths. Capture and restore carry their rows and
restore the active-attempt pointer after its referenced attempt.

For the first failure of a provider subscription-cycle attempt with recorded renewal correlation,
application first calls `subscription_retry_apply_failure` under
`<apply-key>:truth`. Its immutable failure receipt binds the provider attempt,
payment, cycle, sequence, classification and observation times to the resulting
rung and schedule. Truth reuses `<apply-key>:truth:settlement`, or the original
renewal outcome's settlement transition when that same original attempt was
already refused under another key; it does not open
the generic dunning case on this path. The cycle remains `payment_pending`, and
the retry obligation owns scheduling. The reconciliation/refund forward below
adds attributed case handoff. `createPostgresProviderRenewalBinding` composes
these owners for explicitly selected card provider execution; the starter continues to
bind sandbox renewals by default. Other truth routes and sandbox failure handoff are unchanged.
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
Manual unpaid-order cancellation terminalizes both provider intent and payment
lifecycle, refusing later preparation under fresh keys. The first recoverable
one-time or initial-subscription decline mints a native checkout recovery token
and queues its payment-failed notice with a three-minute claim delay. A lost
inline-recovery response replays its durable attempt using the recorded
transition, nonce and rail without requiring fresh purchase or method context.

| Historical data | Result and manual path |
| --- | --- |
| Native intent without a recorded provider lifecycle or attempt | No automatic backfill or inferred payment identity. Inspect the provider object and admit complete authority explicitly before preparing a fresh attempt. |
| Unlinked or superseded event | Ingress remains durable; application returns `payment_control_result_attempt_unresolved` or `payment_control_result_attempt_mismatch`, with no business effects. Resolve attribution through operator recovery. |
| Prepared attempt with no provider handle | Keep the attempt in flight. Missing local handles do not prove provider absence or authorize redispatch. |
| Settled intent without provider correlation | Preserve settlement and historical evidence. No synthetic provider history is created. |
| Recorded provider renewal operation without logical-cycle or exact prepared-attempt correlation | Refuse application without financial or retry effects. Resolve the missing correlation explicitly; native counters and the current active pointer cannot reconstruct it. |
| Same-attempt expiry escalation | An expiry after a decline on the same renewal attempt records the escalation and does not consume an extra retry stage. |
| Method health without a recorded provider reference | Health supplies no charging authority. Record provider method authority through the selected method store before execution. |

Only `paymentSchemaDescriptor.preparedDurableStore` is enabled by this forward.
Method setup, absence reopening and cumulative refund remain separate capabilities;
absence auto-reopen stays off. A refund never pauses or cancels a subscription.

The following `20261114110000_payment_method_refs.sql` adds the reusable-method
ledger, immutable method-write receipts and recovery authority history. Installing
that forward enables `paymentSchemaDescriptor.methodSetup`. Setup collection
requires a host-authenticated principal and an explicitly injected method port;
its handoff remains transient. Registration, lifecycle delivery and retry
scheduling finish before a setup receipt is closed. None of those operations
settles money or changes subscription service.

The raw reference, receipt and recovery-authority tables have no runtime table
privileges. Client-bearing relations retain only their admitted `client_id`
census grant for absorption refusal. Bounded service-only definer readers and
writers bridge existing invoker routines without changing their headers or ACLs.
The authority writers record token context, record the method binding and freeze
that binding at dispatch; they accept stored identifiers and facts, not SQL or
object names. Store transfer must retain all three row-holding relations.

Repair authority applies only to its recorded retry rung. After that attempt
fails, later automatic rungs use the current usable method and preserve the spent
authority's dispatch history. Admission and dispatch freeze compare the recorded
method row, preserving its provider/reference identity, and lock the recovery token
through commit. Admission holds a shared lock on the exact method and rechecks
usability after acquiring that lock. Driver selection and preparation both respect
the quarantine deadline. Recorded provider state, settlement channels and frozen
renewal channels select this path even when historical method refs are absent.
A completed sandbox attachment with current sandbox terms preserves the sandbox
lane when only the initial paid checkout has a non-sandbox channel. Recorded
references (including inactive rows), provider markers or state (also linked
through the initial settlement intent/order), linked provider delivery evidence,
non-sandbox
renewal operations and provider retry evidence still select recorded authority;
a healthy legacy label cannot override those facts.
Reminder eligibility reads active-method facts through the bounded health reader
under runtime privileges, independently of unattended chargeability.

The retry driver consumes a recorded provider failure through its original
immutable receipt key and input. It validates the operation, sequence, logical
cycle and attempt evidence before replay, so another caller key cannot advance
that failure twice. Provider case creation remains with attributed dunning
composition; the existing sandbox case handoff remains selected separately.

| Historical method state | Named result and manual path |
| --- | --- |
| Healthy label or mirror string with no reusable row | `method_ref_not_recorded` from the recorded-method reader; `subscription_missing_payment_method_ref` or `no_matching_method_ref` from scope repair. Obtain verified method evidence; no synthetic reference or automatic backfill is created. |
| Host-composed native real history without a recorded reference | Retry preparation refuses `subscription_missing_payment_method_ref`; recovery authorization refuses `subscription_retry_recovery_not_authorized`; recorded lookup returns `method_ref_not_recorded`. The host records method refs with `payment_method_ref_upsert` using verified provider evidence; no automatic backfill or inference from a healthy label occurs. Existing tokens without recorded context need a new authorized recovery token. |
| One usable same-client account method matching a mirror | Scope repair returns `repaired`; an already scoped method returns `no_op/already_subscription_scoped`. Batch repair defaults to dry-run and accepts 1–500 subscriptions. |
| Cross-client, other-subscription, expired, revoked or ambiguous evidence | Scope repair returns `cross_client_candidate`, `wrong_subscription_owner`, `unusable_candidate` or `ambiguous_candidate`, without rebinding. Resolve the evidence manually. |
| Unmatched or already processed setup delivery | Setup close returns `updated=false`; no payment effect is inferred. |
| Existing checkout token without recorded recovery context | `recovery_not_ready`; record a new authorized recovery token instead of inferring purpose or redemption from revocation. |
| No matching case or retry obligation | `case_not_found` or `recovery_not_ready`; a method update never reconstructs failed work. |
| Previously dispatched authority | Preserve the recorded method and dispatch fence. Reconcile that attempt before a later rung can use another method. |

### Upgrade native method authority

For host-composed native subscriptions with real-provider history but no recorded
references, retry, recovery, reactivation, auto-resume and upcoming reminders
refuse or remain ineligible until the host records refs. Edits and order-now use
the same lifecycle classification. Original renewal charging retains its previous
method and mandate evidence behavior when no recorded reference exists, including
subscriptions with real-provider history. Once any reference row exists, every
reader uses recorded authority, including inactive, revoked or expired rows;
there is no fallback to legacy evidence. The bounded service-only
`subscription_method_has_recorded_ref` reader supplies this existence check
without granting access to the private method table. Account-support health follows the
lifecycle classification even without a reference, so it reports missing method
health for real history. Sandbox subscriptions retain their previous behavior,
including a
completed sandbox renewal attachment whose initial paid checkout used a different
channel, provided no recorded provider or real-renewal evidence selects authority.

The host records method refs with `payment_method_ref_upsert` from verified
provider evidence, then uses the scoped binding/repair path. Do not infer reusable
references from legacy labels or financial success: there is no backfill. Obtain
a new authorized recovery token when an old token lacks recorded context. A
recorded inactive method continues to refuse until usable evidence is recorded;
removing authority is not a compatibility fallback.

Health is evaluated from recorded evidence on reads. `method_expiring` can still
be chargeable until expiry; model-less cards and declared unattended methods
retain separate chargeability rules. Sandbox labels remain sandbox evidence.
The provider-specific pending-activation shape is outside this collection lane.
These are offline PostgreSQL and fake-client witnesses, not provider activation
or hosted renewal qualification.
The [native witnesses](../../tests/postgres/paymentProviderStore.test.ts) and
[pgTAP twins](../../tests/postgres/paymentProviderStorePgtap.test.ts) exercise the
installed store without contacting a payment provider.

The complete chain through `20261114120000_payment_reconciliation_refund_evidence.sql`
adds `createPostgresPaymentProviderReconciliationPort`. Claims retain bounded,
least-recently-checked selection and skip locked attempts. Composite application
validates the exact order, intent, attempt and payment before committing its
reconciliation evidence. The dunning bridge reads the immutable applied failure
receipt, validates case attribution and replays its canonical response. Only the
five named attribution refusals preserve applied money with sticky refusal
evidence; other errors roll back application, rung, case, notices and receipts.
It never applies a failure twice or adopts an unattributed historical case.
Finite native capture and qualified restore retain all four new relations after
their payment, truth, case and retry-receipt parents. Exact restore and replay
preserve the recorded financial evidence and do not issue another notice or token.

Absence reopening is default off. Exact provider proof, a recorded watchdog,
30-minute age and the absence of references, events or terminal corrections are
required. Reopening cancels that prepared attempt and records one new provider
sequence and due receipt. It preserves the native `payment_pending` cycle,
customer retry budget and immutable dispatch receipts. Due readback and keyed
consumption do not dispatch a payment or turn ordinary prepared replay into
permission to charge again. Interactive reopening retains its existing narrow
provider restriction; its portable host binding remains deferred.

Refund observations use `payment_refund_evidence`, separate from captured truth
and original settlement money. Cumulative observations contribute a maximum per
charge; individual observations retain addition. Equal or older cumulative
snapshots are recorded as ignored. Full refunds release only eligible held,
order-scoped reservations. Consumed or unrelated stock, paid cycle history,
subscriptions and dunning history remain intact. Eventless full-refund repair
retains its existing local repair behavior and never manufactures evidence.

On the native rail, `commerce.order.refunded` is a status-only event with no
money-moved claim. Customer “refund processed” messaging must use
`commerce.order.refund_processed`, whose monetary payload is admitted only by
accepted same-currency refund evidence. `payment_refund_readback` supplies the
same evidence-gated cumulative authority; a status change alone returns no
financial evidence. The once-per-order status event and its manual-refund
exclusion retain their existing contract.

| Native payment limit | Result and manual path |
| --- | --- |
| Historical simulator attempt or intent without a provider lifecycle | Zero provider claims; no reconstructed payment identity. Admit complete provider authority explicitly. |
| Unresolved or superseded provider event | `payment_control_result_attempt_unresolved` or `payment_control_result_attempt_mismatch`; zero financial, stock and dunning effects. Resolve attribution explicitly. |
| Settled intent with only an external reference | Preserve settlement; no inferred attempt, method or refund evidence. |
| Method state without a provider reference | No method mutation or charging authority. Independently attributed money evidence does not require an invented method. |
| Thin cumulative refund payload or missing currency | `payment_control_result_refund_snapshot_unproven`; no amount inferred from the order. |
| Late fresh dunning handoff | A late dunning handoff issues a recovery link valid from issue. Advance the attributed case and revoke earlier tokens; mint a recovery token with expiry at issue time plus 14 days, or 30 days for an exhausted ladder. Prompt and late handoff use the same issue-time window. Redemption requires an open case; fresh advancement revokes the earlier link. Case, rung, customer/operator notice identities and canonical replay are preserved; no historical backfill. |
| Historical unattributed dunning case | `subscription_dunning_case_unattributed`; preserve applied money and refusal evidence. No adoption by cycle. |
| Cancelled or refunded historical service | No resurrection, rewritten receipts or automatic repair. |
| Equal or older cumulative refund observation | Durable ignored observation; no repeated financial, reservation or notice effect. |
| Refunded order status without accepted same-currency evidence | Status projection only; no financial notice or monetary readback. Use verified refund evidence for customer messaging. |
| Another payment provider | The native rail supports the two reference payment providers through declarative provider profiles. A third provider needs a profile declaration plus its adapter. |
| Provider dispatch and customer delivery | Offline store proof supplies no live-provider or journey activation claim. The host owns provider reads, dispatch and financial-notice delivery. |

`paymentSchemaDescriptor.absenceReopen` and `.cumulativeRefund` are supported
for this complete installed chain. This is database qualification,
not provider activation. The [native attribution witnesses](../../tests/postgres/paymentReconciliationAttributionGap.test.ts),
[pgTAP witnesses](../../tests/postgres/paymentReconciliationPgtap.test.ts) and
[installed runtime-role PostgreSQL witnesses](../../tests/postgres/paymentReconciliationStore.test.ts)
exercise the boundary without live provider access.

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

`CATALOG_MIGRATIONS` projects canonical catalogue positions
1, 8, 58, 59, 61, 142 and 143: read foundation, storefront attributes, document/identifier
and subscription price-policy foundation, its validation, isolated drafts and
definition bindings and physical quantities.
Each descriptor keeps the canonical path, position, digest and byte-identical
package SQL. History stays in canonical order. Install and observe the complete
selected catalogue; these seven projections do not supply an independent installation
sequence. The package envelope and draft
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

Frozen historical record (2026-11-13) archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#upgrade-native-method-authority-archived-evidence).

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
[Compatibility lifecycle](../../packages/core/docs/guide/upgrade/database-migrations.md#check-application-compatibility); its active SQL is
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

Position 18 is reserved for `q2_20261123192500_catalog_publication_authority.sql`.
Its `qualifiedInstallations` entry is exactly `{ path, sha256 }`, with the full
catalogue path and a SHA-256 digest of the exact SQL bytes. The forward appends
to the `qualified-v2` plan after lock and conflict completion and preserves
the order of shared forwards. The SQL introduction can add the approval and
manifest entry together. The reservation by itself grants no database privileges.

The restricted publication login can write live products, SKUs, SKU identifiers,
product-document revisions and attribute projections, and apply base prices with
their receipts. At commit, each write must match a publication for the same
product recorded by the definer recorder in that transaction. The issue must
reference the current revision of an open draft for that product. Column values
inside an approved publication are trusted to the native runner, as on the owner
path.

As in other runtime paths, the human-admin and actor checks trust the host to
bind actor claims to the transaction. The publication credential authenticates
the host, and the database cannot verify the human identity behind claims
supplied by a holder of that credential.

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

For a managed forward outside the existing SQL classes, a separate control
change can record an exact path, SHA-256 and ordered managed prefix digest in
`managedExactForwards`. The feature change must keep that approval unchanged.
The prefix digest binds every earlier managed SQL path to its content hash.
CI also checks a registered path if its replacement text would otherwise pass
expand-only admission. Release preparation checks the approval in the parent of
the migration's first introduction. Exact admission still requires behavioral
evidence and independent review.

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

Frozen historical record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#m10-9-attempt-replay-control-fixtures).

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

For search-path hardening, a settings-only slot pins its `path` and an ordered
`settingsOnlyFunctions` list of `{ signature, searchPath }` entries for qualified
functions in the base migrations. Signatures are unique and each `searchPath`
contains a single `pg_temp` entry in the final position. The other function and
data lists are empty. By default the whole-file pin covers exactly the listed
`ALTER FUNCTION … SET search_path` statements in order. The PostgreSQL catalog
check allows only the pinned `search_path` changes. A settings-only slot may
name an `ownerWindowRole`. Its forward then contains exactly the rendered open
statement, the ordered `ALTER FUNCTION` statements, and the rendered close
statement. A restricted installer inherits the owner role's privileges only
within the migration transaction, a superuser installer skips the window, and
the open statement refuses a pre-existing self-granted membership.
If role preflight reports `protected_membership_graph_differs` or the migration
reports a pre-existing self-grant, verify the role, installer and grantor
against the declared role mode. During controlled maintenance, revoke only the
unexpected self-grant through its granting installer and preserve the
bootstrap or operator grant. For other membership drift, restore the declared
role graph. If an ALTER reports that the installer must be the function owner,
check the declared login and restore the documented owner and role grants.
Retry after restoring that configuration.

For a path, digest or issued-prefix mismatch, recover the original approved SQL
and its binding together, then verify the complete prefix. For an unissued
forward with a verified binding and a rendered-form mismatch, regenerate the
file with `renderNativeStoreSettingsOwnerWindow` in
`scripts/reviewed-platform-forward.ts`. The admission refusal prints the first
differing line. If admission rejects its order or a target, check the
introduction base for the first available slot and the exact function signature.
A later ordinary slot treats a landed settings-only slot's exact pinned
`ALTER FUNCTION` statements as known DDL, so it can still replace a hardened
function or grant privileges on it. A replacement may tighten a single
top-level `SET search_path` list of unquoted ASCII identifiers, using `=` or
`TO`. It must append exactly one final `pg_temp` to a list with no `pg_temp` or
`pg_temp_<N>` entry. The rest of the header must match with whitespace between
tokens normalized and literal and quoted identifier tokens kept byte-exact.
The standing [definer search-path check](../../tests/postgres/definerSearchPath.test.ts)
requires `pg_temp` last, with no earlier `pg_temp` or `pg_temp_<N>` entry, for every
installed non-system definer. Preserve the intended trusted schemas when
moving `pg_temp` to the end. For a missing or empty path, review and set the
trusted schema list before appending `pg_temp`. Eleven acquisition and partner
acquisition definer functions now pin `pg_temp` last on their search path.
If a retained-store packet has an unknown or mismatched inventory, the remedy is
`capture the source and restore it with the same OpenLup version on a pristine target of the same profile; upgrade the source within its installed profile first if it is older`.
If no such target can be provisioned, connected-store restore is unavailable for that pair.

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

The PostgreSQL catalogue suite ([with `service_role`](../../tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts) and
[without `service_role`](../../tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts))
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
retain the preimage attributes and `search_path` apart from `CREATE OR REPLACE`
and the parsed-list tightening described with the settings-only slots above.
The slot's pinned `searchPath` must match the tightened list. The PostgreSQL
catalog preserves owner and ACL. Issued contents, positions and the sealed-prefix
rule stay fixed.

<a id="qualified-column-select"></a>

One native slot may declare `qualifiedCatalogueStorageSelect: true` for the
qualified live comparator. Its forward must contain exactly one guarded
`GRANT SELECT (net_content_storage) ON TABLE public.catalog_sku_revisions TO openlup_catalog_publication`.
The grant requires the publication role and the exact qualified authority
ledger path and digest. The PostgreSQL catalogue witness permits only that
column ACL delta, without grant option. This control adds no migration.

A replacement keeps the native function header under the rules above.
The `qualifiedSecurityDefiner: true` entry requires the rendered ledger-guarded
`ALTER FUNCTION` block immediately after the replacement, so qualified
installations keep `SECURITY DEFINER` and other installations keep
`SECURITY INVOKER`. A replacement requires this entry when the qualified
catalogue publication authority migration sets the function to `SECURITY DEFINER`.

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
A separate closed shape admits only a new
`public.catalog_sku_successors` table with three `uuid NOT NULL` columns:
`predecessor_sku_id` and `successor_sku_id` each reference
`public.catalog_skus(id)`, and `publication_id` references
`public.catalog_publications(id)`, all with explicit `ON DELETE RESTRICT`.
Its primary key is `(predecessor_sku_id, successor_sku_id)`, in that order,
and its sole check is `predecessor_sku_id <> successor_sku_id`. Only this
complete statement gains the RESTRICT action and inequality syntax before the
existing generic expression and statement guards. Other tables, targets,
arities, key orders, nullable columns, actions, extra clauses and smuggled or
appended destructive SQL refuse. The real PostgreSQL catalogue proof adds exact
installed FK targets, ordered keys, `confdeltype='r'`, default update/match
actions, validation and non-deferrability, the primary key and check, while
retaining every existing ownership, ACL and catalogue guard. This admission
control adds no feature SQL, publication binding or catalogue capability.
Four further closed new-table declarations admit successor storage only:
`public.subscription_successor_proposals`,
`public.subscription_successor_operations_v2`,
`public.subscription_successor_wait_cases_v2`, and
`public.subscription_successor_reservations_v2`. The complete declarations in
[`NATIVE_SUCCESSOR_TABLE_SQL`](../../scripts/reviewed-platform-forward.ts)
fix every column, type, nullability, default, ordered primary/unique key, CHECK
and inline single-column `ON DELETE RESTRICT` reference. Only unquoted SQL
words fold case; literal values and token kinds stay exact. No other action,
shape or appended SQL gains admission. The independent
[catalogue comparator](../../tests/postgres/nativeStoreForwardCatalog.shared.ts)
checks installed columns and constraints, ordered FK keys and exact targets,
RESTRICT, update/match/validation/deferrability, ordinary-table identity and
RLS and column collation. Client-bearing shapes require blocking absorption
classification. Only these four shapes may reference one another in the same slot; all
other targets and keys must preexist. Owner/ACL, absorption classification and
all generic catalogue guards still apply; only an explicitly listed absorption
census may add its existing closed client-column grant and policy. No feature
SQL, runtime grant, binding or capability is installed by this control.
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
One composite exception admits the single-action statement
`ALTER TABLE public.subscription_lines ADD CONSTRAINT subscription_lines_catalog_sku_revision_fkey FOREIGN KEY (variant_id, catalog_sku_revision_id) REFERENCES public.catalog_sku_revisions (sku_id, id) ON DELETE RESTRICT NOT VALID;`.
The revision column must be added earlier in the same slot's ordered list.
The existing listed `VALIDATE CONSTRAINT` action may follow it; the catalogue
proof checks that final validation state, ordered `conkey`/`confkey`, RESTRICT,
default update and match actions, and non-deferrability. PostgreSQL witnesses
prove same-SKU pairing and preservation of historical NULL bindings. Other
arity, column order, columns, relations, actions, validation on add and appended
statements refuse. Only the exact FK action is masked before the existing generic
guards; their other refusals remain in force. This control change installs no
binding, changes no agreement and activates no catalogue capability.
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
the existing reminder authorizer. See the [operator recipe](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#give-an-operator-a-payment-link).

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
See the [composition recipe](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#schedule-reminders-and-expire-abandoned-checkouts)
for configured timing and transport-profile limits.

`checkSupersets` entries declare table, constraint, column and either values or
an integer range as described below;
`uniqueSupersets` entries declare table, constraint, columns and nullsNotDistinct.
The lexical validator checks only the slot's own SQL: exactly one adjacent
DROP CONSTRAINT / ADD CONSTRAINT pair per entry, with the exact listed positive
IN values or literal integer interval (with an optional trailing `NOT VALID`), or
plain UNIQUE columns and NULLS NOT DISTINCT mode. Unlisted drops, non-adjacent pairs and mismatched
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

An integer-range `checkSupersets` entry replaces `values` with
`range: { lower, upper }` and `beforeSha256`. Both endpoints must be literal
signed 32-bit integers with lower ≤ upper. `beforeSha256` pins the exact
`pg_get_constraintdef` text of the installed CHECK immediately before the slot,
including any trailing `NOT VALID`. The existing table must be an ordinary table
and the column must have PostgreSQL type `integer` (int4). The slot admits exactly
one adjacent pair of plain `ALTER TABLE public.<table> DROP CONSTRAINT <name>;`
and `ALTER TABLE public.<table> ADD CONSTRAINT <name> CHECK (<column> BETWEEN
<lower> AND <upper>);`, with an optional trailing `NOT VALID`. The equivalent
`CHECK (<column> >= <lower> AND <column> <= <upper>)` is also admitted. The
migration runner applies the pair in one transaction; intervening statements,
transaction control, conditional drops, CASCADE and extra ALTER actions refuse.

The protected PostgreSQL catalog control verifies that the pinned old definition
is this same inclusive interval on the same column and that the installed new
range equals the declaration. New lower must be ≤ old lower, new upper must be
≥ old upper, and at least one endpoint must widen strictly. Narrowing, unchanged
ranges, missing or mismatched preimages, other columns/tables/constraint names,
non-integer or computed bounds, casts in the forward and extra predicates refuse.
Validation state must remain equal in both directions, including preserving
`NOT VALID` without rechecking historical rows. Existing owner, table/column ACL,
column and unrelated-constraint catalog protections still apply. This capability
changes no installed CHECK by itself; feature SQL and its declarations land in a
later change.

The receipt-backed preview forward uses the single native slot with
`previewNoopAcceptance: true`. The slot lists
only the nullable `accepted_noop_receipt_id` UUID column and its foreign key to
`public.subscription_command_receipts(id)` in `existingTableStatements`. The
foreign key uses PostgreSQL's default `NO ACTION`. The forward uses the three
exact admitted statements. They add the column and then drop and re-add
`subscription_quote_previews_acceptance_check` on
`public.subscription_quote_previews` as an adjacent, validated replacement.
[Forward SQL](../../db/platform/migrations/20261125050000_subscription_preview_noop_acceptance.sql) ·
[Admission rule](../../scripts/reviewed-platform-forward.ts)

Static admission checks the exact forward bytes and pins the issued
package-editor migration by path and hash. Beyond the pinned package-editor and
sized-editor migrations, a file mentioning `subscription_quote_previews` must
split and tokenize completely. The only allowed mentions are in CREATE or DROP
TRIGGER, COMMENT ON TRIGGER, and GRANT or REVOKE targeting previews, or within a
CREATE FUNCTION or PROCEDURE dollar-quoted body. Trigger and privilege targets
use the table name with an optional explicit `public` schema. Plain double
quotes are allowed. A routine body mentioning previews must contain none of
the keywords ALTER, DROP, CREATE, TRUNCATE or RENAME. The scan refuses all other
mentions.
Immediately before the forward, the PostgreSQL proof compares the table and its
`pg_depend` closure with one expected catalogue snapshot, excluding only
non-internal triggers on the preview table, their `pg_constraint` rows of type
`t`, and the dependencies those bring. All columns, other constraints including
the acceptance CHECK, and internal RI triggers remain in the comparison. The
[proof](../../tests/postgres/nativeStoreForwardCatalog.shared.ts) uses stable names
and omits only the named deny-list of instance-specific fields. Database-wide
state is out of scope.
The [installation matrix](../../tests/postgres/subscriptionExactInstallation.test.ts)
runs the same check on all five shipped profiles.

Existing previewed rows and acceptances backed by native events keep a NULL
receipt column. A receipt-backed no-op acceptance requires the acceptance
timestamp and idempotency key, a receipt and a NULL native event. The PostgreSQL
proof exercises every combination of status and NULL values before and after
replacement. Keep any other SQL in separate slots. Land admission changes
separately before introducing the slot and its SQL.

Connected-store capture reads the new UUID through the existing column census.
Restore inserts subscription command receipts and native events after their
client and subscription parents and before previews. A store transfer uses the
current inventory for the same profile on both ends. The recovery steps cover
packets from a different inventory. [Restore recovery steps](#compatible-data-transfer)

`createdViews` entries declare a fresh qualified name and exact CREATE VIEW
statement hash. Only plain unconditional creation is admitted, once per listed
view. OR REPLACE and conditional existence forms refuse. PostgreSQL rejects a
duplicate name; the reader does not reconstruct a prefix object catalog.
REVOKE ALL ON TABLE ... FROM PUBLIC is mandatory after creation; the
existing guarded role revokes are allowed. Every GRANT on a created view refuses.
Views gain no RLS or table-grant capability. The real catalog checks the declared
new view inventory, ownership and owner-only privileges.

<a id="declare-a-reviewed-trigger"></a>

**Declare a deferred trigger.** Add the `createdTriggers` entry and exact SQL in
the same PR. Use 63-byte identifiers at most and `INSERT`, `UPDATE`, `DELETE` order.

```json
{
  "name": "example_guard",
  "relation": "public.example_items",
  "events": ["INSERT", "UPDATE"],
  "function": "public.example_guard()",
  "deferred": true,
  "sha256": "9331c59ff1708220da4c99634c53ccade813038aadfa9f183baf00ffd9eea51a"
}
```

```sql
CREATE CONSTRAINT TRIGGER example_guard AFTER INSERT OR UPDATE ON public.example_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.example_guard();
```

Use a public zero-argument invoker returning `trigger`. Reserve the pinned names
for declarations, new functions and their PUBLIC revokes. Fix parse errors first.
For a pinned function created in the same forward, use either `REVOKE ALL ... FROM PUBLIC` or `REVOKE ALL PRIVILEGES ... FROM PUBLIC`.
For a pinned object, remove the refused statement or use one of the listed exact
statements. Remove an unregistered trigger, or register it and use the rendered
SQL when its form is supported.
Rename any identifier the checker cannot read fully (such as `";"` or a Unicode-escaped identifier), or move its statement to a forward without trigger pins.
Pins may share a relation. Reuse prefix invokers without a revoke and keep other trigger DDL off it.

Ordinary triggers use a name fresh across the prefix, `BEFORE` or `AFTER`, and
a same-slot function with explicit `SECURITY INVOKER`, a pinned `search_path`
and an owner-only ACL. Ordinary triggers also allow `UPDATE OF`.
Ordinary triggers refuse `WHEN`, transition tables, statement-level and `INSTEAD OF` forms, trigger mutation, `OR REPLACE`, and `IF NOT EXISTS`. Revoke the function’s privileges from `PUBLIC`, grant no `EXECUTE`, and target a table in the prefix or created earlier in the same slot.

The destination slot registers four created function signatures and pinned
search paths. Its two new tables, revokes and RLS use the existing same-file
narrowing rules below. Apart from the assignment-default exception below, class data does not pin table columns, constraint/index
names, function security mode, language, defaults or return type; feature SQL's
whole-file/after-hashes and feature review retain those inventory and behavior
duties. Synthetic shape acceptance establishes no implemented destination API.

Each created function must revoke all PUBLIC privileges before its grants and
conditional blocks. SECURITY DEFINER requires the slot's exact pinned
`search_path`, such as `pg_catalog, pg_temp`. A replacement may preserve a legacy
compact `SET search_path=pg_catalog` header or tighten the list under the
settings-only slot rules above. In both cases the slot's pinned `searchPath`
must match the resulting list.
New functions retain their existing spaced spelling, and no other SET grammar,
schema-token or catalogue proconfig check changes. Ordinary grant-only signatures
must exist in the pre-class native prefix and be disjoint from the replaced and
created lists.
They cannot be redefined or named by a direct privilege statement. Only their
pinned conditional role/verb capabilities are admitted, without demanding a new
PUBLIC revoke. A block naming created functions still requires their revokes;
a block naming only grant-only functions does not.
The ordinary conditional DO shell requires an exact `pg_roles` existence guard around
one constant privilege EXECUTE, on admitted targets, for the same role. Function
privileges and table revokes retain one block per role, verb and object kind
(FUNCTION or TABLE). The fixed baseline and notice-table allowances below additionally admit
their grants and policies. Each listed, block-classified, same-slot census table has
two separate `service_role` conditional blocks: one for `SELECT (client_id)` and
one for its derived SELECT-only policy with `USING (true)` and no WITH CHECK.
`anon` admits revokes only; for functions, `authenticated` and `service_role`
admit revokes or EXECUTE grants. Extra statements, branches, dynamic strings and
PUBLIC grants refuse.

One dedicated grant-only shape allows a single non-grantable `EXECUTE` grant to
`openlup_catalog_publication` for exactly
`public.catalog_offer_memberships_page(text,jsonb,integer,text)` and
`public.catalog_publication_activation_readiness(text[],text)`. Both functions
must resolve to their already-issued native slots with matching file and function
hashes. The exact `DO` block checks for the role in `pg_catalog.pg_roles` and for
the exact `catalog_path` and `sha256` of the [qualified-v2 authority migration](../../db/platform/migrations/q2_20261123192500_catalog_publication_authority.sql)
in `ONLY public.platform_schema_migrations` before executing the grant. The
runner records that row in the transaction that applies the authority migration.
The legacy and qualified-admin plans omit that migration, so the block skips
the grant in those databases even when the cluster role exists. The slot
carries only those two grant capabilities, and its pin lists no function definitions.
The live comparator has its own [qualified column SELECT exception](#qualified-column-select).

At most one native-store slot per registry may declare
`qualifiedPriceListBasisSelect: true`. Its function and data lists are empty
and it declares no other capabilities. Its entire file matches the exact
authority-ledger and role-guarded `DO` block, including the final LF. The
block executes only
`GRANT SELECT (amount_basis) ON TABLE public.price_lists TO openlup_catalog_publication`,
without grant option.

An earlier native-store slot must list the nullable `text` column with no default
in `existingTableStatements`. If that slot declares a CHECK for the column,
it must allow only `tax_inclusive`, `tax_exclusive` and NULL. Admission resolves
the column from the earlier slot's approved statement inventory, checks the
whole-file SHA-256 against the registry, and requires that file and binding in
the grant's approval base. The predecessor must tokenize completely. Only the
pinned column and its optional CHECK may reference `price_lists` in that file.
Every intervening file that mentions `price_lists` or uses Unicode-escaped
identifier syntax must also tokenize completely. Only direct row DML on
`price_lists`, GRANT, REVOKE and COMMENT may reference the table in those files.
This excludes index creation and attaching a constraint using an index. The
feature lands the column forward first and introduces the dedicated grant-only
forward after the column is issued.

At most one native-store slot per guarded `EXECUTE` entry may declare
`qualifiedPriceSetupExecute: true`. Its function and data lists are empty,
and it declares no other capabilities. The whole file, including its final LF,
must match the frozen role- and authority-ledger-guarded `DO` block. That block
grants `EXECUTE` on `public.catalog_price_setup_apply_v2(text,text,uuid)` and
`public.catalog_publication_lock_effective_base_price_v2(uuid,uuid,uuid)`, in
that order, to `openlup_catalog_publication` without grant option.
Those two signatures are the default for the flag. The reserved row
`catalog-publication-subscription-profile-identity-execute` selects only
`public.catalog_publication_subscription_profile_identity(text,integer,text)`.
The authority ledger guard limits both entries to qualified v2.

Admission resolves each function's initial `createdFunctions` entry from an
earlier native slot. The registry pins the definition file's path, its whole-file
SHA-256 and the exact `CREATE FUNCTION` statement's after-hash. The grant's
approval base must already contain the same definition bytes and bindings.
The predecessor files and intervening native files must tokenize completely.
Admission requires the issued `PUBLIC` revoke and refuses later static changes
to any target definition. For price setup, PB-1's PostgreSQL witness covers
changes reached through dynamic SQL in earlier admitted routines
and verifies the effective owner, function attributes and privileges under the
installed profiles.

The checkout-owner grant-only forward has one reserved
`*_catalog_checkout_owner_execute.sql` slot. Its ordered routine inventory is
`public.catalog_admission_lock_shared()`,
`public.catalog_admission_lock_checkout_price(uuid,uuid[])` and
`public.catalog_admission_create_order_draft(text,jsonb,jsonb,uuid,jsonb)`.
The pin binds the full forward bytes and has an empty definition list. All
three definitions must come from one earlier, issued catalogue purchase
admission slot. Admission checks the approval base, definition hashes, definer
attributes and intervening routine or schema changes before admitting the
grant. The guarded unit returns on the exact legacy baseline ledger entry.
On either qualified generation, verify the exact baseline, issued definition
ledger entry and the installed routines before the unit can commit. The unit
records a zero-grant no-op if the role is absent. A present role must pass
the qualified session check. The runner verifies the candidate ledger and
permissions in the same transaction before commit.
Replacements of these three routines must follow the issued checkout grant unit.

For either qualified generation and role mode, the host provisions
`openlup_checkout_owner` outside the migration session. Use a dedicated login
with `NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`,
no owned objects, memberships, role defaults or expiry, and the default
connection limit. Give it effective database CONNECT without grant option
and public schema USAGE. On PostgreSQL 16, a non-superuser with `CREATEROLE`
who creates the login receives a membership from the bootstrap authority.
Inspect `pg_auth_members` and have the grantor remove that edge. The database
owner must preserve TEMP for the selected installation roles that use it,
then revoke TEMP from PUBLIC. Inspect `pg_database` with `aclexplode(datacl)`
or the database default ACL if `datacl` is null. Verify the supported TEMP
access and the checkout login's lack of it with `has_database_privilege`.
Coordinate this handoff with each qualified database owner on the cluster.

A qualified readback admits zero local grants or the exact three issued,
non-grantable grants from the definition owner. It verifies the routines
and all stored ACLs before omitting the validated role and grant rows
from the canonical inventory. The effective state comes from the live
database. Connected-store restore keeps the target's qualifying state.

Once the selected catalogue contains the grant and the ledger records it,
the definition owner can apply or verify it through the installed package's
`applyPlatformCheckoutOwnerGrant`. Exclude concurrent host role/default
administration across the cluster and out-of-band local DDL and ACL changes
until the operation completes. It uses the migration session lock, checks
the recorded plan and live definitions, verifies the grants before commit
and leaves the ledger intact. See the
[upgrade handoff](../../packages/core/docs/guide/upgrade/database-migrations.md#prepare-the-optional-checkout-owner)
for the profile roles and callable example.

Only qualified tables created earlier by unconditional `CREATE TABLE public.<name>`
statements in that same slot's file may use table narrowing: bare `REVOKE ALL ON
TABLE <table> FROM PUBLIC`, conditional per-role `REVOKE ALL ON TABLE` lists, and
`ALTER TABLE <table> ENABLE ROW LEVEL SECURITY`. A table from the prefix or
another slot or an unqualified/IF NOT EXISTS creation refuses. The admitted
table grants are limited to the fixed baseline and notice-table allowances below,
the listed census tables' client-column SELECT, the qualified price-list basis
SELECT and the [guarded `catalog_sku_revisions.net_content_storage` SELECT](#qualified-column-select)
for `openlup_catalog_publication`. Census tables keep owner-only table ACLs
and receive only their exact column grant and derived SELECT policy.
The native paid-notice slot may name `insertSelectTables` with the complete
value `["public.subscription_notice_refusals"]`, pinned by the reader. A separate
baseline allowance below uses the same key; neither allows arbitrary tables.
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
This notice INSERT/SELECT allowance applies only to the named notice table.

For a frozen-cohort baseline, `insertSelectTables` may instead be exactly
`["public.commerce_offer_policy_rollout_baselines"]`. After unconditional
same-file table creation, each of these exact statements uses its own existing
`service_role` existence shell, including the inner final semicolon:

```sql
GRANT SELECT, INSERT ON TABLE public.commerce_offer_policy_rollout_baselines TO service_role;
CREATE POLICY commerce_offer_policy_baselines_service_select ON public.commerce_offer_policy_rollout_baselines FOR SELECT TO service_role USING (true);
CREATE POLICY commerce_offer_policy_baselines_service_insert ON public.commerce_offer_policy_rollout_baselines FOR INSERT TO service_role WITH CHECK (true);
```

All three statements must occur exactly once. The real catalogue requires RLS
enabled, owner plus service SELECT/INSERT table privileges only, no column grants
or grant options, and precisely these two permissive policies with this role and
these predicates. With the role absent, the table remains owner-only with no
policies. The allowance does not bypass the generic column-ACL guard. Every
column grant, including SELECT/INSERT/UPDATE/REFERENCES, and every extra table
GRANT outside the exact statement above is refused by static admission; the
real catalogue independently refuses added column or table privileges. PostgreSQL
also refuses DELETE/TRIGGER column-grant syntax. Broader policies, other tables
and other roles remain refused. This admission installs no feature table and enables no runtime.

The exact `existingTableStatements` list may also contain:

```sql
ALTER TABLE public.subscriptions ALTER COLUMN offer_policy_assignment_state SET DEFAULT 'pending_acquisition';
```

An earlier statement targeting `public.subscriptions` in that same list must add
the column with the exact action
`ADD COLUMN offer_policy_assignment_state text NOT NULL DEFAULT 'legacy_frozen'`.
No conditional addition is allowed: PostgreSQL must reject a pre-existing column.
This preserves existing rows' legacy marker and changes only future inserts;
the real catalogue proves the column is fresh, non-null text with the exact new
default. Other defaults, tables, columns, reordered or missing additions, combined
destructive actions and unlisted switches refuse. Generic expand-only admission
continues to refuse SET DEFAULT; this exception does not change that grammar.

The existing expand-only grammar and every other class retain their refusals.
Each feature PR using this narrowing must provide real-PostgreSQL proof that its
restricted runtime retains the access required by its row after the revokes/RLS;
reviewers of that feature PR must assess the proof. This control cannot supply it.

The static checks above are a first gate for ordinary mistakes, not the boundary
against deliberately evasive SQL. For function identity, security attribute,
`search_path` and privileges, the truth is the required real-PostgreSQL
catalogue suite ([with `service_role`](../../tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts) and
[without `service_role`](../../tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts)). Each file replays
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
  its ACL, so only its body may change — except its single `search_path=` `proconfig`
  entry may strictly append trailing `, pg_temp` when its slot pins that tightened
  `search_path` and the prior entry did not already name `pg_temp` or `pg_temp_<N>`.
  A grant-only function keeps its attributes and
  body, may gain only EXECUTE for its listed grant roles and may lose privileges only
  from its listed roles.
- A created function is owned by the migration role, keeps no PUBLIC execute and
  grants execute only to `authenticated` and `service_role`, never with a grant
  option. A definer carries its pinned `search_path`; a function whose slot pins none
  carries no `SET` at all. Its language and leakproof flag are not compared: like
  its body, they stay with the whole-file hash and the feature review.
- Existing relations of every kind, indexes and TOAST tables included, keep their
  owner, privileges, row security, options and column privileges, subject to the
  [qualified column SELECT exception](#qualified-column-select). Only the index
  of an explicitly listed UNIQUE replacement may be replaced with its new key. A new relation of
  any kind is owned by the migration role. By default it carries only its owner's
  table privileges and no column privilege. The pinned notice table may carry
  service-role SELECT/INSERT with RLS enabled and its single fixed policy.
  The pinned baseline table may carry those privileges with its separate fixed
  SELECT and INSERT policies; a missing role leaves neither grant nor policy.
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
  excepted. Listed value-list CHECKs retain their old values in the positive IN
  form PostgreSQL deparses. Listed integer-range CHECKs bind the installed
  definition's exact hash and strictly widen its inclusive int4 interval on the
  same column, preserving validation state. Listed UNIQUE replacements retain every old key
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
catalog test and these named files:
`tests/postgres/nativeStoreForwardCatalog.serviceRole.test.ts`,
`tests/postgres/nativeStoreForwardCatalog.noServiceRole.test.ts`, `tests/postgres/nativeStoreForwardCatalog.shared.ts`,
`tests/postgres/subscriptionExactInstallation.test.ts`,
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

Frozen historical record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#disposable-managed-reference-baseline).

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

Frozen historical record (2026-11-13) archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#compatibility-lifecycle-archived-evidence).

### Paid-mail capture repair

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

Frozen historical delivery record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#paid-mail-capture-repair).

### Managed stock wait, ATP and refund parity

Frozen historical record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#managed-stock-wait-atp-and-refund-parity).

### Native stock wait and ATP (N3)

When upgrading a custom runtime role from the earlier ATP grant list, apply this
additional grant after the policy migration and before resuming ATP calls
(replace `runtime_role` with the host's role):

```sql
GRANT EXECUTE ON FUNCTION public.inventory_renewal_protection_days() TO runtime_role;
```

Frozen historical record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#native-stock-wait-and-atp-n3).

### Native subscription commands (N2)

Frozen historical record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#native-subscription-commands-n2).

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

## Stable schema policy

The [database upgrade guide](../../packages/core/docs/guide/upgrade/database-migrations.md#check-application-compatibility)
owns the 1.x schema commitment and bounded code-rollback proof. Installation
recipes do not extend that evidence to another chain or application.

## Identity reference grants

Frozen historical record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#identity-reference-grants).

## Communications projections

Frozen historical record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#communications-projections).

### Complete account consent choices

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
include historical withdrawals superseded by later explicit choices. It does not
send or retry anything. Frozen historical record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#complete-account-consent-choices).

### Account newsletter withdrawal upgrade

An opt-out recorded before `20261030110000_customer_newsletter_withdrawal.sql`
does not change an existing `granted` row until an operator runs the following
idempotent statement through the direct migration or administration connection:

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

Frozen historical record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#account-newsletter-withdrawal-upgrade).

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
requests. Once M09 owns a request, the [incumbent queue fence](history/data-and-migrations-evidence-2026-11-13.md#m09-incumbent-queue-fence)
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

- **M09 incumbent queue fence** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#m09-incumbent-queue-fence).
- **P4a native store projections** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#p4a-native-store-projections).
- **Native retry timing and timed resume** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#native-retry-timing-and-timed-resume).
- **Terminal native notice refusals** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#terminal-native-notice-refusals).
- **Checkout recovery lineage** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#checkout-recovery-lineage).
### Installed checkout reminder schedule

The native `20261123140000_checkout_recovery_reminder_schedule.sql` forward
replaces `commerce_enqueue_abandoned_cart_reminders(integer)` (current preimage:
`20260818120000_checkout_recovery_lifecycle.sql`) and
`commerce_enqueue_checkout_recovery_reminders(integer,jsonb,timestamptz)` (current
preimage: `20261110100000_checkout_recovery_waves.sql`). Signatures, security,
search paths, owners and ACLs are preserved; the integer-only checkout wrapper
is unchanged. The new restricted SECURITY DEFINER
`commerce_checkout_recovery_reminder_schedule()` validates the installed
`checkout_recovery_reminders` setting with `search_path = pg_catalog, pg_temp`.
With no row, the schedule helper returns nominal stages and hours. Abandoned
cart enqueue uses the 1, 24 and 72 hour waves. Checkout recovery enqueue uses
the host call offsets, with SQL defaults of 1 and 20 hours for omitted offsets.
Malformed data raises `checkout_recovery_reminder_schedule_invalid` before writes. No policy is seeded
and no pending event is rewritten. See the [reader contract](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#install-reminder-stages-and-hours)
for stage routes, timing precedence, predecessor gates and hour-derived keys.
The [PostgreSQL witness](../../tests/postgres/checkoutRecoveryReminderSchedule.test.ts)
compares both current preimages, payloads (apart from the new stage and random
tokens), metadata, dedup keys, replay, function attributes and restricted access.

After the episode pin forward, a separately delegated cart job role retains
its producer `EXECUTE` and needs `EXECUTE` on
`commerce_enqueue_abandoned_cart_reminder_episodes(integer)`. The helper calls
the validator as owner. Follow the [installation recipe](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#install-reminder-stages-and-hours)
for the grant, the refusal and its hint. The TypeScript read helper requires
settings `SELECT` to return the revision and full schedule. The reminder guard
forward
`20261123141000_checkout_recovery_reminder_guard.sql` preserves both producer signatures and privileges. The SQL installer runs with
the installation role's permissions. It takes the same transaction
advisory lock as the guard and both producers, before reading the installed
schedule. Enqueued waves and the guard check therefore serialize at `READ COMMITTED`.
Both blocker predicates require a pending-payment order with a wave and no pin
for its reminder kind. A refusal reports the number of blocking orders.
A compacted checkout wave consumes both stages with an installed schedule
and follows the historical hour mapping when the row is absent.
Abandoned-cart stage identity survives compaction in the event type. Both
producers apply stage deduplication after the candidate limit.
An identical install returns without a write at every isolation level. Changes
and producers require a fresh statement snapshot after the lock, so
`REPEATABLE READ` and `SERIALIZABLE` refuse. Follow the
[reader contract](../../packages/core/docs/guide/how-to/build/checkout-recovery.md#install-reminder-stages-and-hours)
to resolve an open-episode refusal before retrying installation.

`20261123148000_checkout_recovery_reminder_episode_pin.sql` stores each order
and reminder kind's effective offsets with its first wave. The guard continues
to fence preexisting waves without a pin. Native capture and restore carry
episode rows with their order. See the [PostgreSQL witness](../../tests/postgres/checkoutRecoveryReminderEpisodes.test.ts).

- **Expired checkout preparation** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#expired-checkout-preparation).
- **Atomic checkout guidance read** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#atomic-checkout-guidance-read).
- **Operator shipment evidence** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#operator-shipment-evidence).
- **Saved subscription destination selection** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#saved-subscription-destination-selection).
- **Scoped customer preference data** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#scoped-customer-preference-data).
- **Checkout attempt admission** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#checkout-attempt-admission).
### Customer billing profile and invoice buyer data

Frozen historical record archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#customer-billing-profile-and-invoice-buyer-data).

- **First-duty invoice buyer capture** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#first-duty-invoice-buyer-capture).
- **Checkout recreation buyer snapshot repair (slot 28)** — archived in [Data and migrations evidence](history/data-and-migrations-evidence-2026-11-13.md#checkout-recreation-buyer-snapshot-repair-slot-28).
### Native dispatch outcomes and operator attempts

The ordered `20261120110000_fulfillment_dispatch_outcomes.sql` forward adds a
nullable neutral outcome to dispatch references and the private operator-attempt
audit table. Old outcomes remain NULL. The forward preserves submitted identity
while allowing unsubmitted shadow promotion and draft refresh across runs.
The connected native profile captures/restores operator attempts as rows;
operator attempts do not constitute command-ledger or acceptance proof.

### Native provider intake evidence

`20261120120000_fulfillment_provider_intake.sql` adds nullable carrier, service
and public URL columns to existing tracking references and nullable occurrence,
canonical status and recovery classification to existing status evidence. It
creates no table, performs no backfill, and changes no table RLS or payload ACL.
Historical nulls stay unknown. Existing finite capture/restore carries the full
rows; the intake transfer witness asserts the added columns byte-for-byte.

Closed server entrypoints persist first webhook envelopes, recorded correlation,
status evidence, exact packed reservation consumption, reference readback,
exception holds and scoped healing. SECURITY DEFINER entrypoints pin
`pg_catalog, pg_temp`, revoke PUBLIC/browser execution and grant only the server
role. Status and reference triggers recheck dispatched notices only after durable
truth; delivered evidence suppresses late dispatched wording. The exception
emitter replacement preserves its header, search path, owner and ACL while
checking durable handoff or delivered state. Its before-hash is pinned from the
preceding catalogue. No provider identifier convention or raw status mapping
enters SQL. Missing typed receipts, associations or trusted hold scope require
[manual resolution](../../packages/core/docs/guide/reference/limits.md#provider-intake-history).
The intake regression suite uses real PostgreSQL on legacy and both qualified
installations; this remains offline evidence.

### Native replacement arrival composition

`20261120130000_fulfillment_alignment_arrival_chronology.sql` replaces the
delivery trigger function without changing its binding, invoker rights, fixed
search path or ACL. It processes changed non-null arrival timestamps; the existing
subscription-before-case locks and monotonic schedule clamp remain in place.
The replacement preparation reader carries frozen optional lot/expiry values and
parcel sequence. Native dispatch admission selects replacements through the same
per-parcel reservation and submission fences as originals. Intake returns the
recorded parcel sequence to the adapter's outbound-identity codec. Each replaced
function has its own before/after pin; no table or capture/restore membership is
added. The [fulfillment recipe](../../packages/core/docs/guide/how-to/build/fulfillment.md#bind-replacement-and-customer-alignment)
owns host composition.

## Native offer-policy inputs

The native `20261122170000_offer_policy_readiness_inputs` unit supplies unbound
read-only inputs for a later price writer. It marks existing subscriptions as
legacy, switches future ordinary inserts to pending acquisition, and records
installation-time count, sorted-ID fingerprint and database time separately from
the operator's later audited baseline. It changes no agreed price, quantity,
status, cadence, renewal operation, order or delivery clock.

The parameterless `commerce_capture_offer_policy_v2_legacy_baseline()` routine is
an explicit service-authorized audit step. It is never run by installation or
restore. All legacy non-fixture statuses participate. The insert-once baseline
retains its original fingerprint/time on replay. An audited zero requires empty
marking provenance, an empty current cohort and no positive baseline replacement;
a populated cohort becoming empty retains the original empty-baseline error.
Native RLS grants service SELECT/INSERT on baselines only; browser access and
ordinary service UPDATE/DELETE are denied. Marking has no service DML grant.

The connected transfer profile carries both authoritative evidence tables and
the subscription evidence columns. Its existing pristine-target transaction
reconciles the target marking row against actual installation data, then restores
the source marking and baseline without recapture. The baseline INSERT guard
rechecks zero provenance after the subscriptions are restored. Owner-controlled
transfer remains outside the runtime catalogue lock order.

Promotion projection validates consumed scalar, nullable, range, coupling,
reference and uniqueness facts before casts or selection. Financial predicates
retain their acquisition and bundle semantics. Current order metadata or a
current publication head cannot prove historical admission or frozen money
protection. Order-backed agreement quotes, including retained renewal lines,
validate their governing policy pair regardless of age and refuse unproved
historical admission before projecting quote lines. Graduation and sized edit
events can copy or merge retained purchase quotes, so their event identity does
not establish independence. Only complete fresh package quotes and classic
base-line swaps supply independent event evidence; their amounts must still
match the current template and renewal bindings. Order money utilities are not
called by readiness before admission. Qualifying unestablished contexts raise
hard refusals independently
of ordinary readiness reasons. Readiness calls no capture or commerce writer
and takes no commerce row/advisory lock. The managed rail does not supply this
feature; the migration fragment describes the separate RLS-preserving twin.
