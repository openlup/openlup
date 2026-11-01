# M19 G5: native checkout persistence

Status: initial candidate signed and reviewed; package-entry repair requires
a renewed API read, development preview (2026-11-01). No PR yet.
Audience: the money-stream supervisor, implementer and independent reviewers.

## Outcome and boundary

Persist a server-produced quote as a native order draft on `qualified-v2`,
through an installed public export and the restricted runtime role, without
`commerce_configurator_persist_intent` or its policy. Every created order keeps
the complete quote and derived draft snapshot. Matching replay has one effect;
changed input refuses; a new process recovers the durable result. Browser
return data never establishes paid truth.

The accountable maintainer authorizes local work, DCO-signed commits,
submission and merge of this accepted row under normal gates. The native-path
worker implements and supervises this PR under the money-stream supervisor;
the M19 lead owns overall acceptance, caps and landing order. DCO author:
Bart Roszkowski <dev@openlup.com>. Publish, releases, tags, production,
credentials, settings, costs and control changes have no grant here.

Worktree: `oss-m19-g5`; branch: `codex/oss-m19-g5`.
Code base and separately checked policy revision:
`bb0008481a11267ec6dbe3e7e531299777cddc19`.
The lead resumed G5 after the probe reported; no stop rule tripped.
G6, G2, G4, G3, G7 and G8 belong to other assignments.

## Smallest adequate implementation

Add a separate server-only native checkout subpath in the existing platform
package. Reuse quote validation and the existing native draft functions;
derive the draft snapshot from the quote rather than accepting two independent
money records. Use one parameterized call, with JSON values serialized at the
call boundary. Do not use the incumbent TypeScript draft port's supersession
fallback: a changed request must remain a conflict.

No forward is planned. Existing SQL already atomically writes the order,
items, outbox fact and replay receipt, retaining `metadata.quoteSnapshot` and
`metadata.orderDraftSnapshot`. The reserved G5 SQL slot remains empty.
Managed SQL, the gateway and existing commerce/server files stay unchanged.
New public export, API snapshot, consumer classification, catalogue rows and
the affected commerce owner explanation accompany the implementation.

No price writer, promotion administration, payment dispatch, attempt store,
activation, renewal, destination, inventory hold or notification work is added.
Host routing authenticates the customer and supplies the client identity out
of band; it supplies the server-produced quote. Existing native money-shape
refusals remain binding. No new withdrawn-order marker or dispatched-attempt
location is introduced.

## Native compensation and withdrawn markers

Static trace at the recorded base: the `checkout_journey_consumed` branch in
[the failure handler](../../../packages/platform/src/commerce/server/commerceCheckoutFailureHandler.ts)
passes that cancellation reason to `tryCompensate` only when it has an order ID
for compensation. [That orchestrator](../../../packages/platform/src/commerce/server/commerceCheckoutCompensation.ts)
tries reservation release, then promotion cancellation, then abandoned-order
cancellation if promotion cancellation did not succeed. Its caller must withhold
the compensable order ID for uncertain or in-flight provider attempts.

The generic [RPC compensation adapter](../../../packages/platform/src/commerce/server/checkoutCompensation.ts)
calls `commerce_cancel_abandoned_checkout`; there is no definition or alias for
that name in the native migration stream. Bound unchanged through
`PgGatewayClient` to a `qualified-v2` database, it gets missing-function SQLSTATE
`42883` and throws `CommerceRuntimePersistenceError`. Inside `tryCompensate`,
that failure is caught and logged as `checkout_abandoned_order_compensation_failed`;
the original journey conflict still returns. It does not cancel the native
draft, write a marker, or fall back to the differently named native routine.
The reference M11 wrapper only guards injected callables; it does not translate
this RPC or establish that a scripted client works against native PostgreSQL.

A native host using this failure handler must explicitly bind
`cancelAbandonedOrder` to `commerce_compensate_abandoned_checkout`, supplying a
native order UUID and stable idempotency key. The existing reference
[activation adapter](../../../server/adapters/postgres/subscriptionActivation.ts)
exposes `compensateAbandonedCheckout` for that native call; its
[runtime binding](../../../server/runtime/customers/subscriptionActivationBinding.ts)
selects the `node-postgres` bundle. G5's persistence-only export does not wire
this handler or compensation port, and does not promote that reference adapter.
The [native routine](../../../db/platform/migrations/20260814150000_subscription_activation_spine.sql)
cancels a pending-payment order, fails only a `created` settlement intent,
marks a provisional activation compensated, and records an idempotent
compensation outcome. It does not update order metadata. By contrast, the
managed `commerce_cancel_abandoned_checkout_sealed_v1` writes
`checkoutAbandoned = p_reason` in the managed baseline.

The native checkout definitions and first-party callers at this base contain
no writer for `supersededByStableJourneyKey` or `checkoutAbandoned`; the PostgreSQL
OMS adapter only reads them. No such native marker writer is added here.
Whoever later adds a native withdrawn-marker writer must add the OMS
dispatched-attempt clause in the same PR, so dispatched or ambiguous money
cannot be hidden as a withdrawn draft.

## Proof and delivery

The real-PostgreSQL witness installs the hash-checked `qualified-v2` chain and
calls the exported port from an installed tarball using its restricted runtime
login. Only synthetic catalogue/prices and identity are fixture setup; no
order, item, receipt, settlement or payment-truth row is hand-written.

Prove complete stored money with distinct lines and tax values; matching and
concurrent replay with one order, item set, receipt and draft event; changed
quote/client refusal without mutation; invalid money and catalogue admission
refusal; native shipping refusal; response to forged paid-return fields; and
fresh-process replay after disconnect. Compare actual order status and absent
settlement/truth effects, not just a returned `not_started` field. All new
gates receive committed real-PostgreSQL refusal cases. Check every JSON-valued
call with the real pg driver, including arrays nested in snapshots.

Run focused stages through the shared focused gate without requesting release.
Before sign-off, complete the existing cheap checks and the stabilized public
API maintainer read. Two independent fresh-context native reviewers launched
through `collaboration.spawn_agent` review the exact committed candidate; one
considers the smallest adequate alternative. No SQL assessment is required
without a forward. Follow [native review](../../../CONTRIBUTING.md#native-review-and-accountability)
and [documentation impact](../DOCUMENTATION.md#impact).
Stop at `READY_FOR_VERIFY G5` after review; canonical verify waits for the
lead to name this PR. Land after the packaging prerequisite in lead order.

Estimate from code: 1–2 working days including installed DB proof, read/review
and delivery, replacing the earlier 3–5-day estimate. The earlier +3,497-byte
figure came from `npm pack` plus the shared budget measurement functions,
not `packages:check --pack`. A subsequent real
`npm run packages:check -- --pack` now passes for all three packages with no
findings. It ran on an exact staged-tree export in this worktree's ignored
scratch, using an unsigned measurement-only Git snapshot to satisfy the
checker's clean-source requirement. At that measurement the task branch was uncommitted and
unsigned; it was not final post-review verification.

The full check reproduces the identical platform tarball: 2,106,268 packed
bytes, 9,822,946 unpacked bytes and 2,843 files. Against the probe's reported
pack at the same base, the delta remains +3,497 packed bytes, +13,444 unpacked
bytes and +3 files (source, runtime JS, declaration). This comparison is not
an independent baseline rebuild. G5 has no SQL bytes to add. Existing budgets
pass; no new npm package, dependency or numeric gate-budget change is proposed.

## Evidence and remaining work

The probe's successful draft/activation stage is supporting history. Source
reading confirms retained snapshots in
[the native draft](../../../db/platform/migrations/20260813220000_merchandising_order_draft.sql),
native money/refusal guards in
[its wrapper](../../../db/platform/migrations/20260817180000_promotion_claim_lifecycle.sql),
and supersession in the separate
[incumbent port](../../../packages/platform/src/commerce/server/commerceOrderDraft.ts).
Executed working-tree evidence on Node 24.21.0 / npm 11.19.0:

- `npm test -- tests/postgres/nativeCheckoutPersistence.test.ts --maxWorkers=1`:
  5/5 PASS, 12.45 seconds including setup. The installed export loads without
  optional peers; NodeNext and Bundler declarations compile. Both purchase
  modes retain nonzero tax and complete money, including nested arrays. The
  restricted login denies schema creation and privilege escalation. Concurrent
  creation, replay, fresh-process recovery and refusal cases leave one effect
  and no settlement or payment-truth rows.
- `npm run lint`: PASS, zero errors; 33 warnings in unchanged files.
- `npm run oss:published-tree -- --typecheck`: PASS; zero unresolved edges and
  zero consumer-side errors. API snapshot check, ast-grep and whitespace: PASS.
- Real `packages:check --pack`: all three packages PASS with no findings on
  the unsigned staged-source snapshot described above. Gitleaks passed on its
  input delta and snapshot. Platform SHA-256:
  `5d794c6f712211790ba682f9d72814965753b229fd0dad6f0ad9707e635f709b`.
  Code class: 1,812,124 bytes / 2,784 files; documentation class: 58,586 bytes /
  6 files. Signed-candidate package proof and canonical verification remain unrun.
- Policy/navigation check ran on the would-be committed set. Two no-impact
  trailers for the unchanged contributor tests/tooling guidance were subsequently
  recorded with the initial signed commit after the accepted read. Their exact
  source fingerprints and substantive reasons accompany the read packet, and
  the committed policy check passes. Other documentation obligations are
  answered. No contributor-control file changes.

An initial PostgreSQL run failed subscription checkout because the synthetic
SKU fixture omitted the existing opt-in sellability flag. The fixture now
sets it explicitly. Initial lint also caught deep imports across the pricing
module boundary; the implementation now uses that module's public entry.
Both repairs passed the subsequent applicable checks. At that evidence freeze,
no native review session, repair cycle or queue retry had been consumed; the
initial review outcome and pending repair are recorded below.

Remaining: renewed read and DCO for the package-entry repair, two fresh
independent reviews closing the initial findings, lead-named final verification
and authorized delivery. No canonical verify, push, PR, receipt or merge has
been attempted. Preserve evidence and budgets on resume. G5 writes neither `supersededByStableJourneyKey` nor
`checkoutAbandoned`, and adds no dispatched-attempt field or store.

Self-retro: the probe reduced G5 to a binding and proof task, avoiding a forward.
The fixture and import failures showed that profile flags and module entries
deserve checking before the database run. Shared-gate waits dominated elapsed
time; one final type-check admission alone waited 554 seconds. No process or
control change is proposed. The compensation trace distinguishes the managed
RPC from the native routine and exposes the missing automatic binding without
changing either. The full package checker reproduced the earlier preview's
bytes and hash without signing the task candidate.


## Package-entry review repair

The initial API read was accepted for the frozen candidate, which was then
DCO-signed and prepared for two independent fresh-context native reviews. Both
reviews found the same material package-boundary mismatch: the new subpath
was absent from the test's closed nested-entry inventory and targeted a direct
file instead of the required entry directory. The focused package-boundary
run reproduced it: 2,818 passed, one failed. The committed documentation-impact
trailers passed the policy check with zero unanswered obligations.

The repair keeps the existing boundary helper and all its checks. The native
implementation moves to `commerce/server/native-checkout/index.ts`, with only
relative import paths adjusted; its export and declaration targets follow that
layout. The test's exact inventory gains this one entry. No helper, assertion,
refusal, privilege, numeric budget, behavior or API signature is relaxed. The
API snapshot and catalogue follow the new source location. A renewed maintainer
read covers these package-source and target changes before repair sign-off;
the initial FAIL reports remain open until fresh reviewers close them.

Native abandoned-order compensation is not bound or qualified by G5. The
unchanged generic adapter fails closed with `42883`; a follow-on must bind and
prove compensation before overall money-path acceptance counts it. G5 writes
neither withdrawn marker and adds no location for a dispatched attempt.

Self-retro: pack and installed PostgreSQL proof did not cover the package's
closed export inventory. Check that inventory with the new entry before counted
review; preserve its existing standard layout rather than adding an exception.


The repaired entry passes all 2,819 package-boundary cases and all five installed
real-PostgreSQL cases (13.08 seconds including setup). The fresh full
`packages:check --pack` passes all three packages on an exact staged-source
fixture in this worktree's ignored scratch. This is the same unsigned
measurement-only method as before; it does not sign the repair or substitute
for final verification. The repaired platform tarball is 2,106,571 packed bytes,
9,822,963 unpacked bytes and 2,843 files, SHA-256
`a9f07ce7b1e119496a98cc5fa11fb904651c3a3ec70fbd3c8df927035a246a37`.
Against the probe's reported same-base pack (not independently rebuilt), this
is +3,800 packed bytes, +13,461 unpacked bytes and +3 files, superseding the
earlier +3,497-byte measurement. No SQL bytes or numeric cap change.
The estimate remains 1–2 working days. The extra changed test path is
`packages/platform/test/packageBoundary.test.ts`; it changes only the exact
entry list and is explicitly included in the renewed read.

Repair checks also pass: API declaration check, ast-grep and strict root
typecheck (zero unresolved edges and zero consumer-side errors). Full lint
passes with zero errors and 99 warnings in unchanged files. The focused gate
for that lint run waited 520 seconds; there is no rule or suppression change.
Native review is still at cycle zero on the initial committed candidate, with
two FAIL reports and no counted PASS. The first repair is staged but remains
unsigned and unprepared pending the renewed read. Canonical verification has
not run.
