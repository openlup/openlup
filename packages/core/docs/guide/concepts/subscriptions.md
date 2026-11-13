# Subscriptions

Compose subscriptions by separating lifecycle calculations from durable
renewal, recovery and delivery decisions. This page explains which layer owns
each decision and what your host must bind. The pure engine's timing, status
and retry rules are on the [Subscription engine](subscription-engine.md) page.

## Installed subscription boundary

`@openlup/core/subscription` owns pure cycle and payment-clock decisions: its
timing, status and retry rules are described on the subscription engine page.
Use the declarations shipped with your installed package set.

`@openlup/platform/subscriptions` supplies native renewal mechanisms, ports and
PostgreSQL bindings. Constructing a binding does not mount a runner or select a
payment provider. Your application supplies authorization, durable storage,
scheduling and provider bindings, using matching installed `@openlup/*`
versions. Check the installed exports and
[subscription API reference](https://github.com/openlup/openlup/blob/openlup-core-v0.39.0/packages/platform/api/subscriptions.api.md)
before selecting a seam.

The engine returns models and events. Durable admission decides whether a new
renewal may proceed, using stored delivery facts before renewal artifacts are
created. A successful payment is not delivery evidence; the
delivery-alignment boundary, described under "Subscription delivery alignment"
below, owns arrival and persisted schedule alignment.

## Choose the right layer

| Your concern | Owning layer |
| --- | --- |
| Cycle dates, edit windows, lifecycle transitions or payment-clock arithmetic | [Core engine](subscription-engine.md) |
| Types shared by browser and server code | Public core types and `@openlup/platform/subscriptions/contracts` |
| Durable attempts, recovery, reservations and provider execution | Server-side mechanisms and injected ports in `@openlup/platform/subscriptions` |
| Delivery protection and stored schedule changes | [Subscription delivery alignment](#subscription-delivery-alignment) |
| Routes, trusted actors, enabled jobs and selected adapters | Your host's composition |

A local re-export of core still calls core. Keep provider and persistence work
in the host's server composition; inspect the selected handler before assuming
it is independent of HTTP transport. Available source and exports do not prove
that a route, job or adapter is enabled in your installation.

## Lifecycle in durable storage

The [engine status matrix and dunning continuity](subscription-engine.md#the-status-matrix-and-dunning-continuity)
define the recurring lifecycle. Storage can have additional states and duties:

- The managed schema also admits `pending_activation` to `active`,
  `activation_failed` or `cancelled`. Reopening `cancelled` to
  `pending_activation` requires a recorded `subscription.activation_abandoned`
  event. `activation_failed` is terminal. Invalid status updates return
  `subscription_invalid_status_transition`.
- The native PostgreSQL subscription table admits only `active`, `paused` and
  `cancelled`. It cannot store `completed` or provisional activation states;
  its lifecycle functions check source state rather than using the managed
  transition trigger.

Managed restarts require customer confirmation of charge timing. Win-back also
clears the end date and cancellation reason, refuses a locked cycle and
increments the template version. Historical non-payment recovery verifies a
method is chargeable unattended, closes the old case and skips every
uncollected cycle. These duties are not performed by a pure engine call.

The managed win-back and historical recovery functions assign the requested
instant plus two days unconditionally. Unlike the core restart, they do not
preserve a later stored date: a subscription paid through a later date can
therefore receive an earlier next charge on this path. Account for that
limitation when selecting a durable restart.

Durable dunning keeps the unpaid case open and repairable when automatic
retries end. Recovery must converge on valid token redemption, durable method
evidence and the current cycle and attempt before a charge is authorized;
replay must not authorize a second charge.

The native `dunning_lifecycle_handle_failure` entry has no exhaustion-rung
check: a null retry can also come from early class termination. Do not interpret
its exhaustion label as proof that the core exhaustion predicate holds.

Managed first-cycle and renewal refunds settle the financial obligation without
cancelling service, erasing paid-cycle history or emitting
`activation_reversed`. First-cycle order stock release remains separate from
future subscription demand. Existing cancelled subscriptions are not revived.
On the cumulative-refund path, observations need verified signatures and exact
payment-attempt correlation. Equal or older totals have no new refund effect;
the transition to a refunded order emits its notice once. Future hard
reservations and the rolling 14-day soft protection remain in place, so a
one-time allocation cannot consume that protected demand. Stock waiting retains
active service and the original obligation.

## Durable retry timing

For the [retry ladder](subscription-engine.md#the-retry-ladder-terminates), the
native binding accepts trusted `retryCadence.backoffHours`, or the equivalent
second argument to `createPostgresRetryStore`. This changes timing and budget;
it cannot remove the `hard_do_not_retry` stop. Browser request data cannot
configure it. An accepted failure receipt retains its original schedule on
replay. Managed dunning, recovery and due-list guards still use a fixed
exhaustion threshold; a custom core cadence does not alter them.

Native case opening locks the subscription and requires it to be active with
a `payment_pending` cycle before case or notice writes. A terminalized unpaid
cycle stays fenced after resume or reactivation. The refusal is
`subscription_dunning_subscription_cancelled`.

## Timed pauses

`createPostgresSubscriptionAutoResume` exposes `run(limit, now)` for a trusted
host-scheduled job. It selects due finite pause windows without taking rows
another worker has locked. Indefinite windows remain paused.

A window is skipped when method health, cadence, next date or recurring lines
are missing, recovery is open, any cycle is uncollected, or the upcoming date
already has a paid cycle. Orders in `paid`, `fulfillment_pending` or `fulfilled`
also block when linked to that next date. An order without a cycle blocks only
while its renewal operation or activation is unfinished. Completed operations,
completed activations, past paid cycles and cancelled orders left by pause
closure do not keep the pause open.

A skipped window remains available for the next tick; skipping alone does not
make the result's `ok` false. On resume the stored date moves by the actual
pause duration, clamped to execution time. The window closes and records
`subscription.system.auto_resume` under `subscription_auto_resume:<window>`
with the resulting date and eligibility policy.

Pause reminders use the same duration shift, clamped to the window end, for
`nextDeliveryAt` and `resumeAt`, including reminders read from the retained
ledger. The lifecycle dispatcher uses the resumed confirmation. The host owns
scheduling, enablement and job execution records. Manual resume has its own
cadence policy; neither path records delivery arrival or replacement
confirmation.

## Subscription delivery alignment

An active subscription must not start a new renewal while its preceding
unsuperseded delivery is outstanding. Delivery admission records durable
protection before cycle, order or payment artifacts. Existing-cycle retries
retain their recovery authority; they are not new renewals.

A late arrival can extend the next cycle to the delivery instant plus the
stored cadence. The persisted date uses `GREATEST` with the existing date, so
alignment never brings the cycle earlier or stacks deliveries. For split
shipments, automatic alignment uses the latest durable arrival time after no
unsuperseded parcel remains outstanding. Payment timestamps and status text
alone cannot establish arrival.

A replacement stops its predecessor from counting as outstanding through the
replacement link. It does not invent a delivery timestamp for the lost parcel.
The latest unsuperseded replacement remains outstanding until it reaches the
customer, even after dispatch.

Use the trusted service operation
`subscription_delivery_alignment_confirm_replacement` only to attest that a
substitute actually reached the customer when durable delivery evidence cannot
record it. `aligned` means arrival happened. Confirmation uses its own instant
plus cadence under the same later-only clamp. Replaying an aligned case returns
the stored schedule without adding another cadence. Ordinary case resolution
returns `subscription_delivery_alignment_release_would_strand` while an active
subscription still has an unsuperseded, undelivered parcel, leaving protection
and the schedule unchanged.

### Control modes

Select the native control through
`public.subscription_delivery_alignment_set_mode`. An invalid value returns
`subscription_delivery_alignment_invalid_mode`.

| Mode | Effect on new cases |
| --- | --- |
| `off` | No new delivery protection; the installation default |
| `shadow` | Records observations without blocking renewal or automatically changing the schedule |
| `protect` | Blocks renewal for outstanding delivery; eligible arrival releases protection without automatically shifting the date |
| `auto_align` | Blocks renewal and automatically applies the later-only date shift after eligible arrival |

Installation alone does not enforce automatic late-delivery alignment. Existing
cases retain captured protection after a control change, including a return to
`off`. Arrival with open dunning, later renewal artifacts or missing cycle
correlation can require manual review instead of automatic alignment.

In `protect` or `auto_align`, the host must call
`subscription_delivery_alignment_admit_renewal` with subscription, scheduled
instant and server-owned observation time before inserting the new cycle.
Compose a direct renewal store with
`withNativeDeliveryAlignmentRenewalAdmission`; `createNativeSubscriptionBinding`
already uses that decorator. It preserves the store's static terms check and
stops on malformed admission. An insertion without the admission proof refuses
with `subscription_delivery_alignment_admission_required`; a mismatched date
refuses with `subscription_delivery_alignment_stale_schedule`. Keep new-case
control at `off` or `shadow` until admission is composed.

In enforcing modes, paid history without activation or renewal correlation,
such as imported cycles, holds due renewals for manual review. Inspect that
history before changing modes. These controls require the complete installed
database catalogue and host bindings; exporting a function does not activate
them.
