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

TODO: current account/history/detail/invoice and bounded Customer 360 projections,
with frozen owner money, unknown coverage and injected private enrichment.

## R3: self-service composition

TODO: owner preview/apply, accepted quotes and receipts, separate native pause,
payment-method/repair/profile delegates. Preview must never authorize execution.

## R4: operator recovery

TODO: audited operator command composition after applicable owner handoffs and
separately admitted control/forward evidence. Preserve partial results and refusals.

## R5: reference composition

TODO: selected browser/API/owner/store paths, readiness, one executor, M04 notices
and optional enrichment fallback after applicable M11 dependencies land.

## S1: coherent final package set

TODO: cumulative artifacts/tests, unchanged witnesses, migration/cut register and
owner review. Release and adoption require their own authorization and evidence.
