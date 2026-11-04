# Native renewal, retry and alignment composition

Status: implementation and inline-admission SQL read accepted; signed repair
integrated on the frozen control predecessor. Local pre-review proof is running
on that tree. Native review, final verification and hosted qualification are
separate obligations; none is inferred from the earlier focused evidence.

Outcome: expose the existing native renewal/retry/alignment pipeline through
public subscriptions exports, fix historical terminal replay, and preserve the
finite connected-transfer graph for the rows this path writes. Keep real repair,
stock wait, retry fencing, active-service exhaustion and monotonic lateness.
Reuse existing money writers and add the bounded destination read. No new
price writer, payment-attempt store or managed behavior is introduced.

## Scope and authority

Dedicated worktree `oss-m19-g7`, branch `codex/oss-m19-g7`. Current frozen
predecessor: `36ef901c970e533ae9310062fc2fbf058ad39c83`, merged without
rebasing as `6e4676c8`. This integrates the admitted original-routine inline gate
class and the roadmap changes. The earlier deadline predecessor
`c6248bf295dbdb474f86bd8c0fcf5f4e49c64470` remains provenance.
Documentation and later native prepare/verification use
that exact `OPENLUP_STACK_BASE`; focused test children receive no stack pin.
The earlier predecessor history below remains provenance, not the current base.

Earlier signed predecessor:
`9ac0992776bbe5f295c3698fe28e732202b36fa3`, including main `09cd599b`, the
retained-method compatibility fix and the offline installed-consumer correction.
Earlier unsigned work was consolidated as signed `63f9d783`; that signed commit
is preserved. The new test-only predecessor is merged with signed `87ed500f`,
without rebase or rewriting any signed commit. Later native review uses the
new exact predecessor as `OPENLUP_STACK_BASE`.

The supervisor authorizes this exact frozen-head merge, pre-review proof and
record-only corrections, full independent native review, canonical verification,
a normal branch push and a draft PR on the predecessor branch or main after its
landing. Receipt-history publication and the bounded landing helper are permitted
only after those gates pass. Existing signed commits remain unchanged. No direct
merge, manual auto-merge, release, deployment, credentials or unrelated repository
write is authorized. The helper owns any permitted queue transition.
Native repair cycles used: zero. The incremental hard stop is 16,000 packed bytes,
including real SQL and manifest projection. Existing code is promoted with its
characterization tests unchanged; a behavior change is not a promotion.

## Public boundary and compatibility

Existing `@openlup/platform/subscriptions` exports now include:

- `createNativeSubscriptionBinding`: explicit readiness, transaction, shared
  population lease, frozen codec, inventory/payment policy and retry ports.
  Returns services/schema/realization admission; installs no timer or route.
- `createNativeRetryDriver` and `NativeRetryDriverOptions`: durable prepared
  receipt fencing and exact-attempt readback. Ambiguity never redispatches.
- `nativeSubscriptionSchema`: host supplies complete catalogue identity.
- `withNativeDeliveryAlignmentRenewalAdmission`: preserves captured protection
  after mode rollback and defers new money while delivery is outstanding.
- `createPostgresRenewalSettlementPort`: native prepare/ACK/outcome translation.

These five files remain inside the existing `subscriptions/index.ts` entry;
no new subpath, manifest dependency or boundary inventory entry. Own exports sit
next to the codec, away from the lifecycle-message export. The reference binding
is a thin join to public `createSubscriptionContribution`, preserving the same
job, trigger identity, cadence and disabled behavior. Other reference files are
aliases. The unchanged facade and composition witnesses pass.

The existing production store in
`packages/platform/src/subscriptions/postgresStockWaitStore.ts` changes its
`listNormalDue` SQL: it reads `subscription_stock_wait_normal_due` through
`jsonb_to_recordset`, joins the subscription and the shared activation/paid-cycle
correlation columns, then passes those durable facts to the purchase codec.
Stock-wait eligibility still belongs to the existing routine. This is an accepted
production-query change, in addition to the public-code promotion.
`subscription_activations.subscription_id` is not unique: the join can return a
subscription twice, as the renewal reader's existing `listDue` can.
Review criteria: confirm that stable claim identity and operation fencing prevent
a second money or parcel effect when duplicate activation lineage produces two
due rows. Do not assume this join produces unique subscriptions. The production mandate read retains the predecessor
rule: missing method row preserves legacy behavior; only an explicit non-healthy
state refuses. The unchanged 20-case composition fixture and real restricted-role
retained-store renewal proof pass without adding a method row.

The optional recovery `sourceEvidence` host port requires source kind/reference,
observed status/time/fingerprint and exact attempt reference. It is a local
structural type: no payments-module dependency or checker amendment. The driver
forwards it before fixed money/identity inputs into the existing recovery writer.

## Initial SQL replacement and installed chain (historical)

Source: `db/platform/migrations/20261101230000_subscription_renewal_terminal_replay.sql`.
The initial promotion's only replacement was
`public.subscription_claim_due_renewal(text,text,jsonb,text,integer,timestamptz)`.
Same header/defaults/RETURNS jsonb, plpgsql, implicit SECURITY INVOKER,
`search_path=pg_catalog`, owner and ACL. No new function/definer, table, index,
trigger, constraint, grant/revoke, role/default privilege, data or backfill.

Subscription-then-operation lock order stays unchanged. Full identity,
fingerprint and frozen JSON compare before terminal answer. Matching succeeded
and refused answer before due/status eligibility; public run returns
`terminal_replay` without row-version changes or provider execution. Cancelled
history replays; new/nonterminal cancelled claims refuse 22023. Changed input
refuses 23505, including after cancellation. Eligible nonterminal takeover and
lease behavior stay unchanged. No unlocked shortcut or other routine replacement.

Raw and packaged SQL both retain SHA-256
`a26bbf0cce449b231931ede0906bc117ded4f2b8838e1904642b7261ebdc8a63`.
Before-definition SHA-256:
`4814d98dbc9e6495af8d1d4d411a6a40d68cb5bcbd53aa41006bea6a34189af8`;
after `b73637d95950ca72d32c1649b98ef774c2a2c9c2e377c2ae58fd051b3979660e`.
The predecessor purchase forward stays byte-identical at
`2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34`.

The canonical projection generator copies the SQL into `packages/platform/sql/`
and generates `sql/manifest.json`; no generated values are hand-written. Fresh
PostgreSQL measurements confirm the current inventory; historic issued pins stay
untouched. Qualification tests change only permitted current count/hash literals,
with companion counts. The opt-in handover changes only its inventory and table
count literals, keeping the guard message and all effect assertions unchanged.

| Profile | Units | Current inventory SHA-256 |
| --- | ---: | --- |
| legacy | 93 | ddeb608984636056076576bbd5c1eedb7d612e09f1b9073910e425c6078daeae |
| bootstrap | 97 | fa01fb224f80816f0cf417a1ba4009b4b787d2b5fc1fe16fb11cfdc0b4fe93cd |
| separate | 97 | 7beb13019362398921baa5c83bf0abee3f4454a325e4dce872ddc625504944ad |
| admin-managed | 96 | 49883a2c0356a3a830e628e5bf65959f098132021473dc6b700209c98afe2295 |
| admin-operator | 96 | f9fc41f424acbf15909ad99e4d22a5558d92f6665f5e71dd75c246534fb0354e |

The final installed artifact passes fresh PostgreSQL 16 installation in both
qualified generations and both role modes: canonical identities/hashes/order,
named missing/tampered asset refusal and no-op rerun. No new runtime grant is
needed by selected calls. The admission self-check gives the expected unpinned
forward refusal, recorded without changing its control. Issued SQL's trailing
blank line is preserved: diff-check passes with only blank-at-EOF disabled.

Neither public nor the separate adopter managed migration chain defines claim_due.
The served managed graph remains unchanged, checked by the unchanged provider
mapper, renewal execution resolver and package boundary tests. The adopter's own
native SQL and characterization pins remain unchanged until deliberate adoption
and re-pin.

## Finite transfer profile and data limits

Capture and restore add only these nine existing tables, with parents before
children. This changes no SQL. The dunning parents land with this composition;
the later notification change consumes those shared entries.

| Table | Retained contents |
| --- | --- |
| subscription_retry_obligations | Frozen cycle/snapshot/fingerprint, order/payment/case links, rung/state/failure text/clocks. |
| subscription_retry_receipts | Immutable failure/prepare/schedule/recovery input/results, method/evidence and attempt facts. |
| subscription_retry_recovery_authorizations | Token/obligation/rung, method/evidence and authorization/consumption times. |
| commerce_checkout_recovery_tokens | Verifier hash, customer/order links, expiry and revocation; no raw bearer. |
| subscription_stock_wait_cases | Frozen basket, deficits, cycle/order/shipment bindings, reservation/recovery/notice state. |
| subscription_dunning_cases | Customer/cycle links, money, failure/retry state and clocks. |
| subscription_dunning_notifications | Recipient links, payload/path/template, lease/claim/dispatch state, errors/results. |
| commerce_order_draft_receipts | Order link, idempotency key, request fingerprint, response JSON and creation time. |
| fulfillment_stock_operations | Stock writer's replay key, fingerprint, source key, SKU and creation time. |

Reference/key/failure/payload strings can identify people; hosts should use opaque
references. The receipt has no separate raw request-body column, but its saved
response embeds the entire quote snapshot and can contain address/contact data.
The fingerprint covers quote, full draft and client ID; existing outbox data also
contains quote and draft. Stock operations have no address/contact body, but keys
can identify. No synthetic-only guarantee, redaction or erasure path is added.
The existing privacy-lifecycle erasure-coverage limit applies.

Every added row shares existing whole-packet row/byte limits (10,000 rows/64MiB
in the proof and restore ceiling). Retained token hashes preserve original live
bearer authority: expiry/revocation/consumption, authorization rung and notice
leases do not reset. Source writer retirement and exclusive target activation
remain host duties. No raw bearer, installation key or signing secret is copied.
The adapter owner documents these limits; root files add no tarball bytes.

All nine tables are populated by actual writers in the new restricted-role proof.
A full nonempty census, not merely capture's first refusal, finds exactly three
missing earlier stock entries: `fulfillment_stock_current`,
`fulfillment_inventory_reservations`, `fulfillment_inventory_reservation_lines`.
No rows are filtered/deleted to satisfy capture. Complete populated clean-target
restore/continuation and per-added-table limit witnesses run when those earlier
entries join at the instructed main merge. The opt-in 95-table handover reaches
its effect assertions and target readiness with one uncertain operation fenced;
that finite-profile witness does not substitute for the joined money proof.

## Focused results

All checks use the existing focused resource gate; package builds are serialized
with installed-module tests. Every existing importer test stays unchanged except
the permitted literal/current-hash maintenance and one authorized stricter
succeeded-replay assertion in the purchase test. Composition's original fixture
SHA stays `96afefdf582ddc4c26e7b369f502076daf2a1cac1536dfb15bc20217a4bb67b4`.
The complete current suite list follows.

| Suite | Result |
| --- | --- |
| `tests/postgres/subscriptionPublicRenewal.test.ts` | 10/10 PASS |
| `packages/platform/test/account-support/bindings.test.ts` | 5/5 PASS |
| `packages/platform/test/account-support/operatorAuthority.test.ts` | 5/5 PASS |
| `packages/platform/test/account-support/ownerRefusals.test.ts` | 27/27 PASS |
| `packages/platform/test/account-support/paymentMethodComposition.test.ts` | 16/16 PASS |
| `packages/platform/test/account-support/portFit.test.ts` | 1/1 PASS |
| `packages/platform/test/account-support/selfService.test.ts` | 8/8 PASS |
| `packages/platform/test/subscriptions/contracts.test.ts` | 3/3 PASS |
| `packages/platform/test/subscriptions/facades.test.ts` | 43/43 PASS |
| `packages/platform/test/subscriptions/portFit.test.ts` | 12/12 PASS |
| `packages/platform/test/subscriptions/postgresStockWaitStore.test.ts` | 11/11 PASS |
| `packages/platform/test/subscriptions/renewalCycleMechanism.test.ts` | 29/29 PASS |
| `packages/platform/test/subscriptions/renewalKeys.test.ts` | 1/1 PASS |
| `server/runtime/public-reference/m12AccountSupportBinding.test.ts` | 17/17 PASS |
| `server/runtime/public-reference/m12SelfServiceBinding.test.ts` | 15/15 PASS |
| `server/runtime/public-reference/subscriptionFacades.test.ts` | 2/2 PASS |
| `src/public-reference/accountSupportRoutes.test.tsx` | 5/5 PASS |
| `tests/postgres/accountSupportComposition.test.ts` | 2/2 PASS |
| `tests/postgres/accountSupportSelfService.test.ts` | 3/3 PASS |
| `tests/postgres/channelConnectedRestore.test.ts` | 1/1 PASS |
| `tests/postgres/connectedManagedRetained.test.ts` | 16/16 PASS |
| `tests/postgres/connectedStoreTransfer.test.ts` | 9/9 PASS |
| `tests/postgres/m14ManagedCatchup.test.ts` | 1/1 PASS |
| `tests/postgres/m14RestrictedConnectedRestore.test.ts` | 15/15 PASS |
| `tests/postgres/subscriptionComposition.test.ts` | 20/20 PASS |
| `tests/postgres/subscriptionMethodHealthCompatibility.test.ts` | 3/3 PASS |
| `tests/postgres/subscriptionPurchaseRenewal.test.ts` | 11/11 PASS |
| `tests/postgres/subscriptionRenewalLifecycle.test.ts` | 66/66 PASS |
| `tests/postgres/subscriptionRetainedMethodCompatibility.test.ts` | 1/1 PASS |
| `tests/postgres/m14QualifiedAdminComposition.test.ts` | 2/2 PASS |
| `tests/postgres/m14QualifiedComposition.test.ts` | 4/4 PASS |
| `server/infra/providerMappers.test.ts` | 9/9 PASS |
| `server/runtime/subscription/subscriptionRenewalExecutionPortResolver.test.ts` | 5/5 PASS |
| `packages/platform/test/packageBoundary.test.ts` | 2861/2861 PASS |

Total: 34 suites/3239 cases, no skips.
The new installed-public suite proves succeeded/refused/cancelled replay with
xmin/ctid readback and zero extra provider execution, changed-input refusal,
real unhealthy-method repair/authorization, stock wait, ambiguous retry across DB
restart and a fresh process, late matching evidence, open-case exhaustion and
active service. Genuinely past recovery lateness extends once by 11 whole days;
past delivery extends monotonically without stacking/moving earlier. Never
confirm an undelivered replacement. No future-clamp SQL change.

Full lint: 0 errors / 33 existing warnings. Strict typecheck: 0 unresolved edges and
0 consumer errors. API snapshots, structural rules, projection equality and secret
scans pass. Documentation owner sections are updated; the scoped no-impact
trailer answers contributor test instructions, leaving CONTRIBUTING unchanged.
A package change-note fragment records this behavior.
Evidence is retained in `.context/scratch/g7/r0-integration/`.

## Real package measurement

Official Node v24.21.0, real packs including SQL and generated manifest projection:

| Measure | Signed predecessor | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Packed bytes | 2,338,713 | 2,353,549 | 14,836 |
| Code-class gzip bytes | 1,871,894 | 1,884,419 | 12,525 |
| Unpacked bytes | 11,057,131 | 11,122,757 | 65,626 |
| Files | 2,923 | 2,939 | 16 |

This leaves 1,164 B below the 16,000 B stop. Five promoted modules yield 15
source/JS/declaration files; claim SQL is the 16th. Existing index/correlation/
capability/owner/context changes are included. Root capture/restore/tests/docs
and the change fragment are excluded from the tarball. Destination wiring must
fit this stop; report early if it cannot. No dependency, entry-layout or numeric
budget edit. Earlier installed money and migration-profile proofs used the
Homebrew-built equivalent artifact SHA1
`3d83e4a4bc192931b5470fa0856b2a0066543820`; its 14,550 B delta differs because of
toolchain compression, not a package-input change. Official measurement evidence
is in `.context/scratch/g7/official-size-20261102/`.

## Remaining ordered integration and delivery boundary

These are mandatory landing conditions, retained after the accepted read:

- Shipping references must be wired before landing. Resolve the subscription
  destination in the same writable snapshot/claim transaction once the earlier
  destination writer joins; production wiring needs a short delta read on that
  merged candidate. The current null-reference seam is not landable.
- Populated capture, clean-target restore and renewal/pending-duty continuation
  must pass after integration, with per-table transfer limits including address
  tables. The current partial proof does not satisfy this condition.
- Keep destination and simulator limits stated until their joined proofs pass.
  Sandbox recovery must actually begin an attempt on the renewal intent, record
  its captured observation and ingest matching evidence through the recovery
  writer. Fixtures do not substitute for that execution.
- Native review runs on that integrated tree after the delta read.
- The adopter's separate native claim-body characterization pin needs a deliberate
  re-pin at adoption; no adopter source is changed here.
- The official-toolchain incremental stop remains 16,000 B including SQL;
  the accepted current delta is 14,836 B.

The payment owner's actual simulator store must be joined on the sandbox channel
at landing. Host execute begins an attempt on the renewal intent with saved
five-field method facts/original authorization time, records a captured server
observation, and exact readback supplies its six matching source fields and
`sandbox:<observation ID>` evidence key. Driver forwards them but does not itself
begin/observe attempts. Let the existing recovery writer own settlement and the
full-input fingerprint; do not pre-settle using purchase ingress. No purchase
attempt substitute, non-sandbox fixture escape or second attempt store.
Current quote/draft, saved authorization/account/method/evidence and retry
observations remain labelled fixtures. Catalogue/prices remain installation seed.

Destination joining uses the earlier row's subscription-scoped reader in the
same writable snapshot/claim transaction. Freeze its immutable UUID at
`orderSnapshot.shippingAddressRef`; no new dialect or `_host` persistence.
That reader is absent from this stack: both shipping refs remain null and the
renewal shipping amount is zero. Quote authority is separate. The stock transfer
continuation/limits, real simulator joining and destination wiring run at the
later instructed predecessor integration, followed by any required delta read.

Remaining active effort: about 0.5–1 working day after prerequisites, plus ordered
read/control/review/verify waits. No `supersededByStableJourneyKey` or
`checkoutAbandoned` write, no new dispatched-attempt location. No native review
or canonical verification has run; repair cycles remain 0.

Self-retro: existing legacy fixtures exposed the predecessor's missing-method
regression and stayed unchanged. A full nonempty census exposed an additional
stock replay ledger hidden by capture's first error. Preserve writer facts and
add the finite owned entry rather than weaken refusal. Lint caught a forbidden
cross-module type edge: a structural host port is smaller and avoids a new module
dependency. Removing duplicated declaration wording kept the stabilized pack
below its prior figure. Retain readable plus JSON diagnostics and serialize builds
with installed-module proofs; no additional control or learning work is needed.


## Test process configuration follow-up

The signed predecessor's test-only correction is merged with `154d87a3`, without
rebase. Fresh child programs receive their disposable database, identity and
clock as arguments and import Node's argument vector. Normal environment
inheritance replaces explicit environment copies. No baseline, entrypoint
registry, checker, production source or SQL changes. All 91 purchase-test and
6 fixture expect calls are unchanged; the public renewal test body is identical.
The two affected real PostgreSQL suites are rerun (11 purchase and10 public cases).
The earlier34-suite/3,239-case regression set remains recorded above; unchanged
modules and assertions do not gain new behavior from this harness-only correction.
Verify's neutrality component reports 0 increases against both the exact signed
stack base and R0 main. Package inputs are unchanged; the later official measurement above supersedes
the Homebrew 14,550 B/16-file figure.
Evidence is in `.context/scratch/g7/neutrality/`.

Self-retro: fixture child configuration belongs at an explicit process boundary.
Use the child program's Node argument import, preserve the parent's test-runner
classification, and run both actual neutrality and publication-policy checks.
No baseline exception, new command or control change is needed.


Signing follow-up: the accepted production-query disclosure and mandatory landing
conditions are prose-only changes. Production source, API, SQL, tests and package
inputs remain byte-identical to the accepted candidate. The duplicate-lineage
claim check is an explicit criterion for the later native reviewers.
Self-retro: enumerate existing-store query changes alongside promoted exports;
otherwise an unchanged SQL routine can hide a material application-query delta.


## Offline installed-consumer follow-up

The public renewal fixture reuses the signed predecessor's
`tests/helpers/installSubscriptionConsumer.ts`. The only consuming test file is
`tests/postgres/subscriptionPublicRenewal.test.ts`; repository search finds no
other fixture consumers. With a new empty cache supplied outside the test, it
passes 10/10 in 19.662 seconds (whole command excluding the resource gate).
Its scratch pg resolves inside that consumer and its lock contains exactly the
sixteen supplied local tarballs. No additional registry package was needed.
The fixture's six expect calls and public test body are unchanged; the predecessor
merge also preserves all existing purchase and method-health assertions.

Lint, structural checks and zero-increase neutrality pass. The new real official
platform pack is byte-identical to the earlier artifact: 2,353,549 B / 2,939 files,
so the row remains +14,836 B / +16 files including SQL. Both raw and packaged
forwards retain their recorded hashes. No production, API, SQL, package-input,
assertion, baseline or checker change. All earlier destination, populated-transfer,
real-simulator, delta-read, review, adoption-pin and size conditions still stand.

Self-retro: reuse one explicit local runtime closure for all installed witnesses;
removing old consumer modules and using distinct empty caches makes registry or
checkout fallback visible without changing money assertions.
Evidence: `.context/scratch/g7/offline-consumer/`.

## Current integration draft

The prerequisite merge is signed at `4439fa0b`; subsequent work remains an
unsigned draft. The native reservation, release, expiry and stock-wait originals
now carry the shared admission statements inline. Their invoker headers and
original execution grants remain unchanged; no custom runtime needs a new grant.
The helper remains owner-only. The earlier wrapper/revoke design is superseded
by the inline adoption fix below.

The new shipment destination view is stable and nonmutating. Native destination
snapshot finalization and claim share the host transaction and subscription lock.
An existing operation keeps its original frozen document, including on replay;
concurrent first claimants derive the same frozen destination. Lower-level hosts
must supply the store's transaction callback. Custom codecs remain injectable.
The native batch limit is explicit host configuration, with its existing default.
New retry evidence times use canonical UTC microseconds; previously persisted
failure request documents still replay unchanged.

The five PostgreSQL inventory measurements used the exact predecessor order.
A draft merge mistake had sorted the qualified bootstrap entries; the canonical
manifest now preserves the predecessor lists and appends only this forward.
No historic issued inventory pin, guard or validation rule changed. The connected
transfer set remains 107 tables; inline admission adds no row-holding table.

Completed focused evidence: 18 restricted-runtime gate/ACL cases; three joined
simulator recovery cases, including unhealthy repair, exhaustion, ambiguity,
restart and genuinely past lateness. The latter run preceded the final evidence-
time normalization edit and is not claimed as proof of the final draft. The
initial installed-tarball run passed replay and the locked nonmutating destination
view; its four retry fixture errors were traced to invalid synthetic reference
prefixes and corrected. Test assertions were preserved. The new full transfer
and sub-millisecond/concurrent-claim cases have not run. Existing importer suites,
zone probes, cold consumer, starter, handover and final cheap checks remain due.
The admission expectation changes only its bound prefix from four to five slots.

Official Node 24.21.0 real pack versus the predecessor: +16,272 packed bytes,
+14,096 code-class bytes, +79,822 unpacked bytes and +16 files. Absolute figures:
2,469,917 packed bytes, 1,971,743 code-class bytes, 11,622,091 unpacked bytes and
3,048 files. This exceeds the row's 16,000-byte stop by 272 bytes. Work stops
before any cut, cap edit, sign-off, native review or delivery. A measured code-cap
read is still required once the row-size disposition and final tree are settled.
The independent shipping-quote authority remains unresolved on the zero-shipping
rail; no quote reference is invented from a destination UUID.

Self-retro: retain each qualified recipe's predecessor order rather than sorting
its filenames. The early class and size checks found the admission mismatch and
then the 272-byte overrun before a review or delivery cycle was spent.

## Resumed marker and compatibility evidence

The packed stop is now 16,800 bytes. Destination-bound zero-shipping renewals
carry the typed `{ kind: "zero_shipping", shippingAmountMinor: 0 }` marker in
`shippingQuoteRef`, distinguishable from a real quote reference. Cycle shipping
will supply its independent reference later. Existing frozen wire still decodes;
the marker does not permit a non-zero renewal shipping amount.

All 13 installed-tarball cases pass on this draft: terminal replay, cancellation,
stock wait, delivery alignment, exhaustion and real method repair, saved simulator
attempt/observation recovery, restart without redispatch, a full populated capture
and clean restore with per-table row/byte bounds, pending attachment completion,
restored renewal continuation, the nonblocking destination view, concurrent
sub-millisecond claim/charge, the typed marker and non-zero shipping refusal.
The complete API regeneration changes only subscriptions and its contracts report.
The scratch co-location preflight passes using Git trees, with no fixture commits
and no edit to the admission reader or actual slot data.

The first unchanged existing purchase-renewal suite stops with 12 passes and one
failure: subscriptionPurchaseRenewal.test.ts:209 expects the former
subscription_renewal_claim_not_due rejection after success. Its promise resolves
with the terminal replay repair active. That test file remains byte-identical
to this integration's signed head. No assertion, source or SQL repair follows
this stop. Final zone sweeps, remaining importers, both-mode catalog, handover,
cold consumer, starter, solo timing and final checks/pack remain due. No new
code-class number is written before the final measurement. The full remaining
package reserve is 34,701 bytes, to be added before the 1.02 factor.

Self-retro: run compatibility suites early. A test that deliberately pinned an
old known limit can outlive its defect; preserve it until its disposition is
explicit rather than changing implementation to restore the old failure.

## Lifted purchase replay limit

The purchase writer's deliberately pinned successful public-run replay limit is
lifted here. The sub-millisecond purchase regression now expects the original
succeeded operation as a terminal replay; its surrounding unchanged assertions
still require identical effect counts and exactly one provider execution. Only
that known-limit assertion and its comment change. The explicit zero-shipping
marker lasts only until cycle shipping replaces it with the cycle-snapshot
reference and the full free-shipping threshold mechanism.

## Replay disposition and admission-test stop

The full purchase-renewal suite now passes 13/13 after lifting its one known-limit
assertion. Its effect-count and single-execution assertions remain unchanged. The
installed public renewal suite passes 13/13 on the default zone and 13/13 with
sessions forced to UTC+09:00. The full package boundary passes 2,966/2,966. The
real PostgreSQL catalog passes 132/132 across both role modes with the approved
scratch class and five bound forwards. Both neutrality checks report zero
increases. The feature pin is included without changing actual class data.

The unchanged remainder of the admission test was also exercised against that
scratch class: 208 pass, two fail. At line 217 it still expects no created
functions for this row, whereas the approved class lists the destination view
and six wrappers. At line 660 it still expects four inventory functions, whereas
the later inventory class lists five. The signed prerequisite's test predates
those class changes. The approved five-pin expectation is its only edited line;
no additional control, assertion or fixture is changed to bypass the failures.
The next empty grant-only expectation also predates this row's approved three
revokes and will require the control owner's disposition.

Work stops before final pack, code-cap editing or a completed read packet. The
remaining compatibility sweep and zone runs were cancelled while waiting at the
gate; no incomplete case is counted as a failure or pass. Remaining package
work uses the final approximately 42,200-byte reserve, rather than the superseded
34,701-byte inventory, before applying the 1.02 factor to the final measurement.
No SQL, production repair, sign-off, native review, verify or delivery follows
this admission-test stop. All draft changes stay staged for the supervisor.

Self-retro: test the edited admission expectation against the proposed scratch
class before review. Class amendments can outpace the prerequisite's fixture
expectations; keep their disposition with the control owner.

## Staged delta and code-budget read

The two admission failures are control-owned, pending integration. The inventory
class now has five created functions; this row's final slot has seven created
functions and three grant-only revokes. Their expectation updates arrive with
the prerequisite bundle's final integration and the separate control change.
They are not edited here. The authorized bound-prefix expectation remains the
only local admission-test change.

Official Node 24.21.0 paired pack against the exact predecessor, including the
packaged forward and proposed budget metadata: +16,589 packed bytes, +14,327
code-class bytes, +81,072 unpacked bytes and +16 files. Absolute figures are
2,470,234 packed bytes, 1,971,974 code-class bytes, 11,623,341 unpacked bytes and
3,048 files. The packed delta is 211 bytes below the authorized 16,800-byte stop.
Only the code-class maximum changes, from 1,970,000 to 2,054,458 bytes, computed
as ceil((1,971,974 + 42,200) * 1.02). All other limits and baselines stay unchanged.
The metadata-only repack changes packed size by -2 bytes and leaves code,
unpacked bytes and files unchanged.

The delta, reference mapping and budget packets are ready for the maintainer
read of this staged proposal. They list measured suite results rather than
claiming canonical verification. After final prerequisite/control integration,
rerun admission, co-location against the actual registry and the real PostgreSQL
catalog on the integrated tree. No merge, commit, native review, verify, push
or pull request is authorized by these packets. All edits remain staged.

Self-retro: resolve versioned control expectations with their owner and keep
the product proof separate. Repacking the proposed budget metadata makes the
reported artifact match the staged package inputs exactly.

## Native UUID value matching correction

The maintainer authorized the UUID matching class repair in this row's own
TypeScript delta. One internal helper accepts PostgreSQL UUID value spellings,
validates their hexadecimal grouping and emits lower-case canonical UUID text.
It is shared inside subscriptions and is not re-exported by a package entry.
Opaque method references, authorization references, receipt keys and provider
fingerprints retain their exact bytes. No SQL or persisted frozen wire changes.

| Site | UUID origin and matching consumer | Correction |
|---|---|---|
| nativeRetryDriver.ts:91,97 | Host retryInput paymentIntentId/orderRef versus typed UUID columns | Canonical values before comparison; invalid requests retain frozen_mandate_mismatch and no prepare/dispatch |
| nativeRetryDriver.ts:102 | Same two IDs enter prepare JSON; pinned SQL compares their text to typed UUID output | Reuse the canonical IDs in the request; no SQL change |
| nativeRetryDriver.ts:113 | Host readOutcome operationId versus durable operation UUID | Canonical comparison; invalid evidence remains awaiting_provider without settlement or redispatch |
| nativeSubscriptionBinding.ts:85-111 | Host-injectable codec projections from waiting and normal-due discovery enter a seen-subscription Set | Canonicalize insertion and lookup; invalid projections keep their prior downstream refusal path |
| nativeRenewalCodec.ts:165 | New destination UUID enters the frozen fingerprint document | Retain existing UUID schema validation, then canonicalize before fingerprinting; no old snapshot rewrite |

The rest of the delta was swept as well: inventory reservation and the alignment/
settlement adapters bind UUIDs to SQL casts and compare only states/contracts;
services and readiness compare no UUIDs; the transfer delta adds only table
names. Stock deficit find matches opaque SKUs, not UUIDs. The codec's older
schedule comparison and the stock-wait store's older frozen-binding comparison
already exist byte-identically at the predecessor and are not new matching sites
in this delta. This is not a qualification of all earlier native ports.

The restricted PostgreSQL counterexample first passed canonical spelling and
three invalid-input refusal cases, while uppercase, compact, braced and grouped
spellings failed: 4 pass, 4 fail. An additional uppercase destination witness
then demonstrated a changed snapshot/fingerprint before that correction. The
new witnesses require one captured truth, one settlement, one retry execution,
canonical prepare JSON and no effect on a rerun. Invalid input IDs refuse before
prepare; invalid outcome IDs leave the prepared obligation reconcilable and the
next valid read settles without executing again. Evidence is under
`.context/scratch/g7/uuid/`, separated into fail-before and final-run transcripts.

Self-retro: inspect the consumer after a TypeScript comparison. Canonical UUID
comparison alone is insufficient when unchanged SQL later compares JSON text.
The same value spelling must reach that request, without normalizing opaque
provider references or rewriting historical frozen documents.

## Adoption fixes: claim and prepare lock order

The maintainer approved one additional replacement in the existing renewal
forward: `public.commerce_prepare_subscription_renewal(uuid,uuid,timestamptz)`.
It first reads the operation's subscription id without locking, locks that
subscription FOR UPDATE, then takes the existing operation FOR UPDATE. This
matches claim's subscription-then-operation order. The remaining prepare body
is byte-identical, and the original named missing-operation refusal is kept.
Signature, defaults, jsonb result, implicit invoker rights, search_path pg_catalog,
ownership and ACL stay unchanged. Claim and every earlier forward byte stay
unchanged. No retry, extra grant, table, data writer or payment-attempt store.

The reserved SQL commit message, after the required SQL read, is
`obvious defect fix: renewal claim/prepare lock order`.
Prepare's preimage is
`76578042f03f95f7599fa5fc84b0c720fbc8cb17d4031b0a0be6a5c5ce0019fe`;
after-definition SHA-256 is `fdf5dd6e73764a6404aeb9ed5e05dfc6e66b28044c464905b6f5375410c496e0`.
The main reader's unchanged exported helper computed the preimage with
preceding=true. Scratch class checks pass for all five bound forwards; actual
control admission remains pending the ordered integration and slot amendment.

The new real-PostgreSQL restricted-role test holds the subscription in session
A, proves B's prepare blocks behind A through pg_blocking_pids, and proves the
operation remains available to A through FOR UPDATE NOWAIT. A then claims.
Before repair the witness failed with 40P01 (1.2 s solo). After repair it passes
(0.4 s solo), with a measured 30 s deadline. It requires one artifact set, no
new money/subscription/alignment effects, no provider execution, a zero-write
prepare replay and the same missing-operation refusal. The unchanged concurrent
public-run witness also passes: one charge, one cycle and no new effect on rerun.

| Zone | Installed | Purchase | Composition | Lifecycle | Gate |
|---|---:|---:|---:|---:|---:|
| Default |22/0|13/0|20/0|66/0|18/0|
| Etc/GMT-9 |22/0|13/0|20/0|65/1|18/0|
| Etc/GMT+5 |22/0|13/0|20/0|65/1|18/0|

The two failures are the previously classified main test-side UTC assumption
at subscriptionRetryLifecycleCases.ts:107, with the same case and reason.
That test stays unchanged. All product and row-owned assertions pass.
Qualified composition additionally passes 4/0 and admin composition 2/0;
only their current inventory literals change. Historic pins, chain counts,
the handover guard text and table count stay unchanged. The handover witness
reached LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION.

| Profile | Units | Measured current inventory |
|---|---:|---|
|legacy|96|abe9d0f792d414e8822f4aa4c2ad87705feb941a74c539e65c8cf76f16c45f05|
|bootstrap|100|3f1eca1bfd3f84dc5fb9aefa9941c719b3de55f780880c87e9b38985b6dccc58|
|separate|100|fed2b12ec787b397eb45478401359bba745ae0fb0b982cbbf7b8720aab5d0038|
|admin-managed|99|51349e1cb0fa1f46867bf23c684fc49f70e7527b990d3d4d695cd82427e60fd1|
|admin-operator|99|29159277d5b9c54a33e350196f0f46cef14d98dff49edaa0c846ace88cd48a57|

Typecheck, lint, structural rules, both neutrality checks and the complete API
check pass; API reports and TypeScript are unchanged. The exclusive scanner
run requested all 58 root script test files after four capacity timeouts:
54 files pass, four fail; 1,254 cases pass, 16 fail, one skips. Every failed
file reports the pre-integration native store feature/class inventory mismatch:
qualified-migration-admission, reviewed-batch-forward,
reviewed-native-store-forward and source-preview-release. Controls and their
expectations are unchanged. This is not a passing admission claim; the actual
registry/scanners must be rerun after the authorized stack/control integration.

Official pack versus the exact predecessor: +18,105 B packed, +14,875 B code,
+89,165 B unpacked, +16 files. Absolute: 2,471,750 B packed; 1,972,522 B code;
11,631,434 B unpacked; 3,048 files. This repair alone adds 1,042 packed bytes,
6,465 unpacked bytes, zero code bytes and zero files. The new packaged SQL
accounts for all unpacked growth; manifest replacements keep the same length.
The existing 17,300 B row stop is exceeded by 805 B. No cap is changed.
The run stops for size disposition before the test/record DCO commit; the
working candidate and SQL read evidence are retained, without claiming review
readiness. No merge, review, canonical verify, push or PR.

No managed-chain or separate adopter change, supersededByStableJourneyKey or
checkoutAbandoned write, or new place for dispatched attempts.
Self-retro: the direct lock-order change needs no retry abstraction. Recompute
current catalog hashes before a post-fix install. Use the documented tsx
handover launcher; the initial loader-only error was corrected without a source
change. The new draft assertion was corrected to the raw RPC's acquired field
before the passing run; its old-body counterexample stopped earlier at 40P01.
About 44 minutes were spent waiting for exclusive scanner capacity.


## Accepted stacked packed limit

The official paired pack on the frozen predecessor measures 2,489,092 packed
bytes. The itemized remaining-row reserve is 53,075 bytes. The exact ceiling
of (2,489,092 + 53,075) × 1.02 is 2,593,011; rounding upward to the existing
5,000-byte step gives the accepted total limit of 2,595,000. The capReason,
code-class limit of 2,055,017 and every other budget stay unchanged. Only the
total packed number changes in the signed budget commit.

The predecessor-relative policy run requires fresh configuration, tests and
admission-test data bindings after integration. The records below bind this
exact delta without changing the canonical owner sections or any executable
control. The measured deadline draft is backed up and removed from this row;
the predecessor owns that delivery. No scanner, native review, verify or
submission is claimed here.

Self-retro: retain the stated 5,000-byte rounding after the exact calculation,
and separate test-deadline ownership from the accepted package-budget commit.

<!-- openlup-task-doc-impact {"unit":"configuration","doc":"docs/platform/CANONICAL_CONTRACTS.md","anchor":"#compatibility-posture","digest":"sha256-acce7bc4bfffcccf2554c29d5b2383f9f6853caf058a66a896d4eeb975046958","reason":"The own delta on the frozen control predecessor binds the exact native renewal forward, ordered function hashes and measured installation inventories. The predecessor supplies the separate inline-gate class amendment. Issued migration identities, original role grants, class and admission rules and installation authority stay unchanged; Compatibility posture remains accurate and the runtime owners describe the behavior."} -->

<!-- openlup-task-doc-impact {"unit":"tests","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-e4577807ed5a823921a23dc7c782b9aa5c29a5d3bf82018e84235ebe00c2f9be","reason":"The own delta adds installed restricted-role renewal, gate and UUID-value readback witnesses, with measured current catalogue literals and one authorized sequential accounting setup. Every existing accounting assertion and historic pin remains unchanged. The new UUID case uses real writer-created stock-wait state, preserves exact engine keys and checks no-effect refusals under UTC and a non-UTC zone. Existing offline consumers, measured per-case deadlines, required phases, coverage controls, selection and global timeouts remain unchanged, so Development-preview checks stays accurate."} -->

<!-- openlup-task-doc-impact {"unit":"tooling","doc":"CONTRIBUTING.md","anchor":"#development-preview-checks","digest":"sha256-284d80900906e59f6b50819c534a61f1d5ccb6749298b2fba68030d36f76dcd3","reason":"Relative to the frozen control predecessor, the only tooling delta extends the admission suite data expectation from the first four bound slots to the first five for this feature pin. The predecessor owns the class-amendment fixture changes. Reader logic, refusal fixtures, test selection and admission workflow stay unchanged, so Development-preview checks remains accurate."} -->


## Adoption fixes: preserve renewal invoker gate compatibility

The maintainer approved entering shared inventory admission inline inside the
six original renewal reserve, release, expiry, stock-wait admit, refusal-recovery
and deficits routines. Each nested block has the shared helper's exact statements
and ordering, including the isolation refusal, advisory try-lock and transaction
lock timeout. The nested variable scope preserves its existing declaration.
Original headers, invoker rights, ACLs and every other body byte stay unchanged.
No helper grant is added; custom invoker runtimes need no new grant. Browser
roles remain denied the helper. The earlier owner-rights wrappers and three
original revokes are removed. The reservation adapter retains its original SQL
and raw error identity; only stock-wait admit maps admission busy errors to the existing
Error details shape. No SQL security-definer parity is claimed.
No service pause, new money writer, table, price writer or attempt store is added.

The class amendment is exercised through a scratch registry and main's unchanged
reader until its separate control row lands. Repository admission logic and
class data stay unchanged. All repair inputs remain staged for the SQL read;
no committed repair or new native review has started.


The inline draft passes main's unchanged class reader with the proposed scratch
slot: all five bound forwards pass. Text proof confirms six exact nested gate
blocks and unchanged claim, prepare and destination-view statements. Five real
PostgreSQL inventory shapes were measured; only the three current-inventory
literal sites changed, with historic pins untouched. Fresh core/platform builds
and the complete API check pass, with no report edit.

The default-zone caller sweep stopped after 66 passing and one failing case:
18 gate/ACL witnesses and all eight inventory-native cases pass; the purchase
reservation suite has 40 passes and one admission-busy refusal. Its unchanged
concurrent purchase/renewal Promise.all expects both reservations to return,
whereas both writers now enter the same advisory try gate. The renewal call
raises inventory_admission_busy before those accounting assertions execute.
No existing assertion was changed or retried; remaining proofs and measurement
wait for maintainer disposition. Both named main test files are byte-identical
to the starting head. All draft changes stay staged and uncommitted.

Self-retro: the expanded caller sweep caught the shared-admission concurrency
interaction before another review or canonical verification run. The repair
keeps the admission refusal visible instead of hiding it with a retry.


The maintainer then authorized one main-test exception: purchase reservation
precedes renewal reservation in the shared-accounting case, while every
accounting assertion stays unchanged. Concurrent admission is covered by two
new restricted-role witnesses, alternating the winning purchase/renewal
transaction. Each gets exactly one busy refusal with all public rows unchanged
for the refused side, then succeeds on retry with ten total held units.

The installed generic and native runner witnesses show admission busy causes no
charge, dunning, terminal outcome or customer message. The durable operation
stays claimed and service stays active; after the existing lease expires,
retry settles that same operation with one charge. The native witness takes its
all-public-row baseline at the reservation boundary because batch discovery has
independent housekeeping. The initial wider batch-level snapshot observation
is retained in scratch evidence; production code was not changed for it.

The full scanner set reached a new module dependency finding: subscriptions now
imports InventoryPersistenceError from the inventory entry, but the declared
subscriptions value-dependency list is empty. The import-map witness rejects
that edge. Pending slot-amendment scanner failures are separate. No graph,
checker, test expectation or error-constructor workaround was changed; the run
stopped for disposition, with no further suite launches or package measurement.

Self-retro: an allowed public module entrance still requires a declared module
edge. The full scanner set caught that distinction before another review or
canonical verification run; transient-money behavior remains separately proved.


The module dependency finding was resolved by retaining the previously reviewed
plain Error with details.code and details.reason, without an inventory import.
Only stock-wait admit applies this mapping; other calls preserve raw errors.
The batch runner catches the thrown error as a technical per-row failure rather
than a shortage, charge failure or terminal result. Its installed generic and
native busy witnesses pass again with this shape, and the import-map scanner
passes all 123 cases. No architecture graph or error-handling runner changed.


The resumed caller sweep completed 33 default files with 527 passes. Under
Etc/GMT-9, 30 PostgreSQL files produced 505 passes and four failures. Three
failures are the previously classified lifecycle date-only and transfer-text
sites. The fourth is an unchanged main assertion in
retainedClientSubscriptionImport.test.ts:127: its query selects occurred_at::text
and expects a +00 spelling for an explicitly zoned creation instant. That site
is outside the allowed failure list, so the run stopped for disposition without
editing it. No further zone, scanner, handover, cheap-check or pack launched.
The import-map suite passes 123 cases and the installed renewal suite passes
24 cases with the reviewed Error details shape; no error-class dependency is
needed for the transient path. No source change beyond that disposition was made.

Self-retro: the module-local existing error shape preserves the runner's thrown
technical failure without adding an architecture edge. Expanding the caller
sweep also exposed an additional existing UTC-text assertion; its permission
to fail is kept separate from the already approved three sites.


The retained-client assertion was subsequently confirmed as a pre-existing main
zone-text site, owned by 7a82eeb2 (2026-10-27). It remains unchanged. The complete
caller sweep now has 33 default files / 527 passes, and 30 PostgreSQL files /
505 passes in each of Etc/GMT-9 and Etc/GMT+5. Each fixed zone has exactly four
permitted main failures: the lifecycle date-only site, two transfer text sites,
and retained-client import :127. All own busy and retryability witnesses pass.

The full scanner set has 2,016 passes, 16 pending slot-amendment case failures,
and two skips across 81 files; the three associated collection refusals have
the same pending signature/preimage mismatch. The exact sixteen case names
and messages match the recorded pending-control failures. No import-map failure
remains. Main's byte-identical reader admits all five bound forwards against
the proposed scratch class. The real PostgreSQL catalog passes 132 cases in
both role modes, and the stock-wait store's 11 cases pass with the existing Error
shape. Five catalog inventories were remeasured and agree with the staged
current-inventory literals; historic pins remain unchanged. The finite handover
reaches its terminal witness in default, Etc/GMT-9 and Etc/GMT+5 (100.79 s,
99.67 s and 99.55 s). Lint, typecheck, ast-grep, both neutrality checks and the
complete API check pass. Privacy scanning finds no private added text.

Official Node 24.21.0 pack against c6248bf2: +21,005 packed bytes, +14,497 code
bytes, +108,584 unpacked bytes and +16 files. Absolute: 2,492,607 packed,
1,987,360 code, 11,723,947 unpacked bytes and 3,063 files. The total packed
margin is 102,393 bytes; the code margin is 67,657 bytes. Against the prior
17,490-byte own-row measure, the inline repair adds 3,515 packed and 19,419
unpacked bytes with no new files; code-class compression drops by 120 bytes.
The SQL copy grows 20,519 bytes; the six changed source/build files together
shrink by 1,100 bytes. The own-row measure exceeds the earlier 18,400-byte
line by 2,605 bytes and is presented explicitly for the lead's size disposition.
No release-gate number changed. All repair inputs remain staged and uncommitted
for the SQL read; the actual class integration and native review remain later.

Self-retro: preserving the established Error details shape avoided an unwanted
module edge without changing the technical refusal path. The complete callers
sweep and its explicit zone exception list now distinguish inherited test-text
assumptions from product failures and pending admission data.


The frozen admission-control integration is mechanical: merge 6e4676c8 has the
exact predicted tree 6ed5f021. It changes no database, platform-source or native
PostgreSQL test input from the accepted signed repair. All five bound forwards
pass the actual class reader. The full scanner set passes 3,662 cases with zero
failures and two opt-in skips across 81 files, clearing the former class reds.
The one sequential accounting setup and admit-only plain Error details mapping
remain accepted. The own-row packed stop is now 21,500 bytes; total packed and
code limits remain 2,595,000 and 2,055,017 bytes.

F-ZONED-TRANSFER-TEXT covers the recorded pre-existing main timestamp-text sites,
including retainedClientSubscriptionImport.test.ts:127 and the date-only
subscriptionRetryLifecycleCases.ts:107 site, as well as the transfer pair. These
main assertions remain unchanged; they are not allowances for product defects.

Self-retro: the actual control integration clears the admission failures without
changing a reader or relaxing a test. Documentation bindings are refreshed only
for this new predecessor comparison, before native review freezes the candidate.


## Adoption fixes: frozen stock-wait UUID bindings

The public frozen-case reader now compares case, cycle, order and payment IDs
by UUID value using the existing private helper from nativeRetryDriver. Returned
binding IDs and started/resumed notice keys derive from the database case ID,
so equivalent host spellings cannot fork the readback or message identity.
Engine idempotency keys remain exact strings; null values and invalid UUIDs
remain distinct and genuinely changed identities still refuse. No new import-map
edge, public API, SQL, grant or fingerprint dialect is introduced.

The restricted-runtime installed PostgreSQL witness first fails on the old
reader with stock_wait_frozen_binding_changed. It passes after the fix in the
default zone and Etc/GMT-9: uppercase cycle/order/payment/case IDs return the
same case, changed and invalid IDs refuse, and every public row remains exact
with one charge only. The additional unit witness preserves null-vs-invalid
and case-sensitive engine-key behavior (12 store cases pass). An intermediate
own-draft run exposed the notice-key spelling site; that was fixed without
changing the new assertions. Lint initially found the old untracked diagnostic's
deep import; its source is now archived as text evidence, while the committed
witness uses the installed public export. No lint rule or exemption changed.

The source-wide sweep covers the complete changed platform/server file set
against main 9a3a324c. Boolean/state comparisons, schema/table/SKU names and
opaque authorization/method/engine references are not UUID matches. The
relevant comparison and key sites are:

| Site | Disposition |
|---|---|
| nativeRetryDriver.ts:91-98 | Host intent/order IDs already canonicalized before matching database IDs. |
| nativeRetryDriver.ts:113 | Host evidence operation ID already canonicalized. |
| nativeSubscriptionBinding.ts:85-111 | Both sides of the subscription seen-set already canonicalized. |
| postgresStockWaitStore.ts:125-133 | Fixed UUID-valued binding equality; engine key retains exact string equality. |
| postgresStockWaitStore.ts:63-73 | Fixed case-derived binding and notice identities to use the database case ID. |
| nativeRenewalCodec.ts:165 | New destination UUID already canonicalized before freezing. |
| postgresRenewalStore.ts:80-91; postgresRenewalSettlement.ts:4-55; postgresDeliveryAlignmentStore.ts:16-32 | UUID lookups use typed PostgreSQL casts rather than JS spelling matches. |
| public-reference facades, schema declarations and services | No UUID comparison or key matching is added. |
| connected capture/restore additions | Only table lists change; no UUID matcher is added. |

Unchanged main sites are reported without edits: nativeRenewalCodec.ts:111
compares due and schedule subscription IDs as text; :161 interpolates the host
subscription ID into its existing label. The main restore hierarchy at
connectedStoreRestore.ts:537-548 uses packet UUID strings as map/set keys;
:519/:526 compare whole row JSON, and :568-594 builds shipment exception labels.
The managed identity mapping at :68-101 already lowercases validated UUID keys.
These implementations predate this delta; their noncanonical packet behavior
is not newly qualified here. Frozen snapshot and transfer packet fingerprint
comparisons bind whole documents, so their byte-identity protocols are retained.

Self-retro: the real PostgreSQL witness exposed both the comparison and its
adjacent case-derived notice identities. The systemic sweep reports baseline
sites separately, preserving the approved boundary instead of expanding this
repair into unrelated main code.
