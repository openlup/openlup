# Canonical Contracts

Status: development-preview contract. These rules define the intended public
behavioural boundary; they do not assert a stable provider catalogue or release.

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
request, and the non-payment rule below, may move an active subscription to
`paused`. Among the engine's statuses, only the win-back leaves `cancelled`: it
needs a stored payment method and restarts the schedule two days out.

**The sanctioned non-payment rule.** Nothing suspends, freezes or interrupts an
active subscription except a renewal whose refusals ran past the last rung of
the retry ladder. That cycle has failed, has no retry scheduled and has an
attempt number beyond the ladder's length. It pauses the subscription and
records `subscription.paused` with reason `payment_failed_expired`. A ladder
cut short by a terminating refusal class, or a failure that still has a retry
after it, leaves the dunning case open and the subscription active. The
customer's recovery resumes the paused subscription: it skips the uncollected
cycle and restarts the schedule two days out. A plain resume must not be used
for a subscription this rule paused, because it neither skips that cycle nor
moves a stale `next_cycle_at`. The managed SQL side is
`subscription_handle_payment_failure_dunning` and
`subscription_resume_after_expired_dunning`. The engine side is
`isDunningLadderExhausted`, `pauseSubscriptionForExpiredDunning` and
`resumeSubscriptionFromExpiredDunning`.

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
Its dunning rail, `dunning_lifecycle_handle_failure`, has no rung fence: it
expires the case and pauses an active subscription whenever the next retry
instant it is handed is NULL. A class-terminated refusal on rung one also has
no next retry, so a caller that hands its schedule straight through would pause
a live subscription on the first refusal, which the rule above forbids. No
caller in this tree invokes it today. A future caller must not call it with
NULL unless `isDunningLadderExhausted` holds for the refused cycle. A case cut
short earlier must stay open without that call. An adopter on the portable chain therefore cannot store a
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

Stable status, idempotency, and provider-extension commitments wait for `P1-SF`.
Before then, changes must still preserve the contracts above and state their
preview compatibility boundary explicitly.

The [reviewed function-forward approval data](../../config/reviewed-platform-forwards.json)
binds exact managed SQL files and old/new function definitions. Its replacement
list contains exactly three existing signatures in two files; a distinct creation
list requires the two price-setup signatures to be absent before their forward.
An optional runtime list binds one additional forward replacing only the existing
admin search and due-renewal readers, with fixed `service_role` column-read and
function-execution capabilities. Header identity and execution attributes remain
bound to the preceding definitions. The registry must precede both the feature
comparison base and the parent of its introduction; a feature cannot approve itself.
Required self-check and release preparation share the same admission check.
This is a separately reviewed preview admission class, not expand-only or a live
database compatibility proof; see
[Data and migrations](DATA_AND_MIGRATIONS.md#exact-reviewed-function-forwards).

<!-- openlup-doc-impact {"unit":"configuration","digest":"sha256-1189eee35af5c79cedb47e98ed1b0d43d316379fbe4b4ed4d46e2444bb3eb6ec","reason":"The package configuration advances only the lockstep version from 0.10.0 to 0.11.0 after preview 10 and its package publication. Matching package and source preview numbering, development-preview compatibility, and release preparation rules remain unchanged."} -->

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
it cannot admit new debt. These counts reuse the existing scanner semantics and
do not expand a runtime contract or establish a stable preview channel.

Published Tree CI enforces that ratchet in required `self-check` and exercises
its CLI refusal tests in required `test`. The complete root and managed pgTAP
jobs retain raw diagnostic failures with named ownership; their addition does
not change platform behavior, grant application privileges or declare complete
compatibility evidence. Existing release context checks remain unchanged.
