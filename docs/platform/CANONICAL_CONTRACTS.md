# Canonical Contracts

Status: development-preview contract. These rules define the intended public
behavioural boundary; they do not assert a stable provider catalogue or release.

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

Each domain owns its canonical status vocabulary, allowed transitions, and
terminal-state rules. A provider's raw status is evidence at the adapter edge;
it is mapped into a domain fact before it affects durable platform state.

Do not compare provider strings throughout application code or treat a browser
return value as settlement truth. Preserve the raw evidence needed for diagnosis
in a bounded form, map it once, and refuse impossible transitions. Late,
duplicate, or out-of-order evidence must not regress a terminal canonical fact.

Status vocabularies are not interchangeable between domains. A new status or
transition requires an explicit mapping, persistence compatibility, and tests
for refusal, replay, and ordering.

## Idempotency
The native bundle contention witness characterizes the existing global event
key, without adding payload/entity binding. Two absent-key transactions on
disjoint bundles can block at the unique key index: after the first commits,
the second raises `23505` and its attempted composition is rolled back. If the
first rolls back, the second can commit. A later same-key call recognizes the
key before validating changed payload, entity or routine. This is incumbent
recognition, not a stronger exactly-once or payload-fingerprint guarantee.
Catalog draft receipts retain their separate canonical-command fingerprint and
revision behavior; moving their adapter does not change either protocol.


Every externally repeatable write has an idempotency scope, a stable operation
identity, and a request fingerprint. Replaying the same logical request returns
the established result without a second durable effect. Reusing a key for a
different fingerprint is a conflict, not permission to overwrite history.

Idempotency keys are opaque values with documented derivation and scope. An
operation, a provider attempt, a customer journey, and an inbound event may
require different keys; do not collapse them into one user-controlled value.
Persist the ledger before reporting success, and make concurrent repeats resolve
to one canonical effect.

## Provider adapters

Domain code depends on a port, not on a provider SDK. An adapter translates the
provider protocol, verification evidence, and failure facts into the port's
neutral contract. It must carry the platform's identity fields without changing
their meaning and expose declared capabilities rather than relying on provider
name checks in domain policy.

An adapter needs conformance coverage for success, refusal, malformed or missing
evidence, duplicate delivery, out-of-order delivery, and retry/replay. Reference
fixtures demonstrate these behaviours without live provider access; they do not
prove a provider integration, release, or support tier.

### Adapter classes and example templates

An adapter belongs to one class and implements that class's neutral ports. Each
shipped example below is the template for an adapter for another vendor in the
same class; the rules above apply to every class.

A communications (M04) mail adapter returns an `EmailTransport` from
`@openlup/platform/communications`, built with `createGuardedEmailTransport`.
Marketing types come from `./communications/contracts`: `MarketingSyncProvider`
covers profile sync, consent readback and erasure, and `ConsentPushPort` covers
consent push. The marketing example also implements
`MarketingAutomationProviderPort` and a refusal-only `NewsletterSyncProviderPort`.
See the [communications import](PLATFORM_PACKAGE_REFERENCE.md#communications-import)
and the [marketing adapter](#opt-in-singleton-marketing-adapter).

A payments (M07) adapter implements `PaymentAdapter` and declares
`PaymentAdapterCapabilities` from `./payments/contracts`. Prove it with
`runPaymentAdapterConformance` from `@openlup/platform/payments`, using
`PaymentAdapterConformanceSubject` from `./payments/contracts` and verification
fixtures. See the [opt-in payment example](#opt-in-payment-example).

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

| Class | Shipped example subpaths |
| --- | --- |
| Communications | `@openlup/platform/communications/resend`, `@openlup/platform/communications/klaviyo` |
| Payments | `@openlup/platform/payments/stripe`, `@openlup/platform/payments/tpay` |
| Fulfillment | `@openlup/platform/fulfillment/omnipack` |

The examples are default-off and opt-in: the host selects an adapter for each
port it needs, and default wiring includes none. To write another vendor's
adapter, implement the class port and declare capabilities honestly: an
unsupported capability is an explicit refusal, never a silent no-op. Pass the
payments conformance runner or, for communications, extend the class's
[tests](../../packages/platform/test/communications/), including refusal
behaviour, without live provider access. Keep secrets transient and
host-supplied at call time, never in source, fixtures or logs. Keep the adapter
in your own source or propose it upstream through
[contribute existing adopter code, then refactor](../../CONTRIBUTING.md#contribute-existing-adopter-code-then-refactor).

### Opt-in Node protocol adapter

`communications/resend` is an experimental Node-only subpath.
It exports exactly three functions: guarded transport creation, authenticated
webhook handling and GET-only delivery reconciliation. Types remain on the existing neutral entries.
The neutral communications and browser contracts entries expose no vendor factory.

Every `.send` enters `createGuardedEmailTransport` before the internal POST.
The host supplies the policy and environment tag name; only the validated
credential, effective recipient and environment tag reach the provider. Missing,
throwing, malformed or blocked policy causes zero POST; drop is terminal
`ok + suppressed` with zero POST. Optional payload keys, exact idempotency-key
bytes (including empty), abort and 2xx acceptance without an ID retain the
reference transport shapes. Acceptance is not delivery.

The webhook authenticates the original string/UTF-8 bytes before JSON parsing,
using the provider bare or `v1,` signature-member dialect, literal or canonical
`whsec_` keys, a UTC-seconds clock and an inclusive ±300-second window. This
policy is separate from the standard Auth verifier's normalization and grammar.
Explicit foreign environment tags stop before lookup or convergence; the
receiver defaults to non-production. Admitted events use `processEmailObservation`:
lookup/apply errors retry with 500, while attempt telemetry cannot overturn
success. Unsupported or missing-ID events are ignored. Event metadata is opaque.
Webhook and poll observations retain the raw `email.*` provider event type;
the webhook event inventory is an admission gate only.
The webhook returns a fixed 500 body on processing failure and only an HTTP
disposition for unsupported, missing-ID or foreign events.

Reconciliation delegates to `runDeliveryReconciliation`, with internal GET reads
of host-selected existing IDs. Only failed 404 reads contribute to the existing
three-consecutive-404 abandonment rule. Auth/network/provider errors remain
separate; sent and unknown snapshots stay pending. Polls feed the host's existing
atomic writer and never recovery-send. No route, schedule, store, credential
reader or reference binding is installed. Fetch is injectable; no SDK or new
dependency is required. [A1 evidence and limits](plans/oss-a1-communications-adapters.md)
are protocol-only; account verification remains pending.

### Opt-in singleton marketing adapter

`communications/klaviyo` exposes one Node factory implementing the neutral
profile, negative-consent, erasure and consent-push ports, plus the existing
marketing bridge and refusal-only newsletter port. Construction supplies private
host identity/authority registries, a credential resolver and atomic account
storage; fetch and clock are injectable. Nothing installs a route or worker.

Account-dependent operations remain `verification_pending` until owner TEST
readback binds scopes, mappings and operation-specific no-trigger evidence.
Deletion read is unsupported; audience-only deletion cannot become account-wide.
Profile writes change owned fields only and verify the private projection.
Negative readback preserves each fact's scope; scoped remote consent is unknown,
missing sources mean partial coverage, and remote subscribed never grants locally.

The push capability declares account-wide grant effects while each local grant
remains audience-scoped. Grant admission must account for all profile-consent
flows, segments, backfills and DOI, and prove suppression cannot be cleared at
effect time. List-only withdrawal requires proven-safe scope; explicit all-purpose
withdrawal is separate. Every request encodes one subject. Asynchronous job
acknowledgement proves acceptance only, with no import flag or job-control API.

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

## Subscription lifecycle

The subscription status matrix has one meaning and several spellings. The
managed SQL guard `public.subscription_guard_status_transition` fires before
every status update. The core engine publishes the same matrix, restricted to
the four statuses it manages, as `SUBSCRIPTION_STATUS_TRANSITIONS` in
`@openlup/core/subscription`:

| From | To |
| --- | --- |
| `active` | `paused`, `cancelled`, `completed` |
| `paused` | `active`, `cancelled` |
| `cancelled` | `active` (the owner's win-back) |
| `completed` | none; terminal |

The guard's other edges belong to the activation flow, which the engine never
drives: `pending_activation` to `active`, `activation_failed` or `cancelled`,
and the reopen of an abandoned checkout from `cancelled` to
`pending_activation`, which the guard admits only with an audited
`subscription.activation_abandoned` event. `activation_failed` is terminal.
The core contract test, a pgTAP suite over the guard, and a parity test that
reads the guard's live body all pin the matrix. A change to one side must
update the others in the same contribution.

A matrix edge is not a licence for every operation. Only the owner's pause
request may move an active subscription to `paused`. Among the engine's
statuses, only the win-back leaves `cancelled`: it needs a stored payment method
and restarts the schedule two days out.

**The sanctioned non-payment rule.** A failed payment never suspends, freezes or
pauses an active subscription. Neither a ladder cut short by a terminating
refusal class nor exhaustion past the last rung changes its status: the dunning
case stays open, the unpaid cycle is not moved, and no further automatic charge
is scheduled. After exhaustion the same case remains repairable; on the portable
chain `dunning_lifecycle_record_recovery` closes it when the money moves.
Subscriptions already paused and cases already expired under the earlier rule
keep their separate resume behaviour. A plain resume must not be used for such a
subscription, because it neither skips the uncollected cycle nor moves a stale
`next_cycle_at`; the managed `subscription_resume_after_expired_dunning` and the
engine's `resumeSubscriptionFromExpiredDunning` handle it.

Managed M2 now keeps exhausted cases open with a NULL retry and a repair token.
Token redemption, durable method setup and the current cycle/rung must converge
before recovery is authorized; replay cannot mint a second charge. The core
compatibility helper `pauseSubscriptionForExpiredDunning` returns unchanged
state and no pause event. Explicit owner pauses remain separate.

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

The engine models the decision; the host keeps the durable duties the managed
SQL restarts also perform. Both restarts require the customer's confirmation of
the charge timing. A win-back also clears `ended_at` and the cancellation
reason, refuses while a cycle is locked, and bumps the template version. A
recovery also requires a method that is chargeable unattended, not merely
present, and skips every uncollected cycle of the subscription, not only the one
it was given.

The two sides restart the schedule differently. The engine re-arms
`next_cycle_at` at the later of the stored instant and two days out, so a
restart never moves it earlier. The managed SQL restarts assign two days out
unconditionally. For a win-back from a subscription paid through a later date,
the SQL side therefore charges earlier than the engine would.

**Known limitation: the portable chain.** The portable PostgreSQL chain in
`db/platform/migrations` does not yet carry this matrix. Its `subscriptions`
table admits only `active`, `paused` and `cancelled`, so it has no activation
statuses and no `completed`. It has no status-transition trigger: each lifecycle
function checks its own source status. It can send a win-back message to a
cancelled subscriber, but no function reactivates a cancelled subscription.
Its dunning rail, `dunning_lifecycle_handle_failure`, keeps active subscriptions
active on dunning exhaustion (invariant repair). A NULL next retry leaves the
case open and repairable through `dunning_lifecycle_record_recovery`, queues the
final notice and records the exhaustion event, and returns `paused=false`,
`pauseWindowId=null`, `terminal=true` without creating a pause window or changing
subscription or cycle dates. It still has no rung fence: a class-terminated
refusal on rung one also has no next retry. No caller in this tree invokes it
today. A future caller must not call it with NULL unless
`isDunningLadderExhausted` holds for the refused cycle. A case cut short earlier
must stay open without that call. An adopter on the portable chain therefore cannot store a
completed or provisional subscription, and cannot reactivate a cancelled one,
until a forward migration closes the gap under the compatibility lifecycle in
[Data and migrations](DATA_AND_MIGRATIONS.md).

## Subscription delivery alignment

An active subscription must not admit its next renewal while the customer is
still waiting for the preceding delivery. Renewal admission records durable
protection for an undelivered obligation; an already-created
`retry_scheduled` cycle remains existing recovery authority rather than a new
renewal. A delivery that resolves the delay moves `next_cycle_at` to the
delivery or confirmation instant plus the stored cadence. The durable update is
monotonic and uses SQL `GREATEST`, so alignment may extend a cycle but never
move it earlier or stack deliveries on the customer.

A replacement parcel does not erase the obligation merely because it was
created or dispatched. Once a row names an earlier parcel through
`replaces_fulfillment_order_id`, that superseded predecessor is no longer an
outstanding obligation; the latest unsuperseded replacement remains outstanding
until it reaches the customer. Its arrival may settle the predecessor's case as
`aligned` without fabricating `delivered_at` for the parcel that never arrived.

`subscription_delivery_alignment_confirm_replacement` is the service-only path
for recording that a substitute shipment reached the customer when durable
delivery evidence cannot do so. Never use it for an in-flight, lost, or otherwise
undelivered replacement: `aligned` means the delivery happened. Replaying an
already aligned confirmation returns the stored aligned schedule and must not
add another cadence. The ordinary operator-resolution path refuses while an
active subscription still has an unsuperseded undelivered parcel; refusal leaves
the protected case and schedule unchanged.

These are source and persistence contracts, not evidence that any hosted
deployment, provider adapter, or public release has activated the rail.

The native fulfillment translation uses `fulfillment_shipments.replaces_shipment_id` and
order → cycle → subscription correlation, with cycle number on the renewal
operation. Its admission guard applies only to NEW cycle admission/insert;
existing-cycle retries in renewal operations and dunning bypass admission and
neither mint nor consume receipts. The native graph gains no `retry_scheduled`
state and the payments lifecycle is unchanged. Automatic alignment still requires an
actual arrival; missing correlation remains manual review. Native invoker
privileges and complete catalogue installation are described in
[Data and migrations](DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories).

## Compatibility posture

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
entry; the profile build refuses that entry. The list grants
no directory-wide admission: `commerce/server` and the Node-only pricing root
remain outside it. `pricing/browser` admits only its four-file runtime closure
for the existing primitive factory and acquisition capability/expectation schemas. A new reference import must have both browser-safe dependency
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

The M10/F17 `batchedForwards` registry adds exact approval data and inert
snapshots only. The batch has 16 pins: seven native and nine managed. Pending pins use
`20261024` identities after the landed M08/M09 rail tails; N1 keeps
`20261022160000`. Native order is N1 → N2 → N3 → seam → allocator → X → Y;
managed order is M1 → M2 → seam → M3 → M4 → M5 → M6 → F17 helper → F17 parity.
X (`20261024184500`) restores ATP-counted late-positive recovery after the
allocator; Y (`20261024184600`) filters paid retry candidates before LIMIT. N3 (`20261024180000`) excludes waiting/stock_secured cases before normal_due pagination while preserving the base reader's eligibility, shape and due-time/UUID order.
The uninstalled N2 (`20261024170000`) fixture includes raw command-preview
receipt replay with no public-table counts/columns/xmin delta. The apply
function is unchanged. Historical N1 approval still uses the exact old 14-pin
inventory at its first-parent introduction.
The three native body replacements retain their function
headers and ACLs and remain outside installation manifests. Its ordered paths, raw statement/definition hashes, signature
chains and exact grants/seeds do not install SQL, change a baseline, activate a
runtime or establish upgrade compatibility. The
[reviewed-forward boundary](DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards)
requires a separate feature introduction and mandatory real-PG/pgTAP catalog
evidence; existing admission classes keep their prior behavior.

The CI-only [image inventory](../../config/ci-images.json) owns logical names,
upstream repositories, tags, index digests and ordered public-registry sources
for the non-CLI mirror inputs. It records the install-proof database, disposable
test default and managed-batch database pins; Supabase CLI images remain derived
as repository/tag pairs by a read-only plan job from the workflow's CLI pin and
reference config. The pgTAP runner's exclusions constrain long-running services;
they never remove enabled GoTrue, Realtime or Storage API schema-init images.
The derived set contains those three images, Postgres and the binary's `pg_prove`.
An exclusion change leaving an uncovered runtime image refuses derivation.
The write job validates those untrusted pairs against a closed repository allowlist
before any exec or registry call, reads typed owned pins from its own checkout,
and builds upstream sources and mirror targets itself. It runs only pinned
first-party actions plus the repository script, re-resolves source digests, skips
identical targets, refuses moved tags and verifies every copy. CLI images are
trust-on-first-use. The shared reader prepends the single mirror
registry to inventory sources for consumers; mirror copying still uses only
upstreams. The reviewed-batch gate and shared disposable PostgreSQL helper use
these pins, preserving the exact digest on every fallback. Their source order
is mirror, then GHCR/Docker Hub/ECR for managed, or Docker Hub/ECR for native.
The default helper uses the test pin, resolves once per exact ref per process and
runs the successful digest-qualified source with `--pull=never`; explicit
non-inventory overrides keep their existing behavior. Before any shared pull,
exact local index digests (or exact CLI tags when unpinned) bypass network access;
inspection errors refuse. The gate, helper and pgTAP runner share one pull retry
implementation; long Retry-After hints advance by the remaining per-source
share, while shorter waits are capped to preserve non-GHCR fallback.
A Docker-free guard rejects literal digests or registry source lists in the gate test.
An explicit source tag must match the entry's tag and is preserved during
resolution. Mirror absence/private access immediately advances to upstream;
it does not require credentials or make CI depend on mirror publication.
The pgTAP runner uses the same CLI derivation as mirror planning and pre-pulls
all five derived tags with mirror/GHCR/ECR/Docker Hub fallback before start. Those CLI tags have
no pinned inventory digest; a derived digest, when present, is verified. Local
aliases reconcile mixed successful registries with the CLI's requested names.
Other launchers and the install-proof service remain unchanged. These changes
establish no public package visibility or runtime/application default.
[CI image mirror guidance](../../CONTRIBUTING.md#ci-image-mirror) owns retry
budgets, refusal boundaries, mirror execution and the owner's GHCR setup.

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
its after and whole-file hashes bind the proposed forward. This separate control
approval supplies no migration or runtime activation. The
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
through its shim; the RPC subclass stays reference-owned and is injected into
handlers. Validators, their defaults/strictness and operation/MCP/flag authority
remain at the reference boundary. Catalog contracts publish plain DTO types only.
Existing composition order, stock unknowns, allocation and preview selection are
preserved. No database gate, actor-history parity, mount or stronger replay claim
follows from this move; the bundle pending ledger owns those outcomes. The native
read store now has package ownership with unchanged queries and an injected data
executor. Sparse SQL 16/19 projections preserve canonical identity and bytes;
existing writer/transaction/transport ownership and native handler-only actor-kind
protection are unchanged. Sequential key recognition is characterized, without a
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

The opt-in direct OIDC settings registry declares issuer and separate customer
and operator API audiences. Selecting them adds no browser provider or default
login route. Invalid or overlapping audiences refuse composition; managed bundles
retain native federation sessions. The [identity contract](IDENTITY.md#opt-in-oidc-access-tokens)
owns the additive verifier API, deterministic principal mapping and refusals.

The disposable identity reference's run directory, run id and local mail origin
are evaluation settings bound to one owned installation. They establish no
persistent customer identifier, package API version or migration contract. The
selected browser import inventory is independent of the public default build;
server credentials do not become browser configuration.

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

The environment registry declares `IDENTITY_EMAIL_VERIFYING_PROVIDERS` as an
optional server-only value with an empty default. Managed identity hosts parse
its comma-separated provider identifiers as explicit assertions of mailbox
verification; malformed declarations refuse configuration. This setting changes
email-association admission, without changing stored identities or schema. See
[identity policy and migration](IDENTITY.md#responsibility-and-composition).

Operator invitations add a bounded TTL for direct hosts that call the parser and
one append-only direct migration manifest row. Such hosts refuse malformed TTL
values before writes; the managed reference runner neither calls the parser nor
enforces invitation expiry. Its lifecycle outcome data replaces the old message-only invite
response; active/pending-role/identity conflicts use explicit 409 identity reasons.
Managed revoked-row reinvitation refuses with `MANAGED_REINVITE_UNSUPPORTED`.
[Identity](IDENTITY.md#operator-invitation-lifecycle) owns the DTOs and acceptance
boundary; [data compatibility](DATA_AND_MIGRATIONS.md#compatibility-lifecycle) owns
the direct catalogue identity and the managed pending-lifecycle compatibility gap.

The runtime forward registry may pin exactly eight legacy browser-policy
retirements alongside its fixed function and privilege bindings. Retirement
checks exact names, tables, preceding statement hashes and ordered DROP
statements; it does not admit arbitrary RLS changes. Introduction follows the
[co-located SQL/pin rule](DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).
Control approval installs no database permission and cannot stand in for the
corrected forward's actual-role tests.

The publication catalogue now includes the ordered runtime capability forward
and its actual-role and renewal-lock witnesses. The derived source contract
binds that inventory and its classifications; it does not grant permissions or
change package APIs. Runtime authority comes from the separately admitted SQL.

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

Stable status, idempotency, and provider-extension commitments wait for the stable-framework requirements.
Before then, changes must still preserve the contracts above and state their
preview compatibility boundary explicitly.

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
The separate `managedCommerceForwards` list in
`config/reviewed-platform-forwards.json` pins nine M11 managed SQL fixtures: slots 1–8 each retain
one function exactly as pinned, and slot 9 is the starter pair;
[its data contract](DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards)
owns headers, ACLs, preimages and ordered statements. The registry and real
migration rails are authoritative. M11 versions follow every earlier same-rail
pin; each pin requires all earlier same-rail pins present with exact bytes.
Later feature changes may introduce those bytes on the managed rail.
Fixture proof does not establish handler behavior or authorize installation.
Existing control histories remain valid; later repins cannot authorize earlier SQL.
This is a separately reviewed preview admission class, not expand-only or a live
database compatibility proof; see
[Data and migrations](DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards).

While `@openlup/core` is below 1.0, every `@openlup/*` package is released in
one set version `0.N.P` from one commit, each package with its own tag
`openlup-<package>-v<version>` at that commit, and a source preview carries no
package. `release:bump --set` prepares every publishable package's version,
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
their recorded package versions. This is release identity, not a stable
compatibility promise.

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

The [repository check](../../scripts/public-ci-neutrality.mjs) counts text
regardless of filename extension and inventories binary files. It refuses
increases against both the comparison tree and the accepted baseline, including
an increased baseline allowance. Regeneration may lower existing allowances;
it cannot admit new debt except for the fixed diagnostic-fixture introduction
recorded in the checker. That introduction admits five exact SQL fixture files
in category `ui-15`, verified by their complete SHA-256 bytes, original counts
and accepted counts, against one full comparison commit. The explicit baseline
recalibration is required; the candidate still must fit that baseline. A later
comparison commit uses the ordinary ratchet, including refusal of regrowth after
a reduction. Scanner pins and every other path, category and increase remain
unchanged. These counts reuse the existing scanner semantics and do not expand
a runtime contract or establish a stable preview channel.

The opt-in communications adapters have a `ui-12` vocabulary allowance only
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
Only the ledger additionally allows bare adapter names. Neutral communications
sources and contracts, other root content and other documentation remain
checked; baseline counts and matcher pins are unchanged.

Published Tree CI enforces that ratchet in required `self-check` and exercises
its CLI refusal tests in required root `test`. Managed pgTAP remains a raw
diagnostic; follow [testing](../../CONTRIBUTING.md#test-scope-and-diagnostics)
for execution and proof limits. These checks do not grant application privileges
or declare complete compatibility evidence. Existing release context checks remain unchanged.

The outbox rail is a local experimental package candidate in the package catalogue. Its exact core peer, export snapshots and shipped baseline hash are separate from publication eligibility. Admission compares the complete observed set and selected adapter facts; unknown inventory or probe state cannot activate a candidate.

### Native communications evidence

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

The development-preview communications entries expose the same 17 type-only
marketing-sync declarations in
[`marketingSync.ts`](../../packages/platform/src/communications/contracts/marketingSync.ts).
The four families have five operations: `profile.sync`, `consent.read`,
`erasure.request`, `erasure.read` and additive `consent.push`. Capabilities bind an account, environment,
namespace, mapping version and audience. Unsupported scope refuses honestly;
verification remains pending until the applicable account evidence is admitted.
This contract supplies no provider implementation or activation.

The private construction mapper resolves opaque subjects and owned targets.
Brands supplement schema, binding, audience, subject, case and journal checks;
a cast or deserialized receipt grants no authority. Admission saves validated,
immutable effect evidence before dispatch and rechecks generation and tombstones
after awaits. Profile sync changes owned scalar data only. Current-state consent
readback has bounded coverage and source-bound negative facts; account-wide
facts retain that scope and audience denials cannot become global. Remote
subscribed state never grants local consent. The `NegativeFeedback` discriminant
union is readonly, matching its other fields.

Replay identity is `(binding, operation, subjectReference, requestId)` with all
four binding coordinates. Generation is a separate stale fence. A current
new-generation call with the same effect replays without dispatch; its wrapper
echoes the call and its receipt retains the original request. Changed effect
fields under that key refuse `invalid_request`. Unresolved admission or partial
persistence fences new keys too. Cooling is durable and a failed cooldown write
quarantines dispatch; public retry delays are finite positive seconds.

Each operation has a closed result union. Mutation accepted means admitted
intent; acknowledged means provider acceptance. Neither means erasure completed.
Only fresh, authorized `erasure.read` with authenticated provider-read evidence
can complete the original bounded deletion. Ordinary 404, empty search, elapsed
time and receipt replay cannot. Completion never removes the subject tombstone.
Existing marketing ports and their observations and the existing
`NewsletterSyncProviderPort` remain unchanged. A refusal-only newsletter bridge
is planned in the later adapter PR. The [A1 ledger](plans/oss-a1-communications-adapters.md)
records the offline synthetic proof and remaining delivery gates.

### Consent push admission and reconciliation

`ConsentPushRequest`, `ConsentPushResult` and `ConsentPushPort` reuse the frozen
binding, subject, failure and capability types without widening the original
provider. A grant is one local subject, purpose and configured audience with its
local consent evidence reference. Withdrawal carries local withdrawal evidence;
only explicit withdrawal of every purpose authorizes account-wide scope. Missing
or blank evidence refuses `invalid_request`; foreign/provider-only/substituted
evidence refuses `provenance`; revoked, superseded or wrong-direction local
authority refuses `restricted`. Generation is checked before replay and after
awaits. No remote state, membership or successful write grants local permission.

The existing capability declaration is intersected with `consent.push` and its
`grantEffect: "audience" | "account-wide"`. Both directions require support and
owner TEST evidence; missing evidence remains `verification_pending`. No-trigger
admission covers every declared effect, including other-audience profile-consent
flows, segments and backfills for account-wide grant effects. Unaccounted armed
flows, unsafe DOI mail, suppression-clearing subscribe or unknown suppression
coverage refuse grants. Historical import is never an admission bypass.

Klaviyo email's planned mapping declares account-wide grant effects, while local
grants stay audience-scoped. Audience withdrawal must have trustworthy list-only
effect proof, including changes before an asynchronous job acts; a pre-job
membership snapshot alone is insufficient. Explicit all-purpose withdrawal uses
global email unsubscribe. Mailchimp and Brevo declare audience grant effects;
unsupported account-wide withdrawals refuse. Brevo list removal projects membership
only, without claiming global consent. These are partial design mappings, not
provider certification. No flow management, suppression editing or vendor factory
is introduced by this contract.

Withdrawals dispatch immediately even when remote consent is unknown or an
earlier grant is unsettled, subject to local authority, identity, safe scope and
ordinary admission minus exactly the fence caused by this subject's unresolved
grants (ambiguous acceptance, failed recording, unresolved dispatch or partial
persistence). Another subject's grant-caused uncertainty never holds a withdrawal.
Availability quarantine held exclusively by grant causes is exempt across subjects;
any non-grant cause keeps it closed. Durable non-grant ledger quarantine, storage
faults, the single in-flight slot, pacing and the withdrawal's same-key replay
fence still apply. Account-level provider cooling returns `retryable/cooling`
with finite positive `afterSeconds` for the host to retry. Non-grant quarantine
requires explicit host repair. A pending
or unconfirmed withdrawal blocks grants for that subject/audience; account-wide
withdrawal covers every audience. Unresolved dispatch still fences duplicate sends.

Accepted means durable intent; acknowledged includes documented asynchronous
acceptance. Neither completes or proves subscribed/unsubscribed state. Both success
variants require boolean `reconcileRequired`. A dispatched withdrawal whose own
recording fails reports accepted/acknowledged with `journal: "unknown"`, never
confirmed persistence. If an earlier grant is unsettled or
its settlement cannot be established, withdrawal returns `true`; replay retains
that unresolved race and remote state counts as UNKNOWN regardless of journal
confirmation or an early unsubscribed read. Only `consent.read` after all earlier
grant jobs settle can resolve it. Pending, unknown or insufficient readback leaves
it unresolved. If that fresh read says subscribed, the HOST reissues withdrawal
through existing reconciliation with a new request ID. The adapter adds no job API,
executor, callback or automatic retry. Even `reconcileRequired:false` proves no
remote effect. Receipt evidence stays the original admitted request while the
result echoes the current call; replay identity excludes generation and rejects
changed audience, action or evidence with `invalid_request`.

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

Development-preview hosts may select five independent seams; omission preserves
incumbent behavior. No route, policy, provider or new financial default is selected
by importing them. These additive APIs need a minor package set.

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
before upgrading; the [Unreleased migration note](../../packages/platform/CHANGELOG.md#unreleased)
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
disposition. A late positive settles the same obligation, never a new charge.
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
Multi-cycle prepaid and M07 prepared-store parity retain named unsupported
capabilities; N1 retry recovery is selected while stock recovery remains
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

Invoicing keeps issued proof, exact scoped absence, unknown and unsupported
separate. Unknown never authorizes another create; correction recovery binds
stable correction identity and parent. Local void cannot erase an issued
invoice. An owed-duty readback retains unsupported duties and capture faults;
`accountingRequested=false` does not prove absence. Distinct payout items stay
distinct, and account projections preserve owner and document lineage. Host
artifact persistence, clearance observation and M04 acceptance are separate proofs.
See the [invoicing contract reference](PLATFORM_PACKAGE_REFERENCE.md#invoicing-contracts).

See the [M09 forward owner](DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for the registered managed-correction limit and follow-up.

The invoicing refusal factory cannot clear a previously unknown effect: its
unsupported result describes this call only. Offline conformance checks stable
identity, recovery without a second write and parent mismatch before another
write. Adapter-owned fixtures establish this contract boundary; live fiscal
readiness and inbox delivery require their own evidence. Native P4a fencing is
covered by the real-Postgres conformance witness, with no provider access. The
store refuses absent host facts before writes; the duty stays owed. Native
child-document corrections and managed base-row corrections have separate
migration descriptors. An unknown claim always recovers by exact readback;
only authoritative scoped absence can authorize a fresh create.
