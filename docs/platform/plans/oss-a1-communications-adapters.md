# A1 communications adapters

Status: development-preview implementation ledger, 2026-10-20.
Audience and purpose: platform contributors maintaining the neutral marketing-sync
contract and opt-in Node communications adapters. Protocol and synthetic
conformance evidence does not certify a provider account or authorize activation
or release.

## Scope and ownership

A1 extends the existing platform communications module. C-PR1 merged in #233
with the neutral marketing-sync boundary; P1 merged in #235 with the opt-in
Resend adapter. C-PR1b is this change: additive consent-push types and synthetic
conformance through the existing communications entries. The neutral
communications and communications/contracts entries export the marketing-sync
types; the vendor factory is available only from `communications/resend`.
The maintained reference adapters, newsletter port, private persistence witnesses
and browser-entry limits retain their roles.

The [canonical contracts](../CANONICAL_CONTRACTS.md#neutral-marketing-sync) own
marketing lifecycle semantics and the
[architecture guide](../ARCHITECTURE_AND_EXTENSIONS.md) owns package placement and
host composition. P2 owns the Klaviyo factory and private construction; P3 owns
consumer composition. C-PR1b supplies the neutral consent-push contract; P2 owns
its real-adapter implementation and evidence.
P2 inherits immediate withdrawal despite grant-caused fences/quarantine, preserving same-key withdrawal fences and account-level cooling (`retryable/cooling` with finite `afterSeconds`).
Versioning, private adoption, production activation and account certification are
separate outcomes. No default sender, callback, route, schedule or recovery send
is installed by these surfaces.

## C-PR1: neutral marketing sync

C-PR1 introduced 14 type-only declarations through the existing communications
entries from [marketingSync.ts](../../../packages/platform/src/communications/contracts/marketingSync.ts).
The original contract describes profile sync, negative consent readback and
erasure request/status; C-PR1b extends it with the consent-push family below.
Local consent remains authoritative. Existing M04 providers remain assignable;
there is no new package subpath, runtime helper or production abstraction.
A refusal-only newsletter bridge belongs to the later adapter work.

The offline conformance helper uses one synthetic dialect, with audience
variants asserted inside each case. S01–S12 cover binding/capability, private
mapper substitution, post-await fences, owned create/update/mapping, removed
surface, scope, negative feedback, receipt substitution, closed outcomes,
replay/persistence, fresh read authority and cooldown/quarantine. K01–K04 check
both built entries with strict exact-optional compilation: positive controls
compile and the original 28 unmarked forbidden-state probes per entry are
rejected. C-PR1b expands that inventory to 47 per entry.
The 21 invariant plants are exercised inside their named cases, with baseline
and restored witnesses; they add no registrations. Fixture and API paths resolve
from the owning test module, so the tests work from either package or repository
root. Synthetic provenance cannot certify real provider admission, persistence
or authenticated deletion evidence.

## P1: opt-in Resend adapter

The Node-only [adapter entry](../../../packages/platform/src/communications/resend/index.ts)
exports exactly `createResendTransport`, `createResendWebhookHandler` and
`runResendDeliveryReconciliation`, with no exported types or constants. It adapts
EmailTransport, EmailObservationPort and the existing neutral reconciliation
runner. Hosts supply policy, environment selection and persistence ports;
injected fetch adds no SDK or dependency.

W1 preserves payload, idempotency, abort and outcome behavior. Every send passes
through the existing egress guard and uses its selected credential and recipient.
W2 verifies raw webhook bytes before parsing, checks the environment and uses the
neutral observation engine. Polling is GET-only; only a 404 can establish the
not-found abandonment boundary. Raw bypass, original credential/recipient
fallback, parse-before-verify and authentication-as-404 plants falsify these
properties. Installed-consumer proofs check the exact export surface, absence of
SDK/optional peers and injected I/O, including refusal of extra exports and raw
bypass. Account verification remains unestablished.

Package boundary checks resolve declared nested entries under an existing
module, preserve contracts isolation and reject undeclared nested entries. The
undeclared fixture uses a neutral placeholder for a deliberately absent nested
entry; it needs no vocabulary exception. Existing neutral transport, observation, webhook-dialect and egress
conformance witnesses remain required.

P1A-F1 closure, 2026-10-20: local repair of candidate `29250d0` only, with no
Git writes, network, submission or release authority. Webhook observations now
retain raw provider types, matching the donor and poller; the event inventory
only admits supported types. R05, R08 and the installed-consumer proof pin those
names, and R14 folds parity for all five polled states into its existing case.
The short-name plant failed at `R14 delivered: webhook/poll eventType parity`
and was reverted. Three exports and 32 P1 cases (including three generated)
remain unchanged. Root focused tests passed 1,048 cases, package focused tests
1,009, and the package script also passed all 2,793 cases. Lint passed with 33
warnings outside this delta; ast-grep and API checks passed. Neutrality reported
zero increases; policy/inventory requires a refreshed tooling no-impact trailer
for the consumer-proof change, to be supplied by the committing supervisor.
Retro: the first root run exposed the stale installed-consumer expectation;
trace protocol names through consumer proofs as well as unit fixtures.

## Test ledger

The accepted A1 baseline is 1,751 files / 14,700 cases / provisional 523.419 s.
The cumulative allocation is at most +100 required cases and +30 s summed median
hosted file-test time, including C-PR1b. The ledger distinguishes implemented
inventory from later allocations; case counts do not establish runtime savings
or a hosted time fit.

| A1 slice | Added required cases | Inventory and evidence |
| --- | ---: | --- |
| C-PR1 | 16 | S01–S12 shared conformance and K01–K04 compatibility; two test files |
| P1 | 32 | 12 egress + 15 protocol + 2 additive cold-consumer + 3 generated package-boundary cases |
| C-PR1b | 4 | Synthetic CP01–CP04; compile probes fold into K03/K04 |
| P2 | at most 34 | Original 26 plus 8 real-adapter consent-push cases: CP01–CP04 and KP01–KP04 |
| P3 | 8 | Consumer composition allocation |
| V1 private witnesses | 6 | Separate private evidence allocation |
| Cumulative ceiling | 100 | +30 s hosted duration ceiling unchanged; final median/p90 remain unmeasured here |

The +12 consent-push allocation spans four cases in C-PR1b and eight in P2.
P1's 32 cases replace the earlier 44-case grouping, leaving the cumulative
allocation at 100. Every original P1 registration maps to E01–E12, R01–R15,
I01–I02 or B01–B03. Guard variants and observation faults use ordinary loops
with fresh fixtures and labeled assertions; no named invariant or plant is
removed. The three generated boundary cases come from the adapter source
inventory, rather than three new explicit test declarations.
C-PR1's 16 cases and C-PR1b's four cases are additional to P1.

| Property | Required witness | Added cases | Owner |
| --- | --- | ---: | --- |
| Neutral marketing lifecycle, provenance and refusal | [shared conformance](../../../packages/platform/test/communications/marketingSyncConformance.test.ts) | 12 | platform communications |
| Existing-provider assignment and exact type boundary | [compatibility](../../../packages/platform/test/communications/marketingSyncCompatibility.test.ts) | 4 | platform communications |
| Consent push, replay fences and withdrawal/readback races | [shared conformance](../../../packages/platform/test/communications/marketingSyncConformance.test.ts) | 4 | platform communications |
| Guarded transport, selected context and wire shapes | [egress](../../../packages/platform/test/communications/resend/egress.test.ts) | 12 | platform communications |
| Raw authentication, environment, convergence and 404-only polling | [protocol](../../../packages/platform/test/communications/resend/protocol.test.ts) | 15 | platform communications |
| Installed export inventory and guarded injected I/O | [cold consumer](../../../scripts/packages/platform-cold-consumer.test.ts) | 2 | package tooling |
| Source isolation and exact nested entry inventory | [package boundary](../../../packages/platform/test/packageBoundary.test.ts) | 3 generated | platform package |

## Neutrality and verification limits

The existing file-scoped `ui-12` allowance covers the adapter source/test
directories and API reports, exact approved path-segment tokens in the manifest,
release gates, boundary test, publication catalogue, changelog, canonical
contracts and architecture guide, and exact cold-proof lines. API report filename
tokens are restricted to release gates and the publication catalogue; relative
adapter-entry tokens are restricted to the boundary test. This ledger alone also
permits bare vendor words outside those existing adapter/report/proof allowances.
Neutral contracts, the neutral entry and platform root retain their refusals.
Longer, prefixed or directory-shaped tokens do not inherit the exceptions.
Baseline, scanner pins, caps and browser budgets remain unchanged.

Root and package-local test execution, generated API checks, neutrality, lint and
publication policy are distinct obligations. An installed-artifact release proof
requires the actual retained tarball; synthetic consumer fixtures establish only
their named offline properties. Hosted timing, TEST-account/key capability
readback and no-trigger evidence remain separate later-adapter gates.

## C-PR1b: additive consent push

This change adds exactly `ConsentPushRequest`, `ConsentPushResult` and
`ConsentPushPort` through both existing communications entries, bringing the
neutral export inventory from 14 to 17. It also makes the existing
`NegativeFeedback` discriminant union readonly. Callers that assign feedback
`kind` or `outcome` must stop doing so; existing providers remain assignable.
No new subpath, factory, executor, automatic retry or provider activation is added.

Grants require an audience-scoped request; withdrawals also allow account-wide
scope. The push capability declares `grantEffect`. Accepted and acknowledged
results carry `reconcileRequired` and identify the admitted request without
proving its remote effect. Local consent remains authoritative. P2 owns the
provider implementation, private construction and real-adapter evidence.

Four synthetic CP rows reuse the conformance runner with a single-subject model.
Scope, authority, flow, suppression, binding and pending-withdrawal variants have
independent baseline/plant/restored assertions within those registrations.
Changed replay fields cannot add effects. Lost admission fences both same-key
and new-key redispatch. Partial or unsupported readback cannot clear any pending
withdrawal, including one without an earlier grant; sufficient-readback positive
controls permit a fresh local grant. Unknown grant settlement preserves
reconciliation. The model counts its own accepted/acknowledged grants for the
configured subject/audience, including confirmed-journal acknowledgements; CP04
pins immediate withdrawal reconciliation and rejects acknowledgement as settlement.
Synthetic evidence does not certify real provider behavior or
account capabilities.

K03/K04 include strict exact-optional consent-push probes without adding cases.
Both built entries reject 47 unmarked forbidden-state probes each, with positive
controls. The original 21 invariant plants and 53 consent-push plant cycles stay
inside the twenty contract cases. Fixture and virtual compiler paths resolve
from their owning test modules for root and package-local execution.

## Implementation lessons

Module-relative fixtures remove working-directory assumptions. Declared nested
entries preserve exact export and contracts boundaries. Reusing the egress guard
and neutral engines avoids a second convergence mechanism. Webhook observations
retain raw provider event types, matching polling; R14 covers parity for all five
polled states, and the installed-consumer proof pins those names too.

Targeting each plant variant inside its existing row preserves the case budget
while making every safety condition independently falsifiable. A condition shared
by race and ordinary paths needs controls on both paths.
