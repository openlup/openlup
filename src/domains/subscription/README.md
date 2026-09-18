# subscription domain

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
`packages/core/src/subscription/` and is imported through the
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

The engine's own public contract (deterministic clock, late-payment cycle shift,
retry termination, and no I/O) is in
`packages/core/docs/SUBSCRIPTION_ENGINE.md`.

## Delivery-alignment boundary

The pure engine does not decide whether a physical parcel reached the customer
and does not persist delivery-alignment cases. That durable server rail is
defined by `docs/platform/CANONICAL_CONTRACTS.md` and orchestrated from
`server/domains/subscription`: a delayed delivery may only move the next cycle
later, a delivered replacement may settle its predecessor's case as `aligned`,
and a parcel superseded through `replaces_fulfillment_order_id` is no longer an
outstanding obligation. An in-flight or undelivered replacement remains the
current obligation, so it must never be passed to
`subscription_delivery_alignment_confirm_replacement`; that operation records
the fact "Parcel delivered". Host adapters supply delivery evidence without
moving this physical-delivery decision into the browser-shareable engine.

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
- Engine: `packages/core/src/subscription/` (`@openlup/core/subscription`) — the
  pure lifecycle kernel, and the only place engine behaviour changes.
- Shared/frontend: `src/domains/subscription/` (re-export shims, contracts,
  self-service policy, tests).
- Server: `server/domains/subscription/` (checkout activation bridge, runtime
  service/ports, dunning/recovery handlers).

## Further reading

Read `docs/platform/CANONICAL_CONTRACTS.md` for the public delivery-alignment,
status, idempotency, and provider boundaries;
`packages/core/docs/SUBSCRIPTION_ENGINE.md` for the pure engine; and
`server/domains/subscription/README.md` for server orchestration and refusal
edges. A private deployment may add its own `SUBSCRIPTION_ORIENTATION.md`
composition map, but public contributors do not need it and it cannot redefine
these contracts. None of these source documents proves a hosted deployment is
active.
