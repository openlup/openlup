# Subscription engine

Use `@openlup/core/subscription` to calculate subscription cycles, lifecycle
changes and payment timing from explicit inputs. Your application supplies the
clock and carries out the resulting durable work; [Subscriptions](subscriptions.md)
explains that boundary.

## What this package owns

The subscription entry owns cycle planning, edit windows, lifecycle changes,
payment recording and retry decisions. See the [API report](https://github.com/openlup/openlup/blob/openlup-core-v0.41.0/packages/core/api/subscription.api.md)
for the runtime functions and model contracts.

Mutation functions return `SubscriptionEngineResult<T>`: either `ok: true` with
`value`, or `ok: false` with `error.code` and `error.message`. Handle the refusal
value before using the result. The error codes are `invalid_timestamp`,
`invalid_template`, `inactive_subscription`, `edit_window_closed`,
`line_not_found`, `duplicate_line`, `invalid_slide_target`, `invalid_transition`,
`terminal_cycle`, `missing_payment_method` and `dunning_not_exhausted`.

Successful mutations return event descriptions alongside the changed model.
Payment and cycle events derive their `idempotencyKey` from the cycle's
`engineIdempotencyKey`; lifecycle and template events use subscription identity,
timestamps or template versions. The engine neither publishes events nor stores
keys. Your host must enforce uniqueness when persisting them to make event
writes safe to replay.

## No I/O and no ambient clock

The engine has no database, HTTP client, filesystem, scheduler or payment
adapter. It reads no ambient clock: functions receive timestamps such as `now`,
`recordedAt`, `failedAt` and `firstCycleAt`. Identical inputs produce identical
outputs, so you can exercise it without network access or a fake clock.

Pass ISO timestamp strings. `DEFAULT_TIMEZONE` is `UTC`; supply your
application's timezone explicitly when creating a subscription if it differs.
Cadence arithmetic adds elapsed days; the timezone field does not turn it
into local-calendar arithmetic.

## The deterministic clock on recordPaymentSuccess

`recordPaymentSuccess` requires both `paidAt`, the settlement instant reported
by the payment service, and `recordedAt`, the instant your application observed
it. Neither has a clock fallback. An unreadable instant returns
`invalid_timestamp`; a cycle already `paid`, `skipped` or `cancelled` returns
`terminal_cycle`.

Lateness uses the earlier instant. A future settlement timestamp
cannot inflate the shift, and observing an older settlement later does not
replace its payment time with the observation time. The recorded cycle keeps
`paidAt`; the subscription's `updatedAt` uses `recordedAt`.

## A late payment shifts the cycle; it never compresses it

A successful payment calculates the next cycle from the paid cycle's own
`scheduledAt` and snapshot cadence, then adds the whole days it was late.
In this formula, `nonnegativeWholeDays` rounds elapsed days down and excludes
negative lateness:

```text
shiftedByDays = nonnegativeWholeDays(min(paidAt, recordedAt) - scheduledAt)
onTimeNextCycleAt = scheduledAt + cycle.templateSnapshot.cadence_days days
nextCycleAt = max(subscription.nextCycleAt, onTimeNextCycleAt + shiftedByDays days)
```

The outer maximum preserves any later date already stored, including a date
extended by delivery alignment. An old settlement or replay against an older
cycle must not bring the next charge forward. Early payment adds no late days;
partial late days are rounded down. A shift or cadence calculation beyond the
representable timestamp range returns `invalid_timestamp`.

The `subscription.next_cycle_at_updated` event reports `nextCycleAt`,
`basedOnScheduledAt`, `basedOnPaidAt` and `shiftedByDays`. This is a payment-clock
decision; it does not establish that a parcel arrived.

## The retry ladder terminates

`recordPaymentFailure` increments `retryAttempt` on the same cycle and asks
`nextRetryAttemptAt` for its next slot. A timestamp produces `retry_scheduled`;
`null` produces `payment_failed` with no next retry. It preserves the cycle's
identity and does not change the subscription's schedule.

`DEFAULT_CYCLE_RETRY_CADENCE` is frozen. Its `backoffHours` are measured from
each successive failure; read the offsets from the installed cadence rather
than copying them. Its array length is the retry budget;
a failure past the last slot returns `null`, never the last slot again.
`shouldScheduleRetry` accepts only `payment_failed` cycles within that budget.
Use these helpers rather than adding a second attempt-limit check.

The default `terminatingFailureClasses` contains `hard_do_not_retry`. Other
shipped classes keep the ladder. A custom `CycleRetryCadence` may supply its
own offsets and terminating list. `ladderTerminatedByClass` stops a listed class
only if the payment taxonomy recognises it and `failureClassDecision` disallows
retry. Missing, unlisted, unknown or still-retryable classes do not terminate
the ladder, even if a custom list is mistaken.

No next retry means no automatic charge is scheduled. Early class termination
is not exhaustion.
`isDunningLadderExhausted` requires `payment_failed`, `nextRetryAt: null` and
`retryAttempt` greater than `maxRetryAttempts`. Pass the same cadence to payment
failure and dunning operations. Configuring core alone does not configure a
host's durable retry or recovery guards.

`hard_do_not_retry` identifies refusal of the instrument, so another retry rung
cannot make that instrument eligible.

## The status matrix and dunning continuity

`SUBSCRIPTION_STATUS_TRANSITIONS` is frozen; `canTransitionSubscriptionStatus`
reads that matrix:

| From | To |
| --- | --- |
| `active` | `paused`, `cancelled`, `completed` |
| `paused` | `active`, `cancelled` |
| `cancelled` | `active` |
| `completed` | none |

An operation may take only its own edge. `pauseSubscription` is an explicit
owner pause from `active`; `resumeSubscription` accepts only `paused`.
`cancelSubscription` accepts `active` or `paused`, and `completeSubscription`
accepts only `active`. Other source states return `invalid_transition`.

Only `reactivateSubscription` returns a cancelled subscription to active service.
This win-back requires a stored payment method or returns
`missing_payment_method`.

Payment failure leaves active service active. Despite its compatibility name,
`pauseSubscriptionForExpiredDunning` returns an exhausted subscription unchanged
with no events. It returns `dunning_not_exhausted` below exhaustion and
`invalid_transition` for a cycle belonging to another subscription. Authorized
recovery may still pay the same unpaid cycle after automatic retries end.

For a subscription paused by a historical non-payment rule, use
`resumeSubscriptionFromExpiredDunning` with its latest exhausted cycle, rather
than plain resume. It requires `paused` state, matching cycle ownership and a
stored or supplied payment method. It skips that cycle instead of charging it
late. The host must check unattended chargeability and handle any other
uncollected cycles; plain resume does neither this cleanup nor schedule repair.

Win-back and historical dunning recovery set the next date to the later of the
stored date and `now + RESTART_LEAD_DAYS`; use the installed lead constant.
An overflowing restart returns `invalid_timestamp`. Durable restarts have
additional requirements and may use different timing; see
[Lifecycle in durable storage](subscriptions.md#lifecycle-in-durable-storage).

## Consuming it from a host application

Import the public entry. If you need a stable application-local import path,
keep the forwarding module free of lifecycle logic:

```ts
export {
  recordPaymentSuccess,
  recordPaymentFailure,
} from "@openlup/core/subscription";
```

A wrapper may narrow a type or require an otherwise defaulted parameter, such
as timezone; document that constraint. Keep application policy and port
composition outside a forwarding module, and preserve the engine's contracts.
Do not edit an installed package or recreate its lifecycle engine locally.

The host owns persistence, event publication through its outbox, settlement
execution, mandate storage, scheduling, notification copy and the clock passed
into the engine. Returning an updated model alone performs none of that work.
