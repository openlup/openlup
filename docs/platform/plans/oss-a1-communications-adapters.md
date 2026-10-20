# A1 communications adapters

Status: development-preview implementation ledger, 2026-10-20.
Audience and purpose: platform contributors maintaining the neutral marketing-sync
contract and opt-in Node communications adapters. Protocol and synthetic
conformance evidence does not certify a provider account or authorize activation
or release.

## Scope and ownership

A1 extends the existing platform communications module. C-PR1 (#233) supplies the
neutral marketing-sync boundary; P1 supplies the opt-in Resend adapter. Both
surfaces coexist: the neutral communications and communications/contracts entries
export the marketing-sync types, while the vendor factory is available only from
`communications/resend`. The maintained reference adapters, newsletter port,
private persistence witnesses and browser-entry limits retain their roles.

The [canonical contracts](../CANONICAL_CONTRACTS.md#neutral-marketing-sync) own
marketing lifecycle semantics and the
[architecture guide](../ARCHITECTURE_AND_EXTENSIONS.md) owns package placement and
host composition. P2 owns the Klaviyo factory and private construction; P3 owns
consumer composition. Positive consent writes require a separate owner decision.
Versioning, private adoption, production activation and account certification are
separate outcomes. No default sender, callback, route, schedule or recovery send
is installed by these surfaces.

## C-PR1: neutral marketing sync

The existing communications entries expose the frozen 14 type-only declarations
from [marketingSync.ts](../../../packages/platform/src/communications/contracts/marketingSync.ts).
They describe profile sync, negative consent readback and erasure request/status.
Local consent remains authoritative. Existing M04 providers remain assignable;
there is no new package subpath, runtime helper or production abstraction.
A refusal-only newsletter bridge belongs to the later adapter work.

The offline conformance helper uses one synthetic dialect, with audience
variants asserted inside each case. S01–S12 cover binding/capability, private
mapper substitution, post-await fences, owned create/update/mapping, removed
surface, scope, negative feedback, receipt substitution, closed outcomes,
replay/persistence, fresh read authority and cooldown/quarantine. K01–K04 check
both built entries with strict exact-optional compilation: positive controls
compile and all 28 unmarked forbidden-state probes per entry are rejected.
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

## Test ledger

The accepted A1 baseline is 1,751 files / 14,700 cases / provisional 523.419 s.
The cumulative allocation is at most +100 required cases and +30 s summed median
hosted file-test time, including C-PR1b. Counts below describe the implemented
inventory; case counts do not establish runtime savings or a hosted time fit.

| A1 slice | Added required cases | Inventory and evidence |
| --- | ---: | --- |
| C-PR1 | 16 | S01–S12 shared conformance and K01–K04 compatibility; two test files |
| P1 | 32 | 12 egress + 15 protocol + 2 additive cold-consumer + 3 generated package-boundary cases |
| Remaining A1 allocation | 52 | Includes later adapter/composition work and private witnesses; no additional inventory approved by this arithmetic |
| Cumulative ceiling | 100 | Hosted duration and final median/p90 remain unmeasured here; +30 s ceiling is unchanged |

P1's 32 cases replace the earlier 44-case grouping. Every original registration
maps to E01–E12, R01–R15, I01–I02 or B01–B03. Guard variants and observation
faults use ordinary loops with fresh fixtures and labeled assertions; no named
invariant or plant is removed. The three generated boundary cases come from the
adapter source inventory, rather than three new explicit test declarations.
C-PR1's 16 cases are additional to P1 and do not change that count.

| Property | Required witness | Added cases | Owner |
| --- | --- | ---: | --- |
| Neutral marketing lifecycle, provenance and refusal | [shared conformance](../../../packages/platform/test/communications/marketingSyncConformance.test.ts) | 12 | platform communications |
| Existing-provider assignment and exact type boundary | [compatibility](../../../packages/platform/test/communications/marketingSyncCompatibility.test.ts) | 4 | platform communications |
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

Rethink/retro: module-relative fixtures remove cwd assumptions; declared nested
entries remove the old flat-path assumption without weakening exact export or
contracts boundaries. Reusing the egress guard and neutral engines avoids a
second convergence mechanism. Grouping related inputs preserves invariant
assertions without adding runtime abstractions or relaxing the test budget.
