# Native order, subscription and parcel destinations

Status: owner read accepted for DCO; bounded transaction-race and public-text
additions proved below. Ready for the ordered native review after control and
earlier slots. Latest SQL header normalization is recorded below; submission and
release remain unstarted.

## Outcome, authority and boundaries

G3 ports new-address order/subscription destinations and customer/operator
change_shipping_address, including parcel applicability. Matrix rows: P08, R08,
T04-12, A23, T03-57, A78. Assigned worktree oss-m19-g3, branch codex/oss-m19-g3;
base and recovered policy revision 3887ee7425fd0eddeecd9a8e2ef3e1420bcf640d.
G4 and every other worktree stay untouched. The supervisor authorized local SQL,
manifest selection, public bindings, own API snapshots, transfer additions,
characterization/refusal tests and unsigned WIP commits. No approval-class pin,
checker edit or native review is authorized. The later accepted-read grant below
authorizes DCO; landing still waits for separate control and ordered predecessors. No hosted qualification is claimed.

The lead accepted newAddress only (saved book is a named refusal), a separate
address routine, and future-only application once dispatch owns the parcel.
The latest resume authorizes donor confirmation enqueue in the existing routine
and native subscription_events account history. No fifth signature, third table
or trigger. It also permits only the additive native outcome/decoder lines and
one address branch in the existing operator adapter. Other operator capabilities
remain unsupported in the reference projection; explicit host composition is
required. No existing OMS/G5 files or renewal codec are edited.

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
