# Subscription Server Domain

Status: source-of-truth

`server/domains/subscription` owns subscription lifecycle use cases that are
independent from HTTP routing: checkout activation bridges, recurring cycle
charging, dunning/pause/resume decisions, and subscription outbox handlers.

## Engine Location

⚠️ This directory orchestrates the engine; it does not contain it. The pure
lifecycle kernel lives in `packages/core/src/subscription/` behind the
`@openlup/core/subscription` package export, and the `subscriptionEngine*.ts` /
`cycleHardening.ts` files in `src/domains/subscription` are re-export shims over
it. Server code that reaches an engine function through those shims is reaching
core. A change to cycle planning, a lifecycle transition, the payment-recording
semantics, or the retry ladder is a `packages/core` change; this directory owns
only what surrounds it — persistence, leases, ports, and the decision to call.
The public behavioral, status, and idempotency boundary is in `docs/platform/CANONICAL_CONTRACTS.md`; the engine's own
contract is in `packages/core/docs/SUBSCRIPTION_ENGINE.md`.

## Owns

- Subscription runtime orchestration and state transition policy.
- The transport-independent serial renewal batch service and its injected
  clock/due/payment execution boundaries.
- Renewal, pause, resume, reminder, and dunning domain decisions.
- Ports used by subscription cron jobs and payment-control bridges.
- The recovery-token evidence and record/recovery-case port used by the
  customer payment-recovery handlers; its explicit public seam is
  `paymentRecoveryPorts.ts`, while its Supabase adapter remains subscription-owned.
- Subscription-specific outbox handlers and replay-safe event contracts.
- Claim-token fencing and durable delivery-ledger repair for dunning dispatch.

## Does Not Own

- PSP execution and webhook normalization: `server/domains/payment` plus
  `server/adapters/*` / `server/infra/*`.
- PSP readback/reconciliation claiming: `server/domains/payment`. It may open
  subscription dunning only after payment-control has applied a failed renewal
  result and the cycle retry state has been read back from the database.
- Route/auth composition: `server/bff/customers/subscriptions` and cron
  entrypoints under `api/cron`.
- Browser account UI contracts: `src/domains/subscription` and
  `src/domains/customers`.

## Sharp Edges

- Mutation paths stay behind `COMMERCE_SUBSCRIPTION_MUTATIONS_ENABLED`.
- Renewal jobs stay behind `COMMERCE_SUBSCRIPTION_RENEWAL_RUNTIME_ENABLED`.
- Payment-result legacy paths should fail fast in favor of payment-control.
- `subscriptions.payment_method_ref` is only a compatibility mirror. Renewal
  charge eligibility comes from canonical `commerce_payment_method_refs`; legacy
  client-scoped method refs may be promoted only by the service-role
  `commerce_payment_method_ref_repair_subscription_scope` repair RPC when the
  existing method ref is same-client, active, unexpired, and unambiguous.
- Renewal PSP execution must have a prepared local provider attempt before
  Stripe/Tpay are called; replayed prepared attempts without provider refs are
  operator evidence and must not trigger a second automatic charge. The
  payment-provider reconciliation watchdog records stale prepared rows as
  `prepared_without_provider_ack` without provider readback, dunning, or
  fulfillment. A thrown PSP timeout/network error stays on this indeterminate
  path; it is not converted to `failed` or customer dunning. A prepared/no-ack
  Stripe cycle can be re-driven only after genuine provider-side absence proof
  through
  `commerce_payment_control_reopen_prepared_attempt_after_absence`, which uses
  `provider_attempt_sequence` rather than customer `retry_attempt` and refuses
  local attempts still inside the 30-minute min-stranded-age window. The
  reconciliation worker may automate that Stripe proof behind its explicit
  gate. Tpay has no intent-correlated lookup and remains operator-manual.
- Subscription cron work needs idempotency and read-back proof before promotion.
- The default renewal composition in this source tree omits the optional due
  `p_as_of` argument and retains database-default current time. Only the
  loopback reference composition forwards its server-owned fixed instant. This
  describes source composition, not hosted deployment state.
- Current dunning claims carry a fresh token. Mark operations must present that
  token; stale takeovers and transitional legacy overloads cannot mutate the
  current lease. Captured delivery adapters may write sanitized acceptance to
  the existing `email_sends` ledger but must not receive recovery credentials.
- `customer_self_service_apply_subscription_action` has a subscription-first
  wrapper for `pause` and `cancel`. Both refuse when any subscription-cycle
  attempt is `created`, `sent_to_provider`, `requires_action` or `processing`.
  `pause` then delegates to the canonical action body. A safe `cancel` first
  changes an open dunning case to `cancelled`, revokes unused recovery tokens,
  skips queued notices and terminalizes never-paid retry artifacts; it preserves
  succeeded/refunded/partially-refunded/disputed intent or succeeded-attempt
  evidence. The whole mutation rolls back if canonical cancellation fails.
- After that wrapper, the delegated self-service body retains the ordered guard
  stack: idempotency replay; open-dunning block (shipping-address change exempt,
  while safe cancel has already closed the case); missing-method block for the
  explicit payment-dependent action list; charge-timing confirmation for
  `order_now`/`reactivate`; then action dispatch and quote acceptance/drift lock.
  Read the latest `CREATE OR REPLACE` chain before changing any exemption.
- Expired-dunning resume runs ahead of that whole stack. A `resume` on a paused
  subscription whose latest case is `expired` is routed into
  `subscription_resume_after_expired_dunning`, which supplies the fresh pricing,
  ATP, template and order snapshots atomically. It refuses an unchargeable stored
  method and refuses without the charge-timing confirmation, so callers must
  obtain that confirmation before applying the action, not after.

## Delivery Alignment And Replacements

The durable delivery-alignment rail protects an active subscription while the
customer is still waiting for the preceding parcel. Alignment after delivery
moves the next cycle to the delivered instant plus the subscription's stored
cadence, guarded by `GREATEST`; the schedule may extend but must never move
earlier or stack deliveries.

A replacement created through `replaces_fulfillment_order_id` supersedes the
lost or undelivered predecessor, so that predecessor stops being an outstanding
obligation without acquiring a fabricated `delivered_at`. The replacement is
the current obligation and remains one until it reaches the customer. Only then
may its arrival settle the inherited case as `aligned` and shift the cycle.

`subscription_delivery_alignment_confirm_replacement` records the same
delivered fact when an operator has confirmation that the substitute shipment
reached the customer. Never call it for an in-flight or undelivered replacement:
it settles `aligned`, which means "Parcel delivered". Replaying a confirmation
of an already aligned case returns the stored schedule instead of buying a
second cadence. The ordinary case-resolution path refuses while an active
subscription still has an unsuperseded undelivered parcel, leaving protection
and the schedule intact.

## Before Changing

Read `docs/platform/CANONICAL_CONTRACTS.md` first, then the engine contract in
`packages/core/docs/SUBSCRIPTION_ENGINE.md`. For composition boundaries, read
`docs/platform/RUNTIME_AND_SELF_HOSTING.md` and the subscription boundary in
`docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`. Historical implementation plans
are audit trail, not current behavior. A private deployment may keep its own
`SUBSCRIPTION_ORIENTATION.md` mapping, but that file is not a public prerequisite
and cannot override the public contracts above.
