# Invoicing module design

Status: development-preview design. The contract and offline conformance surface
and issue, correction and reversal helpers are available for explicit host
composition, alongside the managed correction forwards. Native stores, SQL
projection, reference routes and release activation are separate implementation steps.

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
(see [package release policy](../../../.github/VERSIONING_AND_EOL.md)); packed,
code-gzip and docs-gzip caps remain unchanged. No other cap increase, behavior
cut, release or activation follows from this design. [Canonical evidence](../CANONICAL_CONTRACTS.md#invoicing-evidence)
remains the result-meaning owner.

## Phase obligations

- P4 must discover captured duties without installed facts; fact preparation
  cannot depend on already having a claimable fiscal snapshot.
- P4 native issue binding must treat non-observed local evidence as unavailable
  without stopping the duty (pinned `invoicing_preflight_duty`). Only `action: "create"`
  claims may issue, with `attemptCount = generation`. Route `action: "readback"`
  claims to provider read, then finish on `found` or fail on `absent`/`unknown`.
  Convert a native `{ kind: "stale" }` preflight or finish result into the claim-fence
  error: write no failure and count zero updates.
- P5 must pass `retryable` and `retrySeconds` evidence for native delivery
  `failed_before_send`: the kind asserts failure before send; no `phase` is required.
  Boolean false parks the failure; otherwise a whole JSON number delays retry
  by 60..86400 seconds (clamped); absent or invalid delay uses 900 seconds.
- P7 must route native reversals through the correction branch of
  `invoicing_request_with_seller_policy`, retain the wrapper-returned seller and
  revision in claim facts, and define claim behavior for unknown/unsupported
  `seller.read`. Order-scoped managed claims must never call the unscoped
  corrections wrapper. First-claim seller freezing retains legacy fallback.
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
registration changes. P8 still owns first-claim seller freezing. Eight semantic
cases extend the existing required selection; incumbent host arithmetic tests
remain the donor witness rather than a second copied suite.

The compatibility callbacks retain the reviewed managed issue result distinctions:
unknown is never exact absence or an accepted document. The port-fit witness
checks typed seam inputs against pinned SQL parameter order, including managed
seller/claim wrappers. This is parameter-order proof only; it does not bind
`runInvoiceIssueJob` to native ports. Native issue binding remains a P4 obligation;
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
