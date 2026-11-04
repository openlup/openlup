# Native order, subscription and parcel destinations

Current status: G3 is combined with G4 in the assigned bundle worktree. The
cycle-3 SQL repair has its accepted read and DCO commit. The current comparison
and review base is the frozen G3x head
`addfaf98e4d4016d77033459090996d0d44d2dad`, integrated by a clean signed merge.
The absorption classification control is on main at
`8b48b5f0956530d59e2182ac28f6ab78d85f8381`, the current policy revision.
The resumed grant authorizes the pre-review set, the final automatic cycle-3
full review, verification and the stacked draft/landing route. Earlier stage
notes below retain their original bases, evidence and grants.

## Outcome, authority and boundaries

G3 ports new-address order/subscription destinations and customer/operator
change_shipping_address, including parcel applicability. Matrix rows: P08, R08,
T04-12, A23, T03-57, A78. Original separate-row worktree oss-m19-g3, branch codex/oss-m19-g3;
base and recovered policy revision 3887ee7425fd0eddeecd9a8e2ef3e1420bcf640d.
That original grant kept G4 untouched. The current bundle grant permits this
assigned worktree only and leaves the export leaf untouched. It authorizes local SQL,
manifest selection, public bindings, own API snapshots, transfer additions,
characterization/refusal tests and unsigned WIP commits. The accepted-read and bundle grants authorize own feature pins, DCO and native
review; no checker edit or delivery is authorized. Landing remains ordered after
the leaf and predecessors. No hosted qualification is claimed.

The lead accepted newAddress only (saved book is a named refusal), a separate
address routine, and future-only application once dispatch owns the parcel.
The latest resume authorizes donor confirmation enqueue in the existing routine
and native subscription_events account history. No fifth signature, third table
or trigger. It permits the additive native outcome/decoder, the address adapter branch and
the native address capability advertisement. Email, phone, account link, short-band
slide, unpaid resume and prepared-attempt pause retain their named native
refusals; ordinary pause/resume/slide and new-address change are advertised.
Explicit host composition is required. No existing OMS/G5 files or renewal codec are edited.

Hard package stop: 8,200 bytes packed including own SQL and manifest. No saved address book,
default selector, list/delete/export/erasure API, real PSP, new attempt ledger,
cycle movement or arrival confirmation. No supersededByStableJourneyKey or
checkoutAbandoned writes. Review repair cycles used: zero.

## Managed donor characterization, recorded before SQL

All managed anchors below refer to the explicit
`supabase/migrations/00000000000000_platform_schema_baseline.sql` at the base.
No directory-wide seal or managed source change is proposed.

| Boundary | Observed managed behavior |
| --- | --- |
| Customer dispatch chain | customer_self_service_apply_subscription_action (28369) delegates address through before_anchor_fence, before_resume_terminalizes, before_expired_resume, before_moq, before_dunning_cancel, pre_cadence (28530), legacy_wave5 (28436), then before_address_ownership (27422). Non-address wrappers delegate this action unchanged. |
| Ownership and replay | Key is at least 8 trimmed characters; resolve client by authenticated principal; lock its owned subscription. Existing subscription/key event replays before address validation and is not compared against changed payload. legacy_wave5 explicitly rejects nonexistent/foreign addresses, closing the deepest body's NULL-kind fallthrough. |
| Dunning and status | Address is explicitly exempt from the open-dunning blanket refusal. It does not require a saved payment method. Active or paused subscriptions are permitted; cancelled refuses. Open dunning does not waive the cycle lock. |
| Cycle lock | customer_self_service_assert_no_locked_cycle (28715) rejects a cycle at next_cycle_at with payment_pending/paid status, or a same-date cycle whose order is paid/fulfillment_pending/fulfilled. Retry history and schedule are not rewritten. |
| Customer effects | Point future subscription at owned shipping/both address, update updated_at, emit subscription.customer_self_service.change_shipping_address with action payload and priceAgreementPolicy lock_until_edit/none/future_unlocked_cycles_only. Cadence, next_cycle_at and template_version do not change. |
| Operator admission | customer_support_apply_subscription_action_v1 (29743) checks active operator before subscriber reads and refuses machine actor; validates object payload, key 8..200 and positive expected version; derives subscriber principal through its client. Unlinked subject refuses. Version compares template_version; address itself does not bump that version. |
| Operator address input | Exactly one shippingAddressId or newAddress. Owned shipping/both saved ID is checked; newAddress inserts a fresh non-default row inside a refusal subtransaction, never edits an old address. RecipientName/line1/city bounds 1..200, postalCode 1..32, country 2..3; supplied line2/phone must be nonempty within 200/64. New-row insertion trims text and uppercases country. The saved-address branch is excluded by the accepted new-address-only scope. |
| Operator replay and refusal | Fingerprint binds action, subscription, expected version and full payload; advisory key serializes the command. Matching success replays; persisted refusal/conflict replays unchanged; changed input/operator/target refuses23505. Wrong version is conflict. Known self-service P0001 becomes a durable refusal; unrelated faults, unique violations and deadlocks escape. |
| Event attribution | Delegate writes the customer event. Only the newly authored event ID is stamped operator; replay never relabels an older customer event. Raw newAddress is replaced by its resulting ID in the delegate event. |
| Current parcel | On applied address change only, select latest cycle parcel by order.created_at DESC, parcel.sequence_no DESC, parcel.id DESC, and lock that parcel FOR UPDATE. created/packed/label_pending repoints BOTH order.shipping_address_id and fulfillment.shipping_address_id. Merge address keys into prior shipping_address_snapshot to preserve delivery selection. Shipped/other ineligible parcel or no parcel is skipped, not an overall refusal. Subscription's future destination still changes. |
| Snapshot fields | addressId, clientId, label, line1, line2, city, postalCode, country, recipientName, contactPhone, companyName, taxId, deliveryNotes, courierInstructions. Keep the full destination document even when a dispatch adapter consumes fewer fields. Operator's fresh-row insert sets only its listed address/contact fields; other address fields take their table defaults. |
| Durable audit | Exactly one support command and audit for every outcome reaching ledger stage, including refusal/version conflict. Audit records before/after address IDs; after is NULL on refusal. Malformed and changed-key input raised before that stage leave no new ledger/audit. Failed mutation rolls back the new address and event before writing the refusal. |


## Deliberate differences and donor fit

The source characterization above preceded SQL. The initial implementation probe
then found a missed trigger closure: the managed baseline function
subscription_emit_self_service_account_event at 41694 and trigger at 57007 mirror
account history and enqueue subscription.address_changed. Work stopped for a
ruling. The resumed implementation now includes enqueue in the same transaction;
native subscription_events is the existing account-history source used by the
journey read at 20260817130000_customer_support_journey_recovery_status.sql:200.
The fixed function/table list did not change. No trigger or literal managed
customer_account_events table is added.

The managed donor suite runs the explicit baseline and prerequisites, followed
by the original operator_change_shipping_address_test.sql (39 assertions) and
subscription_change_shipping_address_test.sql (17 assertions), unchanged. A
focused third case proves the open-dunning/no-method address exemption, immutable
version/cadence/date, event-only replay and paid-next-cycle refusal. All three
cases pass in an owned managed-compatible PostgreSQL container. This is local
donor characterization, not a mutation of or qualification against a live adopter.

Accepted differences: new address only; a changed customer payload under one key
refuses instead of managed event-only replay; dispatch ownership skips the current
order and parcel regardless of local editable status. The result names
applied_from_next_parcel on both original and replay. Native claimed/reserved/
attempt_prepared next-cycle operations also fence changes before their cycle row
exists, preserving the donor's locked-next-cycle meaning for native snapshot state.
Address itself never increments template_version or changes cadence/schedule.

## Implementation and seams

Two immutable-document/scoped-binding relations retain full normalized donor
fields. Purchase registration stores its original command fingerprint and returns
that original document on replay, even after a later current-parcel override.
No arbitrary destination-ID selector or saved book is exposed. Client equality is
checked in both writer and reader. Host authorization remains necessary for all
parent-scoped reads and actor-bound commands; a trusted runtime is service authority.

Subscription reads acquire the subscription row FOR UPDATE. An explicit future
binding wins; otherwise exactly one active owning activation resolves its ORIGINAL
purchase registration, not its mutable order binding. Missing/ambiguous/foreign
origin refuses. G2 activation and closed purchase facts remain unchanged. G7 must
keep the same writable transaction from this reader through snapshot/claim and
freeze the returned UUID in orderSnapshot.shippingAddressRef. Renewal order reads
use their own operation's frozen reference, never the live subscription future.
No codec change or invented shipping quote reference.

Shipment reads take native-dispatch advisory then shipment lock and materialize
one initial binding. The host must call that reader in authoritative preparation
before freezing request evidence; an older frozen sibling then retains its own
document. The existing dispatch recipient remains host-supplied. G3's projection
maps recipientName/name, contactPhone/phone and address fields, with deliveryNotes
as deliveryInstructions; email is null until an authorized host contact authority
adds it under the same lock/revision. G3 contact revision is schemaVersion1,
source commerce-destination:<UUID>, revision1. No raw address in dispatch evidence.

Operator correction selects latest parcel by order.created_at, sequence and ID.
Any persisted direct ref, provider command or provider attempt means dispatch owns
it, even queued or terminal history. Under the native advisory/shipment lock,
skip both current bindings/context when owned; subscription future still changes.
Only unowned created/packed/label_pending moves current order and parcel together.
Provider selection, withholding and delivery/pickup metadata remain intact.
mark_command_submitting takes no shipment lock; the predicate stays valid while
that command advances because ownership does not depend on transient status.
Customer changes future only, as characterized.

The public entry is @openlup/platform/commerce/server/destinations, source at the
required subpath/index.ts with closed entry inventory and API snapshot. It exposes
registerOrder/read/changeShippingAddress, explicit now, normalized full document,
and applicability result. JSONB inputs are serialized through a real pg driver.
The native operator branch delegates to the fourth routine; native result type
and decoder add one outcome without changing managed contracts/decoder. Fully
applied current changes use applied and ordinary support replay uses replayed;
partial changes always keep applied_from_next_parcel, next_parcel, future UUID
and replayed boolean. Hosts must show next-parcel applicability to the customer.

## Atomic account and confirmation effects

Address/bindings, subscription updated_at, command receipt, subscription event,
support audit and confirmation enqueue commit together. Matching replay returns
before effect INSERTs. Outbox key is subscription.address_changed:<source event
UUID>; existing UNIQUE(event_type,idempotency_key) plus ON CONFLICT DO NOTHING
implements the donor deduplication. Native subscription_events supplies account
history; there is no second plaintext account-history address copy.

Event payload carries action, newly authored attribution, resulting future
shippingAddressId, outcome, appliesFrom, futureDestinationId and price policy
lock_until_edit/none/future_unlocked_cycles_only. Outbox payload carries clientId,
subscriptionId, action, nextCycleAt, occurredAt, sourceEventId, outcome, appliesFrom
and futureDestinationId. Neither contains the old frozen parcel's address/ref.
The partial result cannot read as a fully applied current-parcel change. Internal
existing receipt/audit outcome stays applied because the future change did occur;
the stored response and event retain its named limited applicability.

An injected outbox CHECK failure proves address, event, binding, receipt and audit
all roll back. No synchronous mail call exists. The existing lifecycleMessages
mapper and explicit host facade can render subscription.address_changed, but no
automatically installed native consumer is found. Mail delivery is unbound.
The outbox worker claims only its registry's event-type allowlist; an unbound notice
does not block money/parcel events. The managed observable effect is enqueue, not
synchronous mail; no delivered-email promise is made here.

## SQL inventory

Forward: db/platform/migrations/20261101225000_commerce_destinations.sql.
Whole-file SHA256 104ef7f72085166dcfe48f5b1622faf2946b5eb95f31a1b56c8e81ca599c69d6.
Existing replacements: none; before hashes empty. Leave subscription_command_apply,
customer_support_apply_subscription_action_v1, subscription_activation_commit and
commerce_create_order_draft_with_outbox unchanged. The inventory is still exactly
four new signatures and two tables; the confirmation decision changes bodies only.

Closed creation list: exactly FOUR functions, all RETURNS jsonb, LANGUAGE plpgsql,
SECURITY DEFINER, default VOLATILE, SET search_path = pg_catalog, pg_temp:
1. public.commerce_register_order_destination(text,uuid,jsonb,timestamptz)
   p_key text, p_order_id uuid, p_address jsonb, p_now timestamptz DEFAULT now().
   Derive client from real purchase order; refuse missing client/renewal order.
   First registration is immutable; match full input fingerprint before current
   order-state checks; changed order/address under key refuses. No overwrite.
   Definer avoids raw runtime writes to private address and binding relations.
2. public.commerce_read_destination(text,uuid)
   p_scope text, p_id uuid. Scope closed to order/subscription/shipment; no
   arbitrary destination-ID read, list/default or saved-address selector.
   Full wire/resolution/refusals are fixed in purchase-interface.md under G3.
   Shipment scope takes native-dispatch advisory then shipment row lock and pins
   the first resolved destination in its own shipment binding before returning.
   This bounded materialization prevents an older dispatched sibling from later
   inheriting an order correction. Subscription scope locks the parent FOR UPDATE through the caller transaction; order/subscription reads do not insert bindings.
   Definer avoids runtime SELECT on the entire most-sensitive PII relation and
   raw INSERT for that shipment pin.
3. public.subscription_change_shipping_destination(uuid,uuid,text,uuid,jsonb,integer,timestamptz)
   p_actor_id uuid,p_client_id uuid,p_key text,p_subscription_id uuid,
   p_payload jsonb,p_expected_version integer,p_now timestamptz DEFAULT now().
   NewAddress-only payload; authentic customer ownership OR independently checked
   active human administrator. Expected version is template_version, unchanged
   by address. Active/paused and donor next-cycle guard; no blanket dunning or
   method gate. Actor/key lock before owned subscription; exact replay precedes
   version/mutation, changed input refuses. Existing command receipt/event path.
   Customer changes future only as donor; operator delegate may repoint current
   parcel as below. Public response names applicability on original and replay.
   Definer bounds private writes and existing command/event locks without grants.
4. public.customer_support_change_shipping_destination(uuid,uuid,jsonb,integer,text,timestamptz)
   p_operator_id uuid,p_subscription_id uuid,p_payload jsonb,
   p_expected_version integer,p_idempotency_key text,p_now timestamptz; no defaults.
   Same active-human check, support-key fingerprint/lock, m12-support owner key,
   subject derivation, exact replay/version/refusal and ownerReceipt as command
   path; delegate to #3, write one support command/audit. No new support ledger.
   Definer avoids widening existing ledger UPDATE/PII access for trusted runtime.

New table definitions and EVERY named constraint are exactly:
CREATE TABLE public.commerce_destinations (
 id uuid CONSTRAINT commerce_destinations_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
 client_id uuid NOT NULL CONSTRAINT commerce_destinations_client_fkey REFERENCES public.clients(id),
 address jsonb NOT NULL,
 revision integer NOT NULL DEFAULT 1,
 purchase_order_id uuid CONSTRAINT commerce_destinations_purchase_order_fkey REFERENCES public.commerce_orders(id),
 registration_key text,
 registration_fingerprint text,
 created_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT commerce_destinations_address_check CHECK (jsonb_typeof(address) = 'object'),
 CONSTRAINT commerce_destinations_revision_check CHECK (revision = 1),
 CONSTRAINT commerce_destinations_purchase_order_key UNIQUE (purchase_order_id),
 CONSTRAINT commerce_destinations_registration_key_key UNIQUE (registration_key),
 CONSTRAINT commerce_destinations_registration_key_check CHECK (registration_key IS NULL OR length(registration_key) BETWEEN 8 AND 200),
 CONSTRAINT commerce_destinations_registration_fingerprint_check CHECK (registration_fingerprint IS NULL OR char_length(registration_fingerprint) = 64),
 CONSTRAINT commerce_destinations_registration_owner_check CHECK (
  (purchase_order_id IS NULL AND registration_key IS NULL AND registration_fingerprint IS NULL)
  OR (purchase_order_id IS NOT NULL AND registration_key IS NOT NULL AND registration_fingerprint IS NOT NULL))
);
CREATE TABLE public.commerce_destination_bindings (
 id uuid CONSTRAINT commerce_destination_bindings_pkey PRIMARY KEY DEFAULT gen_random_uuid(),
 order_id uuid CONSTRAINT commerce_destination_bindings_order_fkey REFERENCES public.commerce_orders(id),
 subscription_id uuid CONSTRAINT commerce_destination_bindings_subscription_fkey REFERENCES public.subscriptions(id),
 shipment_id uuid CONSTRAINT commerce_destination_bindings_shipment_fkey REFERENCES public.fulfillment_shipments(id),
 destination_id uuid NOT NULL CONSTRAINT commerce_destination_bindings_destination_fkey REFERENCES public.commerce_destinations(id),
 updated_at timestamptz NOT NULL DEFAULT now(),
 CONSTRAINT commerce_destination_bindings_order_key UNIQUE (order_id),
 CONSTRAINT commerce_destination_bindings_subscription_key UNIQUE (subscription_id),
 CONSTRAINT commerce_destination_bindings_shipment_key UNIQUE (shipment_id),
 CONSTRAINT commerce_destination_bindings_owner_check CHECK (
  (order_id IS NOT NULL AND subscription_id IS NULL AND shipment_id IS NULL)
  OR (order_id IS NULL AND subscription_id IS NOT NULL AND shipment_id IS NULL)
  OR (order_id IS NULL AND subscription_id IS NULL AND shipment_id IS NOT NULL))
);
ALTER TABLE public.commerce_destinations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commerce_destination_bindings ENABLE ROW LEVEL SECURITY;

All new FK/CHECKs are validated immediately by ordinary CREATE TABLE; no NOT VALID.
All FKs use default NO ACTION; no cascade or existing-parent privilege change.
Bindings have exactly one owner and one row per owner. Cross-client equality is
checked by bounded routines at write AND read. Documents are immutable through
these APIs; new address creates a new UUID/revision1. No generic table CRUD.
Indexes: ONLY the implicit indexes backing the seven PK/UNIQUE constraints:
commerce_destinations_pkey, commerce_destinations_purchase_order_key,
commerce_destinations_registration_key_key, commerce_destination_bindings_pkey,
commerce_destination_bindings_order_key, commerce_destination_bindings_subscription_key,
commerce_destination_bindings_shipment_key. No standalone index or trigger.
Existing table schema/index/constraint/trigger changes: NONE.

Exact narrowing/ACL list:
- Two bare REVOKE ALL ON TABLE statements, one for each new table FROM PUBLIC.
- Three conditional table REVOKE ALL blocks, recipients anon, authenticated,
  service_role; each one constant REVOKE on BOTH listed new tables, no other object.
- Two ALTER TABLE ENABLE ROW LEVEL SECURITY statements above, no policy/FORCE.
- Four bare REVOKE ALL ON FUNCTION statements, each closed signature FROM PUBLIC,
  before all conditional function blocks.
- Two conditional REVOKE ALL ON FUNCTION blocks listing all FOUR signatures,
  FROM anon and FROM authenticated; one conditional GRANT EXECUTE ON FUNCTION
  block on all FOUR TO service_role. Roles are never created.
Exactly six DO blocks, one role/verb/object-kind each, table and function blocks
separate: IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='<role>') THEN one
EXECUTE constant string; nothing else, no second branch/format/concatenation.
No table GRANT, existing-table privilege, default privilege, schema/role/owner
change or new policy. Invoker alternative would widen raw PII and ledger access.


Both CREATE TABLE statements pass the unmodified expand-only table grammar in
ordinary and reviewed modes; no <>, regex operator, || or :: in table bodies.
Stronger validation stays in routines. Table-prefix SHA256
8fcb632f6c5899cb7e2d8c7169622a3bc79ed52939c8b74c9d6f757bc0f6044a.
Own-table RLS is the explicitly permitted narrowing, not base expand-only SQL.
All newly created constraints are validated. No table grants or existing-table
privilege changes. Every definer avoids a wider raw PII/ledger table grant and
uses fully qualified relations plus pinned pg_catalog,pg_temp search path.

Runtime DML set: commerce_destinations/bindings; subscriptions.updated_at;
subscription_command_receipts; subscription_events; outbox_events;
customer_support_subscription_commands/audit_events; eligible
fulfillment_dispatch_contexts.contact_revision. No top-level data migration,
backfill, role/default-privilege changes, existing trigger or schema alteration.
The local manifest selects the forward; observed object inventories are measured
on each shape. Separate control admission remains a delivery dependency.

## Proof and limits

Real PostgreSQL17, restricted g3_runtime login assuming service_role; no runtime
raw table access. All four exact signatures execute and expose pinned definer
configuration. Native suite has 22 passing cases, donor suite three passing cases.

- Immutable purchase registration and exact replay; changed payload/key refuses.
- Exact command replay before version checking, stale expected version conflict,
  changed input23505, foreign actor42501, human/control guard, invalid saved book.
- Normalization, active/paused/cancelled behavior, dunning exemption while generic
  pause stays blocked, paid-cycle and pre-cycle frozen-operation refusal.
- One account event/outbox/audit/receipt on replay/concurrent matching calls;
  injected outbox error rolls all mutation back. No notice gates submission.
- Real overlapping transactions: old recipient is already frozen while shipment
  reads created. A test-only event barrier holds the address transaction after
  acquiring shipment lock; a second restricted connection completes
  mark_command_submitting before that transaction is released. Future changes,
  current order/parcel/read stay old, partial original/replay and notice say next.
  A fake host send uses the frozen old recipient and verifies its SHA against the
  immutable command fingerprint. The ledger stores fingerprints, not raw requests;
  actual external delivery is not claimed. Sequence and reverse stale-candidate
  fences also pass. Provider/withholding context remains unchanged.
- Real container restart retains future/current distinction, event/notice counts
  and the same partial replay. Fresh pools reconnect to persistent PGDATA.
- Existing alignment helper runs as fixture owner and proves late delivery
  monotonically extends the next cycle; an undelivered replacement remains outstanding with no confirmation.
  No G3 branch moves a cycle or invokes replacement confirmation.

All five local catalogue shapes install and replay zero writes: legacy92;
qualified bootstrap/separate96; restricted managed/operator95. New digests:
legacy b95744d45902bb2a8610108c64dc886177dd9e1f45186a3c8c9bf5f6f4d3fd81;
qualified bootstrap 00e7db57fe27a4ff3d7e007eafafbe758dbf567b9c98c825ceabf20cfdbb63f5;
qualified separate e9ede569e52d11196f437ccd059ebc8914010eb0087fdea3c503e08b4460f5ac;
restricted managed 807f65031369c0d789503b6b8c392887a65183a97549fd2c3b32e9a514e13287;
restricted operator 90b48ba14004aafd055dbb635cf2c64bb234be920b166cd7c5eac536683a39bb.
No previously issued prefix identity is changed and no class pin/checker is edited.
These runner/install tests are not committed admission/native review/verification.

## Sensitive retained transfer

Capture/restore adds both new tables plus existing command receipts and support
command/audit ledgers this row starts writing. Parents/actors precede documents
and ledgers on restore. Existing event/outbox/context rows are already captured.
Root files add zero npm assets. Connected transfer has nine passing cases,
including exact serialized-row equality for all five relations, original document
and support replay after restore, changed-input refusal, actual cumulative row
AND byte bounds at each new relation, and restricted filtered-reader refusal.
RLS would return zero rows without row_security=off; capture instead refuses the
whole operation, with no partial export. No new transfer login privilege is added.

Addresses are the most sensitive relation in this stream: names, street, phone,
company/tax/instructions plus client and parent identifiers. Binding, reference,
key and reason strings can also identify people. Hosts should use opaque references
and avoid personal data in keys/reasons. There is no destination privacy-export or
erasure path; identity erasure does not erase these documents. Retained operator
transfer is not a subject privacy export. Public owner/package/adapter docs state
these limits and the unbound native mail/capability/host seams.

## Managed rail and delivery boundary

Complete scoped native/managed migration and package/server search finds no six
new object names on the managed rail; read-only adopter origin/main search also
finds none in supabase/migrations, server or src. Managed draft RPC shares the
native name, but this forward neither replaces it nor alters its selected chain.
No managed SQL, managed decoder, G2 activation, G5 checkout file, G7 codec or
existing OMS file changes. Exact unchanged existing tests are run before adapting
an obsolete native-address-unavailable expectation to the explicitly granted path.
The first operator run passed12 and failed that one old expectation; the new test
preserves bounded query/partial outcome semantics instead of claiming availability
without SQL. Remaining compatibility and cheap-check results are recorded below.

## Historical caller stop, superseded by the recovery resume

linkThenApply at packages/platform/src/account-support/operatorRecovery.ts:90
currently reports completed for every result without refusalCode. That mislabels
applied_from_next_parcel. A built-export reproduction confirms actual outer
completed/nested limited outcome. The authorized result/decoder/address branch
cannot fix this caller. A one-expression classification as partial plus regression
was requested; no answer yet, file untouched. No fake refusalCode or coercion.
Consumer acceptance cannot pass until the owner grants that line or supplies a
fix. Separate control/read and ordered predecessors also still block landing.

## Final verification evidence

| Suite/check | Local result |
| --- | --- |
| commerceDestinationsNative | 22 PASS on final SQL, including new donor appliedBy assertion |
| commerceDestinationsDonor | 3 PASS; original managed39+17 assertions unchanged |
| connectedStoreTransfer | 9 PASS on final SQL |
| account-support/operatorAuthority | 6 PASS, old managed cases retained |
| account-support/postgresOperatorAuthority | 13 PASS after authorized address expectation update |
| account-support/operatorRecovery | 14 PASS unchanged; lacks required new partial regression pending grant |
| m12AccountSupportBinding | 17 PASS unchanged |
| packageBoundary | 2,822 PASS |
| accountSupportComposition | 2 PASS unchanged |
| accountSupportOperatorAuthority | 23 PASS unchanged |
| channelConnectedRestore | 1 PASS unchanged |
| connectedManagedRetained | 16 PASS unchanged |
| m14ManagedCatchup | 1 PASS unchanged |
| m14QualifiedComposition | 4 PASS; issued92 prefix unchanged, current96 |
| m14RestrictedConnectedRestore | 15 PASS; current95 count |
| m14QualifiedAdminComposition | 2 PASS; issued91 prefix unchanged, current95 |
| Five measured catalogue profiles | install/replay0 after final body correction |
| Public typecheck | five projects, zero unresolved/consumer diagnostics |
| Full lint | final PASS, zero errors/33 existing warnings |
| API snapshots / ast-grep / whitespace / staged secrets | PASS |

First unchanged operator adapter run passed12, failed its now-obsolete native
address-unavailable expectation. The new case asserts bounded query and exact
partial outcome; email/phone/link refusals remain. Current-count assertions in
qualification child/restricted helpers initially still expected95/94 and failed
before exercising installation; only those current counts were advanced96/95.
Issued prefix lengths/digests and privilege/restore/shadow/refusal assertions stay
unchanged. Final admin helper count is corrected and both cases pass.

One account-support import failed when the author overlapped lint's prebuild with
the test and dist was replaced. The unchanged suite passed once built outputs
were fixed; build-mutating and package-import stages are now serialized. This
was a scheduling error, not an implementation or fixture repair.

Final donor field comparison corrected operator appliedBy to the donor's
customer_self_service_delegate rather than generic native null. Exact signatures
and two tables unchanged; all five catalogue hashes and native proof refreshed.
No further SQL/body changes are planned. The current policy ref is
09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a; AGENTS/CONTRIBUTING/AI policy bytes are
unchanged from the fork. No main merge merely to catch up.

## Real package measurement

The final measurement uses isolated copies from landed complete-catalogue commit
09cd599b. Apply exactly this branch's package diff additively, then project its
complete current manifest and real SQL asset using the landed algorithm. Build
and npm pack both: baseline2,318,731 B/2,913files; candidate2,326,711 B/2,917files.
Delta **+7,980 B/+4 files INCLUDING SQL and packaged manifest**, only20 B below
8,000. This supersedes the earlier SQL-only repack (+7,901). Baseline matches the
landed measurement. All copies are inside this worktree; no branch merge, budget
edit or other worktree mutation. Root transfer/test/API snapshot/fragment changes
add no npm assets. Any approved caller repair must be repacked; later predecessor
integration still requires its actual pack. Numeric gate budgets remain unchanged.

Remaining effort1-2workingdays for caller/check/read/integration, excluding owner,
control and predecessor waits. WIP commits only; no DCO/native review/canonical
verify/push/PR. No supersededByStableJourneyKey/checkoutAbandoned writes or added
place for dispatched attempts. Native review repair cycles used: zero.

Self-retro: donor trigger closure and response fields must enter fit before a
port freezes; both omissions were caught before read. Real concurrent command
submission exposed why a shipment-status-only mapping is unsafe. Table-limit
fixture ordering and the overlapping prebuild were corrected without production
bypasses. Existing child proof counts must advance with the measured suffix while
issued identities remain fixed. Several focused admissions waited60-150seconds;
these are actual resource waits, not a reason to bypass the gate. No unrelated
mechanism, abstraction or process/control change is added.


## Recovery-caller and R0 integration resume

The supervisor now authorizes only operatorRecovery.ts line90 to classify the
named future-only result as partial, with an additive regression. Audit the same
refusalCode-in pattern and all callers of the native subscription result before
read; another unsafe caller outside a one-line unowned-file repair is a stop.
The hard stop is8,200 B including SQL/manifest, replacing8,000. Prior real pack
is+7,980 B; report any growth and its required caller/projection cost. No safety
text or tests may be cut for size. No DCO/pin/checker/native review is authorized.

Merge origin/main once as expressly requested, with a merge commit, no rebase.
Fetched main is09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a. The sole conflict is
additive prose under Compatibility lifecycle: preserve G3's destination limits
and R0's complete-catalogue installation guidance, with no SQL/source resolution.
Run existing imported-module suites unchanged except authorized literal current
chain-count/catalogue updates, including native communications event paths. The
four signatures/two tables remain fixed. G4 and all other worktrees stay untouched.


Caller audit after the granted one-line recovery repair: seven refusalCode-in
checks across packages/platform/src and server. operatorRecovery.ts:90 now
returns partial for applied_from_next_parcel while retaining the named nested
result; original and replay regressions are additive. operatorAuthority.ts:284
is a decoder rejection check and reconstructs the named result explicitly.
m12AccountSupportBinding.ts:35 preserves result.outcome; its older browser DTO
refuses the new outcome, proved by an additive route/decoder test. This reference
route is not a fully bound native address-change UI: hosts use the public native
result/binding and must present next-parcel scope. No browser success is coerced.
customerRecoveryCommand.ts:221 uses the separate managed subscription result;
:269 and:293 are email/phone results. leadAbsorption.ts:159 uses its separate
lead result. None of those four receive the native destination outcome.
Other result callers are pass-throughs: createOperatorRecovery.execute:117,
postgresOperatorAuthority.ts:48/56, managed operatorAuthority.ts:338,
customerJourneyBinding.ts:192; the old Postgres customerSupportJourney.ts:168
explicitly throws authority-unavailable. Type/barrel exports classify nothing.
No second unsafe success classifier found; no additional production-file repair.

The import/helper caller closure plus transfer/qualification/communications and
packaging witnesses selects66 files after following the managed-storage child-process proof
(machine inventory in scratch). Include
communicationsNative and subscriptions/facades: subscription.address_changed
has a template mapping in lifecycleMessages.ts and an explicitly host-composed
reference facade, but no automatically registered native consumer. An unbound
pending notice is not claimed by unrelated outbox handlers and does not gate
money or parcel dispatch. Confirmation enqueue, not delivered mail, is the donor
effect being ported. The current native routines and packaged projection both
hash3ca1a151b7ad7d7dd01ed7cf40c50d91dfac39f5d2ed1a76e81a9a3743e50413;
SQL bytes, four signatures and two tables did not change in this resume.


The separate full-OCI M14 handover entry tests/postgres/runM14EffectHandover.ts:54
imports the changed finite transfer profile but asserts82tables; the accepted
five-relation G3 addition makes87. It is outside Vitest discovery, requires a
separate image/module profile and has not been run or weakened. Clarification
was requested because the unchanged-existing-suite exception names migration
chain counts, not this table count. No full handover/qualification claim is made.
The focused closure additionally follows the managedStorageTransfer child proof:
that unchanged existing suite passes, bringing the selected list to66 files.
The reference recovery factory m12OperatorRecoveryBinding.ts:20/27 is another
construction-only pass-through; it makes no outcome classification.


Final role-evidence tightening retains the old owner-based alignment helper and
adds an actual public delivery-alignment port arrival/replay through the restricted
runtime, after an admitted address change. Assert the exact outer maximum of
prior next-cycle and arrival+cadence, no address/replay cycle movement, and active
status. The separate undelivered-replacement case now also asserts admitted
address effect before checking its unchanged case/date and no arrival. No
replacement confirmation call is introduced. This is test-only, zero pack growth.
The compiler caught two errors in the new arrival object's evidence reference;
using the declared evidence: prefix and literal type fixes test construction,
without production/SQL change or diagnostic waiver. Native and typecheck reruns
replace their earlier source observations before the final read.


The stronger late-arrival case first failed because the generic purchase fixture
has neither renewal correlation nor active activation anchor. The unchanged
20261022090000_fulfillment_delivery_alignment.sql view:104 and recorder:227
correctly classify that world as manual_review/missing_renewal_correlation,
so it cannot auto-align. Do not change that SQL or waive the cycle assertion.
Use the supplied fixture's existing withActivation/activationOnly path instead,
which exercises subscription_activation_commit and gives a real cycle0 anchor.
Assert protected/cycle0 before restricted arrival, then the exact monotonic clamp.
Other fixture callers keep their original default behavior. No new fixture
privilege, SQL/signature/table change, grant or package byte is introduced.


The activation-anchored runtime arrival/replay assertions pass. Its first rerun
then exposed test isolation: the added case left global auto_align enabled,
so a later pre-existing destination fixture's planned-cycle insertion correctly
failed subscription_delivery_alignment_stale_schedule. Capture and restore the
prior mode in the added case's finally; do not edit the later case or SQL guard.
This restores the same off setting left by the original helper and adds no fixture
privilege. The final native rerun must pass all22 cases before any read claim.


## Post-R0 focused existing-suite results

All 66 selected Vitest files pass, 3769 test cases. The list follows direct
and transitive changed-module imports and the managed-storage child-process
proof, plus native communications/lifecycle, retained-store, catalogue/qualification
and new destination witnesses. Every pre-resume assertion remains unchanged;
this resume adds only the granted recovery original/replay regression and the
route/old-browser refusal test. Prior current-chain counts/measured current
catalogue changes remain; issued prefix pins and refusal/privilege assertions
stay untouched. No production/SQL repair was needed after the one granted line.
No full-OCI handover result is included or implied by this focused list.

| Test file | Result |
| --- | --- |
| `packages/platform/test/account-support/accountReadFacade.test.ts` | 6 passed (6) |
| `packages/platform/test/account-support/accountReadModels.test.ts` | 58 passed (58) |
| `packages/platform/test/account-support/bindings.test.ts` | 5 passed (5) |
| `packages/platform/test/account-support/browserSafety.test.ts` | 1 passed (1) |
| `packages/platform/test/account-support/contracts.test.ts` | 1 passed (1) |
| `packages/platform/test/account-support/customer360.test.ts` | 60 passed (60) |
| `packages/platform/test/account-support/invoiceAccess.test.ts` | 38 passed (38) |
| `packages/platform/test/account-support/operatorAuthority.test.ts` | 6 passed (6) |
| `packages/platform/test/account-support/operatorRecovery.test.ts` | 16 passed (16) |
| `packages/platform/test/account-support/orderHistory.test.ts` | 34 passed (34) |
| `packages/platform/test/account-support/ownerRefusals.test.ts` | 27 passed (27) |
| `packages/platform/test/account-support/paymentMethodComposition.test.ts` | 16 passed (16) |
| `packages/platform/test/account-support/portFit.test.ts` | 1 passed (1) |
| `packages/platform/test/account-support/postgresOperatorAuthority.test.ts` | 13 passed (13) |
| `packages/platform/test/account-support/selfService.test.ts` | 8 passed (8) |
| `packages/platform/test/account-support/subscriptionCommandCodec.test.ts` | 5 passed (5) |
| `packages/platform/test/packageBoundary.test.ts` | 2840 passed (2840) |
| `packages/platform/test/subscriptions/facades.test.ts` | 43 passed (43) |
| `scripts/packages/platform-cold-consumer.test.ts` | 108 passed (108) |
| `scripts/packages/platform-migration-projection.test.ts` | 1 passed (1) |
| `scripts/packages/reference-delegation-consumer.test.ts` | 1 passed (1) |
| `server/bff/customers/account.test.ts` | 2 passed (2) |
| `server/domains/customers/customerAccountHandler.test.ts` | 6 passed (6) |
| `server/domains/customers/customerAccountReadDiagnostics.test.ts` | 4 passed (4) |
| `server/runtime/auth/emailTrustBinding.test.ts` | 16 passed (16) |
| `server/runtime/auth/identityReadiness.test.ts` | 40 passed (40) |
| `server/runtime/auth/referenceIdentity.test.ts` | 93 passed (93) |
| `server/runtime/outbox/candidateAdmission.test.ts` | 9 passed (9) |
| `server/runtime/public-reference/browserIdentity.test.ts` | 3 passed (3) |
| `server/runtime/public-reference/communications.test.ts` | 2 passed (2) |
| `server/runtime/public-reference/m12AccountReadBinding.test.ts` | 2 passed (2) |
| `server/runtime/public-reference/m12AccountSupportBinding.test.ts` | 18 passed (18) |
| `server/runtime/public-reference/m12OperatorRecoveryBinding.test.ts` | 6 passed (6) |
| `server/runtime/public-reference/m12SelfServiceBinding.test.ts` | 15 passed (15) |
| `server/runtime/public-reference/m12SupportReadBinding.test.ts` | 45 passed (45) |
| `server/runtime/public-reference/m14OperationsBinding.test.ts` | 10 passed (10) |
| `server/runtime/public-reference/serve.test.ts` | 11 passed (11) |
| `server/runtime/public-reference/subscriptionAccount.test.ts` | 10 passed (10) |
| `server/runtime/public-reference/subscriptionOperator.test.ts` | 4 passed (4) |
| `server/runtime/public-reference/subscriptionProfile.test.ts` | 24 passed (24) |
| `server/runtime/public-reference/subscriptionSelfServiceGuardrails.test.ts` | 5 passed (5) |
| `src/public-reference/accountSupportReads.test.tsx` | 1 passed (1) |
| `src/public-reference/accountSupportRecovery.test.tsx` | 2 passed (2) |
| `src/public-reference/accountSupportRoutes.test.tsx` | 5 passed (5) |
| `tests/platform/catalog/m05Composition.test.ts` | 1 passed (1) |
| `tests/platform/channels/channelConsumer.test.ts` | 2 passed (2) |
| `tests/platform/inventory/inventoryConsumer.test.ts` | 2 passed (2) |
| `tests/postgres/accountSupportComposition.test.ts` | 2 passed (2) |
| `tests/postgres/accountSupportOperatorAuthority.test.ts` | 23 passed (23) |
| `tests/postgres/accountSupportReads.test.ts` | 5 passed (5) |
| `tests/postgres/accountSupportSelfService.test.ts` | 3 passed (3) |
| `tests/postgres/accountSupportUpgrade.test.ts` | 2 passed (2) |
| `tests/postgres/channelConnectedRestore.test.ts` | 1 passed (1) |
| `tests/postgres/channelManagedRetainedInstallation.test.ts` | 1 passed (1) |
| `tests/postgres/commerceDestinationsDonor.test.ts` | 3 passed (3) |
| `tests/postgres/commerceDestinationsNative.test.ts` | 22 passed (22) |
| `tests/postgres/communicationsNative.test.ts` | 20 passed (20) |
| `tests/postgres/connectedManagedRetained.test.ts` | 16 passed (16) |
| `tests/postgres/connectedStoreTransfer.test.ts` | 9 passed (9) |
| `tests/postgres/m14ManagedCatchup.test.ts` | 1 passed (1) |
| `tests/postgres/m14QualifiedAdminComposition.test.ts` | 2 passed (2) |
| `tests/postgres/m14QualifiedComposition.test.ts` | 4 passed (4) |
| `tests/postgres/m14RestrictedConnectedRestore.test.ts` | 15 passed (15) |
| `tests/postgres/m19MigrationFacade.test.ts` | 3 passed (3) |
| `tests/postgres/managedStorageTransfer.test.ts` | 1 passed (1) |
| `tests/postgres/partnerAcquisition.test.ts` | 10 passed (10) |


## Existing standalone witness stop

Unchanged tests/postgres/runM14EffectHandover.ts, run through the focused gate
with Node24.21.0 and the supplied already-local immutable image
sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20,
exits1 at:55: Keep the 8A-extended finite graph unchanged, actual87 != expected82.
Its current-inventory preflight passes; full handover and later profile admission
are not reached. This is an actual unchanged-witness failure, not a waived run.

Cause is exactly G3's five additive capture/restore entries: commerce_destinations,
commerce_destination_bindings, subscription_command_receipts,
customer_support_subscription_commands, customer_support_subscription_audit_events.
All82 original names and their relative order remain. Dropping those entries
would lose required address/replay/history transfer and is not a valid repair.
The smallest candidate repair is one expected table-count literal82->87 followed
by the full unchanged witness. It is NOT applied: the supervisor's exception
names migration-chain counts, not this finite profile guard. No new source/SQL
fix, weakened assertion, ignored case, cap change or bypass. The pending scope
question is now backed by an actual preflight result. This blocks a read-ready
claim until the supervisor disposes of the existing-suite requirement.

The four signatures/two tables and final canonical/projected forward SHA remain
3ca1a151b7ad7d7dd01ed7cf40c50d91dfac39f5d2ed1a76e81a9a3743e50413.
All66 focused files pass3769cases, including the final restricted-runtime late
arrival/replay clamp and undelivered replacement assertion. Current actual pack
remains+7999 B/+4files including SQL/manifest. No DCO/native review/pin/checker or
other worktree change. Ordinary review repair cycles remain0.


Final cheap checks pass on the frozen test/source candidate: five-project public
typecheck has0 unresolved edges and0 consumer errors; API check passes after the
R0 build; ast-grep passes; full lint has0errors and33existingwarnings. All2917
packaged files still byte-match the actual2,326,730 B tarball after lint's rebuild.
The package delta is+7,999 B/+4files,19 B above the previous+7,980; archive diff
shows only src/account-support/operatorRecovery.ts and its emitted JavaScript
changed,55unpacked B each. All SQL/manifest bytes match the earlier R0 projection.
The after-hash utility for simple replacement headers rejects DEFAULT now();
using the existing default-aware batchedFunctionDefinitions reader correctly
extracts all four fixed signatures. Neither SQL nor a checker was edited.

Self-retro: the complete caller search closed the default-success gap, and the
child-process search added the managed-storage proof. Strengthening the role
witness caught an incomplete fixture anchor and leaked test mode; using the
supplied activation path and finally-restoring prior mode preserved the actual
alignment guard and all later assertions. The remaining standalone profile
failure is reported, not normalized away. No useful additional abstraction is
needed; scope now stops at the existing-witness ruling. Gate examples:240s build,
241s pack,151s first typecheck,331s native strengthening; no gate bypass.


## Refreshed handoff ruling, same run

Final freshness read of writers-common adds an explicit extension to the count
exception: runM14EffectHandover.ts:53-55 pins current inventory and connected-table
count; update both to measured values, leave its message text and everything else
unchanged, and execute all handover assertions to the end. That supersedes the
pending scope question/blocked counter stop above. Current e9ede569... inventory
already matches measured qualified separate96; only literal82->87 changes now.
The five table names and preserved old82 names/order are recorded above. No
source/SQL/function/table inventory or package-byte change. No new permission
question is needed; continue the existing supplied local Node/profile witness.


## Full standalone handover completion after the extended ruling

The witness executes to its end and exits0 under Node24.21.0 plus the supplied
immutable local image. Outcome:
LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION.
Actual selected catalogue96 ends at G3's3ca1a151... forward and observes measured
separate inventorye9ede569...; current finite graph87 is explicit and asserted.
All source-writer retirement, graph/private-media publication, recovery and target
activation assertions execute. Two independent accepted effects are recovered;
one uncertain operation remains fenced. One ordinary duty dispatches through
actual restricted R; replay makes0provider calls after the initial1. The worker's
expected uncertain refusal is preserved, not suppressed. Cleanup failures empty.
No full-store RPO/SLO, real-provider or hosted acceptance claim.

Evidence report: .context/scratch/oss-m14-connected-catchup/journey-nomMFW/report.json;
summary+digest: .context/scratch/g3-resume-handover-proof.json. The previous87/82
preflight failure remains historical and is now closed under the refreshed count
rule, not waived. Witness delta from the prior WIP is exactly82->87, message and
all other body statements unchanged. Both literals relative to R0 are measured:
current inventorye9ede569... and count87. Five names that moved the count are above.

Current source code base stays09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a; no second
main merge. Fresh policy fetch is4c7afd2590dc6998e22464153fca70a92eecfeb2. Only
changed AGENTS/CONTRIBUTING clauses permit a tree-identical trailer tip after a
qualifying reviewed integration merge; no native review is started here, so that
route is not claimed. The user-provided guide and no-DCO boundary still apply.
Full result is66 focused files/3769cases PLUS the full standalone witness.


Final read preparation: refreshed typecheck passes5projects/0unresolved edges/
0consumer errors after the authorized count update. Full lint passes0errors/
33existingwarnings; ast-grep passes. Package/API source bytes are unchanged from
the actual7999 B real pack; SQL canonical/generated3ca1a151... remains exact.
All66 focused files/3769cases plus the full standalone handover now pass. Fresh
scoped portability/tests no-impact trailers bind the measured count and executed
full witness; no CONTRIBUTING or architecture-guidance change is needed. The
initial counter block is closed only by the explicit refreshed instruction and
complete run, not by treating a preflight as handover proof. Unsigned WIP/read
only; no DCO/native review/pin/checker, no second main merge or G4 change.

Closing self-retro: refreshing instructions at the actual handoff caught the
newly authorized counter rule and prevented an obsolete blocked stop. Measured
87 preserves the82 old names/order plus exactly the five declared additions.
Keeping the literal and full assertions retains the guard; running to the end
proves its finite scope while preserving one intentionally fenced uncertain duty.
No further optional changes or new mechanism are warranted. Remaining owner
read/control/ordered integration is1-2workingdays excluding waits; native review
repair cycles0. OMS marker/attempt-storage exclusions remain unchanged.


## Accepted-read additions and DCO preparation

The supervisor records the accepted head3d2b167d/treec097681f/forward3ca1a151/
diff00e9a131 read. Only an additive real-PostgreSQL same-transaction read/enqueue
race and public transaction/privacy wording are authorized before DCO as
Bart Roszkowski <dev@openlup.com>. No renewed read for exactly that delta. No SQL
change is authorized: if the test shows the lock fails to span that transaction,
stop and report the SQL question. No pin/checker or native review action.

The earlier frozen-command tests cover a command committed before address change.
Their helper's autocommit read/enqueue pair is not a safe general host recipe.
The new test must hold one restricted-role connection/transaction from read to
enqueue, observe the concurrent editor actually waiting on its advisory lock,
then commit the command before permitting the edit. It must fail if that lock
is absent, and assert the named next-parcel result, dispatch_owned reason, old
parcel/order reader and old frozen command fingerprint. No migration byte changes.

Public owner wording must explicitly carry full postal addresses and contact
phones, state no erasure path, and require read/enqueue in one transaction and
connection; otherwise the host owns the window. Use root owner docs outside the
tarball to retain the measured7999 B package within8200, not a cap raise.
The address-change notice binding is owned by G8, with no G3 mail change.
Remaining native review waits on the small control and earlier slots. No G4 or
other worktree changes, no reserved OMS marker/attempt-storage change.


## Accepted-read race proof and final local checks

CD-M19-74 same-transaction witness PASS on actual PostgreSQL through the public
port and restricted g3_runtime/session service_role. The preparation connection
begins a transaction, reads the old immutable shipment document and retains its
native-dispatch advisory lock. A second runtime connection starts the address
change before enqueue. Owner observation asserts that the editor has an ungranted
advisory lock matching the preparer's granted lock AND pg_blocking_pids identifies
the preparer; an early editor completion or absent lock fails the test. Preparation
then enqueues the old fingerprint on that same connection/transaction while the
editor is still waiting. Commit releases it; the change returns
applied_from_next_parcel, currentParcel.reason=dispatch_owned, on original/replay.
Order/shipment readers still return the old document, the command retains its old
fingerprint, status stays created, and the subscription reader exposes the new
future destination. No SQL correction was needed or made. The existing earlier
freeze/submit race remains a distinct witness, not proof of the read/enqueue gap.

Fresh targeted suites: native23, donor3, transfer9, operatorRecovery16,
operatorAuthority6, postgresOperatorAuthority13, reference m12AccountSupportBinding18,
packageBoundary2840: eight files/2928cases PASS. These reruns strengthen the
accepted66-file/3769-case evidence, not a claim that all66 were rerun for this
additive test/docs delta. Full standalone handover evidence above remains intact.
Logs are .context/scratch/g3-dco-native.out and g3-dco-<suite>.out. Fresh typecheck
passes5projects/0unresolved edges/0consumer errors. All original existing tests
stay unchanged in this delta. No production source, SQL, package or config change.

The public owner sections explicitly say full postal addresses and contact phone
numbers, opaque identifying references, and no erasure path. DATA_AND_MIGRATIONS
requires one transaction/connection for shipment read and enqueue; otherwise the
host owns the intervening window. These root docs add zero tarball bytes. G8 owns
the address-change notice binding; G3's durable transactional notice is unchanged.
Real npm pack including SQL/manifest remains2326730 B/2917files versus R0's
2318731 B/2913files: +7999 B/+4files,201 B under8200. Canonical and packaged
forward remain3ca1a151b7ad7d7dd01ed7cf40c50d91dfac39f5d2ed1a76e81a9a3743e50413.

For the granted DCO preparation, certify the four own unpublished WIP commits
including the actual R0 merge, preserving every tree and the parent topology;
only DCO metadata and mapped parent identities change. Retain the accepted read
object under an own backup ref and record a before/after tree map in scratch.
The final accepted additions commit carries the new scoped tests no-impact
trailer rather than changing CONTRIBUTING. No code rebase, second main merge,
SQL edit, pin/checker, native review or external write is authorized or performed.

Self-retro: separating the read/enqueue gap from the earlier frozen-command race
made the missing transaction condition observable. Checking the actual waiting
advisory lock prevents a coincidental row-lock wait from giving false confidence.
The smallest adequate correction is the added witness and public composition
requirement; no SQL or package growth is needed. Remaining control/ordered
integration/native review is1-2workingdays excluding waits; repair cycles0.


Final working-tree checks: focused gate admitted lint after93s; npm run lint
passes with0errors/33existingwarnings, including package rebuild and ast-grep
structural cases. API check passes; typecheck results above remain green. Fresh
lint/API used supported Node24.22.2/npm11.19.1; the prior selected proof/pack used
Node24.21.0/npm11.19.0. All2917 files in the actual current pack byte-match after
the final lint rebuild. Package SHA256 is
3d0e460a8d34d7d10a4cf62acf0dc9a30939ea0d0b1ac0f251a8f314895ea310.
Redacted WIP scan includes merge diffs and all four own commits, with no leaks.
The change note is packages/platform/changes/native-destinations.md; CHANGELOG
is unchanged. The final scoped tests trailer binds the additive witness; no
CONTRIBUTING edit. Historical no-DCO WIP messages retain their original context;
the current accepted-read grant authorizes their later sign-off. No native
review, canonical verify, push or external write; control/earlier slots remain.


## Exact definer-header spelling repair

The supervisor authorizes only the four definer-header attribute spellings from
SET search_path=pg_catalog,pg_temp to SET search_path = pg_catalog, pg_temp,
plus exact canonical/package projection hashes and any measured inventory pins.
No other SQL byte, signature, ACL or behavior changes. Re-run native PostgreSQL,
measure current chain inventory and handover pins, and pack on the official
Node24.21.0 toolchain against its +7807 B measurement. Commit DCO-signed; no
pin/checker/native review or other-worktree action. The existing accepted-read
scope, privacy limits and G8 notice ownership remain unchanged.

The refreshed existing-suite rule explicitly includes the released-schema upgrade
witness. Its current-count guard still says94/91 although this row's already
measured chains are95/92; correct only that literal line under the named exception
and execute its upgrade assertions. Historic prefix pins, guard and body stay
unchanged. This closes a missed current-chain witness from the earlier suite list;
it is not an additional SQL or behavior change. Header spacing should preserve
PostgreSQL's normalized stored definition; verify that on the actual chain proofs
before deciding whether any inventory or handover pin needs changing.


Header-only delta proof: canonical and packaged forward are identical; replacing
exactly the four old header substrings with their requested spellings reproduces
the complete new file byte-for-byte. No body, signature, ACL, table or other SQL
byte changed. New whole SHA256:
104ef7f72085166dcfe48f5b1622faf2946b5eb95f31a1b56c8e81ca599c69d6.
Exact diff: .context/scratch/g3-header-only.diff; proof:
.context/scratch/g3-header-sql-delta-proof.json. R0 generator refreshed packaged
SQL/manifest; only three canonical forward hashes and four projected copies of
that hash change. No object-inventory digest moves. Updated after-statement hashes:
public.commerce_read_destination(text,uuid)
  98281cc8a26421dc08506cec7d6332c75d35f74f9ebe57e8a1d627a0cb5f2c4f
public.commerce_register_order_destination(text,uuid,jsonb,timestamptz)
  a78694eafb85cd8e43a2dbf8379ae303a7f744187cba7bd290785251514efa18
public.subscription_change_shipping_destination(uuid,uuid,text,uuid,jsonb,integer,timestamptz)
  4e8c26611e79cde0b1d76718fef6966d4c8bf868db4b3e2ed7d7ed7eb79b6f08
public.customer_support_change_shipping_destination(uuid,uuid,jsonb,integer,text,timestamptz)
  1d46c163cab94822f15af870ea98ae2dde7fd56af7a11dce5eac791a1c76a8ce

Fresh real-PostgreSQL native23, qualified-chain4, qualified-admin2 and released
legacy upgrade1 all PASS (four files/30cases). Qualified tests measure both
binding shapes/modes; admin tests measure both role modes; legacy upgrade executes
its backfill, interrupted-transaction and replay assertions with92 current units.
Native verifies each definer's stored proconfig is search_path=pg_catalog, pg_temp
and retains the transaction race/replay/refusal/restart witnesses. PostgreSQL
normalizes the attribute spelling: all five catalogue hashes recorded above stay
exactly unchanged. Qualified96/admin95/legacy92 and connected87 stay fixed.
The handover's e9ede569... inventory pin and87 count therefore do not move; no
handover pin/body edit or standalone rerun is needed for this conditional repair.
The prior completed full handover remains historical evidence, not a fresh run.
Suite logs and result list: .context/scratch/g3-header-*.out and
.context/scratch/g3-header-test-results.json. One launcher attempt ran no tests
because local vitest was missing from PATH; adding local binaries after the
required official Node directory corrected it without any fixture/source change.

Official Nodev24.21.0 from ~/.local/share/openlup-toolchain is first on PATH.
Fresh origin/main is4c7afd2590dc6998e22464153fca70a92eecfeb2, unchanged from this
worktree's already measured clean archive base. Real pack2328346 B/2917files
versus base2320536 B/2913files: +7810packed B, +2614code-gzip B,
+39885unpacked B, +4files. It moves+3packed B from+7807 solely for this requested
SQL spelling/hash projection; disclosed immediately after measurement. Total
unpacked11018163 B, code-gzip1862324 B, docs-gzip59459 B; all class caps pass.
The canonical SQL adds12rawbytes; no TypeScript/API/package note/doc growth.
The actual real tarball matches every2917file in this worktree; artifacts in
.context/scratch/g3-header-pack. G4 and all other worktrees stay untouched.

Neutrality passes0increases against the actual09cd599b code base; ast-grep,
API and whitespace pass. Fresh scoped tests no-impact binds the authorized
released-chain literal correction, not a CONTRIBUTING edit. No pin, checker,
new public outcome, managed SQL, OMS marker, dispatched-attempt storage or G8
notice-binding change. Native review remains unstarted; ordered control and
predecessor slots remain. Native repair cycles0; remaining1-2workingdays excluding
waits. Self-retro: exact SQL substitution and actual PostgreSQL catalogue
comparison separate source spelling from stored semantics, avoiding unnecessary
inventory or handover repinning. The newly named existing-upgrade witness exposes
a missed count guard; running its assertions closes that omission rather than
relaxing the guard. Keep the official Node path first and local tools available.


Final repair checks: fresh typecheck5projects/0unresolved edges/0consumer errors;
full lint/ast-grep PASS0errors. Lint prints99warnings:33existing worktree warnings
plus exactly the same33 in each of the two ignored official-measurement archive
copies. Per-path/message comparison confirms no new source warning; proof is
.context/scratch/g3-header-lint-warning-proof.json. No ignore/baseline/checker edit.
Focused gates waited190s for read-only typecheck and94s for lint. All2917 actual
tarball files byte-match this worktree after the final official-toolchain rebuild;
no extra pack/code growth. Scoped tests no-impact covers the measured released-
chain literal only; policy checks it on the signed commit. No CONTRIBUTING edit.
Only six tracked files change: two exact SQL copies, canonical and projected
manifest hashes, this task record and the released-upgrade count literal line.
Fresh native23 plus chain/upgrade7 PASS; handover/catalogue pins remain unchanged.
The measurement archives explain lint's repeated warnings without a source repair
or weakened check; do not describe the99as99new source warnings.


## Combined hold/destination continuation: time VALUE proof

One combined candidate/review budget0/3 is authorized; no SQL or decoder change.
The supervisor accepts SQL-only identity when PostgreSQL renders a typed instant
at UTC and TypeScript never builds/parses/compares that key. G4's expiry is that
case. G3's own fingerprints contain no typed time. Preserve each distinction:

| Own time use | Class | Treatment |
| --- | --- | --- |
| TS register/change now | VALUE | destinations/index.ts binds input.now directly, with no JS Date parsing of stored values. |
| Native operator branch clock | VALUE | postgresOperatorAuthority.ts:48-51 uses a fresh options.now clock; no stored time feeds it. |
| SQL p_now/defaults/created_at/updated_at/audit times | VALUE | forward:9,26,101,130-132,137,194-197,215-218,224-249,254,297-307; timestamp storage and event values, absent from command fingerprints. |
| SQL scheduled_at = next_cycle_at / cycle-lock arguments | VALUE | forward:188-190 compares/passes stored timestamptz within SQL, keeping microseconds. |
| SQL order created_at sorting | VALUE | forward:200; SQL ordering only. |
| Document reader | No time field | forward:98,114 returns only ID/revision/client/address. |
| nextCycleAt in operator response and notice | VALUE | forward:233-239 retains stored precision in JSON; response is display/egress data, not an identity or SQL match input. |
| Existing operator decoder instant() | VALUE/display conversion | operatorAuthority.ts:99-103,119 normalizes output through Date to millisecond ISO; new restricted-route proof records this exactly. Do not change the shared decoder. |
| Owned time IDENTITY | None | Registration/address/support fingerprints and notice keys use no typed time. Host opaque payload strings remain facts, not inferred time fields. |

The new real PostgreSQL case stores next_cycle_at2026-11-30T12:00:00.123456Z and
calls the actual restricted service_role/g3_runtime authority, native decoder,
createOperatorRecovery dispatch and reference route. Effective role is asserted
NOSUPERUSER/NOBYPASSRLS. It runs UTC, Etc/GMT-9 and Etc/GMT+5. Raw receipt JSON
is respectively12:00:00.123456+00:00,21:00:00.123456+09:00 and
07:00:00.123456-05:00 on2026-11-30. SQL casts canonicalize each back to the exact
stored microsecond instant and assert the subscription is unchanged. Every route
response is2026-11-30T12:00:00.123Z: milliseconds, with456microseconds truncated
by existing instant(). Matching replay gives the same value. This is a factual
VALUE readback result, not a microsecond-preserving wire claim.

Callers traced on frozen51c029d1: postgresOperatorAuthority.applySubscriptionAction
returns nativeSubscriptionCommand; operatorAuthority.subscriptionCommand:119
constructs nextCycleAt through instant(); nativeSubscriptionCommand:283-286
passes it; operatorRecovery.execute:117 and linkThenApply:90 return the result;
server/runtime/public-reference/m12AccountSupportBinding:39 puts it in the response.
The managed counterpart server/domains/support/customerRecoveryCommand:228 also
projects its own result as a response; runtime/support/customerJourneyBinding:192
only delegates. Browser response schema customerSupportCommandContracts:198
validates a DTO; accountSupportRecovery displays outcomes and never reuses the
time. No repository caller sends this operator response time back to SQL or
compares it as an exact instant/key. accountReadModels/editCutoff and account
UI nextCycleAt fields are separate query models, not feedback of this response.
Search snapshots g4g3-next-cycle-callers.txt and the result-type/call-site search
are retained in the bundle worktree scratch. No external host behavior is claimed.

Before integration, this new case passes in an exact scratch archive of51c029d1
inside the bundle worktree, with local workspace packages built on official
Node24.21.0. The G3 worktree is untouched. It will run again on the final bundle
and in the requested sweeps. Existing late-delivery clamp/replacement and named
next-parcel proofs remain unchanged and must pass with the combined SQL chain.

## Combined purchase holds and destinations: integration evidence

The supervisor authorizes one local bundle, with two exact DCO merge commits:
`941c64e4` integrates `48fb8a20` (tree `12754c5b`), and `2cc64167`
integrates `51c029d1` (tree `61152662`). The separate pin commit is
`cf890d9f`; no native review, canonical verification, push or PR is authorized
in this run. The bundle has consumed zero of its three native repair cycles.
A subsequently repaired predecessor must be integrated only when the supervisor
names its head.

Both own production deltas preserve their accepted added/deleted line hashes:
G4 has 362 lines, SHA-256
`5eb934055d876b047e16713a3fd2c9b84dc20416ffa4b002acc8c27eefd06162`;
G3 has 377 lines, SHA-256
`a7326d0a08dcd291f45fdee999163dc3b8d546619d534ff42809b8d58c624cbf`.
Every own production source and canonical SQL file is also byte-identical to
its accepted row head. G4's generated packaged SQL copy and both manifest
projections are now present; the canonical and packaged forward hashes stay
`0fe4c20229e3635d61f820788e7d2b98148c8fd46daede44260f71da121e9323`
and `104ef7f72085166dcfe48f5b1622faf2946b5eb95f31a1b56c8e81ca599c69d6`.

The transfer union preserves all added content lines: first merge 63 G4 and
274 predecessor lines; second merge 337 integrated-predecessor and 54 G3
lines. Sorted added-line hash lists match before and after each union. The
complete transfer file passes all 16 cases without coverage. Both fixture sets
run without row/key collision. Duplicate activation table entries were
deduplicated in capture/restore; the actual connected graph has 98 tables.
The two destination relations carry full postal addresses and may carry contact
phones; transfer enforces cumulative row and byte limits and no erasure path
is provided. Purchase references may also hold identifying strings; hosts
should supply opaque references.

Real PostgreSQL measured the current inventories and replayed each installation
with zero additional migrations. Historic inventory pins remain unchanged:

| Shape | Units | Actual current inventory SHA-256 |
| --- | ---: | --- |
| Legacy | 95 | `877bdd3d4db0e71da014647e6e8a884f8626ea59206dc6c70c4cad2477719a61` |
| Qualified bootstrap with restore | 99 | `e578feac21e0329e3dd17f8188ad42c6ff522672708d23c7c6bdf236a6e65819` |
| Qualified separate migrator with restore | 99 | `f0723c366ccbc4de21ea433efe880a286a2b3d09aa74114eb823faa6157848dd` |
| Restricted admin installer-managed | 98 | `6930bc93c7975858d1357cb0801b840eb4590571330c796cf1020a8b0a356a60` |
| Restricted admin operator-provisioned | 98 | `0f51f4ee95a8d756e62352443d79f1fde45c41dafc62279a5c12bf05eaeb67e7` |

The producer is `node --import tsx .context/scratch/g4-inventories.ts`, using
real containers, the canonical migration runner, catalog projection and a
fresh runner replay. The literal change tables retain both parent values and
the measured replacement in `.context/scratch/g4g3-*-literal-report.json`.
The actual capture export supplies the handover table count; the unrelated
catch-up outbox expectation remains one.

Main's `79ebda3d` registry/admission reader accepts G6, G2, G4 and G3 and passes
co-location against the exact predecessor. The real catalog suite passes all
130 cases with `service_role` present and absent. The pin commit changes only
the two row bindings and the bound-list test description/expectation, now
`slots.slice(0, 4)`.

| Official Node 24.21.0 real pack | Predecessor `48fb8a20` | Bundle | Delta |
| --- | ---: | ---: | ---: |
| Packed bytes | 2,435,777 | 2,449,097 | +13,320 |
| Code gzip bytes | 1,950,344 | 1,954,742 | +4,398 |
| Unpacked bytes | 11,454,327 | 11,524,618 | +70,291 |
| Files | 3,021 | 3,029 | +8 |

Both the 1,970,000-byte code cap and 2,485,000-byte packed regroup point
remain satisfied. The package includes both real SQL assets and manifest
entries. The per-file itemization is
`.context/scratch/g4g3-bundle-size/itemization.json`: exact marginal prefix-gzip
contributions at every content-changing file, plus an explicitly identified
unchanged-content dictionary/framing residual. Those contributions sum to the
real pack and policy code-class deltas, rather than adding standalone gzip
sizes. Root capture/restore files, native tests and these records add no
tarball bytes.

The joined capture-after-cancel test originally assumed a flat response shape.
The predecessor returns the outcome under `event`; the corrected assertion
checks that exact shape and requires the review column to exist. Its isolated
real-PostgreSQL run passes, including restart, the `review_required` persisted
fact and released stock. No production code or SQL repair is involved.

Self-retro: preserve complete shared proof cases, then measure the combined
catalog rather than adding parent counts. An overly broad local count rewrite
also touched an unrelated catch-up assertion; inspection restored its original
value and narrowed the helper before the witness run.

### Bundle time sweep and timeout measurements

All 55 initial solo no-coverage cases pass: 28 purchase, 24 destination and
three bundle-owned transfer cases. The latter measure 6.30, 4.97 and 3.68 s;
each now has an explicit 30,000 ms timeout and its measured one-line comment.
The 52 native cases are below three seconds when run solo.

The current ten-file real-PostgreSQL sweep reports:

| Sessions | Passed | Classified main observations | Unclassified failures |
| --- | ---: | ---: | ---: |
| Default UTC | 204 | 0 | 0 |
| Etc/GMT-9 | 201 | 3 | 0 |
| Etc/GMT+5 | 201 | 3 | 0 |
| Alternating UTC / Etc/GMT-9 | 197 | 7 | 0 |

Every own native case passes in all four modes. The observations are confined
to the nine preclassified main sites: the date-only retry fixture, two raw
transfer representations, two retry rollback snapshots, two technical-stock
snapshots and two restored-line snapshots. Those main assertions are unchanged.
The diagnostic startup hook checks each actual connection's requested zone and
role and patches newly loaded pg copies; it is ignored scratch, not a product
default, parser, export, CI exemption or committed harness change.

Two own test snapshots initially compared PostgreSQL-rendered time strings from
different sessions. Purchase snapshots now retain every field under a local
read-only UTC transaction. The destination transfer comparison reuses the
existing UTC census and still compares all five address/support tables without
truncating times or dropping fields. These are the expressly authorized test-side
zone corrections; production source, SQL, grants and behavior stay unchanged.
The transfer merge's original added-line and callback-body hash witnesses were
recorded before this separate correction. Full current-mode reports, startup
connection probes and the earlier failed observations remain in scratch.

Public owner prose now reflects the integrated class/pins and the proved
late-capture review result, rather than the earlier draft's pending-control
state. Source admission remains separate from manifest selection. Dedicated
promotion cancellation and native address-notice dispatch remain unbound here;
the notice binding belongs to the communications follow-up. The package README
correction needs a fresh official pack before the final report.

### Bundle integration stop: cold-consumer export classification

The actual cold consumer stops in assertExportInventory at
scripts/packages/platform-cold-consumer.ts:170: the installed manifest exposes
commerce/server/destinations but neither closed classification list names it.
A complete comparison finds exactly that one unclassified export and zero stale
entries. The original accepted G3 head also lacks this classification. No source,
SQL, assertion, registry or control fix was made after this finding. The existing
suite stop rule requires reporting before a source repair. The bounded proposed
repair is the own non-adapter inventory line plus a regression assertion; no SQL,
public API, signature, grant or cap needs changing.

Current completed proof, without coverage: 26 further focused files / 446 cases,
all green; this includes all 11 unchanged starter files. The remaining focused
queue is paused, not claimed complete. Four full composition files pass22 cases;
all22 cases pass solo. The repeated own proofs pass32 cases (all28 purchase,
the restricted next-cycle route and allthree own transfer cases); the original
55-case solo evidence remains. Slow transfer cases retain explicit30,000ms
comments; additional composition timeout comments are not yet finalized. Their
existing explicit600,000ms (restore1,200,000ms) cold-setup overrides remain, and
measured solo timings are retained in g4g3-composition-timeout-table.json.

The handover witness ran to its end in99.128s:98tables, two accepted effects
recovered and one uncertain operation fenced. The complete report is in
.context/scratch/oss-m14-connected-catchup/journey-Klwh7S/report.json. The10-table
growth is G4's five purchase/stock relations and G3's five destination/support
relations already listed above. Historic catalogue pins stay unchanged.

Official final pack supersedes the earlier figure: predecessor48fb8a20 packed
2,435,777 ->2,449,053B (+13,276); code1,950,344 ->1,954,742B (+4,398);
unpacked11,454,327 ->11,524,562B (+70,235); files3,021 ->3,029 (+8).
Real SQL and manifest are included. It is44B below the first bundle pack after
the public-text correction. Per-file packed/code attribution is retained in
.context/scratch/g4g3-final-size/itemization.json. No cap or gate number changed.
The clean exact candidate archive passed packages:check --pack for allthree
publishable tarballs, without findings. Actual cold starter173tests, typecheck
and build pass before the export-classification refusal. A separate Linux glibc
2.36 / officialNode24.21.0 install passes with networknone, a fresh empty cache,
only local tarballs and all required omission/script flags. Its installed public
factories preserve the microsecond input, named next-parcel outcome and bounded
cancel call, with both packagedSQL hashes checked. This is a bounded installed
entry proof, not a claim that the full cold consumer passed on Linux.

Time sweep connections were353 inGMT+5,352 inGMT-9 and353 in mixed mode, over
tenfiles each, with zero requested/actual zone mismatches. Effective restricted
role proofs remain in the committed native cases. Both neutrality checks pass;
strict typecheck has zeroerrors/edges, lint zeroerrors, astclean. Policy retains
three unanswered scoped no-impact obligations, to settle with the final delta.
No native review/session, canonicalverify, push, PR or delivery occurred;0/3
cycles consumed. DCO finalization and the supervisor-named repaired predecessor
remain pending. No G3 or other worktree was edited.

Self-retro: the real installed consumer catches a missing export classification
that synthetic fixtures generated from the same lists cannot expose. Running it
earlier than the remainder of the broad suite queue bounded the wasted work.
Stop before repairing shared source; the package and SQL outcomes themselves
remain unchanged. The remaining suites and final identity must be recomputed
on the resumed, repaired candidate.

### Landed-base continuation

The supervisor accepted the prior stop and authorized exactly one cold-consumer
classification addition, the named main merge46c3e8b2, remaining proofs and final
DCO. Merge9937722a is DCO-signed; its sole conflict keeps the complete own transfer
case and main's timeout comment/arguments verbatim. Sorted added-line hashes match
for121bundle and16main lines. Stable patch IDs change243a97b4 ->c5b5d03a because
context moved; all5295changed lines have identical sorted hashd7c5434d before/after.
No SQL or derived catalogue input changed. The review base is now actual main;
OPENLUP_STACK_BASE is unset. Native review, canonical verify and submission remain
unauthorized; pin commitcf890d9f and line654 remain unchanged pending lead approval.

The built destination declaration has zero imports and only local interfaces and
built-in types (SHA25601d31fb3d05a9402db6d3df53c3398c84989364fd47c1f2b35cd997117c2acea).
It cannot reach data/pg declarations, so commerce/server/destinations is a
NON_ADAPTER entry under the cold consumer's own rule. Only that single name was
added to the list; no other line in that source file changed. The earlier stop
is resolved by this specific registry-union authority, not by widening a checker.
Measured composition cases receive explicit40/45/60/75second budgets and comments;
released-upgrade has the required30second minimum. Assertions, SQL and historic
pins are unchanged. Remaining focused files and installed proofs run on this base.

### Final landed-base local proof

All242 focused files pass6588 cases with zero failures and skips. The complete
file list and per-file cases/timings are in g4g3-focused-files/results.json;
g4g3-focused-summary.json groups the exact results. Commerce112/887,
inventory9/45 and account-support20/307 all pass unchanged. Package boundary2948,
import map123, outcome projection7, documentation CLI3/bundle20, cold-consumer
unit122, migration admission24 and registry691+210 cases pass. All11 pure starter
files pass173 cases; the installed starter repeats173 cases, strict typecheck
and build. This is local conformance, not hosted qualification or release.

The full cold consumer passes both peer modes, NodeNext/Bundler declarations,
packaged migration modes (qualified99/admin98), native communications/operations
and SQL conformance with no live provider. Its cache was fresh and supplied from
outside the process. The three verified tarballs are byte-identical to the
accepted Linux glibc2.36 / Node24.21.0 offline empty-cache installed proof; its
install set did not change. Official pack on main46c3e8b2 stays2449053B (+13276),
code1954742B (+4398), unpacked11524562B (+70235),3029files (+8), including SQL.
No cap, version, baseline or exemption changed. Full per-file packed/code
attribution is in g4g3-main46-size/itemization.json.

Main46's own forward checks accept allfour bindings; final co-location refuses
the classification path as recorded below. Catalog130/130
passes with roles present/absent. Full transfer16/16 retains both parent case
sets and new address/hold rows with limits. The five actual catalogue
measurements and their zero-application replay remain unchanged; final full
composition and upgrade tests confirm those exact literals. The handover
witness reaches its final98-table assertion in99.128s, recovers two accepted
effects and fences the one uncertain operation. Its scope remains finite.

Allown52 native cases pass on the landed base; six donor cases also pass full
and solo. The earlier83 distinct owned/changed native, donor, transfer and
composition cases have solo measurements without coverage. Slow cases now have
measured comments and explicit budgets: transfer30s; admin45s; qualified40s or
75s; restricted restore60s; released-upgrade30s. Their final full suites pass.
The accepted timezone sweep remains204/0,201/3,201/3 and197/7, with only the nine
classified main sites and no own failures. Actual zone probes353/352/353 have
zero requested/actual mismatches. G4 identity is PostgreSQL-built SQL-only,
no TypeScript key; G3 nextCycleAt is VALUE-only millisecond egress with exact
stored microseconds and no feedback caller. No decoder or SQL change was made.

G4's joined capture after cancel persists review_required after restart and
released stock. G3 never updates a cycle or confirms delivery. Existing delivery
alignment and renewal lifecycle suites pass; their clamp guards plus own
unchanged-date/dunning tests preserve late-only extension, no stacking or earlier
cycle and no confirmation of an undelivered replacement. Both actual parcel
races retain the old record/fingerprint and name the next-parcel outcome.
The fresh seven-site refusalCode audit still names/refuses the native outcome;
four managed sites use another type. Current full postal addresses and contact
phones remain under transfer limits, opaque-reference guidance and no erasure
path. G8 owns the notice dispatch; dedicated promotion cancellation is unbound.

Strict typecheck has zero errors/edges; lint zero errors (342 existing warnings),
ast and both neutrality checks pass. WIP all-ref gitleaks scans1773 commits with
zero findings. Final scoped trailers answer the three unchanged owner sections;
no CONTRIBUTING edit. DCO completes only the two own WIP messages and their
necessary descendant parent references, preserving checked trees, the three
merge shapes, incoming main and pin commitcf890d9f. Final identities/mapping and
DCO verdict are retained in the read packet. No native session/review, canonical
verify, push, PR or release; budget0/3. The lead's pin-test approval remains a
review prerequisite, outside this local proof.

Self-retro: real installed discovery caught the missing entry classification;
list-derived fixtures could not. A parallel prelint rebuild temporarily removed
core/dist during one collection. No assertion ran; its single isolated retry
passed6/6 after the build ended. Subsequent builds/tests were serialized. Keep
prelint's build side effect in the stage plan, and report process exit/suite
collection errors rather than only failed-assertion counts.

### Final admission stop

Status is BLOCKED, not ready for native review. The final main46 reader accepts
allfour native forwards, then assertCoLocatedForwardApproval refuses at its
releaseTool guard (reviewed-platform-forward.ts:893-894). The sole matching path
is scripts/packages/platform-cold-consumer.ts. Its own delta is exactly the one
NON_ADAPTER_ENTRIES addition approved by the supervisor; no other line changed.
The guard treats every non-test scripts/packages path as release machinery and
has no disjoint registry-union exception. Current main d848d684 has the identical
reader. Do not remove the needed entry, alter a checker, choose a false base or
weaken a test to obtain admission. The coordinator must reconcile this guard
with the approved registry-union rule in a separate control. No SQL/signature,
runtime permission, package-cap or new API decision is needed in this feature.

The earlier co-location PASS was taken before this one-name source edit and does
not certify the final candidate. All242/6588 functional cases, full cold consumer,
policy with12answered obligations,130catalog cases and full-range14/14DCO pass;
the admission refusal remains mandatory. DCO certifies provenance, not a green
admission check. No native review/session, canonical verify, push or PR occurred.
Source/SQL/product tarballs remain unchanged; this stop correction changes only
the two task records. Pin commitcf890d9f and all controller source stay intact.

Main advanced to d848d684 (#515 starter support/catalogue binding). Its read-only
merge-tree with the candidate is clean (exit0); no extra main merge was made,
as instructed. The actual review fork remains46c3e8b2. Final identities and
read-only merge-tree output are retained in the external packet.

Self-retro: run the exact main co-location preflight immediately after every
admission-relevant path edit. A conceptual data-only union ruling and a blanket
machine path guard can disagree; a pre-edit PASS cannot cover that later edit.
This was found late after DCO completion; no reviewer or delivery consumed it.

## Transitive operator API report correction

The accepted additive `applied_from_next_parcel` operator outcome also reaches
`account-support/postgres`. Regenerated the API reports with the repository's
`api-contract.ts --update` command on the complete bundle, with the destination
export still present. The only generated change is the eight-line union addition
in `packages/platform/api/account-support-postgres.api.md`; the complete API check passes for every
entry. No source, SQL, gate, checker or other snapshot changed.

The accepted-read authority is CD-M19-74/-75, read packet `reads/g3.md:140-148`,
with register rows CD-M19-64 and CD-M19-61 and the lead's additive operator-outcome
ruling. The eight generated lines match that accepted wording exactly:
`applied_from_next_parcel`, `appliesFrom: "next_parcel"`, `futureDestinationId`,
`replayed`, and the inherited optional `ownerReceipt`. No additional outcome
or field was introduced.

Execution lesson: run the complete API report check immediately after a public
type changes. Boundary tests do not establish that transitive reports are current.
The public destination entry remains scheduled for a separate no-SQL change;
the split's feasibility checks are still pending.

### Public-entry split feasibility stop

The complete API report passes both with and without the destination export after
that transitive report correction. The proposed split's real pack is 2,448,971 B
(code 1,954,742 B, unpacked 11,523,820 B, 3,029 files), +13,194 B packed against
the exact main predecessor. This is a feasibility measurement, not the restored
bundle's final pack. Main's original admission reader passes all four forwards
and co-location on the scratch split tree; policy passes with the changed,
scoped tooling no-impact explanation.

The split nevertheless cannot proceed unchanged: the existing lint rule refuses
public destination imports in tests/postgres/commerceDestinationsNative.test.ts
(line 9) and tests/postgres/connectedStoreTransfer.test.ts (line 3). The strict
typecheck reports the same two unresolved import edges against its zero pin.
Those tests remain unchanged. Reverted every uncommitted public-entry removal;
the accepted API report correction is retained. No checker, rule, baseline,
source, SQL, gate, import, or test assertion was changed to accommodate the split.
No export leaf, native review, verify, push or PR was created.

Completed split checks: import map 123, package boundary 2,948, outcome projection
7, published-tree checker 74, catalog/document boundary 10, documentation CLI 3,
and the four-bound PostgreSQL catalog in both modes 130; all pass. The remaining
commerce, account-support, native destination, starter and full consumer checks
were stopped at the required decision boundary. Linux consumer setup did not
reach a consumer run; its incomplete build supplies no timing evidence.

Self-retro: run the complete API report immediately after a public-type change,
and check existing installed-subpath imports as soon as an export split is
proposed. A passing export inventory does not prove its existing tests can compile.

## Destination entry predecessor integration

The destination public entry now lands first as a separate no-SQL change. This
bundle stacks on that exact entry change and supplies the routines, internal
operator integration, SQL pins and real-database proofs. Release tooling is
identical to the predecessor. The public owner text now states that the routines
are included; the predecessor-only undefined-function interval ends here.

## Donor mapping

Each rule is ported from the reference adopter's behaviour; the rule-by-rule mapping and witnesses are in the maintainer packet.

The current source-rule mapping and production-composition reachability audit
are recorded in the private maintainer packet. The earlier admission and
compensation guards are ported and accepted; these two destination changes await
their read. This is source and local-database evidence, not hosted qualification
or a blanket service-parity certificate. Listing exposure remains a registered
follow-up outside this bundle; native stock accounting does not subtract it.

Accepted differences and limits:

- Only a new address is accepted; a saved address book is outside this change.
- First order registration is immutable; destination reads are scoped and
  shipments receive their own destination binding.
- Changed customer input under an existing key refuses rather than replaying
  from an event alone.
- Dispatch-owned orders and parcels keep the frozen destination, including when
  local shipment status is created, packed or label_pending. The subscription's
  future address changes and the response names `applied_from_next_parcel`.
- The additive operator outcome and recovery result retain next-parcel
  applicability; recovery reports partial rather than completed.
- Address changes do not move a cycle or confirm an undelivered replacement.
  Confirmation mail belongs to the following communication binding.

The private maintainer packet retains the complete package-path
inventory and its source-composition evidence. An additive result type or installed-version pin does not establish
production reachability or service parity. The public-entry predecessor is
untouched.

Self-retro: public records can state the porting boundary and limits without
exposing the reference adopter's source structure.


## Retained parcel ownership reconciliation

The current draft restricts current-parcel selection to orders owned by the
subscription's client, as well as its subscription-cycle scope. The function
signature and header are unchanged. Beyond that lookup, only the reason-event
projection admitted below changes; all other statements are unchanged. The draft
adds a restricted-runtime retained-row regression and an executable source-pinned
lookup witness; every existing case remains unchanged. Five installation
profiles measured new current inventory digests and exact replay wrote nothing.

The earlier rule-chain review found that the optional address-change reason was
accepted but omitted from its persisted subscription event. The resumed draft
ports its persistence in the same function: the top-level reason keeps the
reference normalization, and the nested payload retains the originally supplied
reason. Missing reason has no nested key; the top-level value is JSON null,
as is an empty reason's top-level value. Supplied whitespace is preserved.
Restricted customer and operator cases cover present, empty and absent input
and matching replay; the operator case also checks changed-reason conflict. An exact-source event witness
checks the same normalization. Existing tests remain unchanged.
The source reconciliation, reachability audit and evidence stay in the private
maintainer packet. The draft remains staged for a read; no native review or
delivery is claimed.

Self-retro: reconcile the full event payload as well as locks and ownership;
a command fingerprint preserves identity, not the meaning of a reason.


## Current combined ownership and reason proof

All 24 pre-existing destination cases remain byte-identical. Five additions
cover retained-owner selection, the characterized lookup, customer and operator
reason persistence, and the characterized event expression. The complete suite
passes 29 cases in each of default, two non-UTC and mixed sessions, including
restricted-runtime event readback. The unchanged purchase-hold suite passes
40 cases in each profile. The four-bound catalog passes 130 cases in both role
modes; complete transfer passes 17; handover completes with 99 tables and its
expected single fenced uncertain operation. The managed characterization passes
three cases, including 56 pgTAP assertions; six composition cases pass.

The five new cases also pass solo without coverage, with body durations from
2.8 to 143.7 ms. Existing explicit transfer/composition timeouts and comments
remain unchanged. Full API reports pass all 68 entries; typecheck passes five
projects with zero unresolved edges; lint has zero errors and 33 existing
warnings; ast-grep and both neutrality checks pass. The source-rule chain and
26-path production-composition audit are retained privately, with eager barrel
loading distinguished from unselected native branches.

Policy and docs-update read the staged candidate and report 11 obligations,
three awaiting the proposed scoped no-impact trailers in the later authorized
DCO commit. They are not counted as green. CONTRIBUTING and control logic are
unchanged. The delta remains staged; no commit, review, verify, push or PR.
The public-entry predecessor remains untouched.

Measured current inventories (historic pins and counts unchanged):

| Profile | Current digest | Units | Replay writes |
| --- | --- | ---: | ---: |
| legacy | 49b0f960386c612c79c888634f63c59bcae17df0db4d43fa56252bef3bf8e6b1 | 95 | 0 |
| bootstrap | 02be252bdef8b5dbb5053f77d37f058b98f857043cb57ba1875ed796c7cf647f | 99 | 0 |
| separate | 9250799e79557d489f2ce617aa53bb2d6af8a22fc2d1a9e10536d7c849ee404a | 99 | 0 |
| admin-managed | f47ee11eb5a78e01bd9cabb5f2cb63045e96fe005ad57f2a6c5fae5263b679b3 | 98 | 0 |
| admin-operator | 3f4135031c7dcfb3b00238d3475e99ac68f60b9357cd7bdb81d3bfd68dd0c967 | 98 | 0 |


Official Node v24.21.0 pack against the exact public-entry predecessor:
+12,175 B packed, +2,889 B code-gzip, +69,453 B unpacked and five files for the
combined purchase-hold/destination bundle. Absolute totals: 2,454,062 B packed,
1,957,647 B code, 11,544,987 B unpacked, 3,032 files; docs class 65,567 B.
The two destination-body ports and reason documentation add 119 packed bytes
and zero code-gzip over the earlier bundle measurement. SQL, manifest and README
bytes in the extracted real tarball match the draft. No cap changes.

Self-retro: align the complete staged candidate before policy, and prove event
readback through the existing runtime permission as well as runtime writes.
Both ports now have source-pinned and real-database evidence; final delivery
still needs the read, signed commit, native reviews and authorized verification.


## Operator recipe alignment

The typed UUID guard and the linked operator recipe exposed two different gaps
in the same approved outcome: identity validation used text, while a secondary
recipe still described the previous address refusal. The remaining documentation
owner is the current operator recipe and its canonical receipt summary. The
simplest repair is to describe the already implemented bounded new-address branch
and next-parcel result in both places, preserving the separate shipping-port
refusal and managed boundary. Existing native operator, recovery and destination
regressions discriminate writing, replay and partial applicability; no new runtime
mechanism or prose-mirroring test is needed. This corrects an existing accepted
contract; the native address advertisement now matches its accepted writer.
No additional writer or public type is introduced.

Self-retro: accepted native branch plus stale linked recipe → trace secondary
instructions and correct the same contract at its current documentation owners.


## Cycle-2 regroup and claim sweep

Cycle 0's UUID-alias evaluation and cycle 1's operator-recipe evaluation left
material obstacles to the same approved outcome. G3's advertised native
capabilities, operator recipe and contract text must match the writers it
delivers; the owners are the operator-authority contract and canonical contracts.
The port moved writers without sweeping their same-change claims, so stale
claims surfaced one at a time. The simpler path is one sweep of the whole
purchase-hold/destination delta and its touched files, replacing isolated fixes.
The next discriminating step is that sweep plus the restricted-runtime agreement
regression for the moved address writer and every unsupported native subcase.
Address must succeed and unsupported inputs must return their named refusal,
with zero stale claims. Ordinary lifecycle commands retain a separate named
pre-existing limit, not a passing availability claim (CD-M19-219). The existing review history and
cycle budget remain intact. This entry adds no new behaviour or delivery grant.

Lesson: a ported writer without its capability or doc claims → sweep every claim
tied to a moved writer in the same change.


### Whole-bundle claim sweep

The sweep uses the complete delta from the exact export-leaf stack base and the
full contents of its touched files, plus six related binding/owner files. `rg`
checks supported/unsupported/unavailable/refusal wording, each delivered routine,
capability names, operator recipes, destination/reason and next-parcel terms.
Each hit is one matched HEAD file/line, deduplicated; historical stage notes are
qualified by the current status. Generated declarations and exact SQL/pin/test
references are checked against their source, not treated as capability probes.

| Scope | Finding and action |
|---|---|
| 55 files, 3,471 matched lines | 3,448 accurate; 22 stale sites corrected; one pre-existing named limit (F-QUALIFIED-LIFECYCLE-LOCK). |
| Operator capability and expectation | Advertise native new-address change; preserve every other subcase expectation and the managed graph. |
| Operator recipe and canonical receipt summary | Replace old address refusal and incomplete partial-result claims with bounded SQL and next-parcel applicability. |
| Inventory/account-support package guidance | State native zero safety/exposure accounting separately from managed accounting; include next-parcel partial recovery. |
| G4 routine inventory and row-record status | Four runtime entries plus owner-only helper; qualify original separate-row and pre-read stages as history. |
| Admission, hold/release/expiry, compensation, destination registration/read, event reason and frozen-parcel claims | Retain accurate entry, replay, refusal, owner, privacy and default-off boundaries; no SQL or privilege change. |
| Correctly unsupported restrictions | 486 accurate restriction hit lines across 20 checked classes listed below; they are unchanged. |
| Required runtime agreement | The moved address writer and every unsupported subcase have agreement assertions. Separate pause/resume/slide pins require42501 at the term-line row lock and zero new receipts; these are pre-existing known limits, closed by F-QUALIFIED-LIFECYCLE-LOCK, not passing lifecycle claims. |

The 20 correctly unsupported classes are: email; phone; account link;
short-band slide; expired-dunning resume; residual-unpaid resume;
prepared-attempt pause; saved-address selection/book APIs; elapsed/non-finite
expiry admission; non-READ-COMMITTED admission; direct runtime admission-helper
entry; dedicated promotion cancellation; lots/locations/movement history;
direct native stock adjustment; native safety/channel exposure; subject privacy
export/erasure; automatic mail/host activation; the legacy browser's next-parcel
decoder; the separate OMS address-correction port; and unselected host lanes.
These source-scope checks do not certify qualified-runtime lifecycle commands.
Existing lifecycle availability flags and runtime privileges remain unchanged.
CD-M19-219 narrows agreement to the writers moved here;
F-QUALIFIED-LIFECYCLE-LOCK is the registered follow-up. The
qualified runtime lacks the term-line row-lock privilege: ordinary pause, resume
and slide currently refuse42501 with no new receipt. The registered follow-up
F-QUALIFIED-LIFECYCLE-LOCK will turn these and the existing G4 cancel pins into
positive proofs when it lands; this bundle adds no grant.

The parked prose patch was hash-checked and applied exactly first (its proposed
tree matched), then rebased by this sweep's additional claim corrections. No
CONTRIBUTING edit is included; the lead will collect the lesson after delivery.


### Cycle-2 scope correction and discriminating proof

CD-M19-219 confines writer agreement to new-address change and every unsupported
native subcase. The restricted runtime succeeds for the address writer; email,
phone, account link, short-band slide, both unpaid-resume variants and prepared
attempt pause retain their named refusal. Ordinary pause/resume/slide are not
certified by that test. Each has a separate pre-existing42501 term-line row-lock
pin and zero new command receipts, closed by F-QUALIFIED-LIFECYCLE-LOCK.
The same closer is recorded beside both existing G4 cancel pins; those assertions
are unchanged. No capability other than address, table privilege or role changes.
The one bundle-touched lifecycle delegation claim in the package reference now
states this qualified-runtime limit. This is a scope correction, not a reviewer
finding or a new regroup. The registered follow-up F-QUALIFIED-LIFECYCLE-LOCK
will turn the pins into positive proofs when it lands.

The four new cases ran without coverage in the focused lane: address/unsupported
agreement258ms; pause26ms; resume26ms; slide23ms. None needs a per-case timeout
above the existing10s limit. The first lifecycle expectation incorrectly inspected
the adapter's mapped error for raw SQLSTATE; the test now captures and rethrows
the original SQL error at the injected executor, asserting both the unchanged
mapping and the underlying42501. This adds no fallback or production change.
Complete API regeneration adds only the new-address-only comment to two reports;
no public type or other report changes. CONTRIBUTING remains unchanged.

Address admission keeps parity: allowed during dunning and without a method; refused for a locked next cycle (cycle or order status) or a claimed renewal; witnesses are “allows address during open dunning without a method, but preserves the donor next-cycle lock”, “preserves next-cycle ownership before a frozen native renewal has materialized its cycle”, and “witnesses every next-cycle lock branch through the public address port”.

## Cycle-3 absorption classification repair

The moved destination writer introduced a client-referencing table without its
absorption classification. The absorber enumerates every client foreign key and
refuses unknown tables even when the lead has no rows there. The smallest repair
is the single `commerce_destinations` classification as `block`: a delivery
snapshot remains bound to its original order or subscription and is never
carried or rebound during lead absorption. Both forward copies carry the same
statement; their whole-file pins and packaged manifest are recomputed. No grant,
RLS policy, function body, public API or managed migration changes.

Acceptance distinguishes owner execution from the restricted runtime. With a
readable destination table, a destination-free lead absorbs and replays once;
a lead with one destination refuses `lead_has_commercial_footprint` naming
`commerce_destinations`, leaving all subject and destination rows unchanged.
The separate pre-existing-class pin is **restricted absorption refuses 42501 at
the destinations count; closer qlock-3**. It asserts both empty and nonempty
destination cases and zero absorption effects, including receipts and audits.
It is not a passing restricted-runtime absorption availability claim.

This is the third and last automatic repair cycle of the existing bundle.
The worker may commit only tests and this record with DCO; SQL, hashes and
manifests stay staged for a coordinator re-read. The supervisor owns the later
stack integration and two fresh full reviews. No prepare, review, merge,
canonical verify, push, PR or release is authorized in this run.

The initial owner regression exposed a prerequisite missing on this branch:
`identity_privacy_erasures`, `subscription_command_receipts` and
`subscription_stock_wait_cases` are still unclassified. Their existing approved
classification statements belong to the later consent forward. The G3 repair
does not silently add those statements to its own production migration.
The regression fixture supplies exactly those three approved `block` rows as
explicit full-chain prerequisites. It never supplies the destination row: that
must come from G3's actual hash-checked forward. The managed absorption witness
runs unchanged after the complete managed migration chain; the original managed
address witnesses still run on their original baseline. Only the disposable
pgTAP assertion helpers receive test execution permission.

Policy revision read for this repair:
`6979704a5247b1f572b2cbbd8dce487ca37eff88`; code comparison remains the pinned
stack base `c1dd21ddc8954d62c6fe75dcd90c4c774fafb71f`. Reading newer policy
does not merge it into this candidate. Current main's independent helper accepts
all four bound forwards and recomputes their preimages with the exact one-row G3
amendment in a scratch registry. The tracked G3 class slot remains unchanged.

The first scanner invocation inherited the stack base into synthetic child
repositories, causing two documentation CLI expectation failures. Those tests
create their own comparison bases; the corrected scanner invocation unsets that
environment variable only for the scanner process. Policy and neutrality checks
retain the actual pinned stack base. No scanner, fixture assertion or control
was changed to accommodate the invocation error.

<!-- openlup-task-doc-impact {"unit":"tests","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-9a666f5e3d3863a716c13d75e1bfac0f70cc093e647145676863fb4fc3877bb7","reason":"The cycle-3 repair adds owner admission/replay and destination-footprint refusal, the restricted 42501 zero-effect pin and the unchanged managed absorption witness. Full-chain test setup supplies only the three already approved later absorption classifications; the destination classification must come from the real forward. Managed permissions come from the existing complete managed chain, with execution granted only to disposable pgTAP assertion helpers. Existing test commands, native privileges, gate lanes, baselines and contribution controls remain unchanged, so the development-preview test guidance remains correct."} -->

Self-retro: a moved client writer also needs its absorption classification;
exercise the complete foreign-key census before claiming absorption admission.
The one-row fix preserves the existing fail-closed absorber and table privacy
boundary; widening runtime access belongs to its separately owned closer.

### Cycle-3 completion evidence

The canonical and packaged forward are byte-identical, SHA-256
`1cdb720a6fadbfebeca50dad091e709b069639c2a8af9c8abb542f753687980f`.
Removing exactly the added statement reproduces the previous forward byte for
byte. All function hashes, inventory digests and chain counts remain unchanged.
Only the whole-file hash is rebound in the feature pin and manifest projections.

| Executed scope | Result |
| --- | --- |
| Complete default PostgreSQL selection: writers, absorption, catalog/ACL, transfer, composition, restore and upgrade | 318 passed; final managed file separately passes all 5 cases after its fixture refinement. |
| Native writers and named existing absorption suites, plus the existing lead-absorption domain suite | 145 passed in each of `Etc/GMT-9` and `Etc/GMT+5`. |
| Both native writer suites, the same mixed-session profile used in cycle 2 | 79 passed. |
| Direct managed empty-lead admission and address-footprint refusal | Passed separately in both non-UTC zones and mixed sessions, as the managed runtime role. |
| Unchanged managed absorption pgTAP script | All 41 assertions passed in its UTC fixture profile. |
| Stabilized full `scripts/*.test.ts` scanner set | 2,889 passed; one existing opt-in concurrency case remains unconfigured. |
| Built dist exports, package boundary, commerce, account-support, inventory and related dist consumers | 4,285 passed. |
| Required lint, complete API reports, public typecheck, ast-grep and both neutrality checks | Passed; lint has zero errors and 33 existing warnings; all 68 API entries pass; typecheck has zero unresolved edges or consumer errors. |

All six new cases have individual no-coverage measurements. The largest measured
body is 319 ms; existing slow-case timeout comments and budgets remain unchanged.
Startup probes observed zero requested/actual timezone mismatches. Every existing
native destination test byte and every existing managed test body is preserved.

Broader diagnostic runs were retained rather than counted as passing profiles:
the old managed address characterization inserts a date-only cycle against a UTC
anchor; the unchanged pgTAP script expects UTC consent-audit display text; two
transfer assertions compare timezone-rendered timestamp text; and extra mixed
sessions expose the same representation issue in legacy operator snapshots.
No production behavior or existing assertion was changed for these observations.
The unchanged pgTAP witness explicitly runs in UTC and restores its caller's zone;
the separate managed regression proves admission and refusal in that caller zone.

Official Node 24.21.0 real pack against the pre-repair bundle: **+106 packed B,
+0 code-gzip B, +276 unpacked B, +0 files**. Absolute package totals are
2,454,293 packed B, 1,957,699 code-gzip B, 11,545,576 unpacked B and 3,032 files.
Every current package file byte-matches the measured tarball after the final
build. No cap, export, version or dependency changed. No OMS marker write or
additional dispatched-attempt storage is introduced.

The completed full scanner results predate the new single-scanner-lane rule and
are retained under its explicit transition instruction. No full scanner rerun
was started after resumption; any future full run must use that dedicated lane.
Resumption found no owned destination-test container left behind. The interrupted
tail check was rerun; the newer policy read leaves the same main revision above.

Execution retro: the first 431-second scanner run inherited a stack pin into
synthetic repositories. Finish the full-chain and timezone fixture setup before
the broad scanner, and pass scope variables only to commands that own that scope.
The initial empty-branch-slot fixture was replaced with the three already approved
classification prerequisites, making the actual dependency explicit. These are
test and invocation corrections, not additional production fixes or review cycles.

### Frozen prerequisite integration and pre-review stop

The frozen export prerequisite merged cleanly at
`8e6f426d8096c7436a6275d955db5fe0b802aab1`. The comparison base remains
`addfaf98e4d4016d77033459090996d0d44d2dad` for this run.
The official Node real pack measures 2,471,602 packed B, 1,972,863 code-gzip B,
11,615,363 unpacked B and 3,047 files. Against that predecessor the deltas are
+12,614 packed B, +2,828 code-gzip B, +70,042 unpacked B and +5 files.

The dedicated scanner gate admitted the full set, which passed 2,889 cases with
zero failures and one existing unconfigured opt-in concurrency case. Both
neutrality checks, lint, typecheck and the complete API report check passed.
The built dist and module selection, including the complete commerce directory,
passed all 4,311 cases. The default real-PostgreSQL selection passed all 319.

Each full non-UTC PostgreSQL profile passed 316 cases and failed three.
The managed address characterization supplies a date-only cycle against a UTC
anchor, so its lock expectation resolves successfully in either non-UTC zone.
Two transfer assertions compare session-rendered timestamp text with retained
UTC text. The explicit schedule comparison renders 21:00 +09 or 07:00 -05 for
the same retained 12:00 UTC instant. Both affected test files byte-match the
pre-merge head. These are the diagnostic limits already recorded above, now
encountered by the required complete profiles. Native writer, absorption,
catalogue, composition, restore and upgrade cases pass in all three profiles.
The restricted absorption count retains its 42501 zero-effect pin and qlock-3
closer. Full-profile acceptance requires an owner decision before review.

Self-retro: the complete timezone profiles expose fixture timestamp spelling
assumptions that a native-only profile cannot distinguish. Explicit fixture
instants and typed instant comparisons are the relevant repair boundary.

<!-- openlup-task-doc-impact {"unit":"tooling","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-edffdbc49ceda50cd686a36c275a54ee547093b3c4e974a66da125babaf71434","reason":"The integrated forward-registry test changes only its existing title and feature-binding expectation from two bound slots to four. The newly inherited absorption classification assertion is preserved. Reader, admission, review and release control logic and the documented test commands and trust boundaries retain their existing behavior, so the development-preview guidance remains correct."} -->

### Cycle-3 UTC fixture correction and accepted zone limits

The resumed disposition assigns the two transfer text failures to existing main
assertions from `e58cbf12f6b5cd0283ba9adabcce823c127e4e96` and
`dcd8971dc8042bfe99cd6be61a2371824b5d8eb3`, with follow-up
**F-ZONED-TRANSFER-TEXT**. They are accepted failures for this row's non-UTC zone
sweep. The complete three-zone profile retains both assertions.

The managed address case belongs to this row, introduced in `0c953bbf`.
A real PostgreSQL experiment compared its cycle literal with the source fixture's
`next_cycle_at = '2026-09-15T00:00:00Z'`. In UTC the date-only cycle matches.
In `Etc/GMT-9` it denotes an instant 32,400 seconds earlier, and in `Etc/GMT+5`
it denotes one 18,000 seconds later. The managed
`customer_self_service_assert_no_locked_cycle` compares typed instants with
`scheduled_at = p_next_cycle_at`, so these different cycle instants miss the
paid-cycle guard. Explicit `2026-09-15T00:00:00Z` matches in every zone.
The same case's request instant now spells `2026-09-01T00:00:00Z` explicitly.
Both values preserve the fixture's intended UTC instants.

The fix changes only those two test data literals. All assertions and
expectations are retained. The other own-suite date-only values are paired
operation/cycle timestamps, a distant stock-staleness deadline and a subscription
start preceding the exercised dates. Their zone shifts do not affect an observed
result, so the correction remains confined to this managed case.
The previously completed scanner evidence is retained under the resumed
fixture-only exception. The final cycle-3 review follows the rerun profiles,
lint, typecheck and policy evidence below.

<!-- openlup-task-doc-impact {"unit":"tests","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-7e65bd7200e5cdd6f73033341231445b57c080cc7b1525167947db4a769d3991","reason":"The existing cycle-3 owner admission/replay, destination-footprint refusal, restricted 42501 pin and complete managed-chain witnesses retain their assertions. The only new fixture correction gives the managed address case explicit UTC request and cycle instants matching its existing next-cycle anchor. The two inherited transfer timestamp-text failures are recorded with their assigned follow-up. Existing commands, gate lanes, privileges, timeout rules, baselines and test guidance remain correct for this delta."} -->

Current instruction revision read on resumption is
`cec0236b1c1742a4d6184c8ba4c750007bdc7709`. The explicit comparison and review
base remains the frozen export prerequisite above.

The corrected complete profile passes all 319 cases by default. Each non-UTC
profile passes 317 cases with exactly the two accepted transfer-text failures.
The complete managed destination file passes all five cases in every zone,
including its original lock expectation and both absorption witnesses.
The corrected case also passes alone in `Etc/GMT-9`, without coverage, in 17 ms.
Lint and typecheck pass again. Policy has zero unanswered obligations after
refreshing this fixture delta's documentation-impact record.
All packaged inputs remain identical to the measured merged tree.

Self-retro: session-local midnight and an explicit UTC anchor denote different
instants. Spell fixture instants explicitly before exercising an instant-equality
guard, while recording inherited display-only failures under their actual owner.

## Measured deadlines for the complete replay family

The merge-group run [41763619755](https://github.com/openlup/openlup/actions/runs/41763619755)
exceeded the 45-second admin installer case and the 40-second reference bootstrap
case. The single authorized hosted retry is consumed. The current draft changes
only explicit case deadlines and their measurement comments across the entire
chain-growing family, with this record. It remains staged for the lead's read.

The reference, target and admin compositions, four connected-restore shapes and
released legacy upgrade replay the selected current migration chain. All eleven
cases receive the fourfold hosted-maximum rule. The six qualified baseline cases
use fixed baseline SQL; the fifteen qualified-session cases examine admission
and catalog races without replaying an installed chain. Those bounds remain
unchanged. The other eleven connected-restore cases cover authority/refusal or
pre-install status observation without applying the chain, and retain their
existing bounds. Their four status-only shapes are distinct from the four full
restore cases extended here.

A measured successor tree contains this reviewed head and one additional SQL
forward. Its three isolated and three loaded samples for each production
composition case, plus three loaded full-file sibling runs, are reused. Across
its primary isolated samples load1 was 1.22–2.75 and CPU idle 84.32–98.90 percent;
loaded samples observed load1 1.47–2.88 and idle 68.20–98.11 percent. Every reused
local maximum is lower than the corresponding hosted maximum. New baseline
measurements would duplicate that conservative evidence.

The hosted columns below are milliseconds from the last relevant source runs
and the failed group. A timed-out printed duration is a censored lower bound,
not a completed execution. The second source attempt reused successful sibling
jobs; its repeated sibling numbers are retained as that run's evidence rather
than treated as independent samples.

| Case | Bound before | #527 | #529 | #530 attempt 1 | #530 attempt 2 | Merge group |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| neon-shaped installer-managed | 60000 | 38807 | 31717 | 57203 | 57203 | 32199 |
| neon-shaped operator-provisioned | 60000 | 33778 | 26635 | 50725 | 50725 | 27424 |
| rds-shaped installer-managed | 60000 | 33775 | 26048 | 50303 | 50303 | 26330 |
| rds-shaped operator-provisioned | 60000 | 33679 | 26211 | 48408 | 48408 | 27361 |
| reference bootstrap-restore | 40000 | 38118 | 22495 | 40033 | 31513 | 40038 |
| reference separate-restore | 40000 | 30625 | 18962 | 35042 | 24634 | 35760 |
| target bootstrap-restore | 40000 | 24653 | 14984 | 27089 | 20088 | 26791 |
| target separate-restore | 75000 | 49452 | 29204 | 54210 | 40400 | 54315 |
| released legacy upgrade | 30000 | 7855 | 6449 | 4993 | 4993 | 7870 |
| admin installer | 45000 | 46174 | 42680 | 28221 | 28221 | 45410 |
| admin operator | 45000 | 33910 | 32820 | 20816 | 20816 | 36273 |

For each case, let H be its maximum across those five hosted observations and L
its reused loaded maximum. The initial requirement is four times max(H,L).
The selected 240-second value already bounds each qualified-composition child
process; 40 seconds is an existing qualified case value. The child deadlines and
global defaults retain their values.

The source control/export prefix has two fewer forwards than this bundle.
For a conservative estimate, the per-forward growth envelope is
`max(0, (H - min(#527, #529)) / 2)`. Five remaining SQL units consume five times
that envelope. This intentionally includes hosted-load variation and the older
control run, rather than attributing the entire difference to SQL execution.
It estimates future growth; it does not measure future forwards. Headroom below
is the new deadline minus H minus that five-unit growth. Each selected bound
covers four times the currently observed maximum and leaves positive headroom
after the full tail estimate.

| Case | Loaded local max ms | 4 × H ms | New bound ms | Tail growth ms | Headroom after growth ms |
| --- | ---: | ---: | ---: | ---: | ---: |
| neon-shaped installer-managed | 16025.694 | 228812 | 240000 | 63715.0 | 119082.0 |
| neon-shaped operator-provisioned | 13445.680 | 202900 | 240000 | 60225.0 | 129050.0 |
| rds-shaped installer-managed | 13793.466 | 201212 | 240000 | 60637.5 | 129059.5 |
| rds-shaped operator-provisioned | 13799.661 | 193632 | 240000 | 55492.5 | 136099.5 |
| reference bootstrap-restore | 11425.177 | 160152 | 240000 | 43857.5 | 156104.5 |
| reference separate-restore | 11137.656 | 143040 | 240000 | 41995.0 | 162245.0 |
| target bootstrap-restore | 11104.339 | 108356 | 240000 | 30262.5 | 182648.5 |
| target separate-restore | 21628.916 | 217260 | 240000 | 62777.5 | 122907.5 |
| released legacy upgrade | 3656.365 | 31480 | 40000 | 3552.5 | 28577.5 |
| admin installer | 14248.897 | 184696 | 240000 | 8735.0 | 185091.0 |
| admin operator | 13954.731 | 145092 | 240000 | 8632.5 | 195094.5 |

The operator-provisioned admin and all four full restore cases are included by
the whole-family rule, including those with more room under their earlier bounds.
The released upgrade grows from 30 to 40 seconds because 4 × 7.870 = 31.480
seconds. Assertions, fixtures and child processes keep their existing behavior.
Each changed file will run once in full through focused admission before the
staged read packet is finalized.

Self-retro: a replay-family deadline must account for every role/restore shape
and the remaining chain, rather than only the cases that crossed a timer today.
The direct per-case change keeps this recovery within the existing proof entry
points and preserves the assertion duty.

<!-- openlup-task-doc-impact {"unit":"portability-capability","doc":"docs/platform/ARCHITECTURE_AND_EXTENSIONS.md","anchor":"#existing-store-transfer-and-recovery","digest":"sha256-63c49a9a2a4df89f1036f4dfdc2baa3638d6fadbbc6ad57d18c537e1fd584830","reason":"The bundle retains its measured current inventory/count expectations and existing transfer protocol. The only new portability-owned edit is the qualified composition case deadline and its measurement comment. Transport encoding, cumulative bounds, owner admission, retained graph and replay assertions keep their exact behavior, so the store transfer and recovery section remains correct."} -->

<!-- openlup-task-doc-impact {"unit":"tests","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-77e4caa22080ba78f2255f03a4cb1be8a292f8b3216b5f68eb6351407946e83e","reason":"This draft changes only explicit per-case replay deadlines and measurement comments, retaining every test body, fixture, assertion and global default. Bounds use four times the observed hosted maxima and record capacity after the five-unit tail estimate, with focused full-file proof. Existing test commands, role boundaries, gate lanes and sufficient-evidence guidance remain correct."} -->

The staged draft passes one complete focused invocation of every changed file
on the assigned tree, without coverage and with the official Node toolchain.
Production composition passes 4 cases in 52.458 seconds, admin composition 2 in
27.347 seconds, connected restore 15 in 71.164 seconds and released upgrade 1 in
3.942 seconds. Total is 22 passed, zero failed and zero skipped. A TypeScript AST
comparison removes comments and only each case's third deadline argument before
proving equality with the reviewed head for all four files. Every test body,
assertion, fixture, test title, child deadline and global setting is retained.
The AST structural check passes. The final read packet binds the staged tree and
binary diff identity. The draft remains uncommitted for the lead's read.
