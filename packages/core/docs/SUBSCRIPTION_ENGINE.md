# Subscription engine

Moved to the [OpenLup guide](guide/concepts/subscription-engine.md). This page keeps its headings so existing links resolve.

Owns: the pure subscription lifecycle kernel exported as `@openlup/core/subscription`.
Watches: `src/subscription/**`

All `src/subscription/` paths and unprefixed commands in this document are
relative to this package root.

Evidence (historical record, 2026-11-13):

Verified against: repository state `735d5d7` plus the lifecycle-parity change
(2026-09-26) — every exported name below was read out of the eight source files
in `src/subscription/`, the status matrix out of `subscriptionEngineLifecycle.ts`
and the managed SQL guard it mirrors, the
payment semantics out of `src/subscription/subscriptionEnginePayment.ts`, and
the shipped retry class plus fail-open boundary out of `cycleHardening.ts` and
its exact unit/parity tests.

## What this package owns

Moved to [Subscription engine](guide/concepts/subscription-engine.md#what-this-package-owns).

Source inventory under `src/subscription/`:

| Group | File |
| --- | --- |
| Cycle planning | `subscriptionEngineCore.ts` |
| Lifecycle transitions | `subscriptionEngineLifecycle.ts` |
| Payment recording | `subscriptionEnginePayment.ts` |
| Retry ladder | `cycleHardening.ts` |

`index.ts` is the export barrel. `subscriptionEngineTypes.ts` and `types.ts`
carry the shapes; `subscriptionEngineUtils.ts` carries the shared pure helpers.
When changing refusals, add a `SubscriptionEngineErrorCode` rather than an exception.

## No I/O, and no ambient clock

Moved to [Subscription engine](guide/concepts/subscription-engine.md#no-io-and-no-ambient-clock).

The only import leaving `src/subscription/` is the sibling
`paymentFailureTaxonomyContracts` module. Keep the source scan
`rg 'Date.now|new Date\(\)' src/subscription` empty.

## The deterministic-clock contract on `recordPaymentSuccess`

Moved to [Subscription engine](guide/concepts/subscription-engine.md#the-deterministic-clock-on-recordpaymentsuccess).

## A late payment shifts the cycle; it never compresses it

Moved to [Subscription engine](guide/concepts/subscription-engine.md#a-late-payment-shifts-the-cycle-it-never-compresses-it).

Keep the TypeScript monotonic clamp and its SQL `GREATEST` spelling synchronized
when changing implementations that enforce the same rule.

## The retry ladder terminates; it does not cap

Moved to [Subscription engine](guide/concepts/subscription-engine.md#the-retry-ladder-terminates).

Keep the SQL retry rail's terminating-class singleton synchronized with
`cycleHardening.ts`; the parity test fails if the spellings drift.

## The status matrix and dunning continuity

Moved to [Subscription engine](guide/concepts/subscription-engine.md#the-status-matrix-and-dunning-continuity), [Subscriptions](guide/concepts/subscriptions.md#lifecycle-in-durable-storage).

Keep the engine's four-status matrix synchronized with the managed SQL guard
`public.subscription_guard_status_transition`; the guard's remaining edges
belong to activation.

## Consuming it from a host application

Moved to [Subscription engine](guide/concepts/subscription-engine.md#consuming-it-from-a-host-application).

Make engine behavior changes in `src/subscription/`, covered by the pure tests
and shared by every consumer.
