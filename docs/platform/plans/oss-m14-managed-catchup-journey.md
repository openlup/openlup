# M14 D32 8D-2 — managed connected catch-up journey

Status: restacked local candidate on the signed managed typed-transfer predecessor
`5b0843e5f3e6543e16f63ce4c96da78fa9ac74fc`. The earlier 8D-2 head
`3e9486249da98e45b99ab2304ec63d82e5835512` (tree `e879c9e6`) passed
cycle-1 native review twice, then became inapplicable when the predecessor
removed full-row sidecar transfer. The predecessor is not yet on main.

## Outcome and boundary

Extend the delivered portable-to-portable catch-up witness with a pinned real
local managed first leg: managed source → fresh qualified-admin self-host PG16 →
independent PG16. Compose the predecessor's finite typed capture/mapping and
native restore. The operator retains history-only rows in the source archive;
they are absent from both targets. Reconciled settlement batches/matched items
and expired completed idempotency receipts are source-archive history, while
settled payment state and the provider payment reference are carried in typed
native rows. Unexpired completed keys refuse. Nonempty managed Storage refuses
in this parcel; its separate typed object projection and managed-object witness
belong to a later parcel. The existing portable leg still carries native
private media and partial uploads through its object path.
The disposable fixture observes the source-only rows before teardown and
reports their disposition; durable operation of the owner's archive is outside
this local journey.

Preliminary source copy runs while catalog and consent rows change. Interrupted
export/import roll back and resume. After the declared managed writer/DDL lane
seals, final full recapture goes to a fresh inactive first PG16 target. H1/H2
then retires the portable writer/DDL/ingress/recreation inventory and exports a
second full final generation. Activation requires typed DB state, native
objects, effective access, drain and effect agreement. The witness proves a
pre-takeover refusal and successful takeover while preserving active
subscriptions, frozen terms, unsettled money and outstanding duties. It reports
counts, timings and refusals for later local consumers. No CDC, generic row
upsert/delete engine, production coordinator, hosted qualification or
older-snapshot RPO/RTO is included.

The active supervisor is the single writer in this assigned worktree. The M14
module grant covers local work, DCO, independent native review, draft PR and
later queue merge only after all gates and the lead's predecessor-landed notice.
This restack changed the intent and removed earlier sidecar assertions; the
exact-tree maintainer acceptance and DCO are recorded below. No hosted-resource, credential,
settings, deployment, production, release or npm authority is included. The
sanctioned read-only staging census for all-null settlement links, dangling
Auth IDs, unbound snapshot fields and service relations remains
**BLOCKED-ON-OWNER-UNLOCK**; no staging access was attempted.

## Proof and merge record

The smallest adequate route is existing managed typed projection and native
capture/restore with direct source-to-target assertions. Its main risk is a
source-only obligation mistaken for a transferred row, or a changed typed fact
lost between preliminary and final capture. The local discriminator checks
source dispositions and exact typed target state at both PG16 installations;
separate portable object readback and H1/H2 fencing remain the delivered route.
Run the focused managed journey on the tree's pinned CLI, then catalogue,
publication policy, strict typecheck, lint, structural, neutrality, secret and
whitespace checks before the new read packet. After acceptance, DCO the exact
tree, `prepare --new`, obtain two new full reviews, and wait for predecessor
landing before canonical verification and delivery.

The accepted option C merge has first parent `3e9486249da98e45b99ab2304ec63d82e5835512`
(tree `e879c9e6a7cfbd15211cdcbeefd75c34e162fcec`) and second parent
`5289e6e482c37043dedb1432f89c4b50ca96546c` (tree
`8c5383fd4b1adaade4002163170bde0385317a51`). Four own-file conflict
sites were resolved in `CONTRIBUTING.md`, `ARCHITECTURE_AND_EXTENSIONS.md`,
`RUNTIME_AND_SELF_HOSTING.md` and `runM14EffectHandover.ts`: keep the incoming
older-snapshot and CLI changes, then replace the superseded managed sidecar
claims and code with the typed local first leg. `DATA_AND_MIGRATIONS.md`
merged without a conflict and its stale sidecar prose was corrected. Its exact
result tree and own-delta hash were accepted before the merge DCO below.

The old sidecar assertions have typed replacements: source catalog update/add/
delete is checked in the mapped packet and both targets; changed consent is
checked at source and both native target consents; settled payment, provider
reference, invoice duty, active subscription and frozen term checks use native
target rows. Source-only settlement, idempotency and payment-reference rows are
checked through the finite `retained-history` census and absence from target
schema/packet; no sidecar digest, bytes or privacy-disposition readback remains.
Managed Storage object copy and ACL assertions are removed because nonempty
managed Storage now refuses and the managed-object path is a separate parcel.
Portable private media and partial-file checks remain in the H1/H2 leg.

The prior accepted local proof on tree `e879c9e6` used a 44-row sidecar; those
run-specific counts are historical and no longer describe this contract. Cycle
0 found `D32-8D2-MEDIA-BINDING` and `8D2-CONSENT-FINAL-READBACK`; cycle 1's two
fresh full reviews closed both for that old tree. The direct canonical verify
was terminated at root tests (code 143) after the predecessor change; it is
not a full PASS and cannot be reused. A preceding nested-wrapper invocation
refused before policy. The new intent preserves this native history and uses
`prepare --new` after the read. Self-retro: the earlier fixture compared its
own descriptors and mapper packet; direct sealed-source facts repaired those
gaps. The predecessor's archive-only decision simplifies transfer by removing
the unneeded private sidecar, while explicit source-only dispositions keep its
loss boundary visible.

The option C focused journey passed with the tree's CLI 2.122.0 and Node
24.21.0; log `optc-focused-final.log` and structured report
`.context/scratch/oss-m14-connected-catchup/journey-JFjU43/report.json`.
The managed first leg took 27,383 ms fixture elapsed time: 1 active
subscription, 1 blocked renewal term, 2 settlement intents, 1 owed duty,
2 pending outbox events and 1 denied consent reached the first native target.
It proved 2 changed facts, 1 added product, 1 deleted product, an unexpired
completed-key refusal, export interruption at read 8, import rollback/resume,
6 activation-agreement refusals, and 5 one-row `retained-history` dispositions
absent from the target; settled money and its provider reference are typed.
The second leg ended with 8 subscriptions, 2 renewal terms, 3 settlement
intents, 2 duties, 6 outbox events, 3 complete objects and 1 temporary object;
the history-only relations remained empty/absent. Its report records 15 total
activation refusals, rollback to the authoritative source and successful
takeover with one uncertain dispatch fenced. Overall selected-target readiness
was 110,444 ms from fixture start; this is fixture timing, not RPO/RTO evidence.
The first attempt stopped before mapping because the paid-order fixture made
a planned communication delivery. Matching the predecessor's fixture cleanup
removed that generated row; no production mapper or transfer API changed.

Maintainer acceptance CD-M14-64 (2026-10-30) covers option C merge tree
`8605d10d93356298f630691873bada3c19c4e014`, with parents `3e948624`
and `5289e6e4`. The independently recomputed own-delta SHA-256 versus the
second parent was equal:
`b40e9c5f96c3902e69510dbff689ad0761595952f23ec2dc2ae52597ddfad44c`.
Commit `5ce8fe0188ed3bde57516fffc52d5f989a67064a` DCO-signs that exact
tree. The post-commit documentation policy check passed both obligations and
produced no generated-navigation change.

The CD-M14-64 predecessor carry merged `5b0843e5f3e6543e16f63ce4c96da78fa9ac74fc`
into `945b4e147d91a4c2bba5e14d9924ff848108414d` without conflicts or manual
resolution. It imports only the predecessor's reviewed lineage, including its
main merge, payment-attempt link refusal and evidence note. The automatic
merge tree before this evidence note was
`9b5e8baea49851c8a93f1d4c1fec9f69d84b7ebd`. The complete own-delta stable
patch-id versus `5289e6e4` before and `5b0843e5` after was equal on both sides:
`0de58ea8e7720a16e35e312a2207877617aa7400`. Excluding only this task record,
both patch-ids were also equal: `44532ac739a44b8c312ac56b30bad2c6bb536b4f`.
The payment-link refusal is exercised by this journey, so its focused local
proof must run again before review; a fixture payment refusal requires a new
maintainer read before changing the fixture.

The carry is DCO commit `106cc95e2a3e6f50fb60fccc96cc6798253f6d8b`, tree
`96643318b9dd2dae5a46030845fdfe4d74f9b074`. Current instruction freshness was
checked against `origin/main` `8ae51d2923bcc13bb4a9a12da646bbeb8edeb684`,
separately from the stacked review base. Regenerating the platform agent
context changed only the two source-span references for the unchanged
additive-forward excerpt (180–202 to 186–208); its text and digest are equal.
The first shared heavy-gate wait timed out after 3,006 seconds with another
test command active. This is host waiting, not journey fixture elapsed time;
the prescribed gate retry precedes the carried-tree focused run.
