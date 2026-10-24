# Changelog

Notable changes to this public-source workspace package are recorded here.
“Unreleased” means no npm version carries the change yet; immutable OpenLup
source previews may already ship some changes, and their release notes say
which. Declaration snapshots track candidate drift, not a stable API or
SemVer promise. This file keeps the current release and the two previous ones;
earlier releases are recorded verbatim in `packages/platform/CHANGELOG-HISTORY.md`
in the source repository.

## [Unreleased]

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

## [0.23.0]

- Publishable on the npm `latest` dist-tag as `0.23.0`, from tag
  `openlup-platform-v0.23.0`.

- Add `approveTrackingUrl` inputs to `verifyAndNormalizeFulfillmentObservation`,
  `PostgresFulfillmentShipmentSpineOptions`, `FulfillmentAdapterConformanceSubject`
  and reconciliation `trackingCodecs`. Under the strict default, provider tracking
  URLs persist only with host approval and must be query-free and credential-free
  HTTPS; host-built tracking URLs pass unchanged, including query strings.
- Existing `reconcileFulfillmentObservations` callers now receive row-local unknown
  readback failures (`ok: false` with `failures`) while recognized rows still
  process.
- Observation ingest (`verifyAndNormalizeFulfillmentObservation`, the native
  `recordObservation`, `reconcileFulfillmentObservations` and
  `runFulfillmentReconciliationPage`) now applies the durable-sink sanitizer: provider-derived
  references outside the opaque reference rule (for example `#1001` or
  `ORD/2026/1`) are stored as null or redacted and counted instead of verbatim,
  and `firstReceivedAt` must be an RFC 3339 timestamp with an offset; other
  values fail ingest or the reconciliation row. A correlation refused to null can
  be quarantined as `missing_correlation` in reconciliation.
- Fulfillment reconciliation inputs replace `readLocalFulfillmentState` with
  `readLocalFulfillmentStatus`, `latestStatusOccurredAt` and `readHandedOverAt`;
  migrate host persistence implementations to these three reads.
- Add exported page observation contracts and `runFulfillmentReconciliationPage`
  for host-owned scheduling, checkpoint resume and HTTP/ledger result projection;
  exact lookup remains separate. `providerCalls` counts logical page-port reads,
  including failures and exhaustion, separately from transport retries.
- Add redacted dispatch transcript/mapping fields, typed operation errors,
  acceptance recovery evidence and provider-status occurrence evidence. Existing
  unchanged stage/live dispatch identities retain their stored evidence for native replay.
- Migration: shadow drafts/attempts recorded by `0.22.0`'s native dispatch store
  do not replay after this change: shadow now hashes the local candidate rather
  than the provider-prepared command. Claim may consume a remap or raise
  `fulfillment_dispatch_remap_exhausted`; an existing attempt may raise
  `fulfillment_attempt_key_conflict`. Complete or abandon such drafts before
  upgrading. The `0.22.0` native dispatch store has no adopter; no compatibility
  transition is supplied.
- D2 KEEP-GAP: native `fulfillment_dispatch_finish` drops rejected/unknown error
  detail; durable retention is a scheduled SQL follow-up.

- Compatibility: `getStock()` and `getStockMovements()` now return a row union;
  consumers must discriminate rejections with
  `"kind" in row && row.kind === "rejected"` before reading observation fields.
  Provider read failures now return failed worker results (`ok: false`) with
  persisted `providerError` diagnostics when the provider supplies a typed failure,
  instead of throwing. Hosts can map those
  failures to HTTP 502; terminal cursor-write failures still reject.
  Cursor reads, running-cursor writes, local stock/class/reservation reads and
  stock/evidence writes or SKU evidence resolution now also resolve `ok: false`
  instead of rejecting when a terminal failed cursor can be persisted.
- `SyncCursor` adds optional `syncRunId`, `counts`, `items`, `alerts`, `staleSync`
  and `error`, worker results add `rejected`, `items`, `providerError` and `refusal`,
  and `fulfillment_stock_sync_cursors.error_code` now stores safe operation reasons
  (including `operation:SQLSTATE`) or typed provider/admission reasons instead of
  the generic `io_failure`.
- Mixed valid/rejected batches with valid stock rows succeed, retain rejection
  counts and diagnostics, evaluate/resolve alerts for valid SKUs and advance
  `lastStockSyncedAt`; an empty stock response is also valid, but a nonempty stock
  response with no valid stock rows is malformed and non-retryable even with valid
  movements, preserves prior coverage gaps and cannot resolve stale alerts.
  Typed disabled, not-ready and bad-identity refusals retain their original reason
  and retryability in the worker result and cursor.
  Blank stock SKU references are skipped before persistence; stale-sync recovery
  resolves after the terminal cursor, with cleanup failure preserving success.
  Stock and movement rejection diagnostics carry a `kind` discriminator.
  Stock-sync redirects are non-retryable, report `redirect_refused` and make only
  one GET attempt; exhausted stock network reads remain retryable through the stock
  failure projection. Product-sync retains the base client diagnostics and retry
  behavior, including `retryable: false` after exhausted network reads.
- Stock-sync alert fingerprints now contain only `requestKey`, `skuRef` and
  `thresholdKind`: changing quantities, severity or run evidence under the same
  key returns `replayed: true`. Different SKUs or thresholds use different keys;
  a changed identity under a reused key still conflicts.
- Closed the scheduled KEEP-GAP for stock alert refresh/reopen with native forward
  `20261022165000_fulfillment_stock_evidence_replay_reopen.sql`. Matching-identity
  replay reopens the alert, refreshes severity/quantities and clears `resolved_at`;
  identity mismatches retain SQLSTATE `23505`.

Migration: install the complete native catalogue through `20261022165000` before
stock adoption. The package descriptor and SQL asset project that same forward;
replay preserves the row identity, first-seen time and historical resolver run.
There is no managed forward or legacy fingerprint rewrite.

Migration: alert rows written by 0.22.0's native port carry the earlier whole-input fingerprint; subsequent writes under those keys conflict with SQLSTATE `23505`, and resolve only marks the row resolved while retaining its key and fingerprint, so it does not clear the conflict. Legacy fingerprints are documented only; this change does not rewrite them.

- Fulfillment ingress exposes receipt IDs, a host-neutral HTTP result mapping,
  counted correlation/timestamp/tracking refusals and persisted safe superseded
  causes. The opt-in adapter preserves donor webhook key bytes and defaults to
  strict opaque references. Adopters can explicitly allow wider reference shapes
  through `observationCodecs.approveReference`; tracking URLs retain their strict
  default policy. `carrierRef` now stores the service-derived lowercase carrier
  prefix by default, or the safe kind returned by `normalizeCarrier`, and effects
  receive that same value as `carrierKind`. Both are null when no kind is available
  or service evidence is refused; raw provider carrier codes have no fallback,
  matching donor deduplication. Strict timestamp validation applies only at
  webhook ingress, accepting compact offsets and local timestamps as before;
  reconciliation and stock-movement timestamp parsing retain PR2 behavior.
  Hosts retain referenced raw evidence.

Migration (observation ingress): donor-format colon identities remain the
compatibility target. Observation receipts/effects recorded by 0.22.0's native
stores under package digest keys are not recognized under the incumbent colon
keys, so retrying such an event can apply tracking again. Replaying a superseded
receipt processed by 0.22.0 fails with `fulfillment_observation_outcome_conflict`.
Drain in-flight observation retries before upgrading. No bridges or aliases are
provided for these native rows. Wider incumbent correlation/tracking references
require an explicit adopter allowlist; the default refuses and reports them.

Close the scheduled native stock-evidence refresh/reopen gap with forward
`20261022165000_fulfillment_stock_evidence_replay_reopen.sql` and its byte-identical
fulfillment package projection. Matching fingerprints refresh severity and nullable
quantities, reopen status, and clear `resolved_at`; identity, first-seen time and
historical resolver metadata survive. Existing-row replays and resolution serialize
on the row lock. Fingerprint mismatches still raise `23505`.

Migration: install the complete canonical native catalogue through `20261022165000`
before stock adoption, preserving its immutable ledger prefix. Sparse package SQL
is not a standalone install chain. The managed baseline already has this behavior.
Legacy 0.22.0 whole-input fingerprints are not rewritten and still conflict with
PR1 identity fingerprints, including after resolution.

- Add experimental invoicing declarations and explicit default-off capability selection, preserving exact absence, uncertain effects, correction identity and owed-duty visibility.
- Freeze host fiscal/facts/seller/money, registry, artifact, delivery, payout-item and safe account-history seams without installing a worker, store, provider or route.

Approve only the exact frozen M10/F17 native and managed SQL packet through a separate forward-control class, with inert fixtures, refusal plants and a required real PostgreSQL/pgTAP catalog gate. This control adds no migration, runtime activation or new permission to an installation.

- Add experimental subscription contracts and exact server/browser subpaths, preserving schedule identity, graph transaction boundaries, deferred admission and explicit native capability refusals.
- Contribute the unchanged hosted cycle, refusal and durable failure mechanisms with injected policy and their characterization; preserve native captured-case protection through rollback until actual arrival.

- Add injected native renewal and retry stores and a native executor using the subscription ports; bind hosted charge/failure facades to the contributed mechanism and existing M07 policies.
- Type-level change visible to dev-preview consumers: `capabilities.retryRecovery` changes from `"unavailable"` to `"selected"` (asserted in packages/platform/test/subscriptions/portFit.test.ts).

Migration: Install native N1 through the full ordered manifest before composing the retry driver. Native declines can retry or recover the original obligation instead of stalling indefinitely (F16); exhaustion leaves an active subscription and open case with no next retry. Preserve ledgers on rollback. The initial binding preserves case-before-outcome order and atomic terminal/bookkeeping writes. An existing immutable receipt short-circuits initial terminal replay before settlement, rebinding or case propagation, preserving all later retry effects; no runner is activated and M07 native prepared-store parity remains unavailable.

Host obligations: establish explicit logical-cycle correlation before invoking the runner (including prepare/execute). Ordinary retries must use the frozen mandate/authorization; N1 does not bind an ordinary retry method, so the P8 retry driver or host must enforce this, with a composition witness added in P8. Prepared retries retain the existing non-terminal `retry_scheduled` disposition with no next dispatch date. Bare `failed` execution status without explicit failure evidence requires verified readback (or remains awaiting an ACK).

A host or driver must never call `openCase` after a replayed `applyFailure` receipt, and the P8 retry driver must add a zero-delta replay witness.

### Warehouse product-sync parity

A3 #311 restores product-sync parity and safe diagnostics in the opt-in warehouse
adapter, including product/pack projection and injected transport behavior.
It remains default-off with offline evidence only and no provider-account proof.

Migration: upgrade the complete core/outbox/platform set from `0.22.0` to
`0.23.0` for exact peers. Install the complete canonical native chain through
position 76 (`20261022165000_fulfillment_stock_evidence_replay_reopen.sql`),
including native N1, before selecting native stores. Sparse package SQL is not
an installation chain. Follow the shadow-draft, observation-retry and legacy
alert-fingerprint migration notes above; rollback preserves the forward ledger.

### Experimental stages: no adopter activation

M10 subscription renewal/retry is **EXPERIMENTAL, INCOMPLETE and DEFAULT-OFF**,
not for adopter activation. This set includes P1 exports, the forward controls,
and P2 native renewal/retry stores and executor with native N1 SQL landed.
No runner is activated. G23 composition and N1 correlation, frozen authorization
and replay obligations remain pending: compose admission before any new cycle,
bind a logical cycle before prepare/execute, enforce frozen authorization on
ordinary retries, and never open a case after a replayed failure receipt.
The later retry driver still owes its zero-delta replay witness.

M09 invoicing capability selection and type-only contracts are
**EXPERIMENTAL, INCOMPLETE and DEFAULT-OFF**, not for adopter activation.
There is no invoicing SQL, store, worker, provider or route in this stage.
Installing the set does not register subscription or invoicing routes, workers
or a renewal runner; host composition remains explicit.

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

## [0.22.0]

- Publishable on the npm `latest` dist-tag as `0.22.0`, from tag
  `openlup-platform-v0.22.0`.

- Add eleven experimental reference-application support exports on the existing payment vendor subpaths. Reuse contributed execution, readback, mapping and diagnostic helpers; preserve the no-charge error class identity. Neutral payment exports and default activation remain unchanged.

Migration: none.

### Opt-in warehouse fulfillment example

Add the experimental, opt-in warehouse fulfillment entry described in the README behind the frozen neutral fulfillment ports: explicit injected I/O, prepared-byte binding, closed evidence, token observations and positive readback. Default-off; account readiness is host-owned. Exact absence, label create/void and cancellation remain unsupported.

Missing or malformed evidence refuses before credential resolution or HTTP.

Migration: none

### Offline warehouse fulfillment conformance

Prove the opt-in warehouse fulfillment entry described in the README with M08's offline conformance runner using injected
HTTP and synthetic fixtures. Cover dispatch replay and refusals, observation,
readback, stock and product sync, plus real-worker host-ledger fences after
restart and retention eviction. No provider-account or activation proof is claimed.

Migration: none

### Fulfillment contracts and status canon

Add experimental `fulfillment` and type-only `fulfillment/contracts` entries with
contributed status decisions, strict core parser bindings, concrete provider/store
ports and injected default-off capabilities. No adapter, executor, route or default
profile is activated; existing reference integrations remain unchanged.

Declared adaptation: empty or absent provider selection is a typed refusal in the
new package, rather than the donor host's implicit simulator alias. The donor alias
remains an open owner follow-up; this contribution does not change donor logic.
Private provider trace columns and registry/environment values are excluded from
the neutral package; persisted command fingerprints and opaque host keys are retained.

Migration: none (new surface; no existing reference behavior changes).

### Fulfillment paid handoff and fenced dispatch

Add the paid outbox handler/recovery classifier, injected dispatch worker and
separate durable command-ledger protocol through the new fulfillment entry.
Preserve one contact remap, opaque host keys, actual-command fingerprints,
readback/attempt/begin order and local accepted-proof repair without another POST.
Provider/money/inventory authority remains injected; no SQL, route or activation.

Approved port amendment G14 adds recordProviderAttempt to the new
FulfillmentStorePort. It records only sanitized prepared DispatchEvidence plus
mode/recorded status and opaque references, after authoritative claim readback;
same-key replay writes no second attempt and contact remap retains its own key.
No new named export or subpath is added by this method. Other contracts are unchanged.

Correctable draft re-claim must refresh fingerprint and evidence atomically.
Store conformance and native durability/fencing and SQL proofs remain later work.

Migration: none (new surface; contracts and orchestration land in one release).

### Fulfillment observation and sync workers

Add neutral observation effects, verified ingress, observation reconciliation,
tracking, stock/product sync, read-only evidence handlers and the offline
runFulfillmentAdapterConformance at the existing fulfillment entry.

Migration: approved G15 extends the unreleased SyncCursor with optional
coverageGapSkus (legacy absence reads as []). Only consecutive succeeded runs
confirm a reservation coverage gap; running/failed cursors clear the set.
Migration: approved G16 changes readLocalInventoryStock(requestedAt) to typed
unaggregated lines with skuRef, quantity balances, fulfillable, locationStatus,
lotStatus and expiresAt. The worker filters/sums at the captured clock; expiry
exactly then is excluded. Inventory authority and the provider stock-sync shape
are unchanged.
Migration: approved G17 adds inline localPersistence: ingress records eventKey
receipts preserving firstReceivedAt and marks processing idempotently;
reconciliation reads local status/latestStatusOccurredAt/handedOverAt. No named
persistence type is exported. Durable replay and processing remain host obligations.
A superseding conflict returns superseded but persists only processed status,
without a dedicated superseded-reason field.

Correlated ingress requires a nonblank observation or dispatch external reference
before acceptance/status/effects/processed mark; failure leaves the receipt
unprocessed. Stock-contention annotation is best-effort before the original stock
failure is rethrown; recovered-picked receipt diagnostics remain typed. Effects
retain stock → handover → tracking → invoice and callback/throw order.
Reconciliation fails the run on unknown readback and projects unmapped correlation
evidence before host calls. Product evidence reads retain safe authorization/read
refusal detail. Private codecs, keys, carrier URLs and provider errors stay
host-owned; typed evidence replaces raw payload pass-through. The conformance
runner accepts adapter-owned offline subjects and returns sanitized evidence;
fixture checks do not establish durable store atomicity or arrival alignment.

### Fulfillment native persistence and delivery alignment

Add native shipment, evidence, stock, recovery, dispatch, paid-handoff and
alignment stores through the existing fulfillment entry. Sparse migration
projections bind native units 5/27/51/73/74; install the complete catalogue.
Coverage-gap cursor state and received/status/processed evidence are
durable, while local inventory lines and contact preparation remain explicit
host inputs. Native 3pl acceptance uses a dispatch evidence receipt and preserves
the cancellation fence without inventing an owned label or physical packing.

Native admission: overdue-delivery admission guards only NEW cycle
admission/insert, matching the donor's guard_cycle_insert. Existing-cycle retries
through renewal operations and dunning bypass admission and neither mint nor
consume a one-use receipt. No retry_scheduled state or payments lifecycle change is
introduced. Native continuity requires the complete canonical migration graph,
real-PostgreSQL installation, replay and access-control checks.

### Fulfillment operator lifecycle and customer delay projection

Add host-owned operator and replacement handlers through the fulfillment entry.
Mutation callbacks require actor attribution and idempotency keys; the host owns
atomic replay receipts and replacement eligibility, reservation and hold effects.
Native bindings return a shared typed unsupported refusal without writing.
Customer delay projection keeps absent cases distinct, hides aligned history
when the schedule advances and never presents manual review as protection.
Label helpers preserve transient downloads and cleanup uncertainty. Current
parcel helpers retain sequence selection and companion attribution. These
exports mount no route, dispatch no parcel and attest no replacement arrival.

### Fulfillment commerce reads and recorded progress

Add host-owned commerce list/detail projections, a shipments overview handler and
typed read callbacks. Projected payment status passes through unchanged and
native reads return the shared unsupported refusal. Preserve opaque host overview
buckets and the legacy shipment-status facade. Progress completion requires
recorded milestones and uses the host-resolved customer step.

### Fulfillment internal simplification

Reuse the empty stock-balance constructor in aggregation and sync, and append to
private recovery groups without copying each growing array. Fulfillment results,
public contracts, key bytes and effect order remain unchanged.

### Fulfillment service composition and preparation

Add explicit default-off fulfillment services, a structural contribution and an
inert reference preparation binding. Authoritative source edits and redacted
context synchronization share the native dispatch and shipment locks. Missing
preparation refuses readiness. No route, schedule, renewal wrapper or automatic
dispatch is activated.

### Fulfillment presentation ownership

The status canon, actual-evidence tracking progress, current-parcel selection and
canonical fact parsers belong to `@openlup/core/fulfillment`. Platform keeps thin
compatibility re-exports and preserves its existing narrowed fact type names.
Fulfillment contracts re-export the shared status and progress types from core.
Server orchestration remains in platform. Browser code, including the host
status, fact and current-parcel facades and the account order views, imports
these helpers from core, so no browser graph loads the platform fulfillment
runtime.

Migration: existing platform imports remain valid; no application or schema
migration is required. Core exposes narrowed fact aliases with a `Canonical`
prefix while its generic fact exports retain their names.

Migration: upgrade core, outbox and platform together from `0.21.0` to `0.22.0` for exact peer pins. Install the complete canonical native migration chain through units 73/74 (`20261022080000_fulfillment_command_ledger.sql` and `20261022090000_fulfillment_delivery_alignment.sql`), never the sparse package projections alone. Before, these fulfillment services were host-owned; after, explicitly compose selected ports and default-off services. Nothing mounts routes, schedules dispatch or composes the native renewal runner automatically. Keep native alignment off or shadow until the G23 decorator is composed. Arrival alignment remains once and later-only; undelivered replacements remain outstanding, and replacement confirmation must only record actual customer arrival. Preserve G15–G17 cursor, receipt and local-status persistence when implementing host stores. An application rollback does not reverse the forward migrations; older runners refuse the extended ledger.

### Known limitations

- Portable dunning repair has no managed twin: exhaustion still pauses active subscriptions there; retaining active status needs a managed forward.
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
- The core fulfillment status map carries localized adopter labels; replace them with host-injected labels or internationalization keys before any stable-framework claim.
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
