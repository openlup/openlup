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

The experimental Node `payments/stripe` subpath exposes only its factory,
configuration type and observed capability descriptor. The host owns SDK and
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
See the [communications import](../../packages/platform/README.md#communications-import)
and the [marketing adapter](#opt-in-singleton-marketing-adapter).

A payments (M07) adapter implements `PaymentAdapter` and declares
`PaymentAdapterCapabilities` from `./payments/contracts`. Prove it with
`runPaymentAdapterConformance` from `@openlup/platform/payments`, using
`PaymentAdapterConformanceSubject` from `./payments/contracts` and verification
fixtures. See the [opt-in payment example](#opt-in-payment-example).

Fulfillment neutral ports are planned (M08); there is no API to implement yet. A
fulfillment example adapter is planned for round A3. An adapter for another 3PL,
marketplace fulfillment service or parcel network would then follow that example.

| Class | Shipped example subpaths |
| --- | --- |
| Communications | `@openlup/platform/communications/resend`, `@openlup/platform/communications/klaviyo` |
| Payments | `@openlup/platform/payments/stripe`, `@openlup/platform/payments/tpay` |

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

Two known gaps still pause on exhaustion and must not gain new callers: the
managed SQL `subscription_handle_payment_failure_dunning` (owned by a managed
follow-up forward) and the engine's `pauseSubscriptionForExpiredDunning`, gated
by `isDunningLadderExhausted` (owned by the M10 engine follow-up).

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

## Compatibility posture

The reviewed-forward registry additionally pins one portable function replacement
to keep active subscriptions active on dunning exhaustion (invariant repair).
The signature is fixed in code; its before hash binds the portable chain, while
its after and whole-file hashes bind the proposed forward. This separate control
approval supplies no migration or runtime activation. The
[exact reviewed function rules](DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards)
require unchanged headers, a single function statement and approval before SQL
introduction; managed admission counts remain unchanged.

The portable dunning invariant repair appends exactly one manifest row at
position 71 and refreshes `objectInventorySha256` from the complete live
PostgreSQL catalogue. Earlier file/hash rows remain an exact prefix. Install
the full selected catalogue to keep active subscriptions active on dunning
exhaustion (invariant repair); the forward does not rewrite existing paused
subscriptions or expired cases. The managed chain still needs its own forward.

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
are additive; their schemas, required host financial policy, selector and
readiness live only in the server entry. The reference supplies no acquisition
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
statements; it does not admit arbitrary RLS changes. The approval must exist
unchanged at the feature comparison base and the forward introduction parent.
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
It does not authorize arbitrary runtime grants. Approval must precede the SQL
feature's comparison base and introducing commit; registry installation alone
does not change database permissions.

Stable status, idempotency, and provider-extension commitments wait for the stable-framework requirements.
Before then, changes must still preserve the contracts above and state their
preview compatibility boundary explicitly.

The [reviewed function-forward approval data](../../config/reviewed-platform-forwards.json)
binds exact managed SQL files and old/new function definitions. Its replacement
list contains exactly three existing signatures in two files; a distinct creation
list requires the two price-setup signatures to be absent before their forward.
The optional runtime list pins the capability and identity forwards described above.
Required self-check keeps the whole registry unchanged from the feature comparison
base. Release compares each forward's own entry, list position and shared registry
fields with its introduction parent, allowing later controls to append approvals.
A feature cannot approve itself. Both gates share the same admission checker.
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
