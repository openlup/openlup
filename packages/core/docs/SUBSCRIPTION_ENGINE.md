# Subscription engine

Owns: the pure subscription lifecycle kernel exported as `@openlup/core/subscription`.
Watches: `src/subscription/**`
Verified against: repository state `c03cd8e1a` (2026-09-07) — every exported
name below was read out of the eight source files in `src/subscription/`, the
payment semantics out of `src/subscription/subscriptionEnginePayment.ts`, and
the shipped retry class plus fail-open boundary out of `cycleHardening.ts` and
its exact unit/parity tests.

All `src/subscription/` paths and unprefixed commands in this document are
relative to this package root.

`src/subscription/` is the engine. Nothing else in the platform decides when a
subscription's next cycle falls, whether an edit window is still open, or what a
recorded payment does to the schedule. A host application that re-exports these
functions is a caller, not a second engine — see **Consuming it from a host
application** at the end.

## What this package owns

Eight files under `src/subscription/`, one barrel (`index.ts`), four groups of
exports.

| Group | File | Exports |
| --- | --- | --- |
| Cycle planning | `subscriptionEngineCore.ts` | `createInitialSubscriptionCheckoutModel`, `planSubscriptionCycle`, `isRenewalDue`, `findDueSubscriptions`, `isEditWindowOpen`, `editCutoffAt` |
| Lifecycle transitions | `subscriptionEngineLifecycle.ts` | `pauseSubscription`, `resumeSubscription`, `cancelSubscription`, `completeSubscription`, `skipNextCycle`, `slideNextCycle`, `swapTemplateLine`, `addPermanentAddon` |
| Payment recording | `subscriptionEnginePayment.ts` | `recordPaymentSuccess`, `recordPaymentFailure` |
| Retry ladder | `cycleHardening.ts` | `DEFAULT_CYCLE_RETRY_CADENCE`, `nextRetryAttemptAt`, `shouldScheduleRetry`, `maxRetryAttempts`, `ladderTerminatedByClass` |

`subscriptionEngineTypes.ts` and `types.ts` carry the shapes
(`EngineSubscription`, `EngineCycle`, `EngineEvent`, the status unions, the
template snapshot) and `subscriptionEngineUtils.ts` the small pure helpers the
groups above share (`addCadenceDays`, `parseIso`, `validateTemplate`,
`isTerminalCycle`, `touchSubscription`, `makeEvent`, `success`, `failure`, …).

Every mutating function returns the same discriminated result rather than
throwing:

```ts
type SubscriptionEngineResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code: SubscriptionEngineErrorCode; message: string } };
```

`SubscriptionEngineErrorCode` is a closed union of nine neutral codes
(`invalid_timestamp`, `invalid_template`, `inactive_subscription`,
`edit_window_closed`, `line_not_found`, `duplicate_line`,
`invalid_slide_target`, `invalid_transition`, `terminal_cycle`). Refusals are
values; add a code rather than an exception.

Mutations also return the events they imply (`EngineEvent[]`), each already
carrying an `idempotencyKey` derived from the cycle's own
`engineIdempotencyKey`. The engine does not publish them — the host writes them
to whatever outbox it has, and the stable key is what makes that write
replay-safe.

## No I/O, and no ambient clock

Two rules make `src/subscription/` portable, and both are mechanical rather than
aspirational.

1. **No I/O.** No database handle, no HTTP client, no filesystem, no scheduler,
   no settlement adapter. The only import that leaves `src/subscription/` is
   the sibling `paymentFailureTaxonomyContracts` module, another pure kernel.
2. **No ambient clock.** There is no `Date.now()` and no `new Date()` without an
   argument anywhere in these eight files. Every function that needs the current
   instant takes it as an ISO-8601 string parameter (`now`, `recordedAt`,
   `failedAt`, `firstCycleAt`). `grep -rn "Date.now\|new Date()" src/subscription`
   returns nothing, and it must keep returning nothing.

The consequence is that the same inputs always produce the same outputs, so the
whole engine is testable without a fake clock, a container, or a network.

`DEFAULT_TIMEZONE` here is `"UTC"`. The engine does not know which market it
serves; the composition root names the zone. A caller that has a market zone
should pass it explicitly rather than rely on the default.

## The deterministic-clock contract on `recordPaymentSuccess`

`recordPaymentSuccess` takes **two** instants, and both are required:

```ts
recordPaymentSuccess({ subscription, cycle, paidAt, recordedAt })
```

- `paidAt` is when the money moved, as the settlement service reports it.
- `recordedAt` is when this deployment observed that fact. The caller supplies
  it; the engine has no clock of its own to fall back on.

Lateness is measured to the **earlier of the two**. A settlement timestamp from
the future therefore cannot inflate the schedule shift and push the next charge
out past what the subscriber actually owes, and a delayed observation cannot
shorten it either. Both instants must parse, or the call answers
`invalid_timestamp`.

## A late payment shifts the cycle; it never compresses it

This is the load-bearing rule of the whole engine, and the one most likely to be
"optimised" away by someone who reads it as defensive arithmetic.

The next cycle is computed from the **cycle's own** `scheduledAt` plus its
cadence — not from the moment the money arrived. A late payment must not silently
shorten the interval the subscriber bought. The whole days the payment was late
are then **added**:

```
shiftedByDays = max(0, floor((min(paidAt, recordedAt) - cycle.scheduledAt) / 1 day))
nextCycleAt   = max(subscription.nextCycleAt, onTimeNextCycleAt + shiftedByDays days)
```

The outer `max` is a **monotonic clamp**: `nextCycleAt` may only ever move later,
never earlier. Without it a replayed webhook, an out-of-order settlement, or a
correction applied against an older cycle could compute an earlier instant and
pull a charge forward into a window the subscriber has already been billed for.
That is the one failure mode this rail must never have. A deployment whose
durable schedule enforces the same rule in SQL will spell the clamp `GREATEST`;
the two are one rule with two spellings, and they must move together.

`shiftedByDays` is reported on the emitted
`subscription.next_cycle_at_updated` event alongside `basedOnScheduledAt` and
`basedOnPaidAt`, so the shift is auditable after the fact rather than inferred.

A shift that pushes the instant past the representable timestamp range answers
`invalid_timestamp` rather than returning an invalid date.

## The retry ladder terminates; it does not cap

`cycleHardening.ts` is the single authority on what a refused charge does next.
`nextRetryAttemptAt` answers the instant of the next attempt, or `null` when
there is none. `DEFAULT_CYCLE_RETRY_CADENCE` ships `backoffHours: [24, 72, 168]`
— one day, three days, seven days — frozen so nothing can mutate the shipped
ladder in place, and injectable so a deployment can publish its own.

Asking for the next slot **is** the decision. `null` means only that no next
retry is scheduled; it is a pause signal only after the rung budget is
exhausted. Class termination before exhaustion leaves the subscription active
and must not be treated as exhaustion. The function never answers "the last
slot again". Callers must not add their own
`attempt <= maxRetryAttempts()` guard — a second copy of the budget check is
exactly how two rails drift apart.

`terminatingFailureClasses` lets a refusal's *class*, rather than the rung it
reached, end the ladder. `DEFAULT_CYCLE_RETRY_CADENCE` ships exactly one member:
`["hard_do_not_retry"]`. That class says the issuer refused the instrument, not
only this charge, so no retry rung can change the answer; every other shipped
failure class keeps the full ladder.

`ladderTerminatedByClass` fails open at every configuration uncertainty. An
absent or unlisted class does not terminate. A class explicitly listed by a
custom cadence still does not terminate when the payment taxonomy does not
recognise it, or when `failureClassDecision` says retry remains allowed. Only a
listed, recognised class that the decision table already refuses can shorten
the ladder. The SQL retry rail publishes the same singleton, and the parity test
fails if those two spellings drift.

## Consuming it from a host application

A host application should import from the package entry point and keep its own
module a **re-export shim**:

```ts
// host/src/subscription/subscriptionEnginePayment.ts
export { recordPaymentSuccess, recordPaymentFailure } from "@openlup/core/subscription";
```

The shim exists so host-side call sites keep a stable local import path while the
engine lives here. The rule is one line long: **never add logic to a shim.**
A behaviour change belongs in `src/subscription/`, where it is covered by the
pure tests and shared by every consumer. A shim may narrow a type or require a
parameter the engine defaults (making a market timezone mandatory, for example),
and it must say so in a comment; anything beyond that is a second engine.

What the host still owns: persistence, the outbox write, settlement execution and
mandate storage, scheduling, notification copy, and the clock it passes in. This
package owns none of them and must never acquire one.
