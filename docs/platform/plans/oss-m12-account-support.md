# Account and customer support design

Status: development-preview, R1 local draft. No activation, release, publication,
merge or adopter cutover authority is granted by this page.

## Outcome, placement and ownership

Contribute the existing account/support composition through
`@openlup/platform/account-support` and its type-only `/contracts` entry, consuming
owner truth rather than creating subscription, payment, checkout, fulfillment or
invoice engines. The platform module owns neutral composition and its
compatibility; hosts own authentication, authorization, projection, private
profile/market fields, provider selection and transport mapping. Existing isolated
subpaths suffice: no topology trigger, new npm package, dependency or independent
release lifecycle is needed. Later phase APIs remain subject to actual driver fit.

R1's finite outcome is five typed envelopes, the unchanged read-stage diagnostic
slice, an injected account-read delegate and its reference/installed-consumer
witnesses. This is not extraction of the full account aggregate. Existing action
semantics remain unchanged; archive paging, richer detail/activity UI, exact
historical reorder, new support controls and erasure are excluded. SQL, migration
manifests, reviewed-forward pins, pgTAP changes, version preparation and donor
edits are outside R1. Later phases below are TODO, not acceptance added to R1.

## R1: contracts, unchanged read slice and early consumer

### Public boundary

The five envelopes are `AccountReadPort`, `Customer360ReadPort`,
`SelfServiceCommandFacade`, `OperatorRecoveryCommandEnvelope` and
`InvoiceAccessPort`, accompanied by explicit selected-capability flags.
Account reads preserve owner `userId` arguments, limit-only history requests,
nullability and thrown refusals. DTO type parameters preserve the actual supplied
owner data, including private extensions, without widening the public module into
a private schema. The host remains responsible for trusted context and ownership.

Contracts are self-contained, matching the existing contracts isolation rule.
Owner vocabularies are transcribed with their literal unions, field names,
optionality and readonly qualifiers. `InvoiceAccessPort` is structurally identical
to M09's `InvoiceHostPorts['accountHistory']`, including `denied`, `unknown` and
`unsupported` outcomes. It is order-scoped and supplies no archive or PDF transport.
Executed TypeScript equality checks compare the transcriptions with their actual
owners; real customer/support/subscription drivers must fit the specialized
ports. Packaged-owner checks live in the package port-fit test; checks importing
reference-source owners live in the reference binding test, both executing strict
equality and assignability assertions with TypeScript. No browser-unsafe subset exception was required. Method and commerce
command DTOs remain explicit host type arguments, not claimed driver selections.
The generic envelopes themselves are composition proposals, not new owner DTOs.
`commerceRecovery` and `configuredPurchase` each use
`AccountSupportCapability<"host_binding_required">`, reporting an absent commerce
binding explicitly. These additive flags belong to R1's new, unreleased surface
(ID-4); declaring them selects no commerce driver. R1 has no capability default
or descriptor that installs a selection.

The single appended module-graph entry is
`"account-support": { contracts: true, values: [], types: [] }`.
There are no owner-module edges to justify: both facade and diagnostic helper use
only local types/logic. Equality proof imports owners from tests; production
contracts never reach server or sibling module code. Browser bundling must emit
no runtime values and retain only the contracts entry as a metafile input.

### Unchanged contribution and reference binding

The read-stage slice is contributed from the existing
`server/domains/customers/customerAccountReadDiagnostics.ts` responsibility into
`packages/platform/src/account-support/customerAccountReadDiagnostics.ts` with
unchanged business logic. The old reference path re-exports the package helpers.
Wrapping preserves existing-stage errors and original causes; failure details,
unknown fallback, log prefixes, field selection and 300-character trimmed
provider diagnostics remain unchanged. No refactor is included.

`createAccountReadFacade` adds direct delegation to injected account and order
ports. It preserves callback receivers, arguments, returned object identity,
nulls and original thrown values; it introduces no defaults or retries.
`createM12AccountReadBinding` specializes those generics to existing reference
customer ports. It registers no route, capability, provider or serving change.
The smallest adequate alternative was direct injected delegation with the existing
diagnostic helper; no universal dispatcher, adapter registry or fallback was needed.

### Acceptance and proof boundary

| Required behavior | Discriminating proof |
| --- | --- |
| Diagnostic parity | Package witness covers wrapping/rethrow identity, unknown/staged details, safe bounded fields and both log paths. |
| Exact read delegation | Distinct arguments/results and receiver-dependent callback; all three null/thrown refusal paths. |
| Owner vocabulary and driver fit | Strict type equality plus assignability of actual owner drivers, executed by the TypeScript checker inside the package port-fit and reference binding tests. |
| Browser isolation | Empty browser bundle with exactly the contracts entry as input. |
| Reference specialization | Actual customer-port types and missing/refused reads in the binding witness. |
| Installed boundary | Cold consumer imports the packed facade, executes success/null/original refusal and rejects an invalid typed request in NodeNext/Bundler compilation. |

Existing root/package discovery selects these tests; no runner or live provider
access is added. API, release/pack/browser budgets, five-project compilation,
lint and whole-root tests remain required. Focused or dirty-tree feedback does
not replace the supervisor's committed-candidate package gates, coverage, native
review and final unsandboxed verification. Cumulative case/time and artifact
budgets are shared with subsequent M12 phases; no cap or gate is relaxed here.
Local commands, measured bytes/headroom and any environment-blocked proof are
recorded in the execution handoff, not asserted as release readiness here.

### Generated API companions and migration

The unchanged whole-package generator also regenerates these existing reports:

- `packages/platform/api/catalog.api.md`
- `packages/platform/api/commerce-server.api.md`
- `packages/platform/api/commerce.api.md`
- `packages/platform/api/fulfillment.api.md`
- `packages/platform/api/identity.api.md`
- `packages/platform/api/pricing.api.md`
- `packages/platform/api/promotions.api.md`

These are member order only, no declaration change. Adding the module changes
TypeScript declaration-emit enum/union ordering. An in-memory section comparison
of the baseline program without account-support reproduced the original reports;
comparison of regenerated sections preserves the declarations and changes only
member ordering. No generator/checker filter or hand-edited snapshot is used.
The approved R1 closure is the original 33 paths plus these seven generated
companions, 40 total; any other path requires a bounded lead decision.

Migration: none for existing callers. The two account-support exports are
additive. Existing enum/union members in the seven named API reports are
reordered because declaration emit order changed; no member is added, removed
or changed. The reference diagnostic import path retains the same exports and
observable behavior. No durable data or SQL migration is introduced.

## R2: bounded reads and Customer 360

R2 contributes neutral aggregate, stored-money order-history/detail, Customer 360
projection and M09 invoice delegates through the existing two package entries.
R1's facade, signatures and diagnostic slice stay unchanged. R2 is stacked on R1
commit `8a1875566480839c814a7bbb0b17fd35fda986c1`, its review base, and adds no
SQL, migrations or route mounting.

The aggregate retains two read stages, the 50-row subscription source bound before
visibility filtering, a 20-order store request, subscription assembly fan-out,
local-hour cutoff, eligibility precedence and capped action ordering. The order
reader resolves ownership before line/companion reads and uses commerce stored
money, parcel precedence, recovery evidence and shipping selection projections.
The Customer 360 projection retains pending-order/client recovery authority,
live-token evidence, optional/partial enrichment and bounded chronological audit.
Generic subscription `paymentMethodKind` pointer enrichment retains value, null
for a selected-empty source, and omission for an unread source; private pointers
remain outside the neutral DTO.
Private profile/catalogue presentation, lifecycle source mapping, next-charge
pricing and fulfillment evidence interpretation remain typed host selections.
Observed OpenLup/donor differences belong in the existing task register as
adoption-time injections; R2 does not repair or silently equate them.

Minimal production graph edges are values `commerce` (stored money and recovery),
`invoicing` (history/PDF owner), `shipping` (delivery selection), and types
`commerce/contracts` (money/recovery DTOs), `invoicing/contracts` (exact owner
aliases). No direct fulfillment import is needed: the existing interpreter and
alignment reader are injected. Core supplies parcel precedence through its public
fulfillment entry. Contracts stay self-contained/type-only. Exact equality and
real-driver fit are executed by TypeScript in the two allocated proof files;
private fields use documented subsets and host method/provider vocabularies stay
parameterized. The R1 graph/equality record above is historical to R1.

The account selection calls the new aggregate/history/detail/invoice exports.
The support binding calls the package read facade over the existing native scope
or an explicit managed scope. Authorization runs first; real machine governance
and scope cleanup are retained. Native account/history/invoice and managed
support are unselected by default. Owner M09 denied/unknown/unsupported results
and M08 native-unsupported remain distinct. The manifest is metadata only,
default-off/explicit-host with no routes; static refusals remain unchanged.
Host-fed read views use typed strings, preserve unknown/last-known evidence and
expand summaries without detail API calls. Reference source implementations and
all mounted routes remain unchanged; their package adoption is pending P7.
The diagnostic selection is independent of the journey selection after the same
actor governance, exposing existing typed search, segment history and v2 overview
reads with trusted operator identity. Reference line display explicitly picks
its five declared presentation keys before package projection.

Acceptance case accounting follows coordinator CD-7: every independent input/state
row is an executed case; only one behavior sequence shares a case. The measured
per-file counts are in the table below. Existing import-map cases gain edge/refusal
assertions without adding a new case. Existing owner witnesses retain pricing,
renewal, delivery-alignment, PDF-validation and control-snapshot responsibility.
The complete migration catalogue is required for PostgreSQL evidence; Docker
absence is a missing proof. Only the coordinator-approved case budget changes;
artifact and gate caps remain unchanged.

The smallest adequate implementation is four cohesive read modules, local DTOs
and typed injected owner/query/presentation seams. Pure facade delegation alone
would omit aggregate/projection extraction. Copying private drivers or a pricing
engine would add authority and maintenance cost without meeting neutrality.
API snapshots are produced by the unchanged generator; the generated companion
list below is part of the same R2 scope. Command/route/control work remains excluded.

Final verification is the whole-suite `verify-local --pgtap` on the committed
candidate; missing mandatory proof is a delivery blocker.

### R2 API-freeze conditions

The API-freeze read added two conditions: C1 binds every invoice download to the
principal's own order before bytes, and C2 checks Customer 360 authorization
inside the facade before any source read.

C1 uses the owned-history variant: invoice identity `orderRef` is a stored
business reference, while request `orderId` is the raw order ID. No normalization
is invented. `createInvoiceAccess` adds one account-history read before ticket
resolution; only a found history with matching accountRef/orderId containing the
requested document allows M09 to read artifact bytes. Missing/foreign documents
return `{ kind: "denied" }`. Download requires a bound owned-order history;
an unbound history reports M09 unsupported (`host_binding_required`) instead of
downloading. A history result of denied, unknown or unsupported keeps its distinct
M09 outcome before ticket/artifact IO; a thrown history remains unknown.
Existing own-order correction/PDF success remains covered, including differing orderRef/orderId values. The donor's real ownership
chain remains a host responsibility; the added read establishes document binding.

C2 adds required `authorize(): Promise<boolean>` to
`createCustomer360ReadFacade({ authorize, journey, summary, diagnostics })`.
Each method authorizes before any source call, returning `{ kind: "denied" }`
on refusal and otherwise preserving forwarding/null/throw behavior. The binding
creates a per-invocation facade: its authorization resolves the real actor once,
applies the existing governance, then opens only the selected scope. Diagnostic
search/history/overview stay independent of journey selection; disabled selection
never authorizes or opens a scope. No new authorization policy is invented.

Each condition has its own discriminating test, and the binding test checks the
once-only authorization. The smallest adequate change is the local history guard
and a shared facade authorization callback with lazy scope delegates; M09 and
mounted routes remain unchanged.

### R2 behaviour-class proof and measured cases

A behaviour-class sweep over every branch of the extracted read functions retains
the donor algorithms and adds independently executed witnesses for payment eligibility and aggregate status forwarding,
action/hold precedence, null/absent evidence, projection defaults and document
status ordering. Each newly closed behavior class has a targeted temporary
branch-removal/reordering falsifier. No production read algorithm changed.

The installed R2 witness runs its runtime scenarios once against the existing
packed fixture (the JavaScript is identical under either module mode) and reports
every independent scenario by name with observed/expected comparisons, so each
scenario is its own executed case and one failure cannot hide another. The
NodeNext and Bundler compiler checks and the missing-export/foreign-detail
falsifiers stay separately executed.

Measured R2 cases (coordinator CD-7: each independent input/state row is one
executed case; the M12 ceiling is the measured total at S1):

| R2 test file | Executed R2 cases | File duration |
| --- | ---: | ---: |
| `packages/platform/test/account-support/accountReadModels.test.ts` | 58 | 0.578 s |
| `packages/platform/test/account-support/orderHistory.test.ts` | 34 | 0.012 s |
| `packages/platform/test/account-support/customer360.test.ts` | 60 | 0.017 s |
| `packages/platform/test/account-support/invoiceAccess.test.ts` | 38 | 0.006 s |
| `server/runtime/public-reference/m12SupportReadBinding.test.ts` | 45 | 0.915 s |
| `src/public-reference/accountSupportReads.test.tsx` | 1 | 0.060 s |
| `scripts/packages/platform-cold-consumer.test.ts` (R2 rows) | 14 | 16.29 s |
| `tests/postgres/accountSupportReads.test.ts` | 5 | 7.33 s |
| **Total** | **255** | **25.21 s** |

Durations are printed whole-file times, not hosted medians. The installed-consumer
file is an existing file; its time includes 51 pre-existing cases and the real
packed-consumer setup. The PostgreSQL time includes container start. A temporary
branch-removal or reordering mutation fails exactly the selected row for each of
the 143 branch classes added by the behaviour-class sweep.

### R2 generated API companions

The unchanged generator regenerates the following sibling reports, member order
only, no declaration change. AST comparison permits only type union/type literal
member order and preserves all other declaration structure. These nine paths
are ID-3 generated companions, making the bounded total 35 + 9 = 44 paths.

- `packages/platform/api/catalog.api.md`
- `packages/platform/api/commerce-server.api.md`
- `packages/platform/api/commerce.api.md`
- `packages/platform/api/communications.api.md`
- `packages/platform/api/fulfillment.api.md`
- `packages/platform/api/identity.api.md`
- `packages/platform/api/invoicing.api.md`
- `packages/platform/api/pricing.api.md`
- `packages/platform/api/promotions.api.md`

## R3: self-service composition

R3 composes the existing donor routing behind `createSelfServiceCommandFacade`.
It returns the instantiated R1 `SelfServiceCommandFacade` exactly. Every returned
lane guards the host-verified principal; typed/raw commands require the supplied
clientId to match context.clientId (missing, undefined, null or foreign refuses
before any owner call).
Owner results, nulls and errors pass through by identity. Preview never authorizes
execution; apply never previews or supplies payload fields or keys.

ENV-R3-1 (integrator ID-9) is the approved envelope delta against R1:

- Before: required `capabilities`, `managedSubscription`, `nativeRawSubscription`,
  `nativeSubscription`, `profile`, `paymentMethod`, `commerce`, `recovery`.
- After: required `capabilities: AccountSupportCapabilities` and every output
  lane: `managedSubscription`, `nativeLegacySubscription`, `subscriptionControl`,
  `nativeRawSubscription`, `nativeSubscription`, `profile`, `paymentMethod`,
  `commerce`, `recovery`. R1's generic order, member names and parameter lists
  remain. Each method's prior result union adds `AccountSupportLaneUnavailable`:
  `"unsupported"` for paymentMethod, `"host_binding_required"` for every other
  lane. This is the unsupported arm of `AccountSupportCapability`, with exactly
  `{ supported: false, refusalCode }`. Input lanes remain optional; absent means
  not selected. nativeLegacySubscription uses managed previewAction/applyAction
  DTOs; subscriptionControl exposes getSnapshot(userId). The trailing defaulted
  generic `ControlSnapshot = unknown` retains the host snapshot type, including
  nullability; getSnapshot now returns `Promise<ControlSnapshot |
  AccountSupportLaneUnavailable<"host_binding_required">>`. Existing twelve-argument
  consumers retain their parameter lists and trailing default.

Every method guards the principal before returning an unselected-lane refusal.
PaymentMethod returns the host paymentMethodSetup refusal by identity; commerce
returns commerceRecovery by identity. Other lanes use one frozen
host_binding_required constant. Supported paymentMethodSetup requires paymentMethod;
supported commerceRecovery/configuredPurchase require commerce. Supported
subscriptions.genericBundleCommands or commandBoundReceipts requires at least one
selected managed, native legacy, native raw or native typed command lane.
Support claims without a selected lane and incomplete selected
lanes refuse customer_self_service_lane_configuration_required. Graph mismatch
refuses configuration.

Scope: package-only composition in donor order, with repricing, quote policy,
authorization and error construction injected by the host. No browser extraction
or activation. The raw M10 preview projection is checked before a host sees it.
Account-support source imports no owner types, so the module-graph entry stays
unchanged; installed command proof follows both entry points' JavaScript and
declaration imports. Imports stay inside account-support or reach only the exact
entry files of its declared module edges and the package's declared dependencies.

Native routing preserves the donor transcript: principal mismatch calls nothing;
pause calls explicit pause only; update_bundle canonicalizes the ID and reads
hasSubscription before quote validation, throwing the host refusal when absent;
owned bundle edits call control; other actions keep control's refusal. Preview
and snapshot call their control methods. Neutral fixtures correspond to the donor's
customerSubscriptionPauseBinding ownership/pause/control cases. The default-off
reference binding mounts nothing. A45/A46 remain byte-identical reference handlers.

The smallest adequate composition delegates directly to existing owners and
uses local contract transcriptions; no owner type graph or module-graph edge is
needed. Packaged owner equality/fit runs in ownerRefusals; reference-source action,
preview, control, explicit-pause and bundle-control fit is executed with R1's tsc
pattern in m12SelfServiceBinding.test.ts. R1 portFit and account-read binding tests
remain unchanged and must pass.

Budget: CD-7 replaces the earlier case caps; the M12 ceiling is the measured
executed total, reported at S1. C1–C5 use separate cases for independent input/state rows;
only one behavior sequence shares a case. C7–C9 are three real-PG cases through
the facade, codec and native M10 store. C10 extends the existing installed consumer:
JavaScript/declaration imports stay inside account-support or reach only the exact
entry files of its declared module edges and the package's declared dependencies.
C11 still removes its callable. Measured counts
and per-file seconds are recorded with the module's stack record.

The unchanged API generator leaves two sibling snapshots changed from final R1:
`commerce-server.api.md` and `commerce.api.md` under `packages/platform/api/`.
These are disclosed generated companions: member order only, no
declaration change, proven by AST comparison normalizing union/enum member order.

R5 still owns native browser key retention and selecting existing host delegates.
Native profile/recovery start have no selected implementation; method setup only
collects a transient handoff. Results and refusals remain owner-owned.

### Follow-up register

- D1 — `server/adapters/postgres/customerSubscriptionControl.ts:99`: omitted native legacy addonLines become []; donor-identical; not fixed in R3.
- D2 — `server/adapters/supabase/customerSelfServiceIdempotency.ts:32`, `db/platform/migrations/20260808120000_subscription_lifecycle_rail.sql:254`: legacy replay lacks full-command conflict/immutable response; donor-identical; not fixed in R3.
- D3 — `server/adapters/supabase/customerSubscriptionFacade.ts:142`: recovery start ignores the idempotency key and rotates before separate requeue; donor-identical; not fixed in R3.
- D4 — `server/adapters/supabase/customerSelfService.ts:102`: profile update precedes the separate event write; donor-identical; not fixed in R3.

- M12-R3-F1 — native repair authorizeRecovery/scheduleRecovery composition:
  registered follow-up, not a cut. The donor native account graph does not serve
  repair; adding this lane would introduce behavior. It requires separate scope,
  authority and owner proof. R1 recovery.startPaymentRecovery remains a guarded host pass-through when
  selected and otherwise returns host_binding_required. A45/A46 token routes stay in reference source.

## CTL — supportAuthorityForwards admission

Status: development-preview control scope. This section covers only the M12 CTL
outcome; it grants no feature, release or activation authority.

The finite outcome is a separate fixed two-path support-authority admission class,
its two inert SQL fixtures and README, production admission/history integration,
and three proof cases. The approved closure is 13 paths, of which 12 change:
registry/checker, the existing admission and PostgreSQL test files, three fixture
files, migration/contract/contributor documentation, publication catalog and this
section. The source release contract stays unchanged; its digests are refreshed at
release preparation only. Canonical migrations, packaged SQL, the native manifest, shared rail and
catalog observers, M11 fixtures/pins, dependencies, runners, workflows and lint
rules remain outside CTL. R4 owns feature introduction after its required prefix.

Binding decisions retain native operator pause delegation to the M10 lifecycle
owner (`v_pause_enabled boolean := true`), with prepared-attempt pause and other
unsupported native subcases refused. Customer pause remains unchanged. The managed
class preserves the M11 checkout audit action and appends only the support email
action; managed M11 introductions precede the managed support introduction. The
native and managed recovery identities remain separate by rail, path and signature.
Native contact/link and remaining owner gaps are follow-up owner work, not CTL.
See the [class owner](../DATA_AND_MIGRATIONS.md#m12-supportauthorityforwards).

Simplicity pre-check: extend the existing lexical reader and approval/history
routes with a fixed inventory and a local finite catalog proof. Reusing an old
class would widen its contract; a new SQL parser, runner or shared M10 observer
exception is unnecessary. Hashes identify bytes; real PostgreSQL catalogs and
rollback are the semantic oracle.

Budget used: three new required cases, one admission/refusal table and one finite
catalog/rollback lane per graph, from the shared CTL/R4 ceiling of 14 cases / 8.0 s
(CTL three, R4 eleven). The admission lane also proves the actual queue and release
routes. Measured runtime and unexecuted PostgreSQL obligations belong in the task
handoff; this allocation is not a timing PASS. The supervisor owns commits,
mandatory signed native review, PostgreSQL execution, integration and delivery.
No local uncommitted implementation result establishes admission or publication.

## R4: operator recovery

TODO: audited operator command composition after applicable owner handoffs and
separately admitted control/forward evidence. Preserve partial results and refusals.

## R5: reference composition

TODO: selected browser/API/owner/store paths, readiness, one executor, M04 notices
and optional enrichment fallback after applicable M11 dependencies land.

## S1: coherent final package set

TODO: cumulative artifacts/tests, unchanged witnesses, migration/cut register and
owner review. Release and adoption require their own authorization and evidence.
