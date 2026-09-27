# Subscription workflows

Status: development-preview source navigation.
Audience and purpose: contributors following subscription behavior from its
owner to an internal decision, durable boundary and falsifier.

These paths explain source structure. They do not establish mounting, profile
availability, a passing test or a hosted installation. Use the
[subscription reference](SUBSCRIPTION_REFERENCE.md) for the bounded disposable
profile and [canonical contracts](CANONICAL_CONTRACTS.md) for public invariants.

## Choose the right layer

| Question | Start here |
| --- | --- |
| Where does pure lifecycle behavior change? | [Core engine contract](../../packages/core/docs/SUBSCRIPTION_ENGINE.md) and [core subscription exports](../../packages/core/src/subscription/index.ts) |
| Which contracts can browser or other domains share? | [Shared subscription owner](../../src/domains/subscription/README.md) |
| Which ports, leases and durable decisions surround the engine? | [Server subscription owner](../../server/domains/subscription/README.md) |
| Who turns delivery evidence into a schedule decision? | [Delivery-alignment contract](CANONICAL_CONTRACTS.md) and [protection path](#protect-delivery) |
| What does a selected host actually compose? | Its route registry, capability contract and adapters; [runtime boundaries](RUNTIME_AND_SELF_HOSTING.md) |

The `subscriptionEngine*.ts` and `cycleHardening.ts` files under
`src/domains/subscription` forward to `@openlup/core/subscription`. A local import
through those shims still reaches core. Server services orchestrate persistence
and providers through ports. Some existing server handlers retain HTTP types;
inspect the specific unit before claiming transport independence.

## Lifecycle and retry

| Decision | Implementation | Tests to inspect |
| --- | --- | --- |
| Cycle and edit-window calculation | [subscriptionEngineCore.ts](../../packages/core/src/subscription/subscriptionEngineCore.ts) | [subscriptionEngine.test.ts](../../packages/core/test/subscriptionEngine.test.ts) |
| Lifecycle transition, pause or resume | [subscriptionEngineLifecycle.ts](../../packages/core/src/subscription/subscriptionEngineLifecycle.ts) | [subscriptionStatusTransitions.test.ts](../../packages/core/test/subscriptionStatusTransitions.test.ts), [subscriptionDunningPause.test.ts](../../packages/core/test/subscriptionDunningPause.test.ts) |
| Record payment without compressing the paid cycle | [subscriptionEnginePayment.ts](../../packages/core/src/subscription/subscriptionEnginePayment.ts) | [subscriptionPayment.test.ts](../../packages/core/test/subscriptionPayment.test.ts) |
| Retry time and terminating failure class | [cycleHardening.ts](../../packages/core/src/subscription/cycleHardening.ts) | [shared retry tests](../../src/domains/subscription/cycleHardening.test.ts) |

The [engine contract](../../packages/core/docs/SUBSCRIPTION_ENGINE.md) explains
the explicit clock, late-payment shift, monotonic schedule clamp and retry
termination. These functions do not perform I/O or determine whether a physical
parcel arrived. [Purity tests](../../packages/core/test/subscriptionPurity.test.ts)
challenge the package boundary; delivery protection belongs to the durable rail.

## Renew one cycle

The [local operator tick composition](../../server/bff/subscriptions/renewal-ticks.ts)
shows an injected clock, runtime ports and an outer platform-job lease. It calls
`runSubscriptionRenewalBatch` in
[subscriptionRenewalInvocation.ts](../../server/domains/subscription/subscriptionRenewalInvocation.ts).
The composition source has its own profile gate; this path is not a claim that
the disposable subscription profile exposes it.

| Step | Source | Refusal or invariant |
| --- | --- | --- |
| List due rows and process a serial, budgeted batch | [subscriptionRenewalInvocation.ts](../../server/domains/subscription/subscriptionRenewalInvocation.ts) | Due-list failure is explicit; deferred rows remain for a later invocation. |
| Obtain delivery admission before cycle/payment work | [callSubscriptionDeliveryAlignmentAdmission.ts](../../server/domains/subscription/callSubscriptionDeliveryAlignmentAdmission.ts) | Protected or malformed admission stops the row. |
| Validate stored method and declared rail capability | [paymentMethodLifecycle.ts](../../src/domains/subscription/paymentMethodLifecycle.ts) and [batch preflight](../../server/domains/subscription/subscriptionRenewalInvocation.ts) | A missing, revoked, mismatched or unsupported method cannot be guessed into charge eligibility. |
| Create/replay cycle artifacts, reserve and prepare the durable attempt | [chargeSubscriptionCycleOffSession.ts](../../server/domains/subscription/chargeSubscriptionCycleOffSession.ts) | Admission and reservation precede execution; attempt preparation must succeed before the provider is called. |
| Execute or preserve indeterminate provider state | [chargeSubscriptionCycleOffSession.ts](../../server/domains/subscription/chargeSubscriptionCycleOffSession.ts) | A thrown execution or prepared replay without acknowledgement must not trigger another automatic charge or be fabricated into a decline. |
| Propagate a recorded failure | [propagateSubscriptionCycleChargeFailure.ts](../../server/domains/subscription/propagateSubscriptionCycleChargeFailure.ts) | Dunning follows a failed payment result; provider uncertainty is a different state. |

Inspect [batch tests](../../server/domains/subscription/runSubscriptionRenewalBatch.test.ts),
[charge tests](../../server/domains/subscription/chargeSubscriptionCycleOffSession.test.ts)
and [failure-propagation tests](../../server/domains/subscription/propagateSubscriptionCycleChargeFailure.test.ts).
Useful falsifiers include malformed admission, replay without provider
acknowledgement, a reservation block and a timeout after dispatch. See
[evidence and limits](#evidence-and-limits) before choosing a runnable test scope.

## Recover payment

[paymentRecoveryHandler.ts](../../server/domains/subscription/paymentRecoveryHandler.ts)
is an HTTP handler. It validates the request and authenticates the customer
before consulting the recovery token. Its
[paymentRecoveryPorts.ts](../../server/domains/subscription/paymentRecoveryPorts.ts)
seam separates token evidence from the record/recovery operation.

Follow the ordering: enabled/method/body checks → authenticated session → SHA-256
token lookup → expiry/revocation and owner check → record RPC → validated
response. An owner-bound used token can reach the RPC's idempotent replay; a token
held by another authenticated customer cannot. Raw tokens and provider method
references do not belong in the successful response.

[Recovery handler tests](../../server/domains/subscription/paymentRecoveryHandler.test.ts)
challenge authentication-before-lookup, expired and wrong-owner tokens, replay
and the hash boundary. The
[BFF composition](../../server/bff/customers/payment-recovery/redeem.ts) supplies
auth and the selected adapter; its existence alone does not expose recovery in
every profile.

## Protect delivery

The pure payment clock and physical delivery alignment are separate boundaries.
A late delivery may move the next cycle later; it must never move it earlier or
stack a new parcel while an unsuperseded one remains outstanding.

1. [Admission parser and caller](../../server/domains/subscription/callSubscriptionDeliveryAlignmentAdmission.ts)
   require an explicit usable decision before renewal artifacts.
2. [Delivery-alignment gateway](../../server/adapters/subscriptionDeliveryAlignmentGateway.ts)
   calls `subscription_delivery_alignment_admit_renewal` with subscription,
   scheduled instant and server-owned observation time.
3. The [managed schema baseline](../../supabase/migrations/00000000000000_platform_schema_baseline.sql)
   contains the durable admission, resolution and replacement-confirmation RPCs.
   Read the ordered migration contract in [Data and migrations](DATA_AND_MIGRATIONS.md)
   before changing that authority.

A parcel superseded through `replaces_fulfillment_order_id` stops being the
outstanding obligation without acquiring an invented `delivered_at`. Its
replacement remains outstanding until arrival. Call
`subscription_delivery_alignment_confirm_replacement` only when the substitute
reached the customer: `aligned` records that fact. Replaying an aligned case
returns the stored schedule rather than adding another cadence. Ordinary case
resolution refuses while an active subscription still has an unsuperseded,
undelivered parcel.

Inspect [admission tests](../../server/domains/subscription/callSubscriptionDeliveryAlignmentAdmission.test.ts)
and [gateway tests](../../server/adapters/subscriptionDeliveryAlignmentGateway.test.ts)
for delegation and fail-closed parsing. Those unit tests do not prove the RPC's
database behavior; the canonical contract and installed-schema evidence remain
separate.

## Available domain services

Two additional services are useful entrypoints for reading the domain:

| Service | Meaning and falsifier |
| --- | --- |
| [checkoutActivationBridge.ts](../../server/domains/subscription/checkoutActivationBridge.ts) | Distinguishes one-time payment from initial subscription activation, refuses missing reusable-method evidence and derives a stable activation key. [Bridge tests](../../server/domains/subscription/checkoutActivationBridge.test.ts) inspect those branches. |
| [runAutomaticSubscriptionRenewal.ts](../../server/domains/subscription/runAutomaticSubscriptionRenewal.ts) with [automaticRenewalPorts.ts](../../server/domains/subscription/automaticRenewalPorts.ts) | Orchestrates snapshot/claim, mandate, delivery admission, reservation, preparation and provider readback through injected ports. [Service tests](../../server/domains/subscription/runAutomaticSubscriptionRenewal.test.ts) challenge replay and refusal boundaries. |

These are available source services, not evidence of mounting or profile
activation. Trace an actual caller and capability declaration before describing
them as a running flow. An adopter's composition must preserve their durable
attempt and idempotency boundaries.

## Evidence and limits

The links above identify implementation and tests to inspect. They do not record
results. From the repository root, these are distinct execution scopes:

| Command or source | Scope |
| --- | --- |
| `npm test` | The selected public suite includes the shared `src/domains/subscription` directory; it does not select local `server/domains/subscription` test files. |
| `npm --workspace ./packages/core run ci` | The separate core package suite and package gates, including its own coverage and consumer checks. |
| [Published Tree CI](../../.github/workflows/published-tree-ci.yml) | Invokes those scopes and separately tests public-reference runtime composition and the named renewal modal. |
| Server-domain and gateway tests linked here | Source falsifiers requiring an explicit compatible run; their presence is not an executed public CI result. |

See [contribution checks](../../CONTRIBUTING.md#development-preview-checks) and
the [root test command](../../package.json) before choosing a narrower command.
Some source tests depend on material absent from a selected preview. Record the
actual command, revision, outcome and skipped prerequisites; do not widen a
claim from a mocked service test to a database, provider or browser journey.
