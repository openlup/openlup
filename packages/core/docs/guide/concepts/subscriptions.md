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
[subscription API reference](https://github.com/openlup/openlup/blob/openlup-core-v0.43.0/packages/platform/api/subscriptions.api.md)
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

## Admit application subscription terms

Your application owns which subscription products, quantities and periods it
sells, alongside its one-time offers. Compose the optional
`admitSubscriptionTerms` callback on `PackageEditQuotePorts` (classic and exact
editors) or `SizedHostPorts`. The platform supplies no business cadence list.
This seam does not derive your offer configuration or UI.

The callback receives `SubscriptionEditTerms`: subscription identity, the full
resulting `base` and `addons` arrays with variant ID, SKU and quantity, plus
`nominalPlanDays` and effective `cadenceDays`. A classic unchanged nominal plan
can retain a longer cadence after delivery alignment. Exact edits use the
host's constraint mapper for the nominal plan, or the selected plan-length
lever. Sized terms use the normalized chosen cadence for both fields because
the sized constraint stores unit count rather than a separate nominal plan.

Keep the callback effect-free. Return normally to admit; throw
`subscription_reprice_terms_not_admitted` to refuse. Check every resulting line,
including unchanged add-ons. It runs after normalization and before pricing,
quote-ledger writes or template writes, even when a sized edit preserves every
frozen price. Without the callback, the existing edit behavior is unchanged.
A quote wrapper alone cannot enforce this boundary: classic also quotes a
comparison baseline, while sized pricing can omit all unchanged lines.

Preview and fresh apply each evaluate current admission. A completed command
instead authenticates ownership, takes the existing command-key lock and
compares receipt identity before replaying its original result. Narrowing
request bounds or withdrawing an offer does not invalidate a matching completed
receipt; reusing its key with a different payload still refuses. Host bindings
must also preserve this order rather than reject a replay using current rules.

Fresh quotes, drafts and editor results admit whole-day cadences from 1 through
3660; see the [cadence limits](../reference/limits.md#subscription-cadence-representation).
Historical transport, stored data and frozen receipts retain integer representation.
The admission limit leaves room for date arithmetic; applications own their
offered periods.
Hosts must check the resulting dates for the selected operation. In the current
source candidate, native actor and command previews and the edit-quote CHECK
admit 1..3660 after the complete catalogue includes
`20261122190000_subscription_cadence_bound.sql`. This forward is unreleased;
apply the matching package's complete catalogue before using longer periods.
The public package and exact editors use separate writers.

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
instant plus the implementation’s restart lead unconditionally; consult the
[migration owner](https://github.com/openlup/openlup/blob/openlup-core-v0.43.0/docs/platform/DATA_AND_MIGRATIONS.md#native-subscription-commands-n2)
for the durable timing boundary. Unlike the core restart, they do not
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
reservations and the rolling soft-protection window remain in place, so a
one-time allocation cannot consume that protected demand. Stock waiting retains
active service and the original obligation.

Native reactivation requires trusted charge-timing confirmation, healthy method
and renewal-term evidence; old unpaid cycles stay terminal. The native failure
handler leaves service active, keeps a null-retry case repairable, queues the
final notice and records exhaustion without a pause window or date change. Its
result has `paused: false`, `pauseWindowId: null` and `terminal: true`. Call that
terminal branch only when `isDunningLadderExhausted` holds; early class
termination must leave the case open without invoking it.

## Pause a subscription after failed renewal retries are exhausted

Automatic retry exhaustion leaves service active. If your application policy
requires a pause after failed renewal retries are exhausted, compose
`isDunningLadderExhausted` from `@openlup/core/subscription` with
`createPostgresSubscriptionCommands` from `@openlup/platform/subscriptions`.
`pauseSubscriptionForExpiredDunning` is a compatibility no-op at exhaustion;
it does not implement this policy. A missing automatic setting is not a missing
public command.

In a source candidate containing the owned hook, replace
`owned/renewal-policy.ts` with this complete example. Replace the synthetic
subject IDs only after authorizing that subject through trusted application
evidence; actor IDs alone grant no authority. The bounded selection follows the
repository's PostgreSQL witness, `neutralStoreRenewalPolicy.test.ts`.
Keep its default cadence here: [provider-recorded failures](#durable-retry-timing)
do not accept a custom ladder today.

```ts
import { isDunningLadderExhausted } from "@openlup/core/subscription";
import {
  createPostgresRetryStore,
  type createPostgresSubscriptionCommands,
  type SubscriptionQueryExecutor,
} from "@openlup/platform/subscriptions";
import type { SubscriptionCommand } from "@openlup/platform/subscriptions/contracts";

// Preserve the owned hook's exports used by the managed host.
export interface RenewalPolicyInput {
  db: SubscriptionQueryExecutor;
  result: unknown;
  createCommands: typeof createPostgresSubscriptionCommands;
  withTransaction<T>(work: (db: SubscriptionQueryExecutor) => Promise<T>): Promise<T>;
}
export type RenewalPolicy = (input: RenewalPolicyInput) => Promise<void>;

const subject = {
  clientId: "11111111-1111-4111-8111-111111111111",
  subscriptionId: "22222222-2222-4222-8222-222222222222",
};
const cadence = { backoffHours: [24, 72, 168] };
const futureTerms = async () => ({
  outcome: "refused" as const, reason: "subscription_command_unsupported_action" as const,
}); // Pause needs no future-term quote; other actions refuse.

export const renewalPolicy: RenewalPolicy = async input => {
  const candidate = (await input.db.query(
    `SELECT o.renewal_operation_id FROM public.subscription_retry_obligations o
      JOIN public.subscription_renewal_operations op ON op.id=o.renewal_operation_id
      JOIN public.subscriptions s ON s.id=op.subscription_id
      WHERE o.subscription_id=$1 AND op.scheduled_at=s.next_cycle_at`, // Current cycle only.
    [subject.subscriptionId],
  )).rows[0];
  if (!candidate) return;
  const operationId = String(candidate.renewal_operation_id), key = `exhaustion-pause:${operationId}`;
  await input.withTransaction(async db => {
    // Command actor/key -> subscription -> operation -> obligation -> cycle -> intent -> case.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1::uuid::text||':'||$2::text,0))", [subject.clientId, key]);
    await db.query("SELECT id FROM public.subscriptions WHERE id=$1 AND client_id=$2 FOR UPDATE", [subject.subscriptionId, subject.clientId]);
    await db.query("SELECT id FROM public.subscription_renewal_operations WHERE id=$1 AND subscription_id=$2 FOR UPDATE", [operationId, subject.subscriptionId]);
    await db.query("SELECT id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1 FOR UPDATE", [operationId]);
    await db.query("SELECT id FROM public.subscription_cycles WHERE renewal_operation_id=$1 FOR UPDATE", [operationId]);
    await db.query("SELECT id FROM public.commerce_settlement_intents WHERE renewal_operation_id=$1 FOR UPDATE", [operationId]);
    await db.query("SELECT id FROM public.subscription_dunning_cases WHERE cycle_id=(SELECT cycle_id FROM public.subscription_retry_obligations WHERE renewal_operation_id=$1) FOR UPDATE", [operationId]);
    const retry = await createPostgresRetryStore(db, cadence).read(operationId);
    const current = (await db.query(`SELECT s.status,s.next_cycle_at=op.scheduled_at AS current_cycle,
      c.status AS cycle_status,i.status AS settlement_status,d.status AS case_status
      FROM public.subscriptions s JOIN public.subscription_renewal_operations op ON op.subscription_id=s.id
      JOIN public.subscription_cycles c ON c.renewal_operation_id=op.id
      JOIN public.commerce_settlement_intents i ON i.renewal_operation_id=op.id
      JOIN public.subscription_retry_obligations o ON o.renewal_operation_id=op.id
      JOIN public.subscription_dunning_cases d ON d.id=o.case_id WHERE op.id=$1`, [operationId])).rows[0];
    if (!retry || retry.state !== "waiting" || current?.status !== "active" || !current.current_cycle
      || current.cycle_status !== "payment_pending" || current.settlement_status === "settled" || current.case_status !== "open"
      || !isDunningLadderExhausted({ status: retry.disposition, retryAttempt: retry.retryAttempt, nextRetryAt: retry.nextRetryAt }, cadence)) return;
    await db.query(`INSERT INTO public.subscription_events(subscription_id,event_type,idempotency_key,payload)
      VALUES($1,'application.exhaustion_policy',$2,'{}')`, [subject.subscriptionId, key]);
    const command: Extract<SubscriptionCommand, { action: "pause" }> = {
      actor: { kind: "customer", actorId: subject.clientId, clientId: subject.clientId },
      subscriptionId: subject.subscriptionId, idempotencyKey: key, now: new Date().toISOString(), action: "pause",
      pausePreset: "indefinite", reason: "exhausted_retries", survey: null, saveOffer: null,
    };
    const receipt = await input.createCommands({ withTransaction: work => work(db), futureTerms }).apply(command);
    if ("supported" in receipt || receipt.outcome === "refused") throw new Error("pause_policy_command_refused");
  });
};
```

The population lease excludes other renewal passes, not customer recovery.
The transaction waits for recovery, then skips a repaired or changed cycle;
a null retry alone never establishes exhaustion. Commands reuse that locked
connection without a nested commit. A pause closes recovery, revokes tokens and
terminalizes eligible unpaid artifacts. Refusal escapes the callback, rolling
back both bookkeeping and command receipts. Report it only after rollback.
Replaying a command requires the same key and payload; the command fingerprint
excludes `now`, though keeping it stable is a sensible application choice.
A repeated hook skips the already paused subject.

Runnable proof from the repository root (with the contributor PostgreSQL
prerequisites): `node scripts/test-hosted.mjs neutralStoreRenewalPolicy.test.ts`.
It covers exhaustion, exact command replay, concurrent recovery/recheck and
refusal rollback. Repeat these witnesses for your selection and policy.
A hook exception fails the job; previously committed native work remains.
The released 0.43.0 starter lacks this hook. See
[compose post-renewal policy](../how-to/build/customize-the-starter.md#compose-post-renewal-policy)
for candidate selection and scheduling; the default hook is a no-op.

## Durable retry timing

The [retry ladder](subscription-engine.md#the-retry-ladder-terminates) uses delays
after each preceding failure. `[24, 72, 168]` hours means retries on days 1, 4
and 11 after the initial decline if each runs and fails when due. Days 1, 3 and
7 would require `[24, 48, 96]`; that setting does not reach every path today:

| Failure-recording path | Timing used |
| --- | --- |
| Fresh failures through `createPostgresRetryLifecycleBinding` or `createNativeRetryDriver` | Trusted `retryCadence.backoffHours`; the starter's `host/renewal-sandbox.ts:composeRenewalSandbox` passes `retryBackoffHours` to this driver. `createPostgresRetryStore(db, cadence).applyFailure` calls the four-argument SQL overload. |
| Provider-recorded renewal failures through `payment_provider_result_apply` | The three-argument `subscription_retry_apply_failure(uuid,text,jsonb)` supplies `[24,72,168]`. The driver replays the provider's immutable failure receipt; its configured cadence cannot reschedule it. |

Sandbox observation recording is separate from provider-result recording;
configuring the starter sandbox does not establish provider retry timing.
The current definitions are `payment_provider_result_apply` in
[`20261121090000_payment_provider_profiles.sql`](https://github.com/openlup/openlup/blob/openlup-core-v0.43.0/packages/platform/sql/20261121090000_payment_provider_profiles.sql)
and both failure overloads in
[`20261109100000_subscription_retry_resume.sql`](https://github.com/openlup/openlup/blob/openlup-core-v0.43.0/packages/platform/sql/20261109100000_subscription_retry_resume.sql).
Verify your selected catalogue or applied prefix with the
[current-definition lookup](../upgrade/database-migrations.md#find-the-current-function-definition).

Adopters can configure timing and budget for fresh native failure recording,
but cannot configure the provider-result ladder through today's public
composition. Full ladder configurability is tracked separately. Neither a
custom cadence nor receipt replay removes the `hard_do_not_retry` stop. Browser
request data cannot configure timing. Managed dunning, recovery and due-list
guards retain their fixed exhaustion threshold; custom core timing does not
alter them. Evaluate pause exhaustion against the ladder that actually recorded
the failures.

Native case opening locks the subscription and requires it to be active with
a `payment_pending` cycle before case or notice writes. A terminalized unpaid
cycle stays fenced after resume or reactivation. The refusal is
`subscription_dunning_subscription_cancelled`.

The renewal admission hook accepts the runner's `occurredAt`; a direct caller
that omits it uses the decorator's clock. Only native delivery-admission denials
return `deferred` before reservation/preparation, without a terminal refusal
write. The operation stays claimed until lease expiry before the same schedule
is offered again. Static terms refusals remain terminal.

### Recorded-method recovery

A fresh usable recorded method can accelerate an existing automatic retry.
Exhausted or stopped work requires recorded token authority for the current
case, cycle and retry rung. A method update alone cannot grant that authority
or reset the retry budget. The host still supplies the recovery routes and
provider composition.

Before dispatch, repair authority may bind a different usable method. Dispatch
freezes that binding. A later automatic rung reads its currently recorded usable
method without changing the earlier dispatch binding. Collection, linking and
scheduling neither settle money nor pause, resume or cancel service. Method
health and setup processing are described under
[saved payment methods](payments.md#saved-payment-methods).

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

Unlinked orders count as unfinished while renewal is `claimed`, `reserved` or
`attempt_prepared`, or activation is `provisional`. Completed renewal
(`succeeded`/`refused`) and activation (`active`/`compensated`) no longer block.
Native shipment updates do not advance the order past `paid`, so past paid
cycles alone cannot prevent timed resume.

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

A locally cancelled, undelivered and unsuperseded parcel still blocks new renewal
in enforcing modes. Local cancellation creates no alignment hold or exception
event and does not block the order's other parcels. An existing fulfillment
exception hold can open an alignment case only for an active subscription's
paid cycle while control is enabled. One-time orders open no case, and an
exception case never pauses service. Existing-cycle retries bypass new-cycle
admission and neither mint nor consume its schedule-bound, single-use receipt.
Unordered paid history needs manual review; other uncorrelated cycles also
prevent automatic arrival alignment regardless of scheduled date.

## Native payment truth and review

The native payment descriptor supports truth, settlement, later-only cycle
alignment, durable prepared-attempt storage, method setup, absence reopening
and cumulative refunds with the complete installed database catalogue.
Provider execution and method collection require explicit host bindings;
absence auto-reopen remains default off. Sandbox-attempt storage is a separate
capability. Refunds settle money without cancelling service.
A descriptor alone does not establish installed schema readiness.

Capture against a cancelled order remains `captured` and `open` with
`review_required` application status. It does not settle the order, reopen it
or create a refund/fiscal reversal. Sweep skips review-marked events and
reconciliation keeps them unapplied; readback exposes the marker. Recovery-notice
contention can still roll capture back; redelivery converges after contention
clears, without an automatic retry dispatcher.

Operators find review-marked events with the read-only query on the
[data and migrations page](https://github.com/openlup/openlup/blob/openlup-core-v0.43.0/docs/platform/DATA_AND_MIGRATIONS.md#module-catalogues-and-installed-histories),
run through an authorized native PostgreSQL session; pass a returned event ID to
the truth port's `readEvent` for details. The query records no review decision
and no money or order transition.
