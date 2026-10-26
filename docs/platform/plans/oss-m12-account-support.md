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

R4 provides managed operator recovery/contact/link composition and conditional
native audited support authority on the CTL predecessor's admitted SQL class.
It excludes serve mounts, provider factories, lint/module-graph changes, M11
edits, owner-engine rewrites, release and adopter cutover. RPC, transaction,
identity-move and link resolution use injected ports; reference selection is
default-off and recovery-path policy belongs to the host. Native lifecycle writes
use the existing M10 owner within one support transaction, without a second
lifecycle engine. SQL fixtures and installed/packed twins agree; the native
manifest's object-inventory digest must equal the selected-catalog measurement
printed by the native accountSupportUpgrade witness, which refuses a stale
manifest. Complete managed M11 introductions precede the R4 managed forward.

The unchanged generator rewrites only member order in the `returnApproveSchema`
`refundMode` enum in `packages/platform/api/commerce.api.md` and
`packages/platform/api/commerce-server.api.md`, with no declaration change.
These two paths are ID-3 generated companions, making the bounded total
42 + 2 = 44 changed paths.

ID-6 and RD-R4-1 preserve R1's managed OperatorSubscriptionRefusal/Result unchanged
and append NativeOperatorSubscriptionResult with the unavailable literal.
Optional OperatorOwnerReceipt carries actual owner evidence; delegated appliedBy
may be null, with no synthetic audit identifiers. Native linkSubjectAccount has
an explicit capability refusal. Only the two-key, two-commit link-then-subscription
sequence permits partial completion. Packaged-owner equality is checked in
operatorAuthority.test.ts and reference-owner equality in
m12OperatorRecoveryBinding.test.ts; claim/link additions have no older reference
owner equality claim. Under ID-11, native owner evidence stays server-side: the
reference wire retains the strict donor DTO and excludes ownerReceipt.

Managed email preserves admission → claim → lazy identity read/move/read →
settlement, including recovery after an already-completed identity move. Link
calls `void onLinked()` without a receiver before the separate subscription
command. Phone, recovery, absorption and subscription preserve owner results.
Native SQL capability refusals write only a support receipt and audit;
email/phone/link and typed address refuse before SQL. M03 native contact/link
receipt seams and M10 short band, operator address, unpaid/expired resume and
prepared-attempt pause parity remain CD-6 exclusions; R4 makes no I16/F32 parity
claim. CD-8 uses the native CHECK-admitted `payment_pending` status for residual
unpaid cycles, preserving the native outcome and managed predicate.

CD-9 keeps the link body identical across hosts: the donor uses INVOKER with
table-wide service_role access; OpenLup uses DEFINER with column-level capability
closure and the sibling migration function owner. CD-13a preserves the four email
definers (admit, claim, guard, settle) with `search_path = public, pg_catalog`.
The link definer uses `search_path = pg_catalog, pg_temp` and qualified application
references. All five revoke EXECUTE from PUBLIC, anon, authenticated and
openlup_mcp_reader. Callable entries allow only service_role; the trigger-only
guard also revokes service_role. No table grant is widened. Retired email
correction and recovery retain INVOKER authority.

Under RD-R4-4, machine/non-human, missing and inactive operator refusals leave
clients, support commands and audit unchanged. Unknown subjects, email expectation
conflicts, identities linked elsewhere and already-linked subjects preserve clients
and auth identities, write exactly one refusal receipt and matching audit for the
key, and change no other row/xmin. Outcomes are `refused` for `subject_not_found`
and `conflict` for `email_expectation_conflict`, `identity_linked_elsewhere` and
`subject_account_linked`. Same-key replay returns the stored refusal without writes.
The combined email entry refuses with requires_admission/55000; five existing
pgTAP companions use ordered admission/claim/identity/settlement, including phone
and subscription coverage. The runtime missing-subject/null-clock case uses
admission; machine and inactive operator assertions remain.

CD-7 counts each independent input/state row separately, superseding RD-R4-2's
CTL/R4 allocation. The R4 runner-case inventory is:

| File | Cases | Proof class |
| --- | ---: | --- |
| packages/platform/test/account-support/operatorAuthority.test.ts | 5 | Compiler owner equality, capabilities, decoding and recovery hashing |
| packages/platform/test/account-support/operatorRecovery.test.ts | 14 | Injected orchestration, failure/replay ordering and link sequencing |
| packages/platform/test/account-support/postgresOperatorAuthority.test.ts | 13 | Injected SQL executor, capability refusals, exact error mapping and hashing |
| server/runtime/public-reference/m12OperatorRecoveryBinding.test.ts | 6 | Compiler reference equality, default-off selection and injected bindings |
| src/public-reference/accountSupportRecovery.test.tsx | 2 | Partial completion and native refusal presentation |
| tests/postgres/accountSupportOperatorAuthority.test.ts | 23 | Real native PostgreSQL: owner delegation, eight independent refusals, rollback, replay, races and row/xmin deltas |
| tests/postgres/accountSupportUpgrade.test.ts | 2 | Real native/managed PostgreSQL: prefix upgrade, catalog/ACL delta and recovery replay |
| supabase/tests/account_support_contact_workflow_test.sql | 1 | Managed PostgreSQL/pgTAP: email execution ownership and settlement |
| supabase/tests/account_support_operator_authority_test.sql | 1 | Managed PostgreSQL/pgTAP: link/refusal authority, definer ACLs and clean/hostile service_role sessions |

The inventory totals 67 runner cases; pgTAP files count once each, rather than
once per assertion. The first five files have executed passing cases; the real
PostgreSQL and pgTAP entries identify database proof obligations, not a database
PASS inferred from injected tests. The existing cold-consumer case verifies packed
consumption and refusal propagation without adding a runner case. Existing M10
subscriptionCommandLifecycleCases, M03 postgresAccountLinkStore and M08
fulfillmentDeliveryAlignment proofs are reused. The cumulative M12 ceiling is
125 cases; timing serves module cleanup, with extra speed work only for an
exceeded existing timeout.

## R5: reference composition

R5a supplies the inert browser/API/owner/store composition, readiness guards,
one selected executor and M04 notice delegation described below. Selected M11
commerce composition and managed integration proofs belong to R5b.

## S1: coherent final package set

TODO: cumulative artifacts/tests, unchanged witnesses, migration/cut register and
owner review. Release and adoption require their own authorization and evidence.

## R5a: inert reference composition

R5a contributes `createAccountSupportBindings`, `createAccountSupportServices` and
`createAccountSupportContribution` without mounting the static or subscription
reference. It captures one host-selected graph and operation inventory, guards
each distinct callable once, and shares that wrapper across service, port and
route aliases. A route whose callable is absent from the operation inventory is
invalid configuration. Each enabled entrance observes readiness again; disabled
entrances call neither observer nor owner. Null selected operations remain null
and stay in the contribution's required ports, allowing Core to refuse them.

The schema helper unions selected owner requirements and additional objects under
the host's complete catalogue identity, preserving overloads. A command-only M10
selection requires preview and apply without constructing a renewal runner. The
native composition uses R4's
`customer_support_apply_subscription_action_v1(uuid,uuid,text,jsonb,integer,text,timestamp with time zone)`
and the existing support/owner ledgers. Readiness proves catalogue facts; owner
authorization, transactions and receipt replay remain separate obligations.

The operator subscription route wraps one R4 executor with the donor BFF metadata:
`contractVersion`, `action: "apply_subscription_action"`, `subscriptionAction` and
`subscriptionId`. ID-11 preserves the strict donor wire DTO: only donor outcome
fields are serialized, including decoded ISO timestamps and explicit nulls.
Optional `ownerReceipt` stays on R4's server-side result. The native in-band
`operator_subscription_authority_unavailable` refusal throws the donor's
`OperatorSubscriptionAuthorityUnavailableError`; other R4 errors propagate.
Applied, replayed, noop, refused and conflict responses pass through the real
browser response parser without field removal. SQL's internal action and
timestamp text are distinct from the BFF DTO; R4 result types remain unchanged.

The browser recipe accepts four already authenticated elements and explicit host
paths. Existing customer clients and HTTP handlers cross the guarded route,
preserving owner money and command keys, results and refusals. Hosts own
credentials, authentication and transport mapping of admission refusals; the
recipe installs no HTTP dispatcher. R2 and R3 are predecessors; R5a consumes
their account-read and self-service seams without changing their contracts.

Commerce is an injected nullable callable record: a null record/member returns
`unsupported/host_binding_required`, with no M11 import. R5a selects neither
A47–A51 nor A94/A95 nor the checkout continuation of A130/A131.
`commerceRecovery` and `configuredPurchase` remain unsupported; existing purchase
resume/discard behavior is unchanged. M10 lifecycle descriptors delegate to M04
with the original message key. R4 queues its own payment recovery notice; M12
adds no second effect consumer, worker or scheduler. Selected M11 commerce and
managed composition proofs are excluded from R5a and belong to R5b.

The envelope comprises thirty eligible paths; R5a changes 26 and leaves these
four unchanged: `config/public-reference-capability-manifest.json`,
`eslint.config.js`, `packages/platform/api/account-support-contracts.api.md` and
`scripts/packages/eslint-import-map.test.ts`. Implementation/API/plan paths
introduced by R1 are modifications; the changes fragment is `m12-r5a.md`.
The source-release snapshot, owner contracts, module graph, SQL and versions
are unchanged. Existing exports and companion content are preserved; API report
changes are confined to account-support and composition, with no generated
sibling declaration changes. R5a preserves CD-13a's predecessor definer posture:
the four email definers retain `search_path = public, pg_catalog`; the link
definer retains `pg_catalog, pg_temp` and qualified application references.
All five deny EXECUTE to PUBLIC, anon, authenticated and openlup_mcp_reader;
callable entries admit only service_role, and the trigger-only guard also denies
service_role. No table grant is widened.

CD-7 counts each independent input/state row separately. The executed R5a
inventory expands the eighteen-case forecast to thirty-eight runner cases:

| File | Cases | Proof class and executed cases |
| --- | ---: | --- |
| packages/platform/test/account-support/bindings.test.ts | 5 | Injected owners: B1 success/error, B2 null record/member, B3 unchanged owner unsupported result |
| packages/platform/test/composition/accountSupportContribution.test.ts | 4 | Contribution/Core readiness: C1 metadata, missing port, missing owner, duplicate route |
| server/runtime/public-reference/m12AccountSupportBinding.test.ts | 15 | Injected reference composition: R1–R6, unselected-route refusal, commerce type correlation and seven operator wire/error cases |
| src/public-reference/accountSupportRoutes.test.tsx | 3 | Browser/client/HTTP composition: U1 read, U2 command success/refusal |
| tests/postgres/accountSupportComposition.test.ts | 1 | Real native PostgreSQL: P1 installed catalogue probe, guarded R4 API/store delegation, strict browser DTO, transaction, durable receipt and write-free replay |
| scripts/packages/platform-cold-consumer.test.ts | 10 | Packed consumer: K1 NodeNext/Bundler compilation and six runtime states; K2 missing export/no-op delegate rejection |

C2's empty/inert registration assertion is covered by C1 and R6. L1/L2 reuse
`packages/platform/test/account-support/contracts.test.ts` and the generic module
type/value/deep-import matrix in `scripts/packages/eslint-import-map.test.ts`;
these add no R5a runner cases. No behavior rows are merged to meet the forecast,
and no new test file requests a timeout above existing integration setup bounds.

P1 is real PostgreSQL proof, not an injected executor test. R5a adds no pgTAP
file. The reused R4 proofs in
`tests/postgres/accountSupportOperatorAuthority.test.ts` and
`tests/postgres/accountSupportUpgrade.test.ts` exercise real PostgreSQL;
`supabase/tests/account_support_contact_workflow_test.sql` and
`supabase/tests/account_support_operator_authority_test.sql` exercise managed
PostgreSQL/pgTAP, including CD-13a ACL and hostile-session checks. Those
predecessor proofs are separate from the thirty-eight R5a cases; injected,
browser and packed-consumer cases do not establish database proof.

## R5b: select commerce, purchase stock and existing effects

The host constructs one `createM11CommerceReferenceBinding` over its raw, already
bound commerce record and supplies the result through the reference-only
`commerceOwner` option. R5b does not construct M11 or import its adapter graph;
a local structural type describes only the consumed selection members. It forwards that binding's services,
contributions, ports, routes and triggers once. The keyed entrance retains its
key/request/result relation and checks M12 enablement before delegating directly to the M11 guard; services
are never fed back into another M11 binding. Native reminder names remain
reserved by that owner (`commerce_duplicate_operation`). The host supplies the
reference checkout handler, recovery handlers/ports, selected stock read and
existing outbox registry through `commerceRegistry`. No second executor, dispatcher, installer, worker,
scheduler or stock allocator is introduced. Omitted/false enablement stays cold, with no forwarded commerce entries and null commerce reference handles;
unselected commerce retains `unsupported/host_binding_required`.

The host includes all account-owner and exact ATP requirements when constructing
M11, whose returned schema includes `m11CommerceSchema`. R5b unions that returned
schema with selected account-owner requirements, deduplicated by kind/name/signature
without hand-copying the M11 object list. The host supplies matching enablement
and a readiness observer covering that complete union to M11 and M12. The M11
guard observes the complete union before owner work. Descriptor projection in
the host's M11 construction preserves the existing registry's event
set/timeouts without running handlers. `commerceRegistry` is the same host
registry; it is not a new consumer or an activation signal. Host-bound recovery
and configured-purchase elements reach their selected clients at explicit paths.
Commerce handler outcomes, unknown stock and unsupported options pass through.
The capability manifest describes both entrances as selectable when the host
binds them; its default remains off and its route list empty.

The bounded closure is these eighteen eligible paths:

- `server/runtime/public-reference/m12AccountSupportBinding.ts`, its adjacent
  test and `m12AccountSupportSchema.ts`;
- `src/public-reference/accountSupportRoutes.tsx` and its adjacent test;
- `tests/postgres/accountSupportComposition.test.ts`;
- `scripts/packages/platform-cold-consumer.ts` and its adjacent test;
- `config/public-reference-capability-manifest.json`;
- the platform package's existing M12 R5 change fragment, `m12-r5a.md`;
- `docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`, `RUNTIME_AND_SELF_HOSTING.md`,
  `CANONICAL_CONTRACTS.md`, `PLATFORM_PACKAGE_REFERENCE.md` and this plan;
- `packages/platform/README.md`, `config/openlup-publication-catalog.json` and
  `CONTRIBUTING.md`.

The package source/barrels, API reports, composition source, ESLint edges, SQL,
migrations/registry and source-release contract stay outside this change.
Installed exports and package declarations do not change, so the cold consumer's
K1/K2 proof retains its meaning without extension. No tracked path is added or
removed, so the publication catalogue retains its existing classifications.
Nothing is mounted and this scope grants no external mutation or activation.

The four new executed-case definitions are R7 (host-built real M11 selection,
compile-time assignability to the local selection type, actual registry/descriptors
and no eager effect), U3 (one continuation's owner admission refusal then retry with
distinct root/latest order and client identities and original key), U4 (one
purchase's refused managed options then corrected retry preserving unknown ATP),
and P2 (real PostgreSQL reminder persistence/replay with unchanged row/xmin
snapshots of subscriptions, reservations and alignment). R7 belongs to the
reference-binding test, U3/U4 to the route test and P2 to the PostgreSQL test.
U3/U4 inject package-only selections so the app project never loads the M11
Postgres adapters; R7 and P2 construct the real M11 binding in server tests.
The retry steps share a behavior sequence; independent state rows must remain
separate cases. Real PostgreSQL execution remains required evidence.

Reuse by name rather than duplicating owner policy matrices:

- `selects abandoned reminder consent and terminal compaction with durable replay`
  and `refuses every native entrance before executor work when observation lacks
  the operator token table` in `tests/postgres/commerceComposition.test.ts`;
- `allows only named continuation state %s`, `separates expired policy from
  continuation`, and the existing expired-recovery/redeem/pay suites;
- `refuses unsupported options before RPC: %j` in
  `packages/platform/test/inventory/managedStockAvailability.test.ts`, and
  `W2 protects uncredited due demand and a 72-hour hold without double subtraction
  or a preview waiver` in `tests/postgres/newPurchaseStockNative.test.ts`;
- R5a's K1/K2 installed declaration/runtime witnesses and M10's unchanged
  subscription continuity, propagation replay and population-isolation witnesses.

M11 symbol map (paths relative to repository root; names are the dependency
contract, and line numbers locate their declarations in this selection's base):

| Symbol | Owner source |
| --- | --- |
| `createM11CommerceReferenceBinding` | `server/runtime/public-reference/m11CommerceBinding.ts:16` |
| `m11CommerceSchema` | `server/runtime/public-reference/m11CommerceSchema.ts:6` |
| `createCommerceContribution` | `packages/platform/src/composition/commerceContribution.ts:4` |
| `createReferenceCheckoutHandler` | `packages/platform/src/commerce/server/referenceCheckoutHandler.ts:9` |
| `CheckoutRecoveryOrderReadPort` | `packages/platform/src/commerce/server/checkoutRecoveryOrderPort.ts:37` |
| `CheckoutRecoveryTokenPort` | `packages/platform/src/commerce/server/checkoutRecoveryToken.ts:41` |
| `classifyCheckoutRecoveryTokenState` | `packages/platform/src/commerce/server/checkoutRecoveryToken.ts:24` |
| `createExpiredCheckoutRecoveryPolicy` | `packages/platform/src/commerce/server/checkoutExpiredRecoveryPolicy.ts:16` |
| `createManagedCommerceRuntimeOrderPort` | `packages/platform/src/commerce/server/commerceRuntimePort.ts:12` |
| `createManagedStockAvailability` | `packages/platform/src/inventory/managedStockAvailability.ts:13` |
| `createNewPurchaseStockAvailabilityPort` | `packages/platform/src/inventory/newPurchaseStockAvailability.ts:39` |
| `describeCoreOutboxHandlers` / `createOutboxDispatchRegistry` | `packages/platform/src/commerce/server/outboxDispatchRegistry.ts:121` / `:137` |
| `outboxCheckoutRecoveryEmailDescriptor` | `packages/platform/src/commerce/server/outboxCheckoutRecoveryEmailHandler.ts:39` |

Token classification, expired recovery and managed finalization remain with
those owners; their presence supplies no substitute for bound host ports or
managed installation proof. This selection changes no owner policy or public
account-support contract.
