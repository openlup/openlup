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

The [membership read forward](../../../db/platform/migrations/20261124120000_catalog_publication_reads.sql)
adds a service-executable page and owner-only evidence helpers. The page uses
the caller's statement snapshot. Its cursor binds the latest sealed issue
across governed products. See the installed
[catalogue entry](../../../packages/platform/README.md#read-governed-offer-memberships)
for paging and refusal behavior.

The [readiness forward](../../../db/platform/migrations/20261124140000_catalog_publication_readiness.sql)
adds a batch read executable by the service role. The snapshot and price
helpers are owner-only.
Outside a `READ COMMITTED` read-write transaction it refuses before locking.
Otherwise it takes `SHARE` on `catalog_products`, which conflicts with the
publication writer's first lock, and reads in a separate statement snapshot.
For each selected product, it uses the current-publication reader's matcher to
compare the live product and its SKU roster with the sealed evidence. A
mismatch refuses the batch.
It writes nothing. See the
[catalogue entry](../../../packages/platform/README.md#read-activation-readiness).

**Qualified publication authority**

The [catalogue read grant](../../../db/platform/migrations/20261124180000_catalogue_read_grant.sql)
requires the cluster login and the database's exact qualified-v2 publication
authority ledger entry. See the [closed native store grant shape](../DATA_AND_MIGRATIONS.md#closed-native-store-forwards)
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

The [`catalog_publication` forward](../../../db/platform/migrations/20261123190000_catalog_publication.sql)
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
The [publication commands forward](../../../db/platform/migrations/20261123191000_catalog_publication_commands.sql)
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
introduced by the post-order control unit. The [risk contract](../ARCHITECTURE_AND_EXTENSIONS.md#risk-contracts)
records the intentional differences preserved by the contribution.

Existing native and managed migration bytes remain unchanged.

Reader guidance: [Subscription delivery alignment](../../../packages/core/docs/guide/concepts/subscriptions.md#subscription-delivery-alignment).

`public.subscription_delivery_alignment_control.mode` defaults to `off`.
The complete mode set is `off`, `shadow`, `protect` and `auto_align`, selected
through `public.subscription_delivery_alignment_set_mode`.

The SQL admission control is `subscription_delivery_alignment_admit_renewal`;
the new-cycle insertion guard uses `subscription_delivery_alignment_admission_required`.
The [native renewal store](../../../server/adapters/postgres/subscription/automaticRenewal.ts)
owns the static terms gate; the
[admission decorator](../../../server/runtime/subscription/deliveryAlignmentRenewalStore.ts)
owns delivery admission. The native composer
[`createNativeSubscriptionBinding`](../../../packages/platform/src/subscriptions/nativeSubscriptionBinding.ts)
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

[The native translation decision](../plans/oss-m08-fulfillment-physical-delivery.md#native-admission-and-delivery-alignment) maps managed activation cycle 1 ↔ native activation ordinal 0, and managed
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
[arrival-only discipline](../plans/oss-m08-fulfillment-physical-delivery.md#native-admission-and-delivery-alignment)
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
The [native witnesses](../../../tests/postgres/paymentProviderStore.test.ts) and
[pgTAP twins](../../../tests/postgres/paymentProviderStorePgtap.test.ts) exercise the
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
not provider activation. The [native attribution witnesses](../../../tests/postgres/paymentReconciliationAttributionGap.test.ts),
[pgTAP witnesses](../../../tests/postgres/paymentReconciliationPgtap.test.ts) and
[installed runtime-role PostgreSQL witnesses](../../../tests/postgres/paymentReconciliationStore.test.ts)
exercise the boundary without live provider access.

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
or manifest row. Install the complete catalogue. The [M06 store matrix](../plans/oss-m06-stock-reservations-delivery.md#parity-pending-rows)
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
[identity recipe](../IDENTITY.md#real-issuer-oidc-recipe) requires real local services.

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
[identity conformance](../IDENTITY.md#conformance-and-outstanding-evidence).
The identity SQL projection is not a standalone install chain.

The canonical source manifest for `db/platform/migrations` is the existing
[`config/platform-migration-manifest.json`](../../../config/platform-migration-manifest.json).
Version 1 keeps one baseline, ordered forward file/hash rows and the issued
selected-catalog-v2 `objectInventorySha256`. The
[source validator](../../../scripts/platform-migration-manifest.ts) also supports
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

The reference [PostgreSQL binding](../../../server/adapters/postgres/migrationRunner.ts)
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
[local production-path witness](../../../tests/postgres/m14QualifiedAdminComposition.test.ts)
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

The [session admission and qualified projector](../../../server/adapters/postgres/qualifiedInstall.ts)
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

Frozen historical record (2026-11-13) archived in [Data and migrations evidence](../history/data-and-migrations-evidence-2026-11-13.md#upgrade-native-method-authority-archived-evidence).

