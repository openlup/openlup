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

## Sole SQL replacement and installed chain

Source: `db/platform/migrations/20261101230000_subscription_renewal_terminal_replay.sql`.
The only replacement is
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
