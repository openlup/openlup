# Native renewal, retry and alignment composition

Status: local implementation and focused proof complete; maintainer read accepted
for DCO sign-off with the production-query disclosure recorded below. Destination, stock-profile and simulator joined proof remains a
delivery condition at the instructed predecessor integration. No full joined or
hosted qualification is claimed.

Outcome: expose the existing native renewal/retry/alignment pipeline through
public subscriptions exports, fix historical terminal replay, and preserve the
finite connected-transfer graph for the rows this path writes. Keep real repair,
stock wait, retry fencing, active-service exhaustion and monotonic lateness.
No new price writer, payment-attempt store, SQL routine or managed behavior.

## Scope and authority

Dedicated worktree `oss-m19-g7`, branch `codex/oss-m19-g7`. Signed predecessor:
`9ac0992776bbe5f295c3698fe28e732202b36fa3`, including main `09cd599b`, the
retained-method compatibility fix and the offline installed-consumer correction.
Earlier unsigned work was consolidated as signed `63f9d783`; that signed commit
is preserved. The new test-only predecessor is merged with signed `87ed500f`,
without rebase or rewriting any signed commit. Later native review uses the
new exact predecessor as `OPENLUP_STACK_BASE`.

The supervisor authorizes local implementation, explicit stack merges, focused
checks and DCO-signed consolidation of the accepted candidate onto that signed
predecessor. Its existing signed commits remain unchanged. This run stops before
native review. No registry pin, checker edit, canonical verify, push, PR,
publication, deployment or external service write is authorized in this run.
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
unsigned draft. The native reservation, release, expiry and stock-wait entry
points now have six owner-rights gated wrappers. The existing stock routines
are unchanged. The three direct stock-wait grants narrow to the wrapper path;
the helper remains owner-only. The original reserve, release and expiry PUBLIC
EXECUTE is an accepted residual tracked as F-NATIVE-PUBLIC-EXECUTE.

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
transfer set remains 107 tables; these wrappers add no row-holding table.

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
