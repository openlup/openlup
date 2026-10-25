# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

## [0.26.0]

- Publishable on the npm `latest` dist-tag as `0.26.0`, from tag
  `openlup-platform-v0.26.0`.

Managed dunning attempt replay.

Carry the exact applied failure attempt through renewal propagation. Managed
same/stale observations replay the canonical result; newer attributed failures
advance and revoke prior recovery authority, including used tokens.

Migration: `CycleChargeFailurePropagationPort.openDunningCase` now requires nullable `failedPaymentAttemptId`; update host implementations and callers to pass the applied transition's identity.
Migration: `applyFailedResult` may return `paymentAttemptId?: string | null`; return the durable applied attempt so propagation can forward it, including on replay.
Migration: managed hosts must pass exact applied-transition attribution to the new overloads. Fresh missing attribution refuses with SQLSTATE `55000`; do not substitute the current or prepared attempt. Already-applied donor schema/backfill requires the explicit host mapping in DATA_AND_MIGRATIONS.

Native attempt-replay parity remains REGISTERED with M10; these managed forwards
do not implement native parity or authorize host activation.

## [0.25.0]

- Publishable on the npm `latest` dist-tag as `0.25.0`, from tag
  `openlup-platform-v0.25.0`.

- Re-pin the pending M10/F17 control fixtures after landed M08/M09 without
changing either installation rail, the migration manifest or landed N1. The
16-entry packet has seven native and nine managed pins. Native X restores
ATP-counted late-positive stock recovery; Y filters paid retry candidates
before LIMIT. Fold command-preview receipt replay into uninstalled N2, keeping
apply unchanged. Preserve the historical 14-pin approval reader and exact
prefix, definition, statement, ACL and catalog controls. Real PostgreSQL
witnesses cover ATP, starvation, all 43 fresh command scenarios and raw preview
replay with no counts/columns/xmin delta.

No package SQL asset, export, runtime activation or external CI dependency is
introduced. The development-preview boundary remains.

- Fix uninstalled N3 normal_due pagination to exclude waiting/stock_secured cases before LIMIT, preventing normal-renewal starvation.

- Repair uninstalled N2 donor no-op truth for native bundle/resize, plan, package, add-on and same-UTC-day slide commands before repricing: preserve locked prices after catalogue changes, writing only the command receipt, with no quote, event or version increment. Native resize compares lines/cadence; portion mode/factor remain host-owned without native storage. Predicate-removal mutants cover every mapped donor action; apply stays unchanged.

- Audit pending M10 donor change and no-op semantics together. N2 plan edits
apply requested core lines; new add-ons normalize quantity, preserve cadence
and compare UUIDs by value. N3 preserves paused waits, filters eligible recovery
before LIMIT, binds frozen reads to the current active schedule, reports free
stock separately from own holds, and ignores closed/unpaid realization notices.
Real PostgreSQL tables cover applied state, no-op/refusal/replay and rolled-back
assignment mutants. Installed rails and N2 apply remain unchanged; channel
exposure/admission parity stays outside the frozen stock-seam claim.

- Close the 0.24.0 known limitation that managed dunning exhaustion still pauses active subscriptions.
- Land the reviewed managed M1/M2 prefix: refunds preserve subscription lifecycle and paid history; exhausted dunning stays open with NULL retry and active service until authorized same-cycle repair.
- Folded scope E-gate-replay-loop-landed-untested: retain the existing interleaving-aware catalog replay and add the Docker-free landed N1/M1/M2 witness.
- Folded scope D-earlier-pin-digest-unplanted: prove CI and release refuse changed earlier M1 bytes beneath landed M2.

Migration notes: Apply M1 then M2. Existing paused, expired and refund-cancelled history is not rewritten or reactivated. The existing first-cycle refund stock-release guard remains; later refund-evidence parity and stock-wait/winback changes are separate. No runner is activated.

- Add native N2 command preview/apply stores and a P1 command adapter with atomic future terms, actor/key/actual-command receipts and applied/replayed/noop/refused outcomes; preserve frozen current obligations and existing native callers.
- Type-level flip for dev-preview consumers: `NATIVE_SUBSCRIPTION_CAPABILITIES.genericBundleCommands.supported` and `.commandBoundReceipts.supported` change from `false` to `true`; command results now include `SubscriptionCommandRefusal`.

Migration: install N1 then N2 through the complete native manifest; preserve receipts on rollback. Accepted future prices use lock_until_edit, proration none. Address mutation and private introductory/graduation policy stay host-owned; native activation continues to require captured payment evidence.

Migration (C73, temporary limitation): managed `subscription_create_provisional_for_checkout` stamps an explicit timezone literal equal to today's `subscriptions.timezone` column DEFAULT. Adopters changing that DEFAULT must also replace the function until the scheduled follow-up forward follows the DEFAULT; no managed SQL changes here.

Migration: `SubscriptionCommandPort.apply()` may now return `SubscriptionCommandRefusal` (`outcome: "refused"`), so callers must handle it.

- Type-level change visible to dev-preview consumers: `RenewalPaymentRail.execute` adds an optional `failure` field for explicit failure evidence.
- A host or driver skips `openCase` after a replayed `applyFailure` receipt only when that rung's case propagation already committed; otherwise recovery must complete propagation. The P8 retry driver must add a replay/case-advanced signal and a zero-delta witness for replay after committed propagation.
- N2 preview follows the supplied core lines for plan-length changes (omitted lines retain stored expansion); new add-ons normalize missing/nonpositive quantity to one, add-on actions preserve cadence, and quantity updates/removals compare variant UUIDs case-insensitively.

Land the seven reviewed managed stock-wait/ATP and F17 refund-parity forwards.
Managed hosts can use the service-role SQL functions and pgTAP witnesses; the
package declares the SQL surface and keeps TypeScript stock recovery unavailable
because no managed adapter implements the stock-wait/availability ports.

Migration: apply the complete managed prefix through `20261024185100` before
calling stock-wait or refund-evidence functions. M4 extends M2's active/open
continuity with wait exclusion before LIMIT. M5 makes positive customer
cancellations immediately winback-eligible within 120 days, retaining episode
dedupe, and maps started/resumed notices. F17 accepts cumulative provider snapshots,
emits one refunded event on transition, and preserves M1 refund/lifecycle
independence. Keep captured obligations and receipts on rollback and disable the
host stock-wait driver first. SQL installs no scheduler or payment executor.

ATP protects active upcoming demand within 14 days plus live provider hard holds.
The exposure hook remains zero; current donor channel admission is deferred.
This is a development-preview SQL surface, not a composed managed TypeScript port
or a claim of advance future-cycle reservations or stable installation support.

Native stock-wait persistence, frozen discovery and stock-only refusal recovery
now have transaction-bound adapters. The native ATP/new-purchase read protects
hard holds and fixed 14-day soft subscription demand; the renewal allocator uses
the same seam. X restores late-paid released stock once, and Y filters paid and
settled retry obligations before LIMIT. Managed stock wait and runner composition
remain separate; native selection still requires passing real-PostgreSQL proof.

Migration: install the native N3, ATP seam, allocator, X and Y prefix in filename
order, with their package twins and regenerated selected-catalog-v2 inventory.
Migration: upgrading hosts must grant their native inventory-reserving runtime
role EXECUTE on public.inventory_available_to_promise(text,text,timestamptz,boolean)
and public.inventory_channel_exposure_quantity(text,text), plus SELECT on the
seam's underlying relations as listed in Data and migrations, before using the
updated allocator or N3 stock-wait paths.
`StockWaitStorePort.listCandidates` now returns `StockWaitFrozenCase[]`: discovery
may have no durable case yet. Hosts must retain its frozen snapshot and binding.
Frozen discovery requires the active current schedule; paused current waits remain open.
Deficits separate own reserved units from free ATP and subtract both for missing
units. Closed or pending-payment resume callbacks return null without writes; paid
fulfillment-pending orders can complete realization admission.
No advance reservation, physical coverage guarantee or one-time checkout writer
is introduced. No pause, payment execution or parcel-arrival fact is added.
Uncaptured stock refusals rotate on the operation selection timestamp even when
missing or stale stock prevents case creation, allowing replenished work through
a bounded candidate page.

M10 P6 + P8: composed subscriptions (development preview)

Migration: Additive `./subscriptions` facades are `createSubscriptionServices`, `createSubscriptionCommandExamples`, `createSubscriptionLifecycleMessages` and `subscriptionLifecycleTemplate`; hosts explicitly supply readiness, execution, commands and M04 delivery. No factory activates serving work. `SubscriptionLifecycleFact` is exported from this entry; `subscriptionLifecycleTemplate(kind, retryAttempt?)` preserves the installed payment-failure rungs (1, 2, otherwise 3). `runRenewalBatchRows` exposes the existing per-row error-result isolation for composed hosts.
Migration: Additive `./composition` entry `createSubscriptionContribution` describes exactly one selected subscription schedule; off supplies none. Hosts bind its callable to their existing population lease and observe the complete installed schema.
Migration: `createPostgresRetryStore` adds `failureProgress(operationId,key)`, returning receipt replay and committed case progression. The native retry driver completes interrupted propagation and skips already advanced cases; existing applyFailure/openCase signatures remain unchanged.

The inert native reference binding composes mandatory G23, dunning and stock wait.
Captured alignment cases retain authority under off. Prepared attempts reconcile
without re-execution; ordinary retries bind the frozen mandate and logical cycle.
M04 owns delivery; M12 owns aggregation. No SQL asset, serving swap, release or
managed TypeScript recovery is introduced. Native multi-cycle prepaid and M07
prepared-attempt-store capabilities retain their named unsupported boundaries.

## [0.24.0]

- Publishable on the npm `latest` dist-tag as `0.24.0`, from tag
  `openlup-platform-v0.24.0`.

- Require Zod `^4.6.6` to fix GHSA-mrhx-c7xc-m3w5; oversized constrained
  request collections fail before element validation accumulates errors.
- Preserve the observation adapter's accepted minute-precision occurrence timestamps and raw
  idempotency-key bytes with the updated validator; impossible dates still fail.

- Add the optional `runFulfillmentDispatchWorker.shadowCommandFingerprint` callback for a pure, local adopter command hash in shadow mode. Without it, shadow evidence still hashes the same `JSON.stringify(request)` bytes with SHA-256. The callback must return a lowercase 64-hex SHA-256 digest of the adopter's canonical command bytes, never command contents, credentials or contact data. The package accepts only strings matching `/^[a-f0-9]{64}$/`; invalid output or a throw returns a typed refusal with closed cause `adopter_fingerprint_invalid` or `adopter_fingerprint_failed`, without raw output, exception text or claim/attempt/evidence writes. Stage/live never invoke the callback. The fingerprint is used across shadow claim/readback/attempt, including mapped-attempt replay; shadow never begins, and live preparation must produce the same identity; shadow still performs no provider preparation, credentials lookup or POST.
- Preserve optional boolean `submissionAttempted` and `responseBodyRead` facts on typed dispatch errors and finalize evidence. `submissionAttempted: false` proves no provider submission was attempted; absence is unknown. `responseBodyRead: true` means the response body was read, including empty or malformed JSON; `false` means reading failed, and absence means there is no body-read evidence. Credential/request-construction failures include explicit non-submission proof; command validation/rebuild retains its closed `not_dispatchable` refusal. No raw body, exception prose or credentials enter these facts; durable projections admit only actual booleans.

Migration: existing callers need no changes. `shadowDispatchEvidence(request)` becomes `shadowDispatchEvidence(request, commandFingerprint?)`; omitting the new optional argument keeps the same evidence bytes and hash. These facts allow adopter classification without inferring uncertainty from retryability. Package classification remains unchanged: definitive rejections (including an unreadable HTTP 400 body) are `not_dispatched`; ambiguous submission and unreadable successful acknowledgements are `unknown`. No release, default binding, route, schedule or activation is added.

- Add inert native unsupported invoicing ports and runner-independent offline adapter conformance for exact recovery, parent identity, scoped absence, declared host capabilities and safe evidence.
- Document the invoicing design and host boundaries without installing workers, stores, fiscal providers, routes or activation.

- Extract invoice issue sequencing, snapshot/canonical line verification, unchanged allocation, payment evidence and handoff helpers into the existing invoicing entry; retain host payloads, keys, seller/tax policy and routing.
- Migration: compatibility callbacks preserve existing RPC/provider request bytes, issue fences and handoff descriptors. No native store, D7/O2 behavior, default provider, executor registration or activation is added.

- Add correction and reversal workers to the experimental invoicing entry, preserving durable correction identity, recovery, host event/key semantics and fenced outcomes. The reference host requires an explicit conforming correction bridge; its legacy vendor copy stays unchanged and unselected.
- Migration: introduce the two pinned managed v2/compatibility forwards with versioned adapter and pgTAP callers. Unkeyed attempted legacy corrections remain visibly unresolved for provider reconciliation. Preview correction references use correctionRef. Native forwards and runtime activation remain separate.
- See the [M09 forward owner](../../docs/platform/DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for sync-first settlement and permanent-failure parking.
- Registered limit: multi-reason / late-issue compensation can yield more than one full correction per invoice, as the incumbent does today.

- Add an experimental structural-executor native invoice store, a create/readback issue binding, separate native/managed migration descriptors, and six byte-identical sparse SQL assets. Read-only bounded discovery exposes duty/order IDs before facts are installed. Missing host fiscal facts refuse before writes; local-only document construction retains its previous behavior. Native fresh non-ready preflights settle before dispatch; stale preflight/finalizer results write no failure.
- Migration: append the three reviewed native duty/effect/payment forwards at positions 77–79 after the unchanged 160000/165000 prefix. Install the complete catalogue. Native child-document and managed base-row corrections have distinct descriptors. Seller revision and activation remain separate.

### Independent native invoicing duties

Experimental invoicing adds `collectInvoiceDuties` and
`createIndependentInvoiceDutyBinding` for explicitly invoked, separately committed
duty collection. Native fulfillment no longer waits for accounting readiness or
invoice requests. Managed dispatch behavior stays unchanged.

Install the full native catalogue, including 190000/191000 before the exact
reviewed 192000 payment-decoupling forward. Captured settlement and dunning
recovery survive invoice capture failure; retained paid/handoff facts support
later repair. New unlinked payment events retain `accountingRequested=false`,
including after independent issue; historical linked events retain their readback.
Use owed-duty readback for invoice progress. No payment
export, provider activation, scheduler registration or fiscal default is added.

- Extract invoice delivery, PDF validation, accepted-document synchronization, payout item recording and document-history/read helpers into the existing invoicing entry; bind the reference host facades through explicit callbacks.
- Migration: F8 retains A2 payout transport and exact settlement keys; the legacy batch/payment importer preserves donor calls and aggregate results, while package receipt reuse across item scopes is an identity conflict with continued processing and no extra write; distinct recorded receipts require an item-capable host recorder/resolver. F11 retains M04 content, recipient, locale, transport and uncertainty. F9 bounds reference consumers; F12 leaves runbooks and customer correction intent host-owned. Native delivery uses an optional host envelope projection over P4’s store; job store mode binds fenced terminal/backoff outcomes (whole seconds clamp 60..86400, absent/invalid 900, retryable:false parks); callback mode requires terminalFailure before claim; native history requires a safe owned projection. PDF downloads now refuse invalid bytes; the reference panel displays closed diagnostic codes without free-text provider errors. No SQL, activation, executor or fiscal-policy change.

Explicit invoicing composition and first-claim seller revision

PART A: `createInvoiceServices`, `InvoiceServices` and `createInvoiceContribution`
use the existing `/invoicing` entry. Host selection is default-off; readiness
precedes factories and claim. Native helpers compose the real P4/P5 store,
collection, delivery, sync and read-model implementations. Host-specific factories
retain auth, configuration, transport/query projection and the existing executor,
registry and lease. Targeted module runs refuse before leasing.

PART B — Migration: native 195000 and managed 195100 are forward-only,
byte-identical introductions of the approved CTL-M09-4 fixtures. Eligible
obligations freeze the seller at their first-ever durable claim, independently
for corrections; retries retain it. Previously claimed legacy obligations keep
execution-time fallback. Issued documents and installed buyer/line facts are
unchanged. Native reversals use the correction request branch; managed order
reversals preserve incumbent results through the seller request wrapper.
Unknown/unsupported seller reads and order-scoped managed corrections refuse
before claim. SQL replay conflicts surface as typed identity conflicts.

### Selection and installation boundary

Invoicing remains EXPERIMENTAL and DEFAULT-OFF. The issue/correction/reversal,
durable duty collection, native store, delivery/document/payout sync, safe history
and first-claim seller revision helpers are available for explicit host composition.
Select a provider and capability, bind host ports and establish readiness before
factories or claim; the structural contribution registers nothing itself. Fiscal
policy, ownership/authentication, M04 transport, artifact/history projections,
execution leases and route/job registration remain host responsibilities. No live
provider, fiscal acceptance or inbox-delivery evidence is established. Adopters
must not activate unselected or unready invoicing, or infer activation from SQL.

M10 subscription renewal/retry stages remain EXPERIMENTAL, INCOMPLETE and
DEFAULT-OFF, not for adopter activation: contracts, native stores/executor and
N1 SQL are present, but runner activation and the G23/N1 host composition,
correlation, authorization and replay obligations remain pending. Native delivery
alignment must remain off or shadow until the host composes the renewal runner
with its G23 admission decorator.

Migration: upgrade core, outbox and platform together from `0.23.0` to `0.24.0`
for exact internal peers. Install the complete canonical native migration chain
through position 80 (`20261022195000_invoicing_seller_revision.sql`), including
invoicing positions 77/78/79 (`190000`/`191000`/`192000`); P5 adds no SQL and P7
adds position 80. Sparse package projections are not an installation chain.
Managed installations use their own ordered forwards, including correction
`193000`/`193100` and seller `195100`; managed descriptor paths are catalogue
references, not files installed by the npm tarball. Preserve first-claim seller
snapshots and legacy fallback; there is no retroactive backfill or reversal of
forward SQL on application rollback. Retain the `0.23.0` shadow/observation retry
and legacy stock-fingerprint migration precautions when upgrading older rows.

### Limits closed by this set

- The earlier invoicing contract-only/no-SQL/no-worker surface limit is closed:
  P1b–P7 introduce explicit services, native store and helpers, with CTL-M09-1–4
  reviewed forwards at native positions 77–80 and the managed correction/seller
  forwards; see the [design boundary](../../docs/platform/plans/oss-m09-invoicing.md#p7-composition-and-seller-revision).
  Default activation and live fiscal/provider acceptance remain unclaimed.
- M08 stock-evidence replay/reopen was already closed in `0.23.0` by position 76;
  this set does not close its legacy fingerprint conflict or other M08 gaps.

### Known limitations

- Managed dunning exhaustion still pauses active subscriptions; retaining active status needs a managed forward. Native N1 lands the bounded retry/failure repair, with the host obligations below still pending.
- D8-1: native advisory v2 promo-code candidates/rejection details unavailable.
- D8-2: native mounted v2 issue/honor/fallback unavailable.
- D8-3: native acquisition-only mounted issuance/honor unavailable.
- D8-4: full native/managed eligibility equivalence unavailable.
- Bundle-1: independent DB human-only actor-kind enforcement absent natively; first in the native-backend parity round.
- Bundle-2: managed-equivalent actor-kind/email history absent natively.
- Bundle-3 closes injected-reader M05 mounted admin/feed readback only. Native new-purchase stock read absent despite P5a installed-store proof; deferred second after bundle-1 (owner 2026-10-21); readiness refuses.
- Bundle-4: incumbent real-PostgreSQL contention only; no exactly-once guarantee.
- Managed schema/pgTAP retain `44.404`; removal needs owner decision/forward; reference composition supplies it to app code.
- A1 offline only; account/hosted-time/owner TEST evidence unclaimed; `communications/klaviyo` verification-pending.
- M05 omitted opt-ins preserve defaults/outputs/read order/schedules/refusals/acceptance-token bytes/SQL.
- Native inventory adjustment unavailable; address writes refuse readiness. Flat-rate save needs selected port/Core readiness/applied-seed observation.
- Native shipping audit unavailable; handler swallows best-effort audit failure.
- Native flat-rate integer bounds (0 through host maximum; reference 100,000 minor units) use request schema, not DB CHECK.
- Managed ATP/forecast/dated-supply/pagination readback unproved/pending M06.
- Managed two-session locks/concurrency/uncovered compensation unproved/pending M06.
- Managed exact-prefix upgrade/ledger unproved/pending M06.
- Managed address idempotency/conflict/readback unproved/pending M06.
- Managed successful flat-rate read/save unproved/pending host authority.
- M06 stock-wait lifecycle/durable timing/staging controls retain C5/C6; busy/try-gate, continuity/flag/TTL transfers are dispositions, not PASS.
- Shipping national-registry fields/locale-specific `canonicalAddressKey` fold await M16 host market pack/key migration; reference shipping copy stays locale-specific until M16.
- Native durable prepared storage, method setup, absence reopen and cumulative refunds unavailable; no production installation parity claimed.
- Typed refusal-envelope forwarding unavailable (`failureReason` only); reusable registration needs host ownership resolution.
- Incomplete chargebacks stay refunds/unapplied: reclassification bypasses evidence validation into dispute apply; limited operator recovery.
- Audit compatibility still detects `chargeId`; refund operation identity/original money supply no typed charge identity.
- M07 follow-up: repair poll can clear host redirect; post-timeout verify never restarts polling; unlocalized poller; fixture builds/never calls handler.
- M07 follow-up: reference status route wrong-rail witness.
- M07 follow-up: explicit reference-route refusal for unsupported method setup.
- M07 follow-up: deployment-neutral disabled-verify reason.
- M07 follow-up: reference card normalizer missing-amount path; package settling evidence already requires positive money.

- Native delivery alignment stays off or shadow until a host composes the native automatic-renewal runner with the G23 renewal admission decorator. The decorator alone neither composes nor activates the runner.
- The core fulfillment status map carries localized adopter labels; replace them with host-injected labels or internationalization keys at the host presentation boundary.
- The warehouse adapter example is opt-in and has offline conformance only; no provider-account proof or activation is established. Exact absence, label create/void and cancellation remain unsupported.
- After an alignment extension, a deferred renewal operation at the old schedule remains claimed with no reader or reservation effect. Changed terms snapshots conflict under the existing snapshot-conflict rules.

Native parity remains host-owned at these seams. Missing native bindings use the shared `FULFILLMENT_NATIVE_UNSUPPORTED` refusal; no partial write or parity claim is implied.

| Amendment | Host-owned seam and native boundary |
| --- | --- |
| G18 | Replacement creation and atomic eligibility/replay receipts; native replacement callback refuses. |
| G19 | Operator mutations, actor attribution and replay receipts; native mutation callbacks refuse. |
| G20 | Customer alignment rows; native reader refuses, while the pure delay projection remains callable. |
| G21 | Commerce list/detail and shipments overview; native read callbacks refuse. |
| G22 | Authoritative preparation edits, authorization and replay receipts; missing preparation binding refuses before dispatch, after disabled/selection/readiness checks. |

- M08 parity D2 KEEP-GAP: native dispatch finish still loses rejected/unknown error detail.
- M08 parity KEEP-GAP: immutable stock snapshot/alert evidence storage is absent; cursor JSON is overwritten. Hosts retain referenced evidence.
- Stock-evidence replay/reopen is CLOSED by native position 76; legacy `0.22.0` alert fingerprints still conflict with `23505`, including after resolution.

### Invoicing registered limitations

These are notes carried from the landed design, not fixes in this preparation.

- M07 `payment_truth_readback` still joins `accounting_documents`: operator
  ACCESS EXCLUSIVE DDL or denied ACL can block/refuse the call. New unlinked
  payment events remain `accountingRequested=false` after independent issue;
  use owed-duty readback for invoice progress (PR #334).
- Managed multi-reason and late-issue compensation can create more than one full
  correction per invoice. A later finalizer can be fenced `claim_inactive`, leaving
  its row `processing`; failed/pending rows on already-corrected parents may never
  be reclaimed. Reconcile provider identity/evidence, including unresolved attempted
  legacy corrections. Broader reversal/manual arbitration needs a separately
  designed replacement forward (PR #329, #330, #348).
- An in-flight issue can still compensate outside the seller wrapper with
  `legacy_fallback`; latest-parent reselection retains incumbent behavior.
  Managed keys are scoped to invoice/provider/reason, and delegated void stores
  no key; native cross-order reuse refuses. Pre-wrapper native reversal-key
  retries can conflict after wrapper evidence is added (PR #346, #348).
- Managed paid/handoff contention (`55P03`) is a visible retryable no-effect
  refusal with no automatic adapter retry. Fail-soft dispatch can finish without
  an invoice request; durable recreation can require operator recovery and delayed
  shipped-without-invoice monitoring (PR #348).
- A bad host fiscal revision can refuse an entire scoped/provider batch. A null
  payment `providerRef` falls back to the fiscal provider: hosts must supply explicit
  payment identity. A failing `store.fail` aborts remaining leased work; retain
  lease recovery and host retry handling (PR #334).
- Reversed-duty fact installation can still report owed: read authoritative
  reversal/duty evidence, never treat that answer as permission to issue.
  Unsupported reversal and parked document/request residues remain visible and
  unclaimable; later fact installation/reversal retry can change their diagnostics
  (PR #332, #334; design phase obligations).
- Native corrections ride the issue batch; a separate correction operation without
  a host factory refuses `host_binding_required`. Unknown native seller selection
  currently maps to non-retryable unsupported; hosts must handle recovery explicitly
  (PR #348).
- Delivery visibility must exceed transport timeout. Fenced settlement, database
  failure or lease expiry can abort a batch and leave unsent leased rows uncertain.
  Retryable/unsupported transport diagnostics may project as `retryable`; counters
  omit projection failures/parked mismatches, so inspect durable status/error
  evidence. Malformed projections and permanently invalid PDFs can retry without
  an attempt cap (PR #332, #344).
- Reused settlement-receipt detection continues within one call only; it does not
  detect another item's reuse in a later run. Legacy host aggregates expose item
  conflicts through count differences; distinct receipts require an item-capable
  recorder/resolver (PR #344).
- Hosts retain accepted-document observation polling and safe history composition.
  `resolveDownload` must bind the document to the authorized order; the package
  ticket check compares `documentRef`. Opaque-reference filtering covers its listed
  schemes only (PR #344).
- Closed diagnostic policy reduces managed message-only/non-allowlisted errors to
  `unknown`; an empty/non-string earlier `code` can hide a later closed code. The
  separate OMS projection retains redacted free text. Missing-order cleanup can
  log error rather than warn with the same refused/discarded outcome (PR #344, #348).
- PDF content-type normalization retains OpenLup behavior; signature checks are
  stricter than donor ASCII decoding. `invoicePdfFilename` falls back to English
  `invoice`; supply host captions (PR #344).
