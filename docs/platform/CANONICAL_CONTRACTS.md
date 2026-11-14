# Canonical Contracts

Status: maintainer page: how to change OpenLup. Reader guidance lives in the [OpenLup guide](../../packages/core/docs/guide/README.md); sections marked "Evidence" are frozen historical records.

## Explicit reference adapter composition

The development-preview [A1 host binding](../../server/runtime/communications/a1ReferenceBinding.ts)
selects `communications/resend` and `communications/klaviyo` only when
`enabled === true`. Absent or false opt-in returns before loading host inputs or
runtime imports. Hosts supply a lazy input supplier, egress policy, credential
resolution, callback observation port and environment selection, subject mapping,
authority/evidence, verification and shared durable account storage/availability.
The binding creates none of that authority and does not reset account fences.

The exact returned callables are composed and admitted by the existing reference
communications admission. Each effect entry asserts current candidate identity
before policy, credential, clock, network or database work. Routes, schedules and
handler descriptors are empty until explicitly selected by the host; no new
executor, subscription writer or default wiring is installed. The original
transport's egress admission identity survives the invocation guard, so existing
transport injection remains usable. The newsletter bridge retains its refusal.

Polling opens the selected native store per invocation and closes it in `finally`.
A binding-local table maps `email.sent` to `sent`, `email.delivery_delayed` to
`delayed`, `email.delivered` to `delivered`, `email.failed` to `failed`,
`email.bounced` to `bounced` and `email.complained` to `complained`. Unknown kinds
throw before the native writer; IDs, recipient and timestamp pass through.
Neither public port nor adapter mapping changes. Native replay and three-404
abandonment retain their existing semantics. The
[eight-case ledger](plans/oss-a1-communications-adapters.md#p3-explicit-reference-binding)
names the offline falsifiers and their limits.

## Opt-in payment example

The experimental Node `payments/stripe` subpath exposes its M07 factory,
configuration type and observed capability descriptor, plus the bounded
[reference-support surface](../../packages/platform/README.md#reference-support-surface). The host owns SDK and
transport construction, customer association, mode policy and explicit activation.
No import installs a route, binding or schedule. Attempt identity, fingerprint
and provider idempotency key pass through to the donor execution seam. A
client-confirmed handoff carries a transient secret; diagnostics carry neither
that payload nor provider prose. Synchronous issuer declines carry neutral
refusals and never claim pre-dispatch absence.

Verified events retain their event ID and provider time (or null), with a stable
fingerprint independent of receipt time. Method lifecycle facts stay distinct
from money and retain provider time and replacement facts. When provider time
is absent, the method outcome remains but the lifecycle field is omitted.
Missing refund evidence is refused; valid `amount_refunded` is a
cumulative snapshot with original money and a stable operation ID. Disputes
are emitted as the `disputed` money outcome with the original payment identity
and the dispute amount the provider reports, which can differ from the payment amount. Readback preserves
`active_checkout` and `recovery` semantics, rejects mismatched identity/money,
and keeps uncertainty unknown. Close requires injected cancellation; incomplete
metadata search never enables exact absence. Refund creation and a split
between authorization and capture remain unsupported. Account-dependent offers
remain pending TEST evidence; see [A2](plans/oss-a2-payment-adapters.md).

The `payments/tpay` example uses asynchronous injected certificate resolution
and original notification bytes. Verify certificate validity and notification
freshness: both certificate windows use an injected clock; a signed issued-at
assertion provides provider time, otherwise time remains null. Receipt time
participates only in freshness. Notification age and future-skew limits apply
only when the signed header carries a provider issue time; without it, replay
protection relies on host event identity plus fingerprint deduplication.
Transaction identities combine payment reference
and outcome; method identities combine event/alias and lifecycle outcome. The
host deduplicates identity plus stable fingerprint.
Currencyless money notifications preserve the paid amount and bind to the adapter's single declared currency; multiple declared currencies refuse as malformed.
Chargeback becomes an
explicit full reversal with original money and operation ID. Missing reversal
evidence refuses. Alias method evidence carries the donor lifecycle through M07
projection only when signed provider time is present; without it the lifecycle
field is omitted. Unknown alias lifecycle events refuse `unsupported-event`.
Readback retains purpose, checks exact transaction identity/configured money,
and reports configured money for pending and refused results even when the paid
amount is zero or absent. Unpaid pending transactions remain pending; a dated donor refusal
reports failed unless nonzero paid money mismatches expected money, which stays unknown for manual review. Succeeded results require the donor's observed paid amount to
equal expected money; a mismatch stays unknown for manual review. The donor's
status fallback fields also govern the reversal
guard, which leaves refunded/chargeback unknown for manual review, even with historical
attempt or error refusals, for both readback purposes. Only Model O mandates
can charge unattended. Exact absence, close, refund creation and separate
capture are unsupported; account-dependent offers remain verification_pending.
Bank redirects, one-time codes and unattended Model O attempts are supported
when the host supplies transient payer and method selection through the
canonical M07 P3 attempt input.
Every flow requires explicit payer context. Missing payer/channel/code refuses
with exact before-dispatch evidence and neutral data-correction classification.
Host mode/purpose/currency mismatches throw before I/O; trusted provider document refusals require data correction, while trusted OAuth/deadline/encoding failures remain transient. A renewal the provider refuses for data validation is classified as needing customer data correction: the host should prompt the customer to update payment details, and the bundled retry schedule keeps its normal retries unless the host treats that class as terminating. The subscription stays active; nothing is paused or suspended by this classification. The contributed adopter applies this classification only when reopening a checkout; the example applies it to every purpose.
Payer, authorization, donor payloads and provider prose are excluded from the
returned diagnostics. Alias registration is not exposed by this factory.
Verified audit facts preserve the donor-filtered transaction and alias fields;
missing failure provenance stays absent. Payer, authorization, certificates and
raw bodies are excluded. Audit fields do not participate in event identity or
fingerprints. Offline multi-subject M07 P2 conformance covers replay, chargeback,
exact readback and verification refusals without establishing account activation.

The reference-support execution and readback factories retain their contributed
rich host contracts: setup/customer association, provider audit facts and
purpose-sensitive recovery actions. They are separate from the M07 factory's
neutral envelopes. The reference host translates its subject key and localized
return paths at the bank/code adapter's injected transaction client, preserving callback origin,
query values and simulator return context. It uses the package's real
`ProviderAttemptPreDispatchError` class for nominal no-charge retry/release
checks; matching fields alone never establish trusted no-charge evidence.
The neutral `payments` and `payments/contracts` exports are unchanged.

## Opt-in fulfillment example

The experimental Node `@openlup/platform/fulfillment/omnipack` entry exposes only
its factory, configuration type and capability descriptor. Construction installs
no route, schedule or default binding. The host explicitly selects the adapter,
attests account readiness and supplies HTTP, credentials and notification tokens
per call, product metadata, clock, evidence references and tracking URL approval.
Credentials never establish readiness. The descriptor is deeply frozen and readonly; it stays unselected and not ready
after a host constructs a selected, ready adapter.

Preparation is stateless: it resolves host metadata, serializes the command once,
returns only the fingerprint over those exact bytes, full contact revision and
separate provider/carrier/service references, then discards the body. Dispatch
first validates closed evidence and request contact/selection values and computes
the command digest, without host callbacks, credentials or HTTP on failure.
The single per-instance submission record retains one in-flight or
completed result per command fingerprint, including accepted, unknown and refused
outcomes, bound to the evidence key and canonical command digest used for submission.
The same evidence key and command digest replay that result without I/O; a changed
command or different evidence for an already submitted
fingerprint refuses as `not_dispatchable`, phase `dispatch`, `retryable:false`.
While retained, it permits no second POST. Recorded replay depends only on the
fingerprint's submission record, complete evidence key and SHA-256 command digest,
joining the in-flight result when necessary; later preparations cannot affect it.
The digest covers request/order/fulfillment/parcel identity,
contact revision, wire recipient fields, ordered line SKU/product/pack references
and quantities, and provider/carrier/service/delivery-kind/point-ID selection.
It excludes line titles, recipient line 2 and instructions, and pickup-point
provider/name/address: the outbound codec forwards none of them to wire or evidence.
Only the hash is retained in the in-memory submission record. Equivalent
description changes remain irrelevant.
For an unrecorded fingerprint, dispatch reserves the in-flight entry before any
host callback, then rebuilds the body through the same computation as prepare.
Host resolution callbacks run in prepare and again in a new dispatch and must
return the same values for the same request. A changed fingerprint or failed
resolution releases the reservation and refuses `not_dispatchable / dispatch /
retryable:false` before credentials or provider I/O; the host must re-prepare.
Otherwise dispatch resolves credentials and POSTs exactly the rebuilt bytes.
Valid evidence can therefore dispatch without a prior prepare on this instance.
Changed command evidence may submit once under its new fingerprint.
The replay record is in-memory and per adapter instance, not the durable
double-dispatch guard. Durable protection comes from M08's host ledger through
`claim`, `begin`, `recordProviderAttempt` and `finalize`, plus any idempotency
the provider honours. The donor evidence does not establish provider-side
idempotency, so this example claims none.
`OmnipackFulfillmentAdapterConfig.maxRetainedSubmissions` defaults to 10,000 and
must be a positive safe integer at construction. It bounds completed submission
retention with oldest-first eviction by admission order. Preparation retains no
state and consumes no capacity. A new fingerprint is
always admitted for submission capacity: in-flight entries are never evicted,
so the submission map may temporarily exceed the target when all entries are in
flight. Admission and each completion evict the oldest completed entries until
the target is met or only in-flight entries remain. Matching retained replays
keep their identical results; replay does not refresh an entry's age.
Eviction ≡ restart for that fingerprint: there is no recorded result, so dispatch
rebuilds and POSTs if the supplied evidence still matches current resolution.
The host ledger is the durable guard, preserving its claim/begin/attempt/finalize state across eviction or restart.
Credential, validation and request-construction
failures before submission and definitive rejection are `not_dispatched`;
an unreadable rejection body preserves the status-derived rejection. An unreadable
successful acknowledgement, lost/malformed acknowledgement and ambiguous submission
are `unknown`. Accepted
results carry nonempty opaque proof keys derived from provider reference and
command fingerprint; the host worker assigns its own authoritative keys. No adapter key
is an acceptance authority. The donor wire uses service in both carrier/service
fields; durable evidence keeps the selected references separate. The donor
codec does not transmit line2 or delivery/courier instructions.

Token verification precedes parsing. Trusted route configuration supplies a
missing event kind and rejects malformed explicit values and mismatches. Event identity includes event,
provider/order identity, fulfillment and nullable occurrence, independently of
receipt time. Token auth proves no freshness; missing occurrence stays null.
Readback accepts only a unique positive identity match from an explicitly complete
single-page collection of at most 100 rows (page 0, size 100); missing totals,
pagination, truncation, empty, unmatched
or unknown-status collections stay unknown. Exact absence, label create/void,
cancellation and courier pickup remain unsupported; label reads belong to host
storage. The required label port returns explicit unsupported refusals without I/O
for create, void and read. Configured product paths accept only single-leading-slash
path segments; request URLs must retain the configured HTTPS origin and have no
credentials. Raw bags, raw provider errors, command PII and secrets never enter durable
outputs. Correlation, tracking-number and service references default to 1–128
ASCII opaque-ID characters (letters/digits, `._:-`, starting with a letter/digit).
`observationCodecs.approveReference` lets an adopter explicitly allow its wider
incumbent identifier grammar, with privacy owned by that adopter; controls,
blank/overlong values, email addresses and URLs still refuse. Correlation refusal
is counted and reported before keys or durable observations are constructed;
tracking-number/service refusals are counted in admission diagnostics and results.
Supplied service/URL values are counted before extraction and deduplication,
including malformed values and discarded duplicates; retained tracking data stays
first-wins. A refused service cannot supply a derived carrier, and the shared
durable sink also suppresses carriers paired with refused service evidence.
Tracking URLs default to query-free, fragment-free HTTPS without credentials
and explicit host approval. An optional adapter `observationCodecs.trackingUrl`
can retain required query data under adopter policy; HTTPS, no credentials and
host approval still apply at every projection. Forward that same reference/URL
policy through ingress and native-store `observationCodecs`, conformance-subject
`observationCodecs`, and reconciliation `trackingCodecs`; an omitted policy keeps
the strict default. The optional `normalizeCarrier` codec maps raw carrier/
service evidence to a normalized kind; raw carrier is never forwarded as the kind. Stock collections carry a run ID/time and nullable source revision;
collection time is no provider ordering. Product reads are pull-only in scheduled
composition; writes require explicit host invocation and metadata.
Sync failures/refusals throw Error subclasses with safe messages and typed
`reason`, `phase` and `retryable`; provider failures additionally carry
`providerFailure:true`, status and bounded code for host HTTP 502 mapping.
Product reads preserve the donor's nonempty string EANs and finite quantities
(other values become zero), leaving pack validation/reconciliation to the host.
Stocked product SKUs admit every nonblank string with percent-encoded path segments,
retaining the original identity and deduplicating reads. Literal `.`/`..` and lone
surrogates refuse visibly as `malformed / sync` before HTTP; the product worker
counts per-SKU failures instead of silently dropping them. `pulledSkus`
counts unique completed product reads; `providerCalls` adds the stock listing,
excluding retry attempts.


The example passes M08's offline `runFulfillmentAdapterConformance` with injected
fake HTTP and synthetic sensitive-value plants in the
[conformance witness](../../packages/platform/test/fulfillment/omnipack/conformance.test.ts).
It covers dispatch/replay and pre-I/O mismatch refusal, unsupported label
create/void, observation, positive and empty readback, stock and product sync.
The real M08 worker also refuses fresh-instance and evicted-fingerprint replays
against an already-begun host ledger without provider I/O. These offline checks
provide no provider-account proof; account readbacks remain owner acts.
See the [A3 ledger](plans/oss-a3-fulfillment-adapter.md).

## Canonical status

Moved to [Payments](../../packages/core/docs/guide/concepts/payments.md#canonical-status).

Adding a status or transition requires explicit mapping, persistence
compatibility, and regression coverage for refusal, replay and ordering.

## Idempotency

Moved to [Idempotency](../../packages/core/docs/guide/concepts/idempotency.md#idempotency-contract).

Preserve each incumbent replay protocol when moving adapters. Bundle key
recognition must not become a fingerprint guarantee through documentation or a
refactor. Changes to concurrent key collision or rollback behavior need dedicated
database regression coverage.

Evidence (historical record, 2026-11-13):

The native bundle contention witness characterizes the existing global event
key, without adding payload/entity binding. Two absent-key transactions on
disjoint bundles can block at the unique key index: after the first commits,
the second raises `23505` and its attempted composition is rolled back. If the
first rolls back, the second can commit. A later same-key call recognizes the
key before validating changed payload, entity or routine. This is incumbent
recognition, not a stronger exactly-once or payload-fingerprint guarantee.
Catalog draft receipts retain their separate canonical-command fingerprint and
revision behavior; moving their adapter does not change either protocol.

## Partner acquisition

The partner acquisition vocabulary is `new`, `contacted`, `qualified`,
`disqualified`, `closed_won`, `closed_lost`. The direct lifecycle permits
`new → contacted|disqualified`,
`contacted → qualified|disqualified|closed_lost`, and
`qualified → closed_won|closed_lost|disqualified`; the last three statuses are
terminal. `closed_won` records pipeline progression only, without a customer
identity, commerce mutation or marketing permission. The richer managed admin
surface retains its own contract; it is not this direct transition API.

The [partner package schemas](../../packages/platform/src/marketing/partnerAcquisitionSchemas.ts)
retain the exact bounded case projection and strict public
`openlupInternalCheck` property. Submit normalization collapses organization,
names and notes, uppercases country, lowercases email and retains digit-based
phone normalization. Schema admission and SQL validation have intentionally
unchanged boundaries: country `OTHER` and a leading-zero normalized phone can
pass form/schema admission and fail SQL. Host wire validation and authorization
remain outside the direct adapter. See the
[Partners owner](../../src/domains/partners/README.md) for source availability
and explicit unavailable privacy duties.

Partner submit and transition have distinct persisted command scopes and
installation-keyed fingerprints. Exact replay returns the original projection,
even after later status changes or a new port instance; changed command payload
or transition actor conflicts. Submit replay runs before quota and contact
dedupe. A fresh-key attempt updates requester/email windows before quota or
contact refusal, so refusal can advance quotas without creating lifecycle rows.
The one-hour reset is inclusive. Descending list cursors retain the timestamp
and UUID tuple; expected-version transitions lock the case and append exactly
one accepted receipt/audit. The
[installed PostgreSQL witness](../../tests/postgres/partnerAcquisition.test.ts)
freezes these behaviors using the existing three routines.

## Provider adapters

Moved to [Compose a provider adapter](../../packages/core/docs/guide/how-to/extend/provider-adapters.md#provider-adapters).

### Adapter classes and example templates

Moved to [Compose a provider adapter](../../packages/core/docs/guide/how-to/extend/provider-adapters.md#adapter-classes-and-templates).

For communications changes, extend the class's
[tests](../../packages/platform/test/communications/), including refusal
behaviour, without live provider access.

Evidence (historical record, 2026-11-13):

A fulfillment (M08) adapter declares `FulfillmentCapabilityDescriptor` and
implements the experimental dispatch, label, observation, readback and sync ports
from `@openlup/platform/fulfillment/contracts` (`FulfillmentDispatchPort`,
`FulfillmentObservationPort`, `FulfillmentReadbackPort`; optional
`FulfillmentStockSyncProvider` and `FulfillmentProductSyncProvider`). See the
[fulfillment owner](ARCHITECTURE_AND_EXTENSIONS.md#fulfillment-contracts) for
command preparation, host keys, replay, paid handoff and proof/storage boundaries.
The offline `runFulfillmentAdapterConformance` checks adapter-owned fixtures and
returns sanitized evidence. Native stores and real PostgreSQL conformance cover
durable storage and arrival alignment. The [opt-in fulfillment example](#opt-in-fulfillment-example)
is the template for another warehouse, marketplace fulfillment service or parcel
adapter and passes M08's offline runner with adapter-owned fixtures.
Provider-account proof remains separate; account readbacks remain owner acts.
This surface activates no provider or reference route.

### Opt-in Node protocol adapter

Moved to [Compose a provider adapter](../../packages/core/docs/guide/how-to/extend/provider-adapters.md#node-email-protocol-template).

The concrete adapter records a 2xx response without an ID as transport
acceptance with `resendId: null`, and the provider retains idempotency keys for
a limited window (currently 24 hours); keep the local effect ledger independent
of that window.

The webhook uses a UTC-seconds clock and an inclusive ±300-second timestamp
window.

Evidence (historical record, 2026-11-13):

Reconciliation delegates to `runDeliveryReconciliation`, with internal GET reads
of host-selected existing IDs. Only failed 404 reads contribute to the existing
three-consecutive-404 abandonment rule. Auth/network/provider errors remain
separate; sent and unknown snapshots stay pending. Polls feed the host's existing
atomic writer and never recovery-send. No route, schedule, store, credential
reader or reference binding is installed. Fetch is injectable; no SDK or new
dependency is required. [A1 evidence and limits](plans/oss-a1-communications-adapters.md)
are protocol-only; account verification remains pending.

### Opt-in singleton marketing adapter

Moved to [Compose a provider adapter](../../packages/core/docs/guide/how-to/extend/provider-adapters.md#singleton-marketing-template).

The consent-push capability requires `profiles:read`, `profiles:write`,
`subscriptions:write` and `lists:write`: the read scope admits the preflight,
while the write scopes cover the subscription job and list effects. Missing
any required scope refuses locally before provider HTTP. This declaration
checks host-supplied evidence; it does not independently inspect API-key scopes.

Evidence (historical record, 2026-11-13):

An earlier unsettled grant never delays withdrawal. Its receipt/result retains
`reconcileRequired`, grants stay restricted during unconfirmed withdrawal, and
only fresh complete readback after authenticated settlement of all earlier grants
can resolve the race. The host reissues a withdrawal with a new requestId when
that read shows subscribed. Replay, generation fences, cooling, mapping writes
and quarantine share the host's atomic journal; uncertain mutation dispatch is
never automatically retried. Non-grant results are recorded under durable
quarantine until the stored bytes are verified; a grant's result relies on its
durable per-subject dispatch fence and its recorded grant cause instead of
setting the account bit. A withdrawal under grant-only availability quarantine
also releases its settlement bit after verification. For mutations, transfer's
`finally` releases the account slot before result recording. An uncertain
recording or release preserves completed facts with an unknown journal and
quarantines the account for repair. The private storage seam also supplies one
shared mutable availability record per account/environment, independent of
storage failures. It holds admission through result release and remains closed
on uncertainty. A host restart begins quarantined; only explicit host journal
reconciliation and adapter reconstruction restore admission. Default pacing waits within the deadline so
preflight reads cannot starve the mutation. See the [A1 ledger](plans/oss-a1-communications-adapters.md#p2-opt-in-singleton-marketing-adapter)
for construction requirements, offline evidence and remaining account gates.

### Reference PostgreSQL marketing host

The source-only [single-process reference host](../../server/runtime/communications/marketingPostgresHost.ts)
implements the existing private construction storage seam with exact TEXT CAS.
Its exported setup SQL is an application-owned recipe, never an automatic
platform migration. The application supplies committed-operation PostgreSQL
execution, explicit grants, personal-data contributor/retention policy and one
shared host instance per account/environment. Selecting the profile does not
establish multi-process exclusion or qualify a deployment.

Construction starts quarantined. An authenticated operator must stop old adapter
work, inspect the exact recovery snapshot and account for every unresolved entry
before reconciliation. Recovery changes only slot/quarantine flags and retains
request/result identities, withdrawals, tombstones and cooling; it does not
invent provider settlement or reopen an old adapter instance. A stale snapshot,
incomplete entry list, active work or uncertain repair write keeps admission
closed. The [real PostgreSQL witness](../../server/runtime/communications/marketingPostgresHost.test.ts)
uses fake provider HTTP and checks committed reply loss, replay and withdrawal.

Journal v1 retains original requests and targets, including personal data.
Compaction and erasure of this journal are unsupported in this reference profile;
the adopter must register its actual retained-data disposition. Deleting entries
or replacing them with hashes would lose receipt validation/replay evidence.
The caller supplies a measured finite byte budget; exceeding it follows the
existing host-storage failure path. Privileged recovery snapshots are not log
content. This profile provides local persistence evidence, not account TEST proof.

## Ecommerce event export

This experimental communications surface exports retained facts through
`EcommerceEventsPort`. It is independent of transactional transport, profile
projection and consent mutation. The browser-shareable contracts contain no
provider payload or credential. Closed Node validators refuse extra fields,
invalid source identities and incomplete paid data before provider dispatch.

| Fact | Owning source | Allowed event data |
| --- | --- | --- |
| `order.paid` | Required commerce paid fact, with a paid-time metadata snapshot and corroborating succeeded settlement | Order and intent IDs, purchase kind, integer minor amount, currency and frozen SKU/quantity/line amounts |
| `order.refund_status_changed` | Commerce refunded-status fact or manual order operation, one identity per order | Order ID and `refunded` status; no value, revenue or partial-refund claim |
| `checkout.recovery_qualified` | Token-free commerce qualification, one identity per order, independent of message waves | Order ID and expiry; no recovery token or address |
| `subscription.created`, `.paused`, `.resumed`, `.cancelled` | Retained subscription owner events, including automatic resume | Subscription ID; no reconstruction from current status or email retries |

Every fact also has its schema version, source identity, occurrence time and
subject identity. Paid snapshots distinguish initial subscription acquisition
from renewal using the owning activation/renewal evidence. Missing or malformed
evidence records an incomplete disposition; later catalogue/order edits cannot
repair it into a different purchase. Monetary conversion uses the currency
owner's exponent and retains its provenance, including zero- and three-decimal
currencies. The refunded-status metric is deliberately nonfinancial.

The PostgreSQL projection runs after the source transaction through explicit
host composition. It fixes the account, environment, namespace, mapping and live
cutoff, and uses per-source receipts instead of a high-water cursor. Enqueue and
handoff commit together. A failed projection leaves the source available for a
later bounded pass; it adds no export-store dependency to payment commit.
The initial native-store profile admits one immutable exporter binding; a second
account or binding refuses rather than sharing an unscoped claim invocation.
Existing source consumers retain their payloads. Importing the helpers installs
no route or schedule, and existing facts are not automatically backfilled.

The existing outbox owns claims and retries. Invoke export and commerce workers
separately with disjoint event allowlists and lease identities; adding remote
HTTP to a shared serial commerce batch would not provide that isolation. The
frozen export request binds the source, existing profile, generation, local
authority and mapping. Current authority, erasure and checkout eligibility must
still hold at dispatch. An email change, ambiguous merge, deleted subject or
mapping change cannot silently redirect an already queued fact.

`createPostgresEcommerceEventProjection` initializes the fixed binding/cutoff and
projects a bounded batch; `createPostgresEcommerceEventHandler` binds the neutral
port to the existing worker. Their transaction callback must use one committed
PostgreSQL connection. The native tables and source view stay private; narrow
service-only functions mediate source selection, atomic handoff, claim-bound
receipt changes and privacy. Runtime has no general table-write grant. The
privacy contributor scrubs recipient projections while retaining source/replay
fences, and connected-store transfer preserves those fences and unknown duties.

For uncertainty, `reconcilePostgresEcommerceEvent` requires quiesced work, the
matching request digest, binding and an operator evidence reference. Retrying
additionally requires the original qualified deduplication semantics and current
authority. An active claim, mismatched identity or missing evidence refuses.
Each explicit qualified retry opens a fresh worker budget under the existing
configured attempt and snooze limits, including after terminal exhaustion.
Consumed counters accumulate in outbox metadata as `recoveryAttempts` and
`recoverySnoozes`; the receipt retains the recovery evidence reference.
Unknown duties retain `retainPayload` even if the worker exhausts its retry
budget; terminal compaction skips them and continues with unrelated rows.
Confirmed acceptance/refusal or erasure can release the pin. Reconciliation
does not change source identity, mapping, profile or currency provenance.

The opt-in `communications/klaviyo` factory exposes `events` separately from its
profile/consent ports. Mapping `ecommerce-v1` uses one fixed metric per source
type and the source ID as `unique_id`, with an existing profile ID and no profile
attributes or upsert. Support requires `events:write` and separate account-effect
and sole-message-owner qualification. Scopes and qualification are host-supplied
evidence, not an API-key introspection result. An unqualified selected mapping
remains `verification_pending`; an unrecognized mapping is `unsupported`.
Historical requests refuse with zero HTTP.

Events share the account's slot, pacing and durable cooldown with profile/consent
operations. A single event's uncertain response stays in its own export duty;
it does not create a new consent-journal quarantine that would prevent
withdrawal. Uncertainty in the shared storage or slot still closes account
admission. A bodyless 202 proves acceptance only; response bodies are cancelled
without exposing customer data. Retry retains the exact profile/metric/source
tuple and payload. It never inherits consent-mutation retry semantics.

Local offline examples and real PostgreSQL tests establish protocol and retained
state behavior. Before any account activation, independently prove actual TEST
ingestion, receiver deduplication, unchanged profile/consent data and disabled
competing notification flows. The existing checkout sender remains the message
owner. Production publication, deployment and activation need their own grants;
an accepted event cannot be undone by a code rollback. Disabling dispatch must
preserve pending identities and uncertainty for reconciliation.

## Subscription lifecycle

Moved to [Subscription engine](../../packages/core/docs/guide/concepts/subscription-engine.md#the-status-matrix-and-dunning-continuity), [Subscriptions](../../packages/core/docs/guide/concepts/subscriptions.md#lifecycle-in-durable-storage).

Keep the managed `public.subscription_guard_status_transition`, core
`SUBSCRIPTION_STATUS_TRANSITIONS`, core contract test, pgTAP guard suite and
live-body parity test synchronized in the same contribution. Further status
changes follow the compatibility lifecycle in [Data and migrations](DATA_AND_MIGRATIONS.md).

Managed M2 owns durable exhaustion/recovery continuity; the core compatibility
helper must remain separate from explicit owner pauses. The native chain in
`db/platform/migrations` uses lifecycle functions rather than the managed
status-transition trigger, which fires before every managed status update.
Native retry-case propagation calls `dunning_lifecycle_handle_failure` from
[`subscription_retry_open_case`](../../packages/platform/sql/20261109100000_subscription_retry_resume.sql).
Its failure handler has no exhaustion-rung fence; preserve the distinction
between class termination and exhaustion when changing that call path.

The core matrix covers four statuses. The engine re-arms `next_cycle_at` at the
later of the stored instant and two days out; managed SQL restarts assign two
days out unconditionally.

Evidence (historical record, 2026-11-13):

Managed M1 makes refunds independent of subscription lifecycle: neither a first
nor renewal refund cancels service, erases cycle payment history or emits
`activation_reversed`. Existing first-cycle stock release remains; historical
cancelled rows are not resurrected. F17 now accepts signed, exact-attempt
F17 cumulative snapshots, emits one order-refunded notice on transition and
ignores equal/older snapshots without a new refund effect. Receipt/event
bookkeeping still records ignored evidence. First-cycle and renewal refunds
preserve the active subscription's future hard holds and 14-day soft protection;
a one-time allocation cannot spend that demand. Managed stock wait retains active
service and the original obligation until later-only settlement/delivery alignment.
See the [managed prefix and proof limits](DATA_AND_MIGRATIONS.md#managed-stock-wait-atp-and-refund-parity).

## Subscription delivery alignment

Moved to [Subscriptions](../../packages/core/docs/guide/concepts/subscriptions.md#subscription-delivery-alignment).

The native fulfillment translation uses `fulfillment_shipments.replaces_shipment_id`
and order → cycle → subscription correlation, with cycle number on the renewal
operation. It adds no `retry_scheduled` state or payment lifecycle change.
Native invoker privileges and catalogue ownership remain in
[Data and migrations](../../packages/core/docs/guide/upgrade/database-migrations.md#select-the-complete-catalogue).

## Compatibility posture

Moved to [Versioning and stability](../../packages/core/docs/guide/reference/stability.md#version-numbers).

The account-support reference capability manifest declares default-off,
explicit-host registration and an empty route list. It is descriptive metadata,
not permission to mount an account API or advertise checkout continuation.
Commerce recovery and configured purchase are selectable only when the host
binds their owners; metadata keeps both default-off and mounts nothing.
Selecting the inert account/support recipe requires the host's verified contexts, complete
catalogue/schema observation and admission-refusal transport mapping; it changes
neither the static profile's refusal list nor the subscription serving entry.

The CI-only [image inventory](../../config/ci-images.json) owns logical names,
upstream repositories, tags, index digests and ordered public-registry sources
for every mirrored image. It records four PostgreSQL images (the install-proof
database, also used by raw pgTAP and managed-rail tests, the disposable test
default, and two attribute-version witness pins) plus the starter browser image. No Supabase CLI, CLI-derived or managed-host image remains in hosted CI. The single mirror
job reads typed owned pins from its own checkout, validates all of them before
any exec or registry call, and builds upstream sources and mirror targets itself.
It runs only pinned first-party actions plus the repository script, re-resolves
source digests, skips identical targets, refuses moved tags and two pins that
would write different digests to one target, and verifies every copy.
The shared reader prepends the single mirror
registry to inventory sources for consumers; mirror copying still uses only
upstreams. The reviewed-batch gate and shared disposable PostgreSQL helper use
these pins, preserving the exact digest on every fallback. In CI and locally,
source order is mirror, then GHCR/Docker Hub/ECR for managed, or Docker Hub/ECR
for native. Microsoft registry sources are mirror inputs only: consumers pull
those images from the organization mirror alone, with no upstream fallback.
The default helper uses the test pin, resolves once per exact ref per process and
runs the successful digest-qualified source with `--pull=never`; explicit
non-inventory overrides keep their existing behavior. Before any shared pull,
exact local index digests bypass network access; a tag-only input and
inspection errors refuse. The gate, helper and pgTAP runner share one pull retry
implementation; long Retry-After hints advance by the remaining per-source
share, while shorter waits are capped to preserve non-GHCR fallback.
A Docker-free guard rejects literal digests or registry source lists in the gate test.
An explicit source tag must match the entry's tag and is preserved during
resolution. PostgreSQL consumers with upstream sources immediately advance on
mirror absence/private access and do not depend on organization package access
or publication. The required `install-packages` PostgreSQL 17 startup step is an
exception: it selects only the GHCR mirror, has no upstream fallback and requires
access to that organization package. It uses the same inventory digest and starts
explicitly after job-token GHCR login.
It runs with `--pull=never` and is removed after package proof, including failure.
Other local launchers retain their existing behavior. These changes
establish no public package visibility or runtime/application default.

The `pgtap` lane is required through the `test` aggregate and runs every shipped SQL test on the
install-proof `postgres:17` digest without the Supabase CLI or its images. Its
[package pins](../../config/ci-postgres-packages.json) name the exact pg_cron
1.6.4, pgTAP 1.3.3 and `pg_prove` 3.36 PGDG builds for Debian trixie, for amd64
and arm64, at immutable PostgreSQL apt-archive paths. Each file's committed
SHA-256 is verified before the bytes are cached or installed; an unpinned
architecture, a path that does not match its version or a checksum mismatch
refuses, and no apt index is read. The job restores the downloads through a
SHA-pinned `actions/cache` step keyed by the pin file, so only a cold cache reaches
the apt archive, and every cached file is re-verified before use. A main push
may reuse the exact-commit merge-group proof, which includes `pgtap`. The packages install only into the disposable container. [The managed-compatibility adapter](../../tests/postgres/managed-compat/supabase.sql)
is the only file that creates the managed environment for that lane; the runner
keeps only the replay identity and grants of the retired CLI lane's replay. It is test
infrastructure, never a runtime bootstrap or a supported-host claim.
[The managed-compat test helper](../../tests/helpers/managedCompatPostgres.ts)
boots the same image, packages, server settings and adapter for every
managed-rail `tests/postgres` suite, including the reviewed-batch gate. The only addition is a login for the `supabase_admin` placeholder, the
identity those suites use as their owner session. Each required `test-full-shard`
restores the same SHA-pinned package cache before its tests; a cold cache downloads
the pinned files from the PostgreSQL apt archive, and every file is re-verified
before installation.
The adapter's selected Storage bucket/object columns support the required
managed-source capture and refusal suite; their types, defaults and keys are
copied from the pinned managed schema. They implement no Storage API or
service access. The opt-in
[`runM14ManagedSourceWitness.mjs`](../../tests/postgres/runM14ManagedSourceWitness.mjs)
runs the same assertions and the managed catch-up first-leg suite on fresh
owned CLI 2.122.0 stacks, then the complete local three-installation journey.
It requires an already-local immutable Node 24.21.0 image argument for H1/H2.
[CI image mirror guidance](../../CONTRIBUTING.md#ci-image-mirror) owns retry
budgets, refusal boundaries, mirror execution and the owner's GHCR setup.

The opt-in OIDC settings registry and reference verifier composition retain the
[identity owner](../../packages/core/docs/guide/concepts/identity.md#opt-in-oidc-access-tokens).

The disposable identity reference's run directory, run id and local mail origin
are evaluation settings bound to one owned installation. They establish no
persistent customer identifier, package API version or migration contract. The
selected browser import inventory is independent of the public default build;
server credentials do not become browser configuration.

The managed email-trust declaration remains an environment-registry input;
[identity composition](IDENTITY.md#responsibility-and-composition) owns its
settings binding and migration-free source change.

The runtime forward registry may pin exactly eight legacy browser-policy
retirements alongside its fixed function and privilege bindings. Retirement
checks exact names, tables, preceding statement hashes and ordered DROP
statements; it does not admit arbitrary RLS changes. Introduction follows the
[co-located SQL/pin rule](DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).
Control approval installs no database permission and cannot stand in for the
corrected forward's actual-role tests.

The optional runtime-forward registry is a finite security admission: it pins
one or two files with ordered exact grants. The first pins five unchanged
existing function identities; the checker independently limits its service
columns and four existing callable functions, plus authenticated profile/membership
reads and two pure index helpers. The optional second pins the identity
capabilities file with no functions or policies, only service_role INSERT on
`clients.email`, `auth_user_id`, `acquisition_source` and `lifecycle_stage`, and
UPDATE on `auth_user_id`, INSERT on `admin_users.id`, `email`, `role`,
`membership_state`, `membership_provenance` and `membership_accepted_at` for
operator activation (`is_machine_actor` keeps its false default), and SELECT on `admin_users.email`
for invitation eligibility and conflict checks.
It does not authorize arbitrary runtime grants. Introduction follows the same
co-located SQL/pin rule; registry installation alone does not change database
permissions.

Changes must preserve the contracts above and state their preview
compatibility boundary explicitly.

`release:bump --set` prepares every publishable package's version,
and every exact internal pin on one, in its manifest and lockfiles.
`packages:check` and `@openlup/core`'s release check admit only a set version
below 1.0, `packages:check` refuses publishable packages at different
versions, and the package release workflow refuses a version that differs from
the manifest or that npm holds or has passed. `publish-package.yml` with
`package: all` releases the set under one approval, one tag and immutable
release per package at the set commit. Dispatching the same set again resumes
it: a package npm holds with the same tarball is skipped, a package whose
release exists but npm lacks the version waits for the re-run of its failed
publication, the rest are released, and any other state stops the set. A patch
set is refused when a package's API snapshot differs from its previous set's
release tag. Historical previews retain
their recorded package versions.

The subscription browser profile's closed import list follows the package
exports selected by its build. Core entries therefore name built `dist/*.js`
modules; source paths are not an alternative runtime route. The core workspace
must be built before checking that profile's import closure.

The repository's
[`neutrality baseline`](../../config/openlup-neutrality-baseline.json) records
existing source findings rather than declaring the tree free of them. Its full
source commit identifies the measured base, scanner blob identities pin the
counting implementation, and SHA-256 keys identify exact relative paths. Each
count belongs to one path and category; a reduction elsewhere cannot pay for an
increase, and a new path has no inherited allowance.
The check applies its explicit opt-in adapter vocabulary allowances before
comparing these counts, including the scoped root `ROADMAP.md` addition below.

The [repository check](../../scripts/public-ci-neutrality.mjs) counts text
regardless of filename extension and inventories binary files. It refuses
increases against both the comparison tree and the accepted baseline, including
an increased baseline allowance. Baseline regeneration may lower existing
allowances. It cannot admit new baseline debt except for the fixed
diagnostic-fixture introduction
recorded in the checker. That introduction admits five exact SQL fixture files
in category `ui-15`, verified by their complete SHA-256 bytes, original counts
and accepted counts, against one full comparison commit. The explicit baseline
recalibration is required; the candidate still must fit that baseline. A later
comparison commit uses the ordinary ratchet, including refusal of regrowth after
a reduction. Scanner pins and every other path, category and increase remain
unchanged. These counts reuse the existing scanner semantics and do not expand
a runtime contract or establish a stable preview channel.

Apart from the scoped root `ROADMAP.md` addition below, the opt-in
communications adapters have a `ui-12` vocabulary allowance only
inside their two declared source/test directories, their exact API reports and
exact cold-consumer proof lines. The exact path-segment tokens
`communications/resend` and `communications/klaviyo` are additionally allowed in
the platform manifest, release gates, package boundary test, publication
catalogue, platform CHANGELOG, its non-packed `CHANGELOG-HISTORY.md` and validated
platform `changes/*.md` fragments,
this page, the architecture page and the A1 ledger.
Those same two subpath tokens are allowed in only the A1 reference binding and
its adjacent test under `server/runtime/communications`; bare adapter words
receive no allowance there. A paired out-of-scope token plant must still fail.
The two snapshot filename tokens are additionally allowed only in the platform
release-gates file and publication catalogue; the two relative adapter entry
tokens are allowed only in the package boundary test. The undeclared-subpath
fixture uses a neutral vendor segment and needs no allowance.
The ledger additionally allows bare adapter names. The root `ROADMAP.md`
provider matrix is the one scoped addition to these adapter vocabulary
allowances, with at most two matches each for categories `ui-12`, `ui-13`,
`ui-14` and `ui-15` at that exact path. A third match, those terms at other paths
outside their existing adapter allowances, and every other counted term or
category remain checked. Neutral communications sources and contracts, other
root content and other documentation remain checked outside their existing
allowances. The baseline and scanner pins are unchanged. See the
[CONTRIBUTING neutrality check guidance](../../CONTRIBUTING.md#package-policy-and-release-checks).

Published Tree CI enforces that ratchet in required `self-check` and exercises
its CLI refusal tests in required root `test`. Managed pgTAP is also required
through that aggregate; follow [testing](../../CONTRIBUTING.md#test-scope-and-diagnostics)
for execution and proof limits. These checks do not grant application privileges
or declare complete compatibility evidence. Existing release context checks remain unchanged.

The outbox catalogue candidate retains separate core-peer, export-snapshot and
shipped-baseline pins; those pins do not grant publication eligibility.

While `@openlup/core` is below 1.0, the publishable packages share a `0.N.P`
set version from one commit; package checks admit only a set version below 1.0.

Evidence (historical record, 2026-11-13):

The classic package-editor unit appends one native migration to each selected
source plan while preserving earlier file identities. Its package SQL copy is
projected from the same canonical bytes. Installation-shape catalogue digests
and current migration counts require fresh PostgreSQL measurements; a manifest
entry alone is not admission evidence. Apply that forward before selecting the
new editor or updated native account reads. The host supplies
`subscription_minimum_base_units` in `commerce_settings.value_text` as a strict
positive integer; absent or malformed configuration refuses quoting and apply.
The [data owner](DATA_AND_MIGRATIONS.md#retained-renewal-storage) describes the
ledger, one absorption classification and retained agreement evidence.

The channel suffix established the preceding selected-plan prefix of
91 legacy units, 95 qualified units and 94 restricted units.

The sandbox-attempt source suffix follows the M17 prefix described below. Its
one additive native unit extends those prefix counts to legacy 92, qualified 96
and restricted 95, with separate reference digests for all five installation
shapes. It preserves every earlier migration identity and existing state CHECK;
its additive review marker distinguishes terminal cancelled capture from work
awaiting reconciliation. At that historical checkpoint, the new attempt/readback factory was sandbox-only.
The appended prepared provider store now supplies durable preparation; real PSP
qualification remains a separate obligation.
Class data and feature pins may accompany SQL in its feature pull request; a local manifest entry alone grants no delivery or release authority.

The G4 purchase-hold forward appends the same native forward path/hash to all three
manifest selections, with a separate measured catalogue digest for each existing
installation shape. It preserves every prior source pin and defines four bounded runtime entries
and one owner-only admission helper rather than replacing ATP or renewal functions. Abandoned compensation wraps
the unchanged aggregate donor and releases purchase holds atomically; it adds
neither withdrawal markers nor raw runtime ledger grants. Source admission
separately checks the closed native class and co-located whole-forward/function
pins. The data owner records the accepted ownership shape and donor limits.
The native destination suffix adds two private address/binding relations and
four bounded routines without replacing an existing function. Native operator
results add applied_from_next_parcel; callers must name that partial applicability
or refuse it, never infer fully applied current-parcel success. The managed
subscription result/decoder remain unchanged. Destination/event/outbox records
commit atomically; parcel and money transitions do not depend on mail delivery.
That destination unit supplies no saved address book, privacy erasure/export or
automatic host/mail wiring. The separate saved-address unit declares its own
[storage and privacy coverage](DATA_AND_MIGRATIONS.md#saved-customer-address-rows). The source task and data owner describe the explicit limits.

The M17 channel suffix appends two native units to each existing selected plan.
Each installation shape retains its separately measured catalogue digest. Four
reviewed source pins bind the two native and two managed forwards, including
ordered companion statements; they grant no installation or provider authority.
The RPC catalogue records the normalized ingest and existing payment owner call
sites. Managed settlement uses the existing ATP exposure hook and allocator;
portable source capture/read/CAS declares physical conversion unavailable. Fresh
qualification and privacy lifecycle capabilities remain outside this import.

The native paid-notice suffix appends one source unit to each selected plan,
preserving the existing prefixes.
All five installation-shape inventories are measured separately before and
after applying the forward. The conditional grants expose only the eight
existing native notice helpers to service_role; an absent legacy role receives
no grant. Invoker rights and browser refusals remain unchanged. These manifests
describe installation inputs, not authority to run jobs, disclose contacts or
send messages. The [native notice binding](ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts)
requires trusted scheduled-host admission and preserves transactional delivery receipt replay.
The forward's class/pin admission and eventual package projection
remain delivery prerequisites; a measured local catalog is not publication or
provider qualification.

Corrections to these unissued forwards keep their source hashes, packed SQL
hash and measured fingerprints for all five installation shapes in agreement.
The sparse migration descriptor and its API checksum projection identify the
same native bytes. These corrections preserve the existing signatures and
grants; issued migration files remain immutable.

The earlier qualified retained-import selection requires an actual restore login and one
of the two independently measured 92-unit inventories for its migration/bootstrap
shape. The manifest preserves the entire issued 91-unit prefix and appends the
separately approved owner-path forward after runtime completion; it adds no
legacy unit. The
two reference-derived digests are expectations, not target observations or
qualification. Production status/apply/replay and runtime/restore privilege
witnesses remain required under the
[data compatibility lifecycle](DATA_AND_MIGRATIONS.md#compatibility-lifecycle).

The exact qualified-installation source approvals in
[`reviewed-platform-forwards.json`](../../config/reviewed-platform-forwards.json)
are control inputs, not installation evidence. The seven reviewed fixtures and the
legacy-preserving version-2 source catalogue follow the
[migration owner](DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories).
The supported reader admits the exact sixth identity for the demonstrated
context writes and review-receipt reads/appends. The registry retains all six
prior approvals unchanged; the exact sixth SQL preceded the owner-path tail.
The seventh approval binds one qualified owner-path forward's exact file and
function definitions. Its active SQL is selected as unit 92, byte-identical to
the prior inert fixture; the two installed inventories are measured separately.
Historically, reader support, pin approval and SQL introduction landed
separately. Future SQL, approval pins and class data may land together under
main's validator; a new validator capability still lands first. The installer-ownership/runtime-binding guard relies
on existing trusted session admission. The tail adds only context column writes/
DELETE and receipt SELECT/INSERT; receipt mutation, ownership, RLS, triggers,
production runner/projector, npm API and package budgets remain unchanged.
The complete F90 prefix and historical inventory evidence remain retained.
Introducing SQL follows the [co-located approval rule](DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins);
these pins grant no activation or managed-host compatibility.

The separate restricted-bootstrap approval checkpoint extends the fixed list
from seven to twelve whole-file identities. The seven issued rows, including the
completion and owner-path forward, remain unchanged. The five `qa_` fixtures
stay outside active SQL and the schema-2 manifest; their two owner-body files
carry the same pinned name-resolution attributes as the issued forward. This
approval does not install the future 91-unit restricted plan, establish either
role-mode inventory or grant a release or hosted compatibility claim.
Four corrected `qb_` identities follow at approval positions 13–16 as one
exact-byte append. The preceding twelve approvals remain fixed. The active
restricted plan selects those four files with the approved `qa_` baseline only
with exact approval pins. Its local PG16 qualification covers both role
modes; this does not qualify a hosted installation or release.
A seventeenth exact-byte approval follows as one append. It binds the shared
lock and conflict completion tail that both qualified plans select after their
issued tails, and all sixteen earlier rows stay fixed. The approval itself adds
no active SQL, manifest row, inventory or package change. The identical active
SQL follows as its own change, after the delivery destination forward whose
created state it guards. Both plans select it once, with four newly measured
inventories; it adds no legacy unit.

The reference qualified selection declares actual migration/bootstrap/runtime
and optional restore principals; omitted selection remains legacy. The E2
predecessor's E-only 89-unit inventories distinguish the four binding shapes;
the retained-import plan selects only the two restore-bound shapes. Qualified projection
normalizes declared principal fields only after session and role checks; the
legacy 88-unit identities and inventory remain unchanged. These source bindings
still require production and installed qualification, as described by the
migration owner above.

M10-9 extends the reviewed forward registry to 18 approval pins, retaining
exact 14/16-pin release-history reads and every existing binding and position.
The two managed attempt-replay forwards install the admitted donor-exact
statements and carry exact applied-transition attribution through the hosted
package and managed callers. Same/stale observations reuse the canonical result;
newer attributed failures revoke earlier authority, including used links.
Missing attribution or unavailable replay cache refuses 55000. Native parity is
REGISTERED with owner M10 and the acceptance listed by the migration owner;
these managed semantics do not establish native parity or activate a runner. [Data and migrations](DATA_AND_MIGRATIONS.md#m10-9-attempt-replay-control-fixtures)
owns their schema/backfill prerequisites and explicit mapping for adopters that
already carry the donor history. The new fixtures add no C94 vocabulary counts.

The selected reference browser profiles admit exact built commerce files,
including the browser-safe schemas and pure helper closure. The subscription
profile includes the 31 OMS schema/pure-model files reached when its commerce
barrel is parsed; the Node-only detail builder and managed adapters stay outside
that exact inventory. The identity profile also lists the complete reached OMS,
core fulfillment/payment/subscription and pricing-contracts closure as exact built
paths. Both inventories also list `commerceReturnsPort.js`,
`orderReviewContracts.js` and `orderFeedbackContracts.js` under
`packages/platform/dist/commerce/`, reached through
`@openlup/platform/commerce`: returns request/approve/reject schemas and port
types, with a factory for host-bound request reason codes, native order-review
contracts and hosted-feedback contracts. The subscription inventory additionally
lists `orderEmailEligibility.js`, `orderEmailLines.js`,
`outboxDispatchContracts.js`, `outboxOrderDraftEmailPorts.js` and
`salesChannelEnvelope.js` under the same built commerce directory for the
browser-safe email helpers, outbox ports and sales-channel envelope modules
reached through that barrel. The identity browser profile does not reach these
five files and needs no additional inventory entries for them. Returns and review
handlers, the raw-upload handler and PostgreSQL/Supabase adapters, including
hosted-feedback adapters, are exposed only by the Node-only
`@openlup/platform/commerce/server`
entry; the profile build refuses that entry. The checkout-engine contribution adds the exact
built `commerce/checkoutCommandSchemas.js`, `commerce/offerEvidenceSchemas.js` and
`commerce/paymentContinuation.js` files to both subscription and identity profiles,
for browser-safe validation and continuation lifetime constants. The list grants
no directory-wide admission: `commerce/server` and the Node-only pricing root
remain outside it. `pricing/browser` admits only its five-file runtime closure
for the existing primitive factory, acquisition validators (including resolved
terms) and the pure shipping-terms owner. Reference quote context accepts the
optional shipping/acquisition promises without admitting shipping handlers or
Node HTTP declarations. A new reference import must have both browser-safe dependency
closure and an exact inventory entry before that selected profile can build.

The invoicing reference capability is default-off and installs no routes or
scheduler. Its seller migration entries are forward-only introductions of the
approved fixtures; they preserve the preceding native manifest rows and hashes.
The native seller descriptor follows payment decoupling at position 80. Claims
preserve first-ever seller timing and legacy fallback without rewriting history.

`20261022193000`/`20261022193100` introduce managed correction v2; its sync-first settlement and permanent-failure parking are owned by [M09 forward design](DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval).

Managed M1/M2 land as the first reviewed managed prefix over native N1.
Only M2 adds its immutable C94 rail-path vocabulary counts (`ui-13`: 2,
`ui-14`: 3); M1 has no counted vocabulary. Existing baseline keys and all
reviewed pins stay unchanged. This bounded accounting admits those exact SQL
bytes, without granting activation or a broader compatibility promise.

Native subscription retry N1 extends the existing migration prefix without
changing earlier rows. Its manifest inventory is recomputed by the repository
runner on the complete prefix plus N1, and its package SQL copy retains the CTL
creation pin. Stock-wait forwards remain later additions; installing this
unit does not activate a runner or grant M07 native prepared-store capability.

Native N2 now appends the next manifest row after N1 with its exact CTL command
creation pin and byte-identical package projection. The refreshed object digest
describes the complete N1+N2 prefix; all preceding file/hash rows stay unchanged.
Install that full prefix before selecting the supported command descriptor.
Configuration alone does not activate command writers or a runner.

The native stock-evidence replay forward `20261022165000` appends a file/hash
row to the existing platform manifest without changing its immutable prefix or
format. Its live object-inventory digest changes with the replacement function.
Install the complete catalogue: the fulfillment package descriptor is a sparse
byte-identical projection, not an alternative history. Matching fingerprints
reopen and refresh evidence; legacy whole-input fingerprints still conflict with
PR1 identities and are not migrated. See [data compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle)
for the exact upgrade and replay boundary.

The M12 `supportAuthorityForwards` class binds exactly two inert support-authority
fixtures under its own fixed trusted inventory. Native authority delegates lifecycle
writes to M10 and retains named unavailable subcases; managed authority binds email
claim/settlement, a deferred identity fence, account linking and human recovery.
CTL introduces no installation SQL or runtime activation. R4 owns canonical and
native packed-twin introductions after the required same-rail prefix. Exact pins
and bounded lexical checks do not establish semantics: the
[finite PostgreSQL catalog/rollback proof](../../tests/postgres/reviewedBatchForwards.test.ts)
and required independent review remain necessary. See the
[class boundary](DATA_AND_MIGRATIONS.md#m12-supportauthorityforwards).

The M10/F17 `batchedForwards` registry adds exact approval data and inert
snapshots only. The batch has 16 pins: seven native and nine managed. Pending pins use
`20261024` identities after the landed M08/M09 rail tails; N1 keeps
`20261022160000`. Native order is N1 → N2 → N3 → seam → allocator → X → Y;
managed order is M1 → M2 → seam → M3 → M4 → M5 → M6 → F17 helper → F17 parity.
X (`20261024184500`) restores ATP-counted late-positive recovery after the
allocator; the recovery-truth forward limits those effects to applied payment
truth, preserving reviewed captures without stock restoration or counter advance; Y (`20261024184600`) filters paid retry candidates before LIMIT. N3 (`20261024180000`) excludes waiting/stock_secured cases before normal_due pagination while preserving the base reader's eligibility, shape and due-time/UUID order.
The uninstalled N2 (`20261024170000`) fixture includes raw command-preview
receipt replay with no public-table counts/columns/xmin delta. The apply
function is unchanged. Historical N1 approval still uses the exact old 14-pin
inventory at its first-parent introduction.
The three native body replacements retain their function
headers and ACLs and remain outside installation manifests. Its ordered paths, raw statement/definition hashes, signature
chains and exact grants/seeds do not install SQL, change a baseline, activate a
runtime or establish upgrade compatibility. The
[reviewed-forward boundary](DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards)
requires a feature introduction with exact class data and approval pins, plus
mandatory real-PG/pgTAP catalog evidence.

The native catalogue now appends the three reviewed M09 duty/effect/payment
forwards after its preserved prefix. The manifest inventory digest and sparse
package descriptor bind that complete selected tree; they do not declare
native/managed correction storage or fiscal support equivalent. The approved
pre-install duty re-pin is reflected in both native SQL projections, the file
hash and the live object-inventory hash; these bindings must move together.
It does not authorize rewriting a migration already recorded by an installation.

Fulfillment appends command/alignment units 73/74 and binds
their byte-identical package projections through `FULFILLMENT_MIGRATIONS`.
The canonical manifest retains its baseline and full prior prefix; its refreshed
object-inventory digest describes the complete selected graph. No managed
forward, old hash, role or payments lifecycle is changed. Native continuity is checked by
full-catalogue fresh/prefix/replay tests; a package descriptor alone establishes
no installation readiness.

The reviewed-forward registry additionally pins portable function replacements
to keep active subscriptions active on dunning exhaustion (invariant repair)
and to reopen and refresh stock evidence on matching-fingerprint replay.
The stock replacement keeps the supplied opaque fingerprint comparison and
`23505` mismatch refusal; it does not rewrite legacy fingerprints.
Each signature is fixed in code; its before hash binds the portable chain, while
its after and whole-file hashes bind the proposed forward. This approval
supplies no migration or runtime activation. The
[exact reviewed function rules](DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards)
require unchanged headers and a single function statement, with introduction
following the [co-located SQL/pin rule](DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins). Existing managed classes retain their fixed counts; the separate
[M09 forward admission](DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval)
binds three managed forwards and the additional exact native payment-terminal
replacement. New native routines stay invokers; managed wrappers retain donor
service-only definer attributes. These approvals install no SQL or activation.
When introduced, new F13 captures intentionally read `accountingRequested=false`
on payment readback: they record an owed obligation without linking a document
into payment truth. This is a declared readback change. The trusted-host
`invoicing_duty_readback(uuid)` is the owed-invoice view (KEPT #5), including
subsequent issue state and only the latest capture fault per source kind/ID;
historical linked payment events keep their readback.

The portable dunning invariant repair appends exactly one manifest row at
position 71 and refreshes `objectInventorySha256` from the complete live
PostgreSQL catalogue. Earlier file/hash rows remain an exact prefix. Install
the full selected catalogue to keep active subscriptions active on dunning
exhaustion (invariant repair); the forward does not rewrite existing paused
subscriptions or expired cases. Managed M2 supplies continuity through its
separately reviewed dunning forward.

Bundle application/admin now has package ownership in the existing catalog server
entry with named reference compatibility bindings. Read-error identity is shared
through its shim; the packaged RPC subclass is re-exported and injected into
handlers. Validators, their defaults/strictness and operation/MCP/flag authority
remain at the reference boundary. Catalog contracts publish plain DTO types only.
Existing composition order, stock unknowns, allocation and preview selection are
preserved. No database gate, actor-history parity, mount or stronger replay claim
follows from this move; the bundle pending ledger owns those outcomes. The native
read store now has package ownership with unchanged queries and an injected data
executor. Catalog also owns the native pooled writer and shared RPC marshalling.
Sparse SQL 16/19 projections preserve canonical identity and bytes; host
authorization, response mapping, managed transport and native handler-only actor-kind
protection retain their existing boundaries. Sequential key recognition is characterized, without a
payload-bound or concurrency guarantee.

Promotion admin DTOs and server schemas now have package ownership with named
reference compatibility exports. The structural-slice inventory follows the
moved native-store and admin tests; this is a source-location update, not a
new runtime capability. Reference wrappers preserve the shared admin kit/error
identity, currency validator and managed adapter fences. Sparse SQL 47/48
projections retain canonical bytes and positions without changing installation.

The subscription reference's closed browser import inventory includes exactly
`pricing/contracts/index.js`, `acquisitionTerms.js`, `offerPolicy.js`, `policy.js`, `quote.js`,
`provenance.js` and `offer.js` from the emitted
platform package. Its retained browser policy schemas consume those version
constants through the package entry; schema validation and wire pairing remain
unchanged. The quote and provenance modules retain their wire-version constants; the offer
module also exposes the additive v3 constant. Money/evidence DTOs erase at build time. The inventory admits no pricing server entry, token crypto, readiness
or secret configuration. [The pricing package](../../packages/platform/README.md#pricing)
owns the extracted authority and DTOs. Acquisition DTOs and protocol identities
are additive. `pricing/browser` directly re-exports the existing
`createCommerceQuotePrimitives`, `acquisitionCapabilitySchema` and
`acquisitionTermsExpectationSchema`; the inventories additionally admit only
`pricing/browser/index.js`, `pricing/quotePrimitives.js` and
`pricing/acquisitionTermsSchemas.js` plus the already declared acquisition
constant where needed. Required host financial policy, selector and readiness
remain in the server entry. The reference's four schema imports bind the same
symbols through this browser entry without changing validation. The reference supplies no acquisition
configuration and its request admission and token envelopes are unchanged.

The communications import inventory grants first-party browser imports only to
the explicitly selected disposable profile. It does not change ordinary public
mutation/webhook admission, deployment routes or default clocks. Native diagnostics
are bounded installation observations, not managed-frequency or full-native-sender
parity. A built shell does not establish an email destination or T07 action.

Identity privacy appends the direct receipt migration at position 69 while
preserving the preceding manifest entries and SQL projection identities. Erasure
requires this forward, explicit contributor registration and declared retention
ownership. It preserves contact IDs and auth links, refuses active/resumable
subscriptions, and records atomic replayable identity completion. Managed erasure
returns `MANAGED_PRIVACY_ERASURE_UNAVAILABLE` with no managed migration or new
grants; export exposes its narrower coverage. See
[identity privacy](IDENTITY.md#identity-personal-data) and
[data compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle).

Direct human operator sessions introduce a distinct operator audience and a
browser provider-selection setting. The direct catalogue appends the challenges
forward with an immutable predecessor prefix. Its normalized-email uniqueness
constraint refuses ambiguous identities; customer links and machine credentials
are preserved. [Identity](IDENTITY.md#direct-human-login) owns the authentication
codes, limits and compatibility requirements; no managed migration is added.

Operator invitations add a bounded TTL for direct hosts that call the parser and
one append-only direct migration manifest row. Such hosts refuse malformed TTL
values before writes; the managed reference runner neither calls the parser nor
enforces invitation expiry. Its lifecycle outcome data replaces the old message-only invite
response; active/pending-role/identity conflicts use explicit 409 identity reasons.
Managed revoked-row reinvitation refuses with `MANAGED_REINVITE_UNSUPPORTED`.
[Identity](IDENTITY.md#operator-invitation-lifecycle) owns the DTOs and acceptance
boundary; [data compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle) owns
the direct catalogue identity and the managed pending-lifecycle compatibility gap.

The publication catalogue now includes the ordered runtime capability forward
and its actual-role and renewal-lock witnesses. The derived source contract
binds that inventory and its classifications; it does not grant permissions or
change package APIs. Runtime authority comes from the separately admitted SQL.

The [reviewed function-forward approval data](../../config/reviewed-platform-forwards.json)
binds exact managed SQL files and old/new function definitions. Its replacement
list contains exactly three existing signatures in two files; a distinct creation
list requires the two price-setup signatures to be absent before their forward.
The optional runtime list pins the capability and identity forwards described above.
The separate `portableCreationForwards` list pins two fulfillment and three
invoicing creation forwards by path and whole-file hash, requiring new objects
and invoker functions. The portable replacement list pins the dunning function
and the invoicing payment-terminal accounting block.
Managed correction recovery, lock coupling, trigger admission, seller eligibility and migration ordering are owned by [M09 forward design](DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval).
Self-check and release share the admission checker and the canonical
[co-located SQL/pin rule](DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).
The `managedCommerceForwards` registry binds the managed commerce SQL to the
matching files under `scripts/fixtures/reviewed-m11/` and `supabase/migrations/`.
The registry and real migration rails are authoritative. Each pin requires all
earlier same-rail pins with exact bytes. Tests select each real file once,
compare it with its fixture and replay its complete real prefix. Hole, byte-drift,
header, ACL and catalog refusals preserve that boundary.
The stock reader uses `SECURITY DEFINER` with pinned
`search_path = pg_catalog, pg_temp` and permits execution only by `service_role`.
Behaviour proofs run as that granted role; owner access serves setup and state
inspection. The [data contract](DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards)
owns exact headers, ACLs, preimages, ordered statements and migration actions.
Existing control histories remain valid; later repins cannot authorize earlier SQL.
Database proof does not establish handler behavior or authorize installation.

Migration: managed checkout preference scope, return ownership and normalized
replay, payment-link audit receipts, acquisition finalize admission and terms
reading, new-purchase ATP and starter graduation follow the compatibility actions
in [Data and migrations](DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards).

### Native communications evidence

Evidence: historical record, 2026-11-13. Not reader guidance.

C-compose adds binding-scoped message lookup and bounded delivery evidence.
Foreign references produce no unrelated row; ambiguous message identity refuses.
Only the six native observation states can reach the fact writer. Open, click,
scheduled and unsupported provider events never become delivery. The existing
raw-byte signature/environment admission remains before the native bridge.

Native signed-token preferences commit denied/suppressed authority and default
marketing-purpose membership work in the same transaction. Replay reuses the
current permission event's rail identity; a work failure rolls the permission
write back. Local suppression does not wait for a provider and a provider response
cannot grant consent. Native legacy tester links refuse without an authoritative
legacy source; managed legacy links and localized unsubscribe responses remain.

Position 70 adds native fact storage without changing prior schema identities or
managed contracts. A trusted network-acceptance registration is distinct from a
captured receipt and from an observed delivery. Poll and admitted callback facts
share an atomic writer; exact observation replay is harmless, conflicting replay
refuses, terminal/suppression precedence is monotonic, and abandonment preserves
unknown delivery truth. A bounce or complaint uses the stored recipient fingerprint.

Newsletter work uses the existing outbox event identity, exact target namespace
and claim token. Its sidecar has no independent claim/lease/drainer; settlement
and rail acknowledgement are atomic and stale tokens do nothing. Only the existing
sync dispatch engine executes injected membership effects. Hosts must keep that
namespace out of a generic dispatcher. Registration does not grant consent and a
sync acknowledgement is never a delivery observation.

Native consent means registered P4 policy, authoritative native snapshot, durable
decision and active source-bound admin recipient. Managed frequency caps and
legacy contact-touching are excluded; evaluate is not a send-time fence. Missing
or unsafe storage throws before an effect. The [B3 expectation table](plans/oss-m04-communications-triggers.md#b3-native-stores)
names each changed public operation and its witnesses. Required-test registration
adds the native PG and reference-binding suites while retaining every old selector.

## Communications import compatibility

Evidence: historical record, 2026-11-13. Not reader guidance.

M04 P1 preserves the existing public communications contract while moving its
provider-agnostic algorithms to the platform package. Auth standard-webhook verification
keeps its stream-only body reader and millisecond clock; the maintained HTTP mail provider keeps its own
signature dialect and mapping in unchanged reference source. The generic HTTP hex-HMAC reader keeps its inclusive
1 MiB byte cap and parsed-body fallback; it does not replace either verifier.
The package transport contract and capture keep raw outcome/projection distinctions;
reference transport responses keep omitted fields,
headers/tags and sink/drop handling. Token purpose sets, receipt conflicts,
three-404 reconciliation abandonment and send/ledger ordering remain unchanged.
Browser-used renderer and preview values remain local. See the
[communications owner](../../src/domains/communications/README.md#packaged-server-algorithms).

## Neutral marketing sync

Moved to [Marketing sync](../../packages/core/docs/guide/concepts/marketing-sync.md#operations-and-scope).

Keep private mapper and brand construction inside the adapter boundary. Preserve
existing marketing imports, ports and observations, including
`NewsletterSyncProviderPort`. Result unions remain closed; new adapters must
retain authority checks without silently widening existing ports.

The private construction mapper resolves opaque subjects and owned targets.
Admission stores validated immutable effect evidence before dispatch and
rechecks generation and tombstones after awaits. The type declarations live in
[`marketingSync.ts`](../../packages/platform/src/communications/contracts/marketingSync.ts).

The communications entries expose the same 17 type-only marketing-sync
declarations. The four families have five operations; replay identity includes
all four binding coordinates.

Evidence (historical record, 2026-11-13):

Each operation has a closed result union. Mutation accepted means admitted
intent; acknowledged means provider acceptance. Neither means erasure completed.
Only fresh, authorized `erasure.read` with authenticated provider-read evidence
can complete the original bounded deletion. Ordinary 404, empty search, elapsed
time and receipt replay cannot. Completion never removes the subject tombstone.
Existing marketing ports and their observations and the existing
`NewsletterSyncProviderPort` remain unchanged. The current opt-in adapter
includes a refusal-only `NewsletterSyncProviderPort`: all capability flags are
false, and `sync` and `reconcile` return `skipped/unsupported`; it does not
enable newsletter provider work. This declared bridge is not provider selection
or activation. The [A1 ledger](plans/oss-a1-communications-adapters.md)
records the offline synthetic proof and remaining delivery gates.

### Consent push admission and reconciliation

Moved to [Marketing sync](../../packages/core/docs/guide/concepts/marketing-sync.md#consent-push-admission-and-reconciliation).

Keep provider effect mappings and proof requirements with adapter design.
Implementations must preserve no-trigger admission, suppression safety, safe
audience withdrawal and all-purpose authority checks without widening the
original provider ports.

Evidence (historical record, 2026-11-13):

Klaviyo email's planned mapping declares account-wide grant effects, while local
grants stay audience-scoped. Audience withdrawal must have trustworthy list-only
effect proof, including changes before an asynchronous job acts; a pre-job
membership snapshot alone is insufficient. Explicit all-purpose withdrawal uses
global email unsubscribe. Mailchimp and Brevo declare audience grant effects;
unsupported account-wide withdrawals refuse. Brevo list removal projects membership
only, without claiming global consent. These are partial design mappings, not
provider certification. No flow management, suppression editing or vendor factory
is introduced by this contract.

## Source release snapshots

The source-release contract separates authored runtime, repository/release
identity, database seam and signed typecheck compatibility from derived digest
bindings. PR/main/merge-group policy and inventory checks run derivation against
live inputs without requiring a fresh committed snapshot. Digests refresh only
at release prep; source prepare and package preflight, protected prepare/plan and
publication/resume compare canonical snapshot bytes against exact target Git
objects. The authored publication catalogue keeps exact rows except for regular,
non-executable, content-validated package `changes/*.md` fragments. Git binds all
remaining source contents and modes. This is preview evidence, not stability.

## M05 parity seams

Development-preview hosts may select independent seams; omission preserves
incumbent behavior. No route, policy, provider or new financial default is selected
by importing them. These additive APIs need a minor package set.

The existing catalog entry also supplies the opt-in
`createPostgresCommerceQuoteCatalogReadPort`. It reuses strict SKU envelopes,
then guards the current payload against the product/slug/pointer and complete
revision tuple before excluding inactive products. Included products then undergo
required host schema, semantic identity and canonical digest verification.
Bounded keyset scanning refuses excess cardinality/pages, duplicate variant or
code and repeated cursor without partial success. Known quote catalog errors
retain their class; unexpected failures become authority unavailable. This is
current-direct authority, without a publication-wide snapshot or head-qualified
publication. See the [catalog package contract](../../packages/platform/README.md#catalog)
for the callback, limits and existing runtime SELECT capability.

`createPromotionQuoteAcceptance` accepts explicit `shippingTerms` on each issue
and verify input. `projectPromotionQuoteMoney(quote, acquisitionTerms?, shippingTerms?)`
and `promotionQuoteMoneySections` include the promise only when supplied, in the
shipping section. Shipping-only agreements can receive a token. A changed or
removed promise refuses as `quote_mismatch` / `shipping`, even if money is equal.
The public and strict quote projections bind the same money and promise.

`createCommerceQuoteHandler` optionally receives `shipping: { terms(quote) }`.
The host must preserve terms through its response schema and forward the fourth
issue callback argument (fifth for honor) to the acceptance helper. An unsigned
shipping promise refuses before promotion fallback; a fallback retaining shipping
terms also refuses. Hosts use `parseShippingTerms` inside `shipping.terms(quote)`
to refuse corrupt retained terms. With the binding omitted, callbacks retain their incumbent
argument count and token bytes remain unchanged.

`createDbBackedCommerceQuotePort` optionally receives
`resolveQuoteShippingPromotions(input)`, returning final discounts, rejections,
shipping gross, `hasShipping`, and optional shipping/acquisition terms. Without it,
the flat-fee read still precedes automatic evaluation and code adjustment. With it,
pricing uses its supplied money and terms and does not call the incumbent lane
callbacks; the flat fee is ignored once a resolver is supplied. Hosts must select a context schema that retains these promises.

The promotions `createQuoteShippingPromotions` factory receives settings and raw
promotion/code ports plus the existing bound automatic and code applications.
It resolves current/scheduled shipping settings, evaluates both lanes at the flat
fee, then compares product payable after product discounts with the threshold.
Shipping discounts do not count as product spend; equality is free. A changed fee
reruns both lanes exactly once and returns that pass's winners and rejections.
There is no fixed-point iteration. Raw promotion reads and code candidates are
memoized only inside one resolution, with cloned mutable results for each reader;
a second quote, concurrent batch member or later retry owns fresh reads.

The shipping server entry validates policy/terms and exposes
`normalizeShippingPolicy`, `resolveShippingPolicy` and `resolveThresholdShipping`.
Its contracts entry adds only DTO types. A null policy uses the validated legacy
fee; an ineffective or disabled selected policy yields zero without terms.
Malformed retained policy refuses rather than becoming a legacy fallback.

The promotions legacy, v2 and automatic factories accept an optional `acquisition`
binding with host `financialPolicy`; the automatic factory also reads the host's
`capability(request)`. V2 receives `acquisitionCapability` in its evaluation input.
Existing paid subscribers exclude metadata-tagged and first-subscription rows
before schedule selection. New subscription customers use the existing pricing
selector, half-open schedule filter and capability/engine refusal precedence.
Selected terms propagate only for a negotiated capability. The legacy evaluator
keeps its unfiltered `allCandidates` for code canonicalization and rejection/cap
precedence separately from the filtered evaluation candidates. Ordinary coupons
retain their existing evaluator rules. Legacy, v2 and automatic acquisition
bindings reach the quote context only through `resolveQuoteShippingPromotions`,
which carries the selected acquisition terms. Omission keeps candidate sets and read
order unchanged; hosts still own financial constants and metadata interpretation.

Neutral witnesses live in the package promotions tests
`shippingConsentParity.test.ts`, `thresholdShippingParity.test.ts` and
`acquisitionOrchestrationParity.test.ts`; the [M05 extension ledger](plans/oss-m05-catalog-offers-pricing.md#m05-parity-extension)
records the bounded contribution. Native candidate/claim and mounted acceptance
gaps in that plan remain separate obligations.

`createAdminBundleReadHandlers` accepts an optional `effectiveTarget(bundle)` on
its handler dependencies. With it, previews use that authoritative target; null
never falls back to active history. An explicit preview amount still wins, and
an omitted mode without a target defaults to `one_time`. Without the hook the
incumbent active-row search and `any` fallback remain unchanged. Optional
`resolvedTargetPrice` survives the detail DTO and reference response schema;
older details may omit it.

`createPostgresBundleCatalogStore(executor, { priceAuthority: "effective" })`
selects half-open target/list windows, currency, optional region and purchase
mode (`one_time` by default), with `any` fallback and overlap/identity refusal.
Detail accepts `regionCode`/`atTime`; the feed also accepts `mode`. The exported
`selectEffectiveBundleTargetPrice(rows, context)` applies list/currency, active,
gross, positive-target and window filters before exact-mode selection. Component
anchors require effective gross minQty-one entries; duplicates refuse. The feed
emits a whole BOM only when every component has current document and primary
unit GTIN authority, active product/SKU, positive integral weight and anchor,
and sellability for the requested mode. Detail retains unready components.
With the option, list/detail `hasActiveTargetPrice` also follows the effective
rule (gross, positive target, `one_time`/`any`, active list, current window)
instead of the active flag alone.
Omitting the store option preserves existing SQL bytes, reads and outputs.

`createConcurrentCommercePriceAuthorityPort(reads)` is an alternate pricing
factory: subscription history starts alongside the base read using the selected
list ID, with captured history errors subordinate to base refusals. One-time
requests schedule no history; legacy fallback still uses the validated base ID.
The incumbent authority and PostgreSQL factory retain their sequential scheduling
and observed-base identity. The native effective-bundle witness is
`tests/postgres/bundleEffectiveParity.test.ts`; all parity additions use existing
collectors and synthetic host data.

## Fulfillment observation and sync execution

The [fulfillment contract owner](ARCHITECTURE_AND_EXTENSIONS.md#fulfillment-contracts)
explains G15–G17: consecutive-success coverage confirmation, timed local stock
lines and inline host persistence. Ingress persists eventKey receipts before
lifecycle writes. For correlated ingress, a trimmed observation or dispatch
external reference is required before acceptance/status/effects/processed mark;
a missing/blank pair leaves the receipt unprocessed. Hosts own idempotent replay; a superseding conflict returns
superseded and persists/returns its safe `supersededCause`. Ingress returns the
host receipt ID (or durable event key), counters for rejected correlation fields,
tracking numbers/services/URLs and invalid timestamps, and diagnostics on early
refusal. Original supplied occurrence is validated before mapping: numbers,
objects, empty strings and invalid timestamp strings refuse and count; absent/null
occurrence remains unknown without a refusal count.
The host applies `fulfillmentIngressHttpResult` for status and safe message class;
no route is installed. The webhook colon key retains original occurrence bytes;
host-injected persistence/effect keys must keep the donor namespace for replay.
Native 0.22.0 digest receipts/effects and superseded outcomes are outside that
compatibility: retries can repeat tracking or fail with
`fulfillment_observation_outcome_conflict`. Drain in-flight observation retries
before upgrading; the [0.23.0 migration note](../../packages/platform/CHANGELOG-HISTORY.md#0230)
records these limitations without a bridge or alias migration.
The normalized fact uses a separate opaque identity. Hosts must retain the raw
evidence referenced by its opaque pointer, with access/retention policy of their own.

Reconciliation reads local chronology independently of provider readback.
Non-stale found observations for locally cancelled/exception rows write status
evidence only. Older known occurrences skip status/effects; only on-track rows
with handedOverAt may retry an invoice on that path. Unknown readback is row-local:
it counts a run failure while recognized rows still process. Unmapped evidence
is projected before host calls;
correlated off-track rows skip acceptance/quarantine. These workers call no
alignment or replacement-confirmation operation; native late-arrival alignment
must preserve the later-only monotonic rule.

## Subscription port boundary

The experimental [subscription declarations](../../packages/platform/src/subscriptions/contracts/index.ts)
carry deferred admission independently of terminal refusal, original schedule
text independently of its comparison instant, frozen revisions and complete
claim readback. Verified M07 evidence carries original occurrence, observation
and first-recorded clocks with nullable money and explicit ambiguity/late-positive
disposition. A late positive settles the same obligation only when payment truth confirms an
applied captured settlement, never a new charge. Captures retained for review
apply no paid retry effects and create no recovered receipt. Their existing
payment-truth event preserves evidence and idempotent redelivery; the public
retry store returns `payment_failed`, and the driver reports reconciliation work.
Only an explicit `succeeded` provider readback may settle success; an unrecognized
status remains awaiting provider evidence even when it carries matching money.
A waiting retry row with disposition `payment_failed` and null `nextRetryAt`
is intentional exhaustion or a class stop. An in-flight prepared retry retains
`retry_scheduled` with a null date; it awaits evidence rather than another
dispatch. Fallback cadence is allowed only when the row is absent.

Native N1 records retries against the original refused renewal without resetting
that terminal operation or minting another cycle. Each failure receipt advances
the rung once, separately from case propagation; a prepared receipt permits only
its first caller to dispatch. Unknown observations and missing acknowledgements
require reconciliation. Recovery consumes M07's verified matching positive
payment evidence and commits settlement, receipt, case, cycle and native counter
effects together. It never guesses a logical number from the native counter,
pauses the subscription, or moves `next_cycle_at` earlier. Exhaustion keeps the
case open with a null retry. Reopening a class stop or exhausted ladder requires
a same-case token and durable healthy-method evidence before scheduling.

The initial runner handoff must open the case before the terminal outcome;
subsequent retry failures apply settlement and rung once before advancing that
case. N1's case wrapper requires an already recorded failure, so it is not by
itself the initial handoff. The package binding opens the existing case first and atomically attaches N1
bookkeeping during terminal recording, using the same case and preserving the
initial handoff key. Hosts supply its transaction/correlation/M07 ports; payment
execution stays outside every local transaction. Initial terminal replay checks
the immutable receipt and returns before settlement, case rebinding or case
propagation; it preserves later retry state, notifications and events.
A host or driver skips `openCase` after a replayed `applyFailure` receipt only
when that rung's case propagation already committed. If propagation did not
commit, recovery must complete it. The composed native retry driver uses
`failureProgress` to distinguish those states under the subscription lock;
its real-PostgreSQL witness compares every public row, including tuple versions,
after replay of a committed subsequent-rung propagation.

The host must establish explicit logical-cycle correlation before invoking the
automatic runner, including its prepare/execute path; the terminal binding
cannot repair missing correlation after charging. Ordinary retries must use the
frozen mandate/authorization. N1 does not bind an ordinary retry method to it:
the composed retry driver checks the frozen host mandate before preparing an
ordinary retry. Its PostgreSQL refusal witness proves no durable delta and no
second provider call for a different method. The binding checks logical-cycle
correlation before the original prepare/execute path too.

Nothing in automatic renewal pauses an active subscription. Arrival alignment
uses the outer schedule maximum and actual latest arrival plus cadence; no
cycle moves earlier or stacks. A superseded predecessor is no longer outstanding,
but an undelivered replacement still is. Never call
`subscription_delivery_alignment_confirm_replacement` until that replacement
arrives. After rollback to `off`, shadow cases are admitted. Captured protected cases
still go through admission and defer until actual arrival: `protect` releases
the case; `auto_align` settles as `aligned` using the latest arrival plus cadence
with the outer maximum, never earlier or stacked. `manual_review` cases, including
protected cases whose arrival meets open dunning or a successor cycle, keep
deferring until resolved.

The native descriptor supports generic bundle commands and command-bound receipts
with N2 installed after N1. Actor/key uniqueness binds the actual action and all
payload fields, including accepted quote, subscription and client. A changed
command refuses; a successful replay returns the original receipt even after
quote expiry. Refused commands persist their reason without business writes.
The native command store checks the stored receipt under N2's actor/key lock
and returns replay before invoking the SQL lifecycle function.
Accepted prices lock until edit with no proration; only future agreement changes.
An existing claim, cycle or order keeps its frozen snapshot and money. Preview
and apply are separate transactions; apply commits terms, event and receipt
atomically. Private introductory cadence and acquisition policy remain host-owned.
Multi-cycle prepaid retains its named unsupported capability. The dedicated
native payment store supports durable preparation, immutable ingress and exact
attempt correlation. The first failure of each correlated provider renewal
attempt records one immutable attempt-bound retry receipt before truth reuses
the financial transition. The receipt owns the rung and schedule; the cycle
stays `payment_pending`. An expiry
after that attempt's decline records the escalation without another retry stage.
Provider dunning case, notice and token handoff await attributed composition,
and a real provider renewal binding is not yet supplied. The subscription descriptor retains its separate composition
limits. N1 retry recovery is selected while stock recovery remains
unavailable. One executor stays default off with mandatory delivery admission.
Host-selected M04 descriptors carry recorded
lifecycle facts; copy, recipient, consent and delivery remain host/M04-owned.
See the [architecture boundary](ARCHITECTURE_AND_EXTENSIONS.md#subscription-contracts).

## Invoicing evidence

The seller wrapper freezes only eligible obligations at their first durable
claim; retries reuse its returned revision. A correction has its own eligibility
and first-claim seller. Pre-cutover obligations retain execution-time fallback
on later retries, and issued history is immutable. Missing/unknown seller reads
consume no claim. Managed correction claims with an order scope refuse before
the unscoped wrapper can run. Managed order-status reversals use the seller
request wrapper and preserve the incumbent result. SQL replay identity conflicts
surface as typed conflicts. Native upgrades never freeze a previously claimed duty.

Reader guidance: [Compose invoicing](../../packages/core/docs/guide/how-to/build/invoicing.md).

Host artifact persistence, clearance observation and M04 acceptance are separate
proofs. The [invoicing contract reference](../../packages/core/docs/guide/how-to/build/invoicing.md#select-the-ports)
retains source witnesses.

See the [M09 forward owner](DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for the registered managed-correction limit and follow-up.

Offline conformance checks stable
identity, recovery without a second write and parent mismatch before another
write. Adapter-owned fixtures establish this contract boundary; live fiscal
readiness and inbox delivery require their own evidence. Native P4a fencing is
covered by the real-Postgres conformance witness, with no provider access. Native
child-document corrections and managed base-row corrections have separate
migration descriptors.

## Account self-service owner results

R5a composition admission adds only `disabled`, `schema_unknown` and
`schema_unsatisfied`, before entering an injected owner. Every entrance checks
again; a prior ready observation does not authorize a later command. Callable
aliases share one guard, preserving the selected owner's arguments, result,
exception and original idempotency key. This is admission, not authorization or
mutual exclusion: trusted customer/operator context and durable owner replay
remain mandatory. A null selected operation remains an unsatisfied required port.
The separate absent commerce record/member returns
`{ kind: "unsupported", code: "host_binding_required" }`; a selected owner's own
unsupported answer remains unchanged. Selecting `commerceOwner` forwards one
host-built M11 binding's guarded services and descriptors through a local
structural type; R5b does not construct M11 or import its adapters. The host
supplies matching enablement/readiness with the complete selected account/M11/ATP
schema observed before entry and the existing registry as `commerceRegistry`.
It preserves commerce handler
outcomes, unknown stock and `managed_stock_read_options_unsupported`; no success
or optimistic availability is synthesized. Recovery root/latest-order identity,
client identity and the original key remain owner inputs. M04 retains notice
replay and M12 creates no additional effect consumer.

The experimental account-support composition selects each owner lane explicitly.
Managed results, nulls and errors pass through; native typed and raw lanes keep
owner receipts and verbatim refusals, including unsupported verbs. No lane is a
fallback for another. The native donor route keeps pause on the explicit pause
port, checks ownership before validating an update_bundle quote, and sends other
verbs to control. Verified-principal mismatch refuses before any owner call.

The raw codec supplies verified identity and time, preserving the host's resolved
payload and idempotency key. Preview copies that payload without acceptedQuoteHash;
apply never previews. Only a checked previewed record reaches an injected host
projection; other owner records retain identity. The projection must supply any
legacy telemetry from trusted host facts. Native browser key retention remains
unselected until the host retains one key across preview/apply. Native profile edits and invoice correction requests have an explicitly selected
PostgreSQL port; recovery start and managed-shaped redeem remain unselected.
The facade returns every R1 output lane plus native legacy/control, with required
host-supplied AccountSupportCapabilities. Input lanes are optional. Every output
lane guards the verified principal;
raw/typed lanes require the supplied clientId to equal context.clientId, including
refusal of omitted, undefined and null values before any owner call. Supported paymentMethodSetup requires a
paymentMethod lane; supported commerceRecovery/configuredPurchase require commerce.
Supported subscriptions.genericBundleCommands/commandBoundReceipts require at least
one selected managed/native legacy/raw/typed subscription command lane. Missing
required lanes and incomplete selected lanes refuse configuration. Unselected
methods resolve to `{ supported: false, refusalCode }`: paymentMethod returns the
host paymentMethodSetup refusal by identity, commerce returns commerceRecovery by
identity, and every other lane returns the frozen host_binding_required constant.
The guard runs before every unselected-lane refusal. M07 method setup adapts setupMethod to the
guarded paymentMethod.execute lane and collects a transient handoff only.
Token routes remain reference handlers. The selected native method-reference
lane now supplies recorded repair authorization and bounded recovery-retry
scheduling through its service-only store. The host still composes authenticated
routes, verified provider ingress and method collection; importing the factory
does not select those routes or qualify a provider account.
See the [self-service reference](../../packages/core/docs/guide/how-to/build/account-and-support.md#choose-the-imports).


### Operator support receipts and partial links

R4's managed operator subscription result remains the reference transcription.
The additive native result carries `operator_subscription_authority_unavailable`
for explicitly missing owner capabilities, plus optional actual M10 evidence
`{ id, actorId, idempotencyKey, commandFingerprint, result }`. Delegated
`appliedBy` is null; a lifecycle event is never relabelled as a support audit id.
The support key remains unchanged; the M10 key is `m12-support:` plus SHA-256 of
the complete UTF-8 support key. Exact replay changes only the top success outcome,
retaining the original nested owner receipt. Conflicting reuse writes nothing.
An M10 exception or missing owner receipt aborts the whole support transaction;
an owner in-band refusal is durably paired with its support receipt/audit.

Native SQL refusals write exactly one support receipt and one audit, with zero
owner/lifecycle/event/outbox/address/identity changes. Native email/phone/link
port refusals open no transaction. The native new-address branch instead calls
its bounded destination routine and returns the destination applicability result;
`applied_from_next_parcel` retains the frozen current parcel and changes the
subscription's future. Same-UTC-day slide is a support-only noop after
window/version checks. Required real database proofs
are [operator authority](../../tests/postgres/accountSupportOperatorAuthority.test.ts)
and [upgrade/recovery replay](../../tests/postgres/accountSupportUpgrade.test.ts).

Link-then-subscription composition preserves a partial result: the completed link
and the second command's refusal, next-parcel application or unknown transport
completion remain separate.
Its callback is invoked before the second call without awaiting refresh. Email
correction instead follows admission, exclusive execution claim, identity commit
and settlement. A queued recovery notice is not proof of delivery, and an email
claim is not a universal reservation against independent identity writers.
