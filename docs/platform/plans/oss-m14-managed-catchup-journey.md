# M14 D32 8D-2 — managed connected catch-up journey

Status: restacked local candidate on the signed managed typed-transfer predecessor
`04cb1137dca571fe99d685bb6c645e9441407339`. Complete adapter-overlay,
real-overlay and normal real journeys now pass. The combined fixture/capture
read remains pending; no DCO or native review has run on this candidate. The earlier 8D-2 head
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

The next predecessor carry has parents `fce132d2b2d3cea38d4d110e68a5eb8e8a0ec5ff`
and `7c909b0bc453f855fb9c96175249c7da5b926686`. It merged without conflicts
or manual resolution; the automatic tree before this note was
`bf77d6cbdc57f4bd9db314df7a2fd36efa06b0a3`. The zero-context own patch-id
before was `175a2f1ecb600b91c4199531e89cb0e60770ca4a`; after it was
`4cf8b745dc34fb99c910bcabc03d8eff98fd345c`. Every owned path has equal
per-file patch-ids except the publication catalog, where Git aligns identical
JSON separators differently beside the predecessor's new entry. Parsing both
catalog deltas gives the same three added public-output paths and no removed
or changed entries. The required aggregate equality is nevertheless absent,
so the carry remains uncommitted pending a maintainer read. The compatibility
fixture conversion, real-source runner extension and parity proof have not
started. The interrupted earlier focused rerun is obsolete and claims no new
proof. Self-retro: repeated catalog separators can change a zero-context text
patch identity despite equal entry deltas; retain both identities and seek the
bounded carry decision before DCO rather than rewriting catalog bytes.

The catalog comparison rule subsequently admitted that clean carry: the parsed
delta is the same three additions with zero removals, and the zero-context
patch-id excluding the catalog and this record is equal on both bases,
`1294a74f8f1fa657e8793dec36b242946428df5f`. DCO merge
`433907f7fd25e6f0577e7e2052b42201936c5d8c` has the exact staged tree
`3ce34e33970e3071b0827d4f6c74d0001d53f19b`; no fixture edit was included.

The new fixture candidate replaces its private Supabase CLI startup with
`runManagedCompatPostgres`, matching the predecessor's source suite. An owned
loopback port supplied only by the opt-in real-source runner selects a real
managed stack instead. The final read-only pool, source seeds and all existing
capture, catch-up, refusal, typed-target and H1/H2 assertions remain. No
`supabase.sql` shape or grant has been added and no assertion has moved to a
weaker substitute. Required `m14ManagedCatchup.test.ts` executes the managed
first leg on the compatibility source and qualified PG16; it needs no CLI or
Node container image. The complete H1/H2 three-installation executable remains
opt-in and retains its already-local immutable Node 24.21.0 image prerequisite.
Reports label compatibility and real sources separately.

The real-source runner now gives the seven source-projection tests, the managed
first-leg Vitest case and the complete journey separate fresh owned stacks.
It records CLI archive/binary, baseline, source schema/image and journey-report
identities and refuses a missing/mismatched Node image, missing CLI pin, failed
assertions, skips or failed cleanup. The real journey runs once. Before the new
read packet, compare ordered Vitest names/statuses for the adapter and real
first leg, compare its deterministic facts with the earlier complete journey,
and confirm required discovery excludes the opt-in runner. Then run strict
typecheck, lint and focused tests through the shared gate and scan the staged
tree for secrets. This fixture change remains uncommitted pending its read.

The adapter and real-source proof passed. Private evidence is under
`.context/scratch/oss-m14-managed-journey/`: `adapter-vitest.json` (8/8),
`adapter-first-leg.json`, `adapter-parity.json`, `adapter-preservation-refusals.json`,
and `adapter-typecheck.log`/`adapter-lint.log`. Required discovery lists the new
managed test among 2,205 paths and excludes `runM14ManagedSourceWitness.mjs`.
The adapter complete report is `journey-AOJA7k/report.json` under
`.context/scratch/oss-m14-connected-catchup/`. The opt-in witness report is
`.context/scratch/m14-real-managed-source-r7gL4c/report.json`; its three fresh
source jobs passed, including the complete `journey-RfM5Sj` report with SHA-256
`43d12d338fb86e8f75c4013fbdff548ea9ba33a3c63e6f4dbae72f9724dc4bee`.
The runner source SHA-256 is
`3aae506c5980280409f04b8be7098e21c111ceb6c40810dab9df1e114be1f051`.

| Proof | Earlier real journey | Adapter | New real witness |
| --- | --- | --- | --- |
| Ordered source-suite Vitest names/statuses | Not recorded by this journey | 7 passed | Same 7 passed |
| `catches up managed typed obligations with interrupted copy, source-only history and activation refusal` | Executable facts passed; no Vitest name then | passed | passed |
| Managed first-leg counts and deterministic facts | Reference | All equal | All equal |
| Complete journey outcome | Ready, uncertainty fenced | Same | Same |
| Complete review-audit rows | 27 | 27 | 26 |
| Overall fixture readiness elapsed ms | 110,444 | 92,157 | 90,994 |

All eight current Vitest names and statuses are equal in declaration order.
All 82 managed first-leg table counts match the earlier report. Full journeys
match 81/82 final table counts and all retained business/object/refusal/effect
facts: 8 subscriptions, 2 terms, 3 settlement intents, 2 duties, 6 outbox rows,
3 complete objects, 1 partial, 15 activation refusals and 1 fenced uncertain
dispatch. The cross-run audit cardinality difference is disclosed; each run's
unchanged full-row source-to-target comparison passed, including its own audit
rows. Callback ordering differs in the real media-race trace. No assertion was
weakened to manufacture cross-run equality. These are fixture timings only.

The real source used CLI 2.122.0, macOS arm64 asset 668849778, archive SHA-256
`fe87a5f9781d5423dbd5a6e1a541d01754d14941c574952e5695eaab0` and binary SHA-256
`89838b26049c0672f9609aaf46455c89a46d351f852e313c0c5ae6b3abcbdf9d`.
All three jobs observed source image
`sha256:c141fd17ac6a76c4323e90b3aee8ff1a23d2e89e547c2b963cfadc309c079cc2`,
schema SHA-256 `af016442b7e376e273dc56ce170c2960a1c75635375b3e9f499802df2baaa1b1`,
and the unchanged baseline pin `fb4de62d4ccf30dca83075b41ea2769ddf74165ecd47d21875790ed5f397ccbe`.
The already-local Node image was
`sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20`.
Missing image argument and absent immutable image both refused with exit 1.

The source seed/capture suffix is byte-identical to the accepted carry,
SHA-256 `7918a16f566d77f4f6b5ada9e0805f4da6b16a2f6c6485145571d3ff16542fd0`.
All assertion-bearing lines of the managed first leg and full H1/H2 executable
are unchanged. No business assertion moved; CLI provisioning/version checks
belong only to the real runner. No adapter SQL delta was needed. Strict
typecheck passed all five projects and lint had zero errors (33 existing
warnings). The shared typecheck gate waited 1,473 seconds; later gates admitted
immediately. Self-retro: preserve the existing assertion body behind one source
fixture seam, and compare per-run facts explicitly rather than treating a live
race's audit total as a deterministic cross-run inventory.

## Current carry, native witnesses and refusal evidence

The pending merge retains first parent `433907f7fd25e6f0577e7e2052b42201936c5d8c`
and imports managed predecessor `04cb1137dca571fe99d685bb6c645e9441407339`.
The resolved carry tree, before the subsequent witness/fixture edits, is
`08372106d72a30378c311818b211ed84cadc1c8f`. Outside the approved architecture
paragraphs, regenerated context, imported runner duties and catalogue, the
zero-context patch-id is equal: `e2c5e381ab50a98ca20ecc3922df50aea9805cbb`.
Parsed catalogue additions are the same four rows with zero removals. The carry
keeps the managed first-leg paragraph, unions the source-history paragraph,
regenerates context, and retains three fresh runner jobs with all sixteen
source tests, no skips, the non-superuser capture-role check and source-schema
record. The prior fixture read remains pending and is combined with this delta.

The current predecessor refuses every managed invoice row. The fixture removes
its managed invoice/issue-outbox seeds. The independent native portable
invoice-duty seed is restored verbatim from HEAD; native invoice transfer stays
in scope and its nonempty-table preservation assertion is unchanged.
Managed effect reconciliation now expects zero owed invoice duties rather than
one; both targets assert absence for the managed paid order. No invoice
assertion moved elsewhere. The predecessor suite independently refuses invoice
states. Native generic invoice transfer tests remain; all other catch-up
assertions, subscription/frozen-term checks, money, outbox, object and dispatch
checks remain. Earlier successful counts and unchanged-assertion hashes above
describe their historical trees, not this candidate.

The native capture audit found only owner or row-security-bypassing callers;
restricted captures retain the existing inherited acquisition-owner window.
The adapter now sets local row security off, so filtered reads refuse. Its new
negative login test first explicitly sets row security on, observes zero rows
without error, then records SQLSTATE `42501` and capture's `database_unavailable`.
The separate native JSON witness captures/restores an outbox payload and reads
`9007199254740993` exactly as PostgreSQL text. Both passed; no rounding occurred.

The earlier local run stopped with `target_conflict` on
`public.commerce_order_items`: both synthetic order-item inserts omitted
`sku_id`. The lead authorized up to three seed-omission repairs without guard
or assertion changes. One repair category was used: both items now reference
the existing seeded SKU. The source's SKU foreign key and populated-SKU order
creation paths admit that shape, and the real pinned source captured it
successfully. No other seed, guard or assertion changed in this repair.

The lead corrected the earlier native invoice-duty removal: it belongs to the
portable leg and never passes through managed capture. Restoring that one
INSERT resolves the nonempty-duty assertion without changing it. Managed
activation still requires zero owed duties before portable fixtures are added;
both target readbacks still find no duty for the managed paid order. The native
portable order carries its separate owed duty through takeover. The real runner
now saves child stderr as a private mode-0600 scratch file before checking exit.

Shared-gate strict typecheck passed all five projects; lint passed with zero
errors and 33 warnings after completed scan extractions were removed. All three
requested complete journeys passed, with no failing step/code/relation:

| Run | Complete report | Final captured rows | Fixture elapsed ms |
| --- | --- | --- | --- |
| Compatibility with temporary managed-number guard | `journey-O4jwBR` | 187 | 93,100 |
| Real source with temporary guard | `journey-tegoCn` | 187 | 90,409 |
| Normal real runner | `journey-Zk8ed6` | 188 | 90,307 |

All preserve 8 subscriptions, 2 frozen terms, 3 settlement intents, 1 native
invoice duty and 6 outbox rows, plus 3 objects and 1 partial. They exercise 15
activation refusals, successful takeover/rollback, recovery of two accepted
effects and fencing of one uncertain dispatch. Managed first-leg counts are
identical across all 82 tables: 48 rows and zero invoice duties. All six managed
activation facts pass and all five one-row retained-history dispositions remain.
The normal runner separately passes 16 source tests and the first-leg Vitest
case on fresh sources, recording `postgres` as NOSUPERUSER/BYPASSRLS for the
source suite. This does not qualify the journey's managed capture login.

Compared with the earlier passing full reports, invoice duties 2→1, fact
revisions 1→0 and effect receipts 2→0 reflect only the removed managed invoice
projection; invoicing cutover 0→1 is the predecessor's paid-transition marker
preventing a new duty on carried settled history. First-leg duties change 1→0;
its other three invoice deltas are the same. No other deterministic table count
changed. Review-audit rows are 26/26/27: the live media race records 2/2/3
`media_cleanup` actions; all other action counts match. Each run's complete
source-to-target row comparison passes, including its own audit rows. No cross-run
row normalization or all-count equality is claimed.

Structured evidence in parcel scratch `cd94-journey-evidence.json` includes all
82 captured table counts per leg/run and every count delta against earlier
`journey-JFjU43`, `journey-AOJA7k` and `journey-RfM5Sj`, with reasons. Selected
business/readiness/effect facts match those earlier reports. Fresh IDs, process
identities, timestamps and digests vary by owned installation; source labels
identify the rail. Timings are fixture elapsed values, not RPO/RTO or a matched
performance comparison; older private-CLI provisioning and current externally
provisioned real-source runners have different start boundaries.

Real overlay report: `.context/scratch/m14-real-managed-source-n8LY0y/report.json`;
normal runner: `.context/scratch/m14-real-managed-source-3YiFDm/report.json`.
All child stderr files are saved and empty. Both temporary overlays were
reversed separately; each pre/post binary diff is identical. No managed guard
overlay remains. Managed Storage remains a current limitation. Staging census
remains BLOCKED-ON-OWNER-UNLOCK. No DCO, prepare, review, canonical verify, push
or PR ran. Self-retro: distinguish managed unsupported rows from independently
seeded native obligations; restore the native witness instead of weakening its
preservation assertion, and retain child diagnostics before checking failure.

Current real runner source SHA-256: `a7f22fc66be27aac6252ed055f4be8435291e804f80518aa7df6287e45098762`.
Current CLI archive pin: `fe87a5f9781d5423dbd5ebba2d5a6e1a541d01754d14941c574952e5695eaab0`; binary:
`89838b26049c0672f9609aaf46455c89a46d351f852e313c0c5ae6b3abcbdf9d`. Source image and schema pins match the
prior fixture run; no broader source-login or hosted qualification is claimed.
