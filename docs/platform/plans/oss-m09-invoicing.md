# Invoicing module design

Status: development-preview design. The contract and offline conformance surface,
the issue, correction and reversal helpers, the managed correction forwards, and
the native store with its SQL projections are available for explicit host composition.
Explicit service composition is available; reference route selection and release
activation remain host decisions.

## Placement and ownership

Use the existing `@openlup/platform/invoicing` server entry and type-only,
browser-safe `@openlup/platform/invoicing/contracts`. There is no new package,
dependency, testing entry or composition export. Provider SDKs, wire payloads,
fiscal numbering and country policy stay behind host/adapter ports. The
[architecture owner](../ARCHITECTURE_AND_EXTENSIONS.md#invoicing-contracts) and
[package reference](../PLATFORM_PACKAGE_REFERENCE.md#invoicing-contracts) own the
current callable surface. The module has no cross-module import edges.

The host supplies frozen buyer/order/tax/line facts, seller, fiscal identifier,
tax and rounding policy, M07 money projection, storage/artifacts, registry lookup,
M04 delivery and M12 ownership/history. Missing parity is typed unsupported
before unsupported writes; no zero-tax native row or live catalogue reread can
replace missing fiscal facts. Keep original request keys and persisted create
identity distinct. Hosts own credentials, actors, retention, copy and authority.
Diagnostics use a closed diagnostic allowlist in the neutral contract.

## Facts, identity and outcomes

Facts retain revision, policy version, ordered lines and integer currency minor
amounts, explicit shipping/discount components, charged totals, dates and local
references. Legacy missing position kinds and order-money headers remain null.
Provider numbers are nullable and distinct from local invoice references.
Identifier/tax/rounding references select explicit host policy; no fiscal default
is installed. Registry lookup retains neutral identifier/provenance/evidence,
never overwrites saved checkout facts and is not a renewal prerequisite.

Readback is found, exact complete scoped absence, unknown or unsupported. Neither
silence, timeout, truncation, refusal nor unsupported lookup licenses create.
Issue/correction writes return issued proof, a closed refusal, unknown effect or
unsupported. Full reversal retains positive immutable BEFORE facts and zero AFTER
totals, stable correction identity and the expected parent. Local pre-issue void
is separate from remote void. A late issue must retain its external identity and
atomically enqueue one compensation; it cannot be erased by local reversal.

Policy suppression explicitly records channel-owned issuance or no-document
policy; operator skip retains actor, reason and key. These receipts do not invent
an invoice ID. The owed-duty projection preserves order, capture faults, duty and
parent/document identities, state, attempts, closed reason and lease chronology.
Ready remains owed and processing is claimed. Unsupported duties stay visible;
empty duties or `accountingRequested=false` never prove invoice absence.

## Designed execution boundaries

| Responsibility | Boundary |
| --- | --- |
| Paid/handoff capture | Durable independent source/key receipts converge on one base duty per order; a rescan anti-join avoids losing work while disabled. |
| Canonical projection | Preserve donor allocation/order/key behavior and explicit delivery; independently verify integer totals and injected tax safety. |
| Issue | Claim, local preflight, projection, fresh M07 read, second preflight, create/recover, fenced finalize. Unknown retries are readback candidates. |
| Correction | Persist identity before I/O; recover by correction/parent before another create; preserve positive historical BEFORE and separate child identity. |
| Native persistence | Request-before-duty locks, token/generation/lease fences, immutable revisions and exact success replay; no database transaction spans remote I/O. |
| Money/parcel continuity | Accounting failure cannot roll back captured money/dunning recovery or block physical dispatch; an owed duty remains durable and retryable. No M09 money/refund writer. |
| Clearance | Targets, observer, status record, accepted-artifact sync. Keep not_submitted/pending/rejected/accepted/not_required/unsupported separate; no submission or national mapping. |
| Artifacts | Validate transient PDF bytes before send; opaque persisted object/provider references are separate proof from download or signed URL. |
| Delivery | M04 owns content/transport. Preserve exact keys and uncertainty; acceptance is not inbox delivery and unknown send cannot retry blindly. |
| Settlement | Record each distinct balance item and nullable links through the host resolver/recorder; native batch/payment uniqueness cannot collapse items. |
| Account history | Authenticate owner/order before fetch; preserve parent lineage, correction currency/totals and safe download availability. Customer intent grants no mutation authority. |
| Seller revision | New obligations freeze first-claim seller independently for each duty; legacy fallback and issued documents remain unchanged. |
| Composition | Explicit default-off provider selection, host readiness and one executor; no automatic route, job, provider or scheduler registration. |

Native and managed stores keep their distinct transaction graphs. Existing
local-only native document requests remain callable separately from fiscal issue.
Native control admission and immutable forward bytes precede store projection;
a sparse module migration list never substitutes for a complete installed chain.
Customer, operator and provider bridges require their own ownership and safety
proof; a source checkout is not a stable framework or supported deployment.

## Offline proof and later acceptance

The refusal factory supplies typed unsupported host/store/provider ports with no
executor. The runner-independent conformance helper checks adapter-owned positive,
refusal, exact absence, unknown, parent/recovery and redaction fixtures and their
write counters. It checks declared artifact/clearance/company/payout capabilities
only with selected host fixtures. Its returned case evidence contains no raw
provider result or personal facts. This is contract proof, not live provider,
PostgreSQL lock/atomicity, fiscal or inbox proof.

Later workers and stores need unchanged donor characterization, real PostgreSQL
fresh/upgrade/replay/concurrency/ACL proof, seller revision race/legacy witnesses,
and actual installed service composition. Measure package/code/docs/browser caps
at each material addition; long recipes stay in the package reference outside the
npm artifact. The platform unpacked cap is 6,400 KiB for the M09/M10 wave
(see [package release policy](../../../.github/VERSIONING_AND_EOL.md)). P5's
cumulative pack crosses the prior code-gzip cap, so its approved cap edit raises
code-gzip to 1,228,800 B, packed to 1,474,560 B and docs-gzip to 57,344 B;
unpacked remains 6,553,600 B. M09 is the largest module, the caps date from M05,
and P5/P7 exceed the remaining headroom. No behavior cut, release or activation
follows from that budget change. [Canonical evidence](../CANONICAL_CONTRACTS.md#invoicing-evidence)
remains the result-meaning owner.

## Phase obligations

- P4 must discover captured duties without installed facts; fact preparation
  cannot depend on already having a claimable fiscal snapshot. The native
  `discoverDuties` read supplies IDs before installation, with a UUID cursor to
  advance past unavailable facts; P7 binds host facts and scan continuation.
- P4 native issue binding must treat non-observed local evidence as unavailable
  without stopping the duty (pinned `invoicing_preflight_duty`). Only `action: "create"`
  claims may issue, with `attemptCount = generation`. Route `action: "readback"`
  claims to provider read, then finish on `found` or fail on `absent`/`unknown`.
  Convert a native `{ kind: "stale" }` preflight or finish result into the claim-fence
  error: write no failure and count zero updates. A fresh non-ready preflight
  settles through fail before returning (a local observed mismatch/blocked also settles blocked before the fresh read): blocked for mismatch/blocked; retryable
  with before_send for unavailable. P4 supplies these bindings in
  `runNativeInvoiceIssueJob`; P7 owns their policy/seller/service composition.
- P5 must pass `retryable` and `retrySeconds` evidence for native delivery
  `failed_before_send`: the kind asserts failure before send; no `phase` is required.
  Boolean false parks the failure; otherwise a whole JSON number delays retry
  by 60..86400 seconds (clamped); absent or invalid delay uses 900 seconds.
  The native store's optional delivery projection and `runInvoiceDeliveryJob`
  store mode bind these outcomes; executed evidence belongs to the table-driven
  [native delivery contract](../../../tests/postgres/invoicingDelivery.test.ts).
- P7 must route native reversals through the correction branch of
  `invoicing_request_with_seller_policy`, retain the wrapper-returned seller and
  revision in claim facts, and define claim behavior for unknown/unsupported
  `seller.read`. Order-scoped managed claims must never call the unscoped
  corrections wrapper. First-claim seller freezing retains legacy fallback.
  Readback must surface both terminal reversal outcomes: an owed duty whose
  reversal answered `unsupported` remains owed with no reversal diagnostic,
  retaining any earlier fact-preparation diagnostic (for example `retryable`)
  although it is never leased again, and
  preparation committed before reversal may leave an unclaimable
  `issue_requested` document and its request parked at infinity. Both are
  terminal by design; P7 must expose them without making them claimable.
- S1 re-measures root-docs gzip against the package cap and trims only if the
  release set exceeds it.

The nine additional named contract exports have concrete consumers:
`InvoiceDocumentIdentity` for artifact/clearance/download adapters;
`InvoiceProviderPort` for the correction bridge; `InvoiceSettlementPort` and
`InvoiceSettlementItem` for host payout resolution/recording;
`InvoiceDutyReadback` for operator readback; `InvoiceUnsupported` for native
bindings; `InvoiceDiagnosticCode` for adapter diagnostics; `InvoiceProof` for
host evidence recorders; and `InvoiceClearanceObservation` for clearance
observers. Installed declaration compiles consume all nine by name. P1b adds
only the refusal factory and conformance helper to the runtime entry.

## P2 issue helper boundary

P2's nine helpers cover issue sequencing, snapshot/canonical positions, both donor
allocators, payment readback and event/direct handoff wrappers. Existing host
facades are their named consumers. The issue worker's compatibility callbacks
preserve managed payloads and fenced finalization; they do not redefine P1 ports
or manufacture the proofs required by a future native binding. Recovery remains
inside the selected provider and is required on every reclaimed attempt.

Migration: F5 default captions and legacy tax labels are explicit host inputs;
F6 event type/timeout, event and direct-dispatch keys, and executor selection stay
host-owned with unchanged output. F9 imports only the named accounting slices.
Channel policy resolution and correction projection stay in the host. No native
D7/O2 expectation, SQL, money/dunning writer, subscription alignment or dispatch
registration changes. P8 owns the seller-freezing SQL forwards; P7 owns their
host composition. Eight semantic
cases extend the existing required selection; incumbent host arithmetic tests
remain the donor witness rather than a second copied suite.

The compatibility callbacks retain the reviewed managed issue result distinctions:
unknown is never exact absence or an accepted document. The port-fit witness
checks typed seam inputs against pinned SQL parameter order, including managed
seller/claim wrappers. The native `runNativeInvoiceIssueJob` additionally binds
create/readback actions, both preflights and fenced outcomes;
seller pre-claim reads, document-scoped post-issue operations and delivery
settlement remain with their phase owners above.

## P3 correction and reversal boundary

The P3 design uses `runInvoiceCorrectionJob` and `createInvoiceReversalHandlers`
to retain the donor worker's identity validation, effect order, retry bounds and outcome vocabulary.
Reference facades are their named consumers; the recovery bridge is explicit and
not automatically supplied by the legacy vendor copy. The bridge owns exact
recovery/absence, parent checks and provider positive BEFORE/zero AFTER mapping.
Unknown/absent/issued remain distinct. Neither worker writes money or controls
renewal parcel admission or dunning recovery.

The [M09 forward owner](../DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval)
owns managed installation, compatibility cutover and legacy reconciliation.
F7's new semantic witnesses are additional proof, not claims about old coverage.
F10's preview correction IDs/numbers derive from correctionRef, not the base order.
No native forward, provider wire implementation or activation is added here.

P3 builds on landed P1/P2; this design grants no merge or release authority.

The native reversal design follows the [canonical reversal rules](../DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval):
a safe completed failed attempt may void immediately; in-flight or unknown work
requires readback. The managed compatibility facade preserves its separate
incumbent RPC outcomes and late-document compensation; it does not implement
the native store port.

See the [M09 forward owner](../DATA_AND_MIGRATIONS.md#m09-invoicing-forward-design-and-control-approval) for the registered managed-correction limit, follow-up and finalization semantics.

## P4 native continuity and issue binding

D7 translates the native composition instead of copying the donor unchanged:
remove the inline accounting wrapper and its readiness gate, retaining shipment
creation, label and handoff behavior. W7 changes only those native accounting
expectations; managed fail-soft wrappers remain unchanged. The independent
collector reuses durable sweep, split prepare and fenced finish calls. It neither
reads providers nor controls renewal, payment or delivery. Fiscal fact installation
and eventual scheduler selection remain explicit host/service composition work.

F13 introduces the exact reviewed 20261022192000 replacement after native 160000,
165000, 190000 and 191000 (positions 75–79). Capture failures are isolated from
settlement and dunning recovery. The retry source is retained succeeded settlement
or handoff evidence, even when the fault marker fails. The two M07 conformance
expectations that change are captured replay and captured recovery:
`accountingRequested=true` becomes false because no accounting document is linked
inside payment finalization. Money, refusal, recovery and cycle assertions stay.

The combined P4 supplies canonical 190000/191000/192000 bytes matching their
pins, with descriptor positions 77–79. No M10 runtime or future migration is
required. Source and synthetic PostgreSQL proof establish neither fiscal
provider activation nor a release or supported installation.

Registered follow-up limit (coordinator ruling): unchanged M07
`payment_truth_readback` joins accounting_documents, so ACCESS EXCLUSIVE DDL
or denied readback ACL can block/refuse the overall call. Practical exposure is
operator DDL windows/misconfiguration; M09 does not widen or repair this boundary.

## P5 read side

Seven helpers add delivery, PDF validation/filenames, document synchronization,
payout recording, lineage and a read model. Existing host facades keep transport,
query/auth, keys and legacy column projection. `syncAcceptedInvoiceDocuments`
also accepts target/observer/status callbacks: pending/rejected/not-submitted
observations are recorded without artifact sync; accepted targets download all
host-selected attachments after status recording, with per-target failure counts.
No separate polling export or scheduling/composition is added.

`createInvoiceReadModel` keeps found, exact scoped absence, unknown and unsupported
separate. Readback checks every identity field and exact/complete scope; it has no
create writer. The native account-history binding checks ownership before its
host query, preserves parent lineage, signed totals and currency, and projects
only safe fields. Missing parity is `host_binding_required`; empty duties never
prove invoice absence. Customer tickets resolve the real client/order owner before
PDF fetch; the host operator handler authorizes before querying. The browser
reference client consumes that host route; HTTP/UI projections show closed diagnostic codes only.

Migration: F8 retains the host payout reader and original item keys; the host
recorder/resolver owns richer item evidence and nullable links (KEEP #12). F11
retains M04 content, locale, transport and uncertain behavior that forbids sending again. F9/F12
keep bounded reference clients, runbook URLs and correction-request intent in the
host; intent creates no fiscal correction. Accepted artifact references remain
provider references, with transient downloads distinct from storage receipts.
KEEP #21 retains native history through an injected safe host projection rather
than claiming an unavailable native schema query. Native delivery claim/settlement
and duty readback retain P1 input shapes; the seam witness checks every required
input against pinned SQL parameter order. P5 extends P4's store with an optional
M04 envelope projection and native claim/settlement routing; it changes no SQL.
The table-driven real-PostgreSQL contract exercises the package store and job,
checking adapter results and persisted delivery/receipt/attempt state.

P5's managed payout facade preserves the donor's legacy recorder calls, side
effects and aggregate counts. The package returns per-item receipts: reuse of a
real settlement receipt for a different provider/batch/item/payment scope becomes
`conflict` / `identity_mismatch`, with no extra write and continued processing.
Legacy batch/payment storage can therefore yield fewer item-level successes than
the host aggregate. An item-capable host recorder/resolver yields distinct
`recorded` receipts (KEEP #12). Neither granularity establishes payment success.
CTL-M09-3's FINAL 191000 `public.invoicing_settle_delivery` receives native
`failedBeforeSend` evidence `{phase:'before_send', retryable:true, retrySeconds}`.
Whole-number seconds clamp to 60..86400; absent/invalid delay uses 900 seconds.
`terminalFailure` settles the same branch with `{phase:'before_send', retryable:false}`:
`available_at='infinity'` prevents reclaim while status `failed` and `last_error`
remain visible. Callback mode requires an explicit `terminalFailure` before claim;
store mode supplies it. Without a native projection the store refuses before leasing.
The native delivery contract tests claim, sent, uncertain, bounded/default delays,
terminal parking, stale fencing and projection refusal against the installed
pinned SQL. Hosts still supply M04 transport/content and authorized envelope facts;
these tests establish neither provider readiness nor inbox delivery.

## P7 composition and seller revision

PART A reuses the host executor/registry and the real P4 collection and P5
read-side helpers. Services and contributions remain inert until explicitly
selected; readiness precedes claim. Transport-specific factories stay host-owned.
The accepted targeted-module refusal precedes leasing, preserving order scope.

PART B introduces the approved CTL-M09-4 seller fixtures without changing their
bytes. Native reversals use `invoicing_request_with_seller_policy`'s correction
branch. Claimed facts keep the wrapper-returned seller, revision and mode.
Unknown/unsupported seller reads consume no lease. Order-scoped managed
corrections never call the unscoped wrapper. First-ever claim freezing preserves
legacy fallback after upgrade; managed order-status reversals use the request
wrapper with source kind `order_status_reversal` and preserve incumbent results.
Issued documents are unchanged. Replay conflicts return typed identity conflicts.
The native descriptor appends 195000 at position 80, after 192000; install the
complete ordered catalogue. PART A and PART B remain separately reviewable.
