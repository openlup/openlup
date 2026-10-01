# subscription domain

Status: development-preview source guidance.

Browser-shareable subscription surface: the platform's own subscription
lifecycle (cadence, edit window, cycles, skip/slide, swap, timed
pause/resume/cancel, self-service preview, and price-agreement policy) exposed as
pure functions, plus the activation, runtime, dunning, and payment-recovery
contracts that cross domain boundaries.

## Owns / does not own
- **Owns:** subscription state machine, cycle/template snapshots,
  retry/slide/swap pure logic, timed pause windows, structured cancellation
  survey/save-offer payloads, `lock_until_edit` price agreements, activation,
  runtime, dunning, and recovery contracts.
- **Does not own:** payment-provider execution / method vaulting (`payment` +
  `server/infra`), order persistence (`commerce`), email delivery
  (`communications`), or the durable delivery-alignment rail and its
  replacement-confirmation operation (`server/domains/subscription` plus the
  ordered database migrations).

## Shim boundary

⚠️ **The engine is not in this directory.** It lives in
[packages/core/src/subscription](../../../packages/core/src/subscription/) and is imported through the
`@openlup/core/subscription` package export. The files here that look like the
engine are **re-export shims**: one-line modules whose whole body forwards names
out of the core package.

```ts
// subscriptionEnginePayment.ts, in full
export {
  recordPaymentFailure,
  recordPaymentSuccess,
} from "@openlup/core/subscription";
```

**Why.** The lifecycle kernel was extracted into the core package so that a
self-hosting adopter receives the engine without receiving this application. The
shims exist so that call sites inside this application keep a stable local import
path across that extraction, and so that a future move of the engine does not
become a repository-wide rename.

**The rule: never add logic to a shim.** A behaviour change belongs in
`packages/core/src/subscription/`, where the pure tests cover it and every
consumer shares it. Editing a shim either does nothing (the name is re-exported
anyway) or silently forks the engine for this application only, which is the
failure mode the boundary exists to prevent.

There are exactly three sanctioned local additions on top of a re-export, each
narrowing rather than replacing the engine, and each carrying a comment saying
so:

| File | Local addition |
| --- | --- |
| `subscriptionEngineCore.ts` | A wrapper input type that makes `timezone` **required**. The engine is market-neutral and refuses to guess a zone, so the composition root must name one. |
| `subscriptionEngineTypes.ts` | One deprecated market-timezone constant, retained only so an external importer keeps compiling. Nothing first-party reads it. |
| `types.ts` | `subject_ref` (and its deprecated alias) on the template snapshot — a TypeScript-only concern that is never persisted from here. |

Anything beyond narrowing a type or requiring a parameter the engine defaults is
a second engine. Put it in core.

The engine's own [public contract](../../../packages/core/docs/SUBSCRIPTION_ENGINE.md)
defines the deterministic clock, late-payment cycle shift, retry termination and
no-I/O boundary. The [lifecycle and retry reading path](../../../docs/platform/SUBSCRIPTION_WORKFLOWS.md#lifecycle-and-retry)
links those decisions to the implementation and package tests.

## Delivery-alignment boundary

The pure engine does not decide whether a physical parcel reached the customer
and does not persist delivery-alignment cases. That durable server rail is
defined by [canonical contracts](../../../docs/platform/CANONICAL_CONTRACTS.md) and orchestrated from
[server subscription services](../../../server/domains/subscription/README.md): a delayed delivery may only move the next cycle
later, a delivered replacement may settle its predecessor's case as `aligned`,
and a parcel superseded through `replaces_fulfillment_order_id` is no longer an
outstanding obligation. An in-flight or undelivered replacement remains the
current obligation, so it must never be passed to
`subscription_delivery_alignment_confirm_replacement`; that operation records
the fact "Parcel delivered". Host adapters supply delivery evidence without
moving this physical-delivery decision into the browser-shareable engine.

## Starter-pack charges

A starter-pack subscription (marker `subscriptions.starter_pack`) prices its
first cycles from the offer frozen at checkout.
[`starterPackCharge.ts`](../../../server/domains/subscription/starterPackCharge.ts)
is the one computation for every amount a customer is charged or shown for an
upcoming starter cycle: the renewal engine charges with it, the account read
model states it as `nextCharge`, and the lifecycle emails announce it.

- Delivery 2 keeps the frozen checkout amount while the line subtotal equals the
  checkout basis. A reactivation that only bumps `template_version` does not
  reprice it.
- A changed composition is priced at 65% of the catalog list total of the lines
  on file, rounded up, never as a rate taken off the already discounted band
  subtotal. In the renewal engine the list total comes from the same line read
  as the subtotal.
- A re-driven cycle keeps the delivery-2 discount stored in its own pricing
  snapshot, so a retry rebuilds the snapshots its first attempt was priced with.
- The upcoming cycle number is shared as well: an open cycle keeps its own
  number, so a declined delivery 2 is still announced and shown as delivery 2.

The lifecycle emails state these facts, and a deployment may add one of its
own. `StarterPackEmailFields.starterSteadyDetail` is an optional,
already-localized description of the steady package, formatted by the
deployment and never by this domain. The welcome and renewal-reminder content
pass it to the copy as the optional third argument of `starterSteadyLine` and
`starterGraduationLine`, and only beside the steady unit count and cadence. The
fact builders never set it: the deployment's handler reads what it needs at
send time and adds it. Absent or null, both emails render exactly as before.

## Public surface (import cross-domain ONLY these)
- `contracts.ts`, `runtimeContracts.ts`, `paymentRecoveryContracts.ts` —
  activation, runtime, dunning, recovery, and cycle contracts.
- `runtimeContracts.ts` + `runtimePorts.ts` — typed local operator tick
  contract/client; the server retains profile, clock, and provider selection.
- `ports.ts` — neutral delivery and runtime-clock contracts that exclude
  recovery credentials and provider payloads.
- `selfServiceContracts.ts`, `selfServiceActions.ts` — provider-neutral
  self-service action/preview contracts and pure eligibility policy.
- `ports.ts`, `runtimePorts.ts` — engine + runtime ports.
- `types.ts`, `subscriptionEngineTypes.ts` — subscription/cycle statuses +
  events (re-exported from core; see **Shim boundary**).
- `subscriptionEngine*.ts`, `cycleHardening.ts` — the engine surface, re-exported
  from core, plus first-party test helpers.

## Where the code lives
- Engine: [packages/core/src/subscription](../../../packages/core/src/subscription/)
  (`@openlup/core/subscription`) — the
  pure lifecycle kernel, and the only place engine behaviour changes.
- Shared/frontend: [this directory](./) (re-export shims, contracts,
  self-service policy, tests).
- Server: [server/domains/subscription](../../../server/domains/subscription/README.md)
  (checkout activation bridge, runtime
  service/ports, dunning/recovery handlers).

## Workflow navigation

- [Choose the right layer](../../../docs/platform/SUBSCRIPTION_WORKFLOWS.md#choose-the-right-layer)
  before changing a contract or a shim.
- [Renew one cycle](../../../docs/platform/SUBSCRIPTION_WORKFLOWS.md#renew-one-cycle)
  follows admission, payment-method policy, durable attempt preparation and replay.
- [Protect delivery](../../../docs/platform/SUBSCRIPTION_WORKFLOWS.md#protect-delivery)
  follows the physical-delivery decision outside the pure engine.
- [Recover payment](../../../docs/platform/SUBSCRIPTION_WORKFLOWS.md#recover-payment)
  follows authenticated, customer-bound recovery evidence.

## Verification

The [root public test command](../../../package.json) selects the shared
subscription directory. The extracted engine has a separate package suite:
`npm --workspace ./packages/core run ci`. A green root run does not establish
that package result. Inspect
[self-service tests](selfServiceActions.test.ts),
[shared engine tests](subscriptionEngine.test.ts) and the
[workflow evidence limits](../../../docs/platform/SUBSCRIPTION_WORKFLOWS.md#evidence-and-limits)
before choosing the affected checks.

## Further reading

Read [canonical contracts](../../../docs/platform/CANONICAL_CONTRACTS.md) for
delivery-alignment, status, idempotency and provider boundaries;
the [core engine contract](../../../packages/core/docs/SUBSCRIPTION_ENGINE.md)
for pure behavior; and the
[server owner](../../../server/domains/subscription/README.md) for orchestration
and refusal edges. The [reference profile](../../../docs/platform/SUBSCRIPTION_REFERENCE.md)
owns its bounded evaluation instructions. Source guidance does not prove that a
hosted installation is active.

<!-- openlup-doc-impact {"unit":"domain-subscription","digest":"sha256-3a208f71d3eae82e01ab698c863ac305e61daa6e61189431ee5656f663c66eb3","reason":"Comment-only delta. Five subscription comments name architecture guardrails, the deployment's cancel-survey and delivery-policy modules and infrastructure adapters by role instead of by downstream path. No subscription contract, lifecycle rule or invariant described here changes."} -->
