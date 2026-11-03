# Native purchase holds

Status: the admission port is staged for the maintainer's whole-delta read.
The inventory-owned error mapping passes lint without a cross-module dependency.
PostgreSQL proofs preserve expiry execution access and deny direct runtime entry
to the owner-only helper. The prior control amendment remains required. No
admission-delta commit, native review or delivery has started.

## Outcome, authority and scope

The supervisor authorized G4 only: purchase hold, release and expiry on the
existing native reservation table, through a public factory and restricted
runtime. Local implementation, focused checks and a clean DCO-signed history are permitted.
The narrowed donor slice and existing-table ownership alteration cannot land
until a separate prior control admits them; the stabilized owner read is accepted.
The coordinator accepted the ownership shape in principle for this slot and
accepted the donor slice; neither remains an unanswered design decision. No
review/admission machinery or approval pin changes. G3 remains a later task in
its own worktree; no destination, activation or codec implementation is included.

Branch: `codex/oss-m19-g4`. Code review base and freshly fetched policy pin are
separate identities, both initially
`bb0008481a11267ec6dbe3e7e531299777cddc19`. Work is confined to the assigned
worktree. There is no release, hosted, production or credential authority here.

The initial inventory stop found the non-null renewal owner, incompatible local
allocation model and donor replay differences before SQL was written. The
supervisor resumed this local draft with existing-table purchase ownership,
observed-stock outcomes and two deliberate differences: changed keyed input
refuses, and elapsed initial expiry refuses by name. The coordinator accepted
the narrowing and the ownership shape in principle; the stabilized read is now
accepted, and the small control remains a landing prerequisite. The alternative
companion stock table was rejected for this draft because it changes the chosen boundary and requires ATP
replacement. No scope or retry budget is reset by this resume.

## Donor characterization recorded before SQL

Explicit donor files:
`supabase/migrations/00000000000000_platform_schema_baseline.sql`,
`supabase/migrations/20261024175000_inventory_available_to_promise.sql`, and
`supabase/migrations/20261024184000_inventory_reserve_order_uses_seam.sql`.
The committed donor test installs these files explicitly, not a directory seal.

| Boundary | Managed outcome and native mapping |
| --- | --- |
| Fields | Reserve receives key, order/item/cycle/SKU, quantity, kind, payment status, expiry, metadata and provider. Batch preserves item order. Native derives SKU text from finalized order items and uses an explicit observed-stock source; purchase kind is fixed. Metadata and requested fields remain in the command receipt. |
| Admission | Payment status is created/requires_action/processing/succeeded; quantities are positive. Missing/stale provider stock and shortage refuse. Native validates actual order/item/SKU/quantity, finite time, source/key/metadata shapes and aggregate per-SKU demand. ATP always receives renewal exemption false. |
| Effects | Validate, replay check, stock lock, ATP, reservation, managed balance increment and movement, response. Batch rolls back every line if any line fails. Native locks actual items and stock in deterministic SKU order, checks all demand, then writes one header/line per item and one batch receipt atomically. |
| Release | Locks reservation; missing refuses. Terminal state returns replay. Reserved becomes released once, balance decreases once, and managed movement retains key/reason/metadata. Native uses retained line quantities plus terminal status and a release receipt; ATP stops counting the row once. |
| Expiry | Locks elapsed finite reserved rows in expiry order, up to limit, marks expired and decrements balance once. No release movement is emitted. Native bounds limit to 1..1000 and changes only purchase-owned rows. |
| Concurrency | Stock-row locks serialize competing admissions; the loser cannot spend the winner's units. Release and expiry share the reservation lock; one terminal transition wins. Native keeps these boundaries and tests a simultaneous new hold, release and expiry. |
| Persistence | Identity, order/item ownership, quantities, expiry, metadata and status survive sessions. Replay does not allocate again; terminal release/expiry cannot restore units twice. Native receipts and rows survive a real PostgreSQL restart, with fresh pools and no reconstructed state. |
| Named limit | Local lots, location choice, FEFO allocations, balance counters and stock movements are not represented. Native stock is externally observed and live native lines are subtracted by ATP. The coordinator accepted this named limit. |

The donor replays key/SKU without comparing changed quantity/order/metadata and
accepts an elapsed initial lease. Native deliberately conflicts on changed
input and refuses elapsed initial expiry. Matching replay after expiry remains
valid: it returns retained identity/current status and never extends the lease.
UTC expiry normalization also preserves matching replay across session timezones.
The native binding adds bounded key/source/time/metadata and order-item ownership
checks; these are explicit, tested native input boundaries.

## Implementation and SQL risk assessment

Forward:
`db/platform/migrations/20261101224000_new_purchase_inventory_reservations.sql`.
No existing function is replaced. The renewal-owner NOT NULL property is relaxed;
its UNIQUE/FK remain. A purchase-order FK and exclusive-owner CHECK are added NOT
VALID then validated, with no data backfill or old CHECK replacement. The existing
expiry CHECK remains intact. One new command-receipt table binds reserve/release/cancel.
Purchase-order and elapsed-lease indexes support the two bounded access paths.

Five new routines implement owner-only admission, reserve batch, per-reservation
release, expiry and aggregate abandoned-order compensation.
Reserve, release and compensation are definers with `search_path = pg_catalog, pg_temp` to avoid
new runtime receipt-table writes; compensation also avoids a ledger UPDATE
grant. Reserve locks actual order items.
Expiry is definer-rights so the bounded entry can call owner-only admission.
Its migration-role ownership and EXECUTE access match the pre-admission version;
its purchase predicate, finite-time check and 1..1000 bound retain their meaning.
Every expiry reference is schema-qualified and its search path remains pinned.
All new routines revoke PUBLIC before the exact conditional role revokes.
The four entry points retain their service_role execute grant. The admission
helper has no runtime grant and explicitly revokes service_role execution. The new receipt table also has a bare PUBLIC revoke and separate conditional
table revokes for anon, authenticated and service_role. Table and function
blocks remain separate. No RLS, table grant, role or default privilege
statement is introduced; the existing reservation table has no privilege statement. Existing native table ACLs retain their trusted-runtime
boundary; these routines do not create hard isolation from that trusted caller.

Smallest adequate design: keep existing ATP, renewal, stock wait and retry
unchanged, sharing their stock-row locks and held/committed quantity accounting.
Purchase holds receive no soft renewal-demand credit. No second stock oracle,
generic state machine, scheduler process or dependency is added. Fiscal documents,
money truth, dunning, subscription schedules and parcel transitions are not
written. Finite terminal states, replay receipts and transactional rollback avoid
endless reclaim and partial obligations. There is no purchase worker claim token
to reuse; renewal claim/refusal machinery remains with its existing owner.

The managed inventory definitions and managed adapters are unchanged. Read-only
adopter search found the shared table name in native PostgreSQL admin reads,
not a managed definition; new routine/receipt names have no managed match. The
native and managed migration selections remain separate. Native reservation
admin listing still projects renewal ownership; G4 does not claim its extension.

G5 composition seam: `createPostgresPurchaseReservationPort` exposes
`reserveOrderItems`, `releaseReservation`, and `expireReservations`. The host
supplies finalized IDs, observed-stock source, server payment status and normally
an expiry from `reservationPolicyFor`. The companion
`createPostgresAbandonedCheckoutCompensationPort` supplies native
`cancelAbandonedOrder`; host composition and scheduled expiry wiring follow G5. No G5 file or existing compensation routine is edited.
The complete-chain packaging paths remain with their prerequisite owner; this
task does not edit packaged SQL or migration implementation paths on this base.

## Completion evidence and remaining gates

Node 24.21.0 and npm 11.19.0. Dependency installation passed. The selected donor
PostgreSQL suite passed 3 tests; the native suite passed 27 tests through an actual
restricted login assuming service_role. It proves browser execution refusal,
receipt-table write refusal, exclusive owner/FK/renewal uniqueness refusals,
changed input and elapsed expiry, late batch receipt-fault rollback, duplicate
SKU aggregation, concurrent admission/release/expiry, ATP/renewal/stock-wait/retry
accounting, expiry ordering/limit and restart replay. It preserves active service.

The resumed ownership audit searches all canonical/managed migrations, all four
package source roots, packaged SQL and server source. The stabilized external
read packet lists every matching file/function and distinguishes similarly named
columns on other tables. Nine existing SQL carriers are byte-identical mirrors.
Exact-operation predicates and INNER JOINs exclude NULL purchase owners from
renewal responses, release, expiry, cancellation, preparation and outcomes;
quantity sums deliberately include them. New real-PG cases prove mutual renewal
and purchase release/expiry isolation, preflight/outcome/late recovery isolation,
expired-own stock-wait recovery and mixed admin/stock-sync accounting. Existing
admin reservation listing remains renewal-only; purchase listing is not claimed.

The upgrade fixture seeds five renewal-owned rows before the forward: held,
committed, consumed, released and expired. It asserts the old NOT NULL refusal,
then unchanged original-column row JSON (excluding the added NULL purchase column),
unchanged reservation relacl and validated old/new
constraints after install, including convalidated=true for the new FK and CHECK.
The receipt CREATE TABLE passes the unchanged expand-only grammar in both modes.
The exact table narrowing is tested against fixture-only effective grants in a
rolled-back transaction; every named browser/runtime role loses all privileges,
with no RLS and no feature table grant.

The refreshed common brief also requires retained-store transfer. Six additive
capture/restore entries cover observed current stock, reservation headers/lines,
command receipts, activation state and compensation history. Restore follows order/renewal parents and header-before-line
ordering. Receipt JSON can contain personal metadata; existing owner-only access,
whole-packet row/byte limits, lossless PostgreSQL encoding and unknown-table refusal
remain. The full connected-transfer suite passed 8 tests, including the new actual
source/target row equality,
restored replay and changed-input refusal, plus a byte-limit refusal specifically at the receipt table with synthetic
personal metadata. These root adapter edits add no package assets.

Compatibility probes expose two existing restricted-runtime gaps, without fixes:
subscription cancellation cannot lock subscription_renewal_term_lines on the issued
prefix or after G4; promotion transition has claim-event INSERT but lacks SELECT
needed by its ON CONFLICT path, unchanged before/after. Both fail 42501 as asserted;
owner executions prove purchase rows remain unchanged without fixture grants.
No delivery, payment or parcel behavior is broadened by those owner-only probes.

All five actual catalogue shapes were measured and then accepted by canonical
runner zero-write replay: legacy 92 units, qualified bootstrap/separate 96 each,
restricted installer/operator 95 each. Their current digest/count expectations
were refreshed mechanically; every earlier source pin and issued-prefix
expectation remains unchanged. The measurement is local proof, not hosted or
release qualification. The final expiry invoker refinement was remeasured on all
five shapes and passed the native suite again.
Full existing composition/handover scenarios were not rerun here; their edits
only refresh current catalogue digests/counts, with issued expectations intact.

First native restart proof failed because the helper's default tmpfs discarded
its cluster. The fixture now uses its existing PGDATA option in the owned
container's disposable writable layer; no row reconstruction or helper change.
The first root typecheck found two empty fixture arrays inferred as never[];
explicit types fixed them, and all five public typecheck projects then passed
with zero unresolved edges and zero consumer errors. Ast-grep and diff checks
passed. Full lint passed with zero errors and 33 warnings in unchanged source.
The local measurement utility's two explicit-any lint errors were corrected to
existing container/installation types; no rule or suppression changed.

Real npm packs, built with the pinned tools against the exact original package:
base 2,102,771 B / 2,840 files; candidate 2,105,573 B / 2,843 files. Delta:
+2,802 packed B, +11,888 unpacked B, +3 files (source, JavaScript and declaration).
A separate real repack adding only this forward as a flat SQL asset measures
2,108,961 B / 2,844 files: +6,190 packed B and +4 files against base. This is a
budget projection, not a complete-chain install artifact; prerequisite manifest
packaging is separate. The expanded compensation scope puts the projection above the approximately
5 KB soft target: +1,468 packed B versus the previous G4 draft. No cap raise
is requested.
No cap or package version changes. Remaining review/integration work is estimated
at 1-2 working days after the prior control/read and preceding slots, excluding
unknown owner/admission wait time.

No approval pins, native review or canonical verification are claimed. The
small prior control and ordered predecessor landing remain delivery prerequisites.
The public API/security/transfer read is accepted for DCO; this resume signs the
clean candidate without starting native review. No withdrawal marker, supersededByStableJourneyKey, checkoutAbandoned
or dispatched-attempt storage is written. Repair cycles used: zero.

Self-retro: the early inventory stop exposed real contract differences before
control pins existed. A tmpfs restart assumption and implicit fixture-array types
cost two focused diagnoses. The simpler privilege choice is invoker expiry;
only receipt writers need elevation. The resume also caught synthetic
started_at later than cancellation time; aligning fixture time fixed its constraint
failure without changing production. The nullable-owner audit exposed existing
runtime privilege gaps rather than justifying wider grants. Lesson: inspect
persistence and existing permissions before freezing the fixture and function headers. No successor work
or process change is opened. The first focused admission alone waited 522 seconds;
shared-machine waits dominated elapsed time; the resumed pack gate waited
314 seconds. The transfer additions reused the existing finite lists and importer
instead of introducing another transport or control.


## Abandoned-order compensation extension, characterized before SQL

The supervisor extended this slot to native abandoned-order compensation. The
existing donor is commerce_compensate_abandoned_checkout(text,uuid,text,timestamptz)
in 20260814150000_subscription_activation_spine.sql. It validates key/order/reason,
locks/replays its compensation row (conflict compares only order), locks the order,
leaves non-pending orders terminal, otherwise cancels, fails only created intents,
compensates provisional activation, writes one compensation ledger row and returns
cancelled/reason/orderStatus/replayed. It neither releases inventory nor writes
withdrawal metadata. A missing order intends cancelled=false but its ledger FK
prevents persisting that response. Runtime has SELECT/INSERT on its ledger but
not UPDATE needed for FOR UPDATE. The generic RPC adapter instead names
commerce_cancel_abandoned_checkout, which is absent on native (42883).

Choose a new bounded SECURITY DEFINER wrapper over replacing that donor. It
preserves aggregate cleanup and adds one strict command receipt plus ordered
calls to this slot's purchase release routine in the same transaction. An invoker
would need a ledger UPDATE grant; replacing the body duplicates aggregate logic
and changes its existing callers. No shared function is replaced. The wrapper
locks order then its intents, matching the earlier payment slot's stated order,
and refuses renewal-order cancellation. It also refuses cancellation if existing settlement or captured/indeterminate truth
already records money. Exact keyed replay is immutable; changed order/reason
refuses. Missing-order response persists only in the new receipt, avoiding the
existing donor's FK defect. New hold admission excludes cancelled/terminal orders
while retaining pending/paid admissions and retained replay after cancellation.

Expose createPostgresAbandonedCheckoutCompensationPort alongside the purchase
reservation seam through the existing inventory entry; it returns only
CheckoutCompensationPort.cancelAbandonedOrder. No new subpath or existing OMS
file edit. Dedicated cancelUnstartedPromotionOrder has no native RPC and remains
outside this extension; ordinary non-promoted abandonment needs only this entry.
The existing donor retains its aggregate trigger behavior for promoted orders;
no promotion capability or transfer qualification is introduced.

The existing compensation ledger and activation rows become written by this
entry, so add both to the finite transfer capture/restore lists after order and
subscription parents. Test real restricted cancellation, provisional cleanup,
strict replay, changed input, terminal/paid/money refusal, atomic injected release
failure, simultaneous cancellation, ATP restoration and persistent restart.
Keep all withdrawal markers absent. Extend transfer proof to retained cancellation
receipts, compensation history and activation state with metadata byte limits.

Late-capture integration follows the earlier payment slot's recorded contract:
retain captured truth as review_required, never reopen or settle a cancelled order,
never create invoice/refund work, and do not lose the capture. This checkout lacks
that earlier forward. Do not copy or import its implementation. A committed
existing-truth API test exercises the recorded review disposition when that slot
is installed and reports the current base's order-not-payable refusal otherwise;
the full review_required branch must pass after ordered integration. This is an
explicit remaining cross-slot proof limit, not a claim of current G6 behavior.

Managed compensation audit: the new wrapper name has no public/adopter managed
match. The unchanged native donor appears only in the adopter's PostgreSQL
adapter and test. The generic commerce_cancel_abandoned_checkout name has its
own managed definition and callers; it is not changed, aliased or rebound here.

Compensation native proof: 27 real-PostgreSQL tests pass through the restricted
login. They reproduce generic RPC 42883 and direct donor ledger-lock 42501;
prove concurrent matching cancel, one donor ledger effect, strict reason/order
conflict, complete release/ATP restoration, rollback across the entire aggregate
when a release faults, paid/captured/indeterminate/settled refusal, renewal-order
refusal, admission/settlement races and persistent restart. The equal owner CHECK
passes the unchanged table grammar and remains catalog-validated. The late-capture
case passed only the explicitly identified base refusal branch; the earlier
slot's review_required disposition remains unproved until integration. No earlier
slot code is imported, copied or edited.

The full connected-transfer suite again passed all 8 cases with six G4-owned
profile additions. It preserves cancelled order/activation/hold/compensation rows
and both hold/cancel command replay. Table-specific byte bounds refuse at each
activation, compensation and command-receipt relation, including synthetic
personal metadata/reasons. Root transfer files remain outside the npm artifact.

A caller trace found that the checkout key may be reused for reservation and
compensation. The wrapper therefore derives a bounded cancellation-specific
receipt/donor key from the original key, while strict replay still compares
order/reason. A regression case deliberately reuses the reservation's key.
This preserves the existing port's separate abandonment key space and avoids
requiring new host key choreography. The initial draft's shared raw key would
have refused that valid compensation; it is corrected before review.

Resume self-retro: per-helper replay tests missed reuse of the public checkout key
across reserve and cancel. Tracing the existing caller caught it before review;
a cancellation-specific derived key within the existing receipt store and a
caller-level regression case preserve the port without extra host choreography.
No new abstraction, transport, role grant or admission exception was needed.

Final typecheck caught the caller-key fixture's inferred UUID-template type when
it received the port's plain string key. Typing the fixture from the actual
CheckoutCompensationPort input fixes that compiler-only mismatch; emitted runtime
logic and SQL remain unchanged. No additional production seam is added.

Lint rejected the initial internal commerce-type import under the module-entry
boundary. The native factory now declares its small structural cancel-method
shape without that cross-module dependency; an exact compile-time comparison
against CheckoutCompensationPort lives in the integration test. This keeps the
inventory declaration graph bounded instead of importing the whole commerce
entry, while preserving the public port meaning and unchanged runtime code.


## Accepted read and final preparation

The supervisor relayed the coordinator's accepted read of base bb000848,
head 8d1137e7, tree 55385460 and full diff be4aa34b, subject to the small later
control. The sole permitted SQL byte edit removes the transient LOCAL DRAFT
header; both squawk-ignore lines and all executable SQL remain byte-identical.
The manifest's three forward hashes follow the new file identity. The notable
change moves from CHANGELOG.md into a release fragment. Public inventory and
data owners now warn that references can identify people, recommend opaque
values, and state that there is no erasure path yet. Dedicated native promotion
cancellation remains unbound. No read scope, function signature or runtime
behavior changes in this preparation.

Acceptance still open: after G6 and G4 are both on main, run the joined real-PG
capture-after-cancel case and prove `review_required`, retained captured truth,
no reopening/settlement and no fiscal/refund work. This case remains G4's
responsibility; its conditional base-refusal result is not completion evidence.

The final candidate uses the scoped documentation no-impact trailers for the
existing test guidance and transfer architecture rather than editing
CONTRIBUTING.md. The user authorizes replacing the unpushed, unreviewed WIP
history with a clean DCO-signed commit as Bart Roszkowski <dev@openlup.com>.
No pin, checker, native review or other worktree is changed. Repair cycles: zero.

Resume self-retro: moving release prose into a fragment removes a shared
changelog conflict without changing shipped behavior. Keeping the joined G6
case explicit prevents conditional base proof from being mistaken for acceptance.


Final preparation proof: the restricted native suite passes 27 tests, the donor
witness passes 3, and the full connected-transfer suite passes 8. Public
five-project typecheck has zero unresolved edges and consumer errors. Ast-grep
passes; full lint has zero errors and 33 existing warnings. The old three WIP
commits and staged preparation delta pass redacted gitleaks scans. The policy
check reports all six documentation obligations answered without a
CONTRIBUTING.md edit. The runner accepted the refreshed forward file hash without
changing the measured catalogue digests; executable definitions are unchanged.

Re-measured real pack after the permitted edits: base 2,102,771 B / 2,840 files;
candidate 2,105,385 B / 2,843 files (+2,614 B / +3 files). A real repack adding
only the final G4 SQL asset is 2,108,729 B / 2,844 files: +5,958 packed B and
+29,524 unpacked B / +4 files against base. This includes G4 SQL as a budget
projection; complete-chain installation packaging still belongs to its
prerequisite. The root transfer files and release fragment add no package
assets. The +5,958 B total remains within the accepted G4 envelope including
compensation; no cap or version change. This supersedes the earlier draft pack
figure, not its historical evidence.

An initial transfer command invoked the Vitest wrapper directly
without npm's local-bin PATH; it exited ENOENT before tests. Supplying the local
bin PATH ran the unchanged transfer suite successfully. No fixture or production
repair was needed. The DCO checker also refused symbolic HEAD as a range end;
the rerun supplies the required full commit digest. Remaining ordered integration and review work is still
estimated at 1-2 working days, excluding admission/predecessor waits.

Package boundary: 2,819 assertions pass; API snapshot check passes. Focused gate
waits total 93 seconds in this resume. All preparatory checks are complete;
no native review or canonical verification is claimed. The SQL inventory and
accepted read packet retain the prior read identity plus the final candidate's
computed identities outside tracked source. G3 remains untouched.


## DO-ending compatibility resume

The supervisor authorizes exactly six END-to-END-semicolon edits in the forward,
DCO-signed on top of71539d088390817ef27a0ff35617ff02f71a4af6, with no new owner read
for this exact delta. New whole forward SHA256:
0fe4c20229e3635d61f820788e7d2b98148c8fd46daede44260f71da121e9323.
The diff is six replacements of END $$; by END; $$;, exactly+6 bytes. Every byte
outside those replacements is unchanged, including the added column, DROP NOT
NULL, FK/CHECK NOT VALID and VALIDATE statements, their whitespace/order/names.
The three manifest hashes follow the new file identity; no function-body/catalogue
change is intended. The one remaining restricted-chain literal is advanced94->95
under the explicit count-bump exception; historical identities remain unchanged.
No source repair or other SQL byte edit is authorized. If an existing suite needs
such a repair, stop and identify suite, case and mechanism before any fix.

Compatibility question: does G4 change valid rows/stores that never used its new
writer? Test the existing inventory exports and native reservation/ATP/renewal/
stock-wait/retry/preparation/outcome readers, and retained/connected restore paths.
The unchanged old writers supply a renewal owner; old NOT NULL rows satisfy the
new CHECK, keep UNIQUE/FK and ACL, and must remain untouched by purchase release/
expiry. A legacy direct insert with NO owner still refuses (now CHECK rather than
NOT NULL); it was never a valid old row. Existing full suites, not only new-writer
fixtures, are required. Complete scoped suite inventory and results follow below.
Native review, merge/verify/submission and the G3 worktree remain out of scope.

The full byte comparison to71539d08 passes: exactly the six replacements and
nothing else. All four function after-hashes are identical; the complete leading
ownership-DDL prefix SHA256 remains
980448ed2fd5a123d3b88a7e65b58d472465ed78a5adc50dda7f6f324349a803.
The earlier static comparison utility used JavaScript replacement dollars as
substitution syntax; using a literal-returning callback corrected that utility,
without any SQL repair. The scoped search followed SQL helper imports to57 test
files; every file is run unchanged at71539d08 except the permitted count bump.

Selected current catalogue values are unchanged by DO punctuation; fresh canonical
runner observations are recorded in the suite results below:
- legacy: "a7f554093bb9c597d4625134b9f11476563e92f2005cc4f00abb4580dda7fe6c"
- qualified: {"bootstrapMigrator":{"withRestore":"ff02a3c158b3d71347c2621e27f10891cab564eacfaff84a1bfcc7754dc0a68c"},"separateMigrator":{"withRestore":"6a7b1e4060a65ca39276ceb6ea9a17da61f80d95230815d2abd2692451091ae4"}}
- qualifiedAdmin: {"installerManaged":"9dba97d582e8adfb21ada0e88b2d531376124016f17bae52a4fa5d99953fe805","operatorProvisioned":"b5f2b4eb29de190fcdb2777ed9a297f13aebe97675213dcbe168912e01cd45ff"}

Real isolated R0-based pack, including this forward AND its full packaged manifest:
baseline09cd599b2,318,731 B/2,913files; G4 candidate2,324,762 B/2,917files.
Delta +6,031 packed B/+30,408 unpacked B/+4 files. This supersedes the older
own-SQL-only5,958 B projection. The packed G4 source diff is applied additively to
isolated R0 copies; no branch merge or other worktree mutation. It remains within
the accepted4.7KB+3KB compensation envelope; no numeric budget/version changes.
Root transfer/test/fragment changes add no package assets. Predecessor integration
still requires its final real pack and joined capture-after-cancel proof.


Specific non-writer answer: valid legacy headers keep their renewal owner and
all original values; raw row JSON acquires purchase_order_id:null because a
column was added. The upgrade witness compares original columns explicitly,
not byte-identical pre/post full-row JSON. Old operation-specific predicates and
joins exclude NULL purchase owners, while aggregate stock accounting includes
all live holds. Purchase release/expiry cannot consume legacy renewal rows.
The invalid raw insert with neither owner still refuses, now under the exclusive
owner CHECK rather than the old NOT NULL property.

Retained-store behavior DOES intentionally expand: the accepted finite capture/
restore profile now includes ALL rows in the five existing stock/reservation/
activation/compensation relations, not only rows written by G4; the sixth table
is the new receipt relation. A nonempty legacy relation formerly outside that
finite profile can now transfer rather than cause unknown-table refusal. This
is the six-table addition already named in the accepted transfer owner read,
not a new narrowing or hidden row filter. Current-catalogue transfer still checks
actual schema, parents, limits, exact encoding and pristine targets; no arbitrary
cross-catalogue old-packet compatibility is claimed. Existing suite results below
separate these intentional schema/profile changes from old reader/writer outcomes.


Resume self-retro: following SQL helper imports found additional old consumers
beyond direct barrel imports. Keeping the full byte comparison separate from
compatibility proof prevents a punctuation-only diff from being mistaken for a
proof about old stores. R0-based measurement includes manifest cost instead of
reporting only a copied SQL asset. No production source, helper behavior, checker,
privilege or data repair is introduced; existing-suite failures requiring such
a repair remain a mandatory stop. Native review repair cycles remain zero.


### Existing-suite compatibility results

All 57 selected files pass through the focused gate. The inventory follows changed
inventory/capture/restore imports, reservation/ATP reader-writer routines and SQL
helper callers, then retained-installation and qualification witnesses. Every
behavioral assertion and historical inventory pin stays unchanged from71539d08;
the only existing-test delta is the permitted literal chain count94->95. No
production-source or SQL repair was needed. No test case failed. The Core smoke
file initially went to the root runner, which found no files; its unchanged test
then passed with packages/core/vitest.config.ts. This was a runner correction,
not a fixture or behavior change. The conservative Core graph witness is included
even though its inventory path is Core's own barrel.

| Test file | Result |
| --- | --- |
| `packages/core/smoke/standaloneGraph.test.ts` | 3 passed (3) |
| `packages/platform/test/commerce/checkoutCompensation.test.ts` | 3 passed (3) |
| `packages/platform/test/commerce/commerceAtpConsumptionConformance.test.ts` | 6 passed (6) |
| `packages/platform/test/commerce/commerceCheckoutCompensation.test.ts` | 5 passed (5) |
| `packages/platform/test/commerce/commerceFinalizeOutcomeConformance.test.ts` | 5 passed (5) |
| `packages/platform/test/inventory/adminInventoryConformance.test.ts` | 3 passed (3) |
| `packages/platform/test/inventory/contracts.test.ts` | 2 passed (2) |
| `packages/platform/test/inventory/inventoryAvailabilityCharacterization.test.ts` | 4 passed (4) |
| `packages/platform/test/inventory/managedStockAvailability.test.ts` | 17 passed (17) |
| `packages/platform/test/inventory/newPurchaseStockBoundary.test.ts` | 3 passed (3) |
| `packages/platform/test/inventory/newPurchaseStockConformance.test.ts` | 2 passed (2) |
| `packages/platform/test/inventory/reservationPolicyConformance.test.ts` | 4 passed (4) |
| `packages/platform/test/inventory/subscriptionForecastCalculation.test.ts` | 4 passed (4) |
| `packages/platform/test/packageBoundary.test.ts` | 2819 passed (2819) |
| `packages/platform/test/promotions/promotionClaims.test.ts` | 2 passed (2) |
| `packages/platform/test/subscriptions/renewalCycleMechanism.test.ts` | 29 passed (29) |
| `scripts/packages/platform-cold-consumer.test.ts` | 108 passed (108) |
| `scripts/reviewed-batch-forward.test.ts` | 691 passed (691) |
| `server/adapters/postgres/subscriptionActivation.test.ts` | 5 passed (5) |
| `server/adapters/supabase/promotionClaims.test.ts` | 4 passed (4) |
| `server/runtime/public-reference/m12AccountSupportBinding.test.ts` | 17 passed (17) |
| `tests/platform/channels/channelCompositionBinding.test.ts` | 5 passed (5) |
| `tests/platform/channels/channelConsumer.test.ts` | 2 passed (2) |
| `tests/platform/inventory/inventoryBindings.test.ts` | 10 passed (10) |
| `tests/platform/inventory/inventoryConsumer.test.ts` | 2 passed (2) |
| `tests/postgres/accountSupportComposition.test.ts` | 2 passed (2) |
| `tests/postgres/accountSupportOperatorAuthority.test.ts` | 23 passed (23) |
| `tests/postgres/accountSupportSelfService.test.ts` | 3 passed (3) |
| `tests/postgres/accountSupportUpgrade.test.ts` | 2 passed (2) |
| `tests/postgres/channelConnectedRestore.test.ts` | 1 passed (1) |
| `tests/postgres/channelManagedRetainedInstallation.test.ts` | 1 passed (1) |
| `tests/postgres/channelPurchase.conformance.test.ts` | 30 passed (30) |
| `tests/postgres/commerceComposition.test.ts` | 4 passed (4) |
| `tests/postgres/commerceManagedRail.test.ts` | 26 passed (26) |
| `tests/postgres/connectedManagedRetained.test.ts` | 16 passed (16) |
| `tests/postgres/connectedStoreTransfer.test.ts` | 8 passed (8) |
| `tests/postgres/fulfillmentDeliveryAlignment.test.ts` | 29 passed (29) |
| `tests/postgres/fulfillmentRenewalAdmission.test.ts` | 9 passed (9) |
| `tests/postgres/fulfillmentStockEvidenceReplay.test.ts` | 6 passed (6) |
| `tests/postgres/inventoryNative.test.ts` | 8 passed (8) |
| `tests/postgres/m05CatalogComposition.test.ts` | 3 passed (3) |
| `tests/postgres/m14ManagedCatchup.test.ts` | 1 passed (1) |
| `tests/postgres/m14QualifiedAdminComposition.test.ts` | 2 passed (2) |
| `tests/postgres/m14QualifiedComposition.test.ts` | 4 passed (4) |
| `tests/postgres/m14RestrictedConnectedRestore.test.ts` | 15 passed (15) |
| `tests/postgres/m17ChannelReference.test.ts` | 6 passed (6) |
| `tests/postgres/managedStorageTransfer.test.ts` | 1 passed (1) |
| `tests/postgres/newPurchaseStockManaged.test.ts` | 10 passed (10) |
| `tests/postgres/newPurchaseStockNative.test.ts` | 11 passed (11) |
| `tests/postgres/purchaseReservationDonor.test.ts` | 3 passed (3) |
| `tests/postgres/purchaseReservationNative.test.ts` | 27 passed (27) |
| `tests/postgres/retainedClientSubscriptionImport.test.ts` | 13 passed (13) |
| `tests/postgres/reviewedBatchForwards.test.ts` | 106 passed (106) |
| `tests/postgres/subscriptionComposition.test.ts` | 20 passed (20) |
| `tests/postgres/subscriptionContinuityBaseline.test.ts` | 4 passed (4) |
| `tests/postgres/subscriptionManagedStock.test.ts` | 12 passed (12) |
| `tests/postgres/subscriptionRenewalLifecycle.test.ts` | 66 passed (66) |


Final resume checks: 4,227 tests pass across the 57 files above. Public five-project
typecheck passes with zero unresolved edges and zero consumer-side errors; API
snapshot and ast-grep checks pass. Full lint passes with zero errors and the same
33 existing warnings. The SQL byte proof confirms exactly six inserted semicolons,
unchanged extra ownership statements and unchanged function after-hashes. Current
manifest forward identities change in three selections, with no historical
inventory edits. The scoped tests no-impact trailer accompanies this follow-up;
the documentation policy check is repeated after committing it. Prior signed
candidate and all three old WIP commits pass redacted gitleaks; staged and new
signed range scans are recorded in the final handoff. No source/SQL repair,
checker/pin/native-review change or other worktree change. Gate wait examples:
331 seconds for typecheck and 120 seconds for lint admission. The Core runner
correction is the only invocation recovery; no behavioral test needed relaxing.
The real pack above is stable because no packed source, SQL or manifest changed
after measurement. Remaining joined G6 acceptance, ordered integration and native
review are still open; estimate1-2workingdays excluding waits, repair cycles0.


## Combined hold/destination continuation and time proof

The supervisor accepts the read-only (a)-(l) inventory on the two frozen row
heads. This continuation builds one combined candidate with fresh native review
budget0/3, stopping before review. SQL remains byte-identical. The later time
ruling accepts a PostgreSQL-built SQL-only identity: exact UTC rendering after
AT TIME ZONE preserves microseconds, while TypeScript never builds/parses/compares
that key. No format-only SQL edit, timestamp helper or public entry is added.

| Own time use | Class | Treatment |
| --- | --- | --- |
| TS expiresAt, SQL command expiry | PostgreSQL-built SQL-only identity, no TypeScript key | purchaseReservation.ts:11,50 -> forward:60,64,115; typed timestamptz rendered after AT TIME ZONE UTC, compared as receipt JSON and hashed only in SQL. |
| TS reserve/release/expiry now | VALUE | TS:13,50,54,57 binds exact input string directly to timestamptz; SQL:50,74-76,110,118,126,141,156,163,173,176-178 retains precision. |
| TS cancellation clock/default Date | VALUE | TS:65,74 uses a fresh host clock, not a stored time; SQL:189,199,225,231,239 stores/passes timestamptz and excludes it from receipt identity. |
| SQL created_at/updated_at defaults and writes | VALUE | forward:21,118,126,156,163,178,239; timestamp storage only. |
| SQL stock.stale_after and held expiry/order | VALUE | forward:110,176-177; timestamp comparisons/order stay entirely in SQL. |
| Stored times returned to G4 TS | None | Bounded results contain IDs/status/counts or cancellation boolean; no stored-time JS parse or key. |

New real PostgreSQL proof is in purchaseReservationNative.test.ts: SQL-only expiry
identity, with two instant pairs (123456Z/+09:00 and000000Z/no-fraction), each
across three distinct runtime backend PIDs fixed at UTC, Etc/GMT-9 and Etc/GMT+5.
Every connection asserts effective service_role with no superuser/bypass flags
and the g4_runtime login identity; fixture setup declares that login NOSUPERUSER/NOBYPASSRLS. Twelve equivalent-spelling replays, six changed-
microsecond refusals, two initial non-null identities, plus two NULL/default
identities remain one effect each. Each non-null replay scenario has one receipt, fingerprint,
header and line; hard hold stays2 and availability8 before the separate NULL/default case. Stored expires_at retains
all6digits; receipt expiry text preserves123456 or its stable whole-second UTC
spelling. Stock snapshots stay unchanged. NULL now and both infinities retain
named input/elapsed refusals; NULL expiry keeps the30minute default and replay.
The full native file passes28cases; logs g4g3-g4-time-three-sessions.out in scratch.
No movement ledger is introduced; native observed-stock row and reservation-line
accounting are the asserted stock boundary. No SQL/managed behavior change.

G3's separate frozen-head proof is prepared only in an ignored scratch archive
inside this worktree so its own worktree remains untouched. Test/record patches
will be applied after the two expressly authorized integration merges. Keep the
first G4 source delta/patch preserved while those merges require a clean tree.

## Combined purchase holds and destinations: integration evidence

The supervisor authorizes one local bundle, with two exact DCO merge commits:
`941c64e4` integrates `48fb8a20` (tree `12754c5b`), and `2cc64167`
integrates `51c029d1` (tree `61152662`). The separate pin commit is
`cf890d9f`; no native review, canonical verification, push or PR is authorized
in this run. The bundle has consumed zero of its three native repair cycles.
A subsequently repaired predecessor must be integrated only when the supervisor
names its head.

Both own production deltas preserve their accepted added/deleted line hashes:
G4 has 362 lines, SHA-256
`5eb934055d876b047e16713a3fd2c9b84dc20416ffa4b002acc8c27eefd06162`;
G3 has 377 lines, SHA-256
`a7326d0a08dcd291f45fdee999163dc3b8d546619d534ff42809b8d58c624cbf`.
Every own production source and canonical SQL file is also byte-identical to
its accepted row head. G4's generated packaged SQL copy and both manifest
projections are now present; the canonical and packaged forward hashes stay
`0fe4c20229e3635d61f820788e7d2b98148c8fd46daede44260f71da121e9323`
and `104ef7f72085166dcfe48f5b1622faf2946b5eb95f31a1b56c8e81ca599c69d6`.

The transfer union preserves all added content lines: first merge 63 G4 and
274 predecessor lines; second merge 337 integrated-predecessor and 54 G3
lines. Sorted added-line hash lists match before and after each union. The
complete transfer file passes all 16 cases without coverage. Both fixture sets
run without row/key collision. Duplicate activation table entries were
deduplicated in capture/restore; the actual connected graph has 98 tables.
The two destination relations carry full postal addresses and may carry contact
phones; transfer enforces cumulative row and byte limits and no erasure path
is provided. Purchase references may also hold identifying strings; hosts
should supply opaque references.

Real PostgreSQL measured the current inventories and replayed each installation
with zero additional migrations. Historic inventory pins remain unchanged:

| Shape | Units | Actual current inventory SHA-256 |
| --- | ---: | --- |
| Legacy | 95 | `877bdd3d4db0e71da014647e6e8a884f8626ea59206dc6c70c4cad2477719a61` |
| Qualified bootstrap with restore | 99 | `e578feac21e0329e3dd17f8188ad42c6ff522672708d23c7c6bdf236a6e65819` |
| Qualified separate migrator with restore | 99 | `f0723c366ccbc4de21ea433efe880a286a2b3d09aa74114eb823faa6157848dd` |
| Restricted admin installer-managed | 98 | `6930bc93c7975858d1357cb0801b840eb4590571330c796cf1020a8b0a356a60` |
| Restricted admin operator-provisioned | 98 | `0f51f4ee95a8d756e62352443d79f1fde45c41dafc62279a5c12bf05eaeb67e7` |

The producer is `node --import tsx .context/scratch/g4-inventories.ts`, using
real containers, the canonical migration runner, catalog projection and a
fresh runner replay. The literal change tables retain both parent values and
the measured replacement in `.context/scratch/g4g3-*-literal-report.json`.
The actual capture export supplies the handover table count; the unrelated
catch-up outbox expectation remains one.

Main's `79ebda3d` registry/admission reader accepts G6, G2, G4 and G3 and passes
co-location against the exact predecessor. The real catalog suite passes all
130 cases with `service_role` present and absent. The pin commit changes only
the two row bindings and the bound-list test description/expectation, now
`slots.slice(0, 4)`.

| Official Node 24.21.0 real pack | Predecessor `48fb8a20` | Bundle | Delta |
| --- | ---: | ---: | ---: |
| Packed bytes | 2,435,777 | 2,449,097 | +13,320 |
| Code gzip bytes | 1,950,344 | 1,954,742 | +4,398 |
| Unpacked bytes | 11,454,327 | 11,524,618 | +70,291 |
| Files | 3,021 | 3,029 | +8 |

Both the 1,970,000-byte code cap and 2,485,000-byte packed regroup point
remain satisfied. The package includes both real SQL assets and manifest
entries. The per-file itemization is
`.context/scratch/g4g3-bundle-size/itemization.json`: exact marginal prefix-gzip
contributions at every content-changing file, plus an explicitly identified
unchanged-content dictionary/framing residual. Those contributions sum to the
real pack and policy code-class deltas, rather than adding standalone gzip
sizes. Root capture/restore files, native tests and these records add no
tarball bytes.

The joined capture-after-cancel test originally assumed a flat response shape.
The predecessor returns the outcome under `event`; the corrected assertion
checks that exact shape and requires the review column to exist. Its isolated
real-PostgreSQL run passes, including restart, the `review_required` persisted
fact and released stock. No production code or SQL repair is involved.

Self-retro: preserve complete shared proof cases, then measure the combined
catalog rather than adding parent counts. An overly broad local count rewrite
also touched an unrelated catch-up assertion; inspection restored its original
value and narrowed the helper before the witness run.

### Bundle time sweep and timeout measurements

All 55 initial solo no-coverage cases pass: 28 purchase, 24 destination and
three bundle-owned transfer cases. The latter measure 6.30, 4.97 and 3.68 s;
each now has an explicit 30,000 ms timeout and its measured one-line comment.
The 52 native cases are below three seconds when run solo.

The current ten-file real-PostgreSQL sweep reports:

| Sessions | Passed | Classified main observations | Unclassified failures |
| --- | ---: | ---: | ---: |
| Default UTC | 204 | 0 | 0 |
| Etc/GMT-9 | 201 | 3 | 0 |
| Etc/GMT+5 | 201 | 3 | 0 |
| Alternating UTC / Etc/GMT-9 | 197 | 7 | 0 |

Every own native case passes in all four modes. The observations are confined
to the nine preclassified main sites: the date-only retry fixture, two raw
transfer representations, two retry rollback snapshots, two technical-stock
snapshots and two restored-line snapshots. Those main assertions are unchanged.
The diagnostic startup hook checks each actual connection's requested zone and
role and patches newly loaded pg copies; it is ignored scratch, not a product
default, parser, export, CI exemption or committed harness change.

Two own test snapshots initially compared PostgreSQL-rendered time strings from
different sessions. Purchase snapshots now retain every field under a local
read-only UTC transaction. The destination transfer comparison reuses the
existing UTC census and still compares all five address/support tables without
truncating times or dropping fields. These are the expressly authorized test-side
zone corrections; production source, SQL, grants and behavior stay unchanged.
The transfer merge's original added-line and callback-body hash witnesses were
recorded before this separate correction. Full current-mode reports, startup
connection probes and the earlier failed observations remain in scratch.

Public owner prose now reflects the integrated class/pins and the proved
late-capture review result, rather than the earlier draft's pending-control
state. Source admission remains separate from manifest selection. Dedicated
promotion cancellation and native address-notice dispatch remain unbound here;
the notice binding belongs to the communications follow-up. The package README
correction needs a fresh official pack before the final report.

### Bundle integration stop: cold-consumer export classification

The actual cold consumer stops in assertExportInventory at
scripts/packages/platform-cold-consumer.ts:170: the installed manifest exposes
commerce/server/destinations but neither closed classification list names it.
A complete comparison finds exactly that one unclassified export and zero stale
entries. The original accepted G3 head also lacks this classification. No source,
SQL, assertion, registry or control fix was made after this finding. The existing
suite stop rule requires reporting before a source repair. The bounded proposed
repair is the own non-adapter inventory line plus a regression assertion; no SQL,
public API, signature, grant or cap needs changing.

Current completed proof, without coverage: 26 further focused files / 446 cases,
all green; this includes all 11 unchanged starter files. The remaining focused
queue is paused, not claimed complete. Four full composition files pass22 cases;
all22 cases pass solo. The repeated own proofs pass32 cases (all28 purchase,
the restricted next-cycle route and allthree own transfer cases); the original
55-case solo evidence remains. Slow transfer cases retain explicit30,000ms
comments; additional composition timeout comments are not yet finalized. Their
existing explicit600,000ms (restore1,200,000ms) cold-setup overrides remain, and
measured solo timings are retained in g4g3-composition-timeout-table.json.

The handover witness ran to its end in99.128s:98tables, two accepted effects
recovered and one uncertain operation fenced. The complete report is in
.context/scratch/oss-m14-connected-catchup/journey-Klwh7S/report.json. The10-table
growth is G4's five purchase/stock relations and G3's five destination/support
relations already listed above. Historic catalogue pins stay unchanged.

Official final pack supersedes the earlier figure: predecessor48fb8a20 packed
2,435,777 ->2,449,053B (+13,276); code1,950,344 ->1,954,742B (+4,398);
unpacked11,454,327 ->11,524,562B (+70,235); files3,021 ->3,029 (+8).
Real SQL and manifest are included. It is44B below the first bundle pack after
the public-text correction. Per-file packed/code attribution is retained in
.context/scratch/g4g3-final-size/itemization.json. No cap or gate number changed.
The clean exact candidate archive passed packages:check --pack for allthree
publishable tarballs, without findings. Actual cold starter173tests, typecheck
and build pass before the export-classification refusal. A separate Linux glibc
2.36 / officialNode24.21.0 install passes with networknone, a fresh empty cache,
only local tarballs and all required omission/script flags. Its installed public
factories preserve the microsecond input, named next-parcel outcome and bounded
cancel call, with both packagedSQL hashes checked. This is a bounded installed
entry proof, not a claim that the full cold consumer passed on Linux.

Time sweep connections were353 inGMT+5,352 inGMT-9 and353 in mixed mode, over
tenfiles each, with zero requested/actual zone mismatches. Effective restricted
role proofs remain in the committed native cases. Both neutrality checks pass;
strict typecheck has zeroerrors/edges, lint zeroerrors, astclean. Policy retains
three unanswered scoped no-impact obligations, to settle with the final delta.
No native review/session, canonicalverify, push, PR or delivery occurred;0/3
cycles consumed. DCO finalization and the supervisor-named repaired predecessor
remain pending. No G3 or other worktree was edited.

Self-retro: the real installed consumer catches a missing export classification
that synthetic fixtures generated from the same lists cannot expose. Running it
earlier than the remainder of the broad suite queue bounded the wasted work.
Stop before repairing shared source; the package and SQL outcomes themselves
remain unchanged. The remaining suites and final identity must be recomputed
on the resumed, repaired candidate.

### Landed-base continuation

The supervisor accepted the prior stop and authorized exactly one cold-consumer
classification addition, the named main merge46c3e8b2, remaining proofs and final
DCO. Merge9937722a is DCO-signed; its sole conflict keeps the complete own transfer
case and main's timeout comment/arguments verbatim. Sorted added-line hashes match
for121bundle and16main lines. Stable patch IDs change243a97b4 ->c5b5d03a because
context moved; all5295changed lines have identical sorted hashd7c5434d before/after.
No SQL or derived catalogue input changed. The review base is now actual main;
OPENLUP_STACK_BASE is unset. Native review, canonical verify and submission remain
unauthorized; pin commitcf890d9f and line654 remain unchanged pending lead approval.

The built destination declaration has zero imports and only local interfaces and
built-in types (SHA25601d31fb3d05a9402db6d3df53c3398c84989364fd47c1f2b35cd997117c2acea).
It cannot reach data/pg declarations, so commerce/server/destinations is a
NON_ADAPTER entry under the cold consumer's own rule. Only that single name was
added to the list; no other line in that source file changed. The earlier stop
is resolved by this specific registry-union authority, not by widening a checker.
Measured composition cases receive explicit40/45/60/75second budgets and comments;
released-upgrade has the required30second minimum. Assertions, SQL and historic
pins are unchanged. Remaining focused files and installed proofs run on this base.

### Final landed-base local proof

All242 focused files pass6588 cases with zero failures and skips. The complete
file list and per-file cases/timings are in g4g3-focused-files/results.json;
g4g3-focused-summary.json groups the exact results. Commerce112/887,
inventory9/45 and account-support20/307 all pass unchanged. Package boundary2948,
import map123, outcome projection7, documentation CLI3/bundle20, cold-consumer
unit122, migration admission24 and registry691+210 cases pass. All11 pure starter
files pass173 cases; the installed starter repeats173 cases, strict typecheck
and build. This is local conformance, not hosted qualification or release.

The full cold consumer passes both peer modes, NodeNext/Bundler declarations,
packaged migration modes (qualified99/admin98), native communications/operations
and SQL conformance with no live provider. Its cache was fresh and supplied from
outside the process. The three verified tarballs are byte-identical to the
accepted Linux glibc2.36 / Node24.21.0 offline empty-cache installed proof; its
install set did not change. Official pack on main46c3e8b2 stays2449053B (+13276),
code1954742B (+4398), unpacked11524562B (+70235),3029files (+8), including SQL.
No cap, version, baseline or exemption changed. Full per-file packed/code
attribution is in g4g3-main46-size/itemization.json.

Main46's own forward checks accept allfour bindings; final co-location refuses
the classification path as recorded below. Catalog130/130
passes with roles present/absent. Full transfer16/16 retains both parent case
sets and new address/hold rows with limits. The five actual catalogue
measurements and their zero-application replay remain unchanged; final full
composition and upgrade tests confirm those exact literals. The handover
witness reaches its final98-table assertion in99.128s, recovers two accepted
effects and fences the one uncertain operation. Its scope remains finite.

Allown52 native cases pass on the landed base; six donor cases also pass full
and solo. The earlier83 distinct owned/changed native, donor, transfer and
composition cases have solo measurements without coverage. Slow cases now have
measured comments and explicit budgets: transfer30s; admin45s; qualified40s or
75s; restricted restore60s; released-upgrade30s. Their final full suites pass.
The accepted timezone sweep remains204/0,201/3,201/3 and197/7, with only the nine
classified main sites and no own failures. Actual zone probes353/352/353 have
zero requested/actual mismatches. G4 identity is PostgreSQL-built SQL-only,
no TypeScript key; G3 nextCycleAt is VALUE-only millisecond egress with exact
stored microseconds and no feedback caller. No decoder or SQL change was made.

G4's joined capture after cancel persists review_required after restart and
released stock. G3 never updates a cycle or confirms delivery. Existing delivery
alignment and renewal lifecycle suites pass; their clamp guards plus own
unchanged-date/dunning tests preserve late-only extension, no stacking or earlier
cycle and no confirmation of an undelivered replacement. Both actual parcel
races retain the old record/fingerprint and name the next-parcel outcome.
The fresh seven-site refusalCode audit still names/refuses the native outcome;
four managed sites use another type. Current full postal addresses and contact
phones remain under transfer limits, opaque-reference guidance and no erasure
path. G8 owns the notice dispatch; dedicated promotion cancellation is unbound.

Strict typecheck has zero errors/edges; lint zero errors (342 existing warnings),
ast and both neutrality checks pass. WIP all-ref gitleaks scans1773 commits with
zero findings. Final scoped trailers answer the three unchanged owner sections;
no CONTRIBUTING edit. DCO completes only the two own WIP messages and their
necessary descendant parent references, preserving checked trees, the three
merge shapes, incoming main and pin commitcf890d9f. Final identities/mapping and
DCO verdict are retained in the read packet. No native session/review, canonical
verify, push, PR or release; budget0/3. The lead's pin-test approval remains a
review prerequisite, outside this local proof.

Self-retro: real installed discovery caught the missing entry classification;
list-derived fixtures could not. A parallel prelint rebuild temporarily removed
core/dist during one collection. No assertion ran; its single isolated retry
passed6/6 after the build ended. Subsequent builds/tests were serialized. Keep
prelint's build side effect in the stage plan, and report process exit/suite
collection errors rather than only failed-assertion counts.

### Final admission stop

Status is BLOCKED, not ready for native review. The final main46 reader accepts
allfour native forwards, then assertCoLocatedForwardApproval refuses at its
releaseTool guard (reviewed-platform-forward.ts:893-894). The sole matching path
is scripts/packages/platform-cold-consumer.ts. Its own delta is exactly the one
NON_ADAPTER_ENTRIES addition approved by the supervisor; no other line changed.
The guard treats every non-test scripts/packages path as release machinery and
has no disjoint registry-union exception. Current main d848d684 has the identical
reader. Do not remove the needed entry, alter a checker, choose a false base or
weaken a test to obtain admission. The coordinator must reconcile this guard
with the approved registry-union rule in a separate control. No SQL/signature,
runtime permission, package-cap or new API decision is needed in this feature.

The earlier co-location PASS was taken before this one-name source edit and does
not certify the final candidate. All242/6588 functional cases, full cold consumer,
policy with12answered obligations,130catalog cases and full-range14/14DCO pass;
the admission refusal remains mandatory. DCO certifies provenance, not a green
admission check. No native review/session, canonical verify, push or PR occurred.
Source/SQL/product tarballs remain unchanged; this stop correction changes only
the two task records. Pin commitcf890d9f and all controller source stay intact.

Main advanced to d848d684 (#515 starter support/catalogue binding). Its read-only
merge-tree with the candidate is clean (exit0); no extra main merge was made,
as instructed. The actual review fork remains46c3e8b2. Final identities and
read-only merge-tree output are retained in the external packet.

Self-retro: run the exact main co-location preflight immediately after every
admission-relevant path edit. A conceptual data-only union ruling and a blanket
machine path guard can disagree; a pre-edit PASS cannot cover that later edit.
This was found late after DCO completion; no reviewer or delivery consumed it.

## Destination entry predecessor integration

Merged the exact destination-entry predecessor with one signed merge commit.
Five conflict files contain only disjoint catalog, nested-entry, cold-consumer
and transfer-document additions, plus the handover count. Both sides' complete
transfer test additions survive unchanged, verified by sorted added-line hashes.
The actual exported transfer inventory is 99 tables, including the native
checkout draft receipt; the witness count is recomputed to 99. Five real-engine
inventory digests and selected chain counts are unchanged. Source SQL and its
packaged copies are unchanged. The bundle makes the destination routines
available after the preceding entry-only change.

## Donor mapping

Each rule is ported from the reference adopter's behaviour; the rule-by-rule mapping and witnesses are in the maintainer packet.

The current mapping remains incomplete; this statement describes the required
porting boundary, not a completed parity certification. The inventory
admission-gate ruling is pending. No gate rework or native review has started.
Listing exposure is deferred to a registered follow-up and is outside this
bundle: native available-to-promise does not subtract retained listing exposure.

Accepted differences and limits:

- Lots, locations and stock movements are outside the native slice.
- Changed input under the same key and an elapsed initial expiry refuse.
- Native key, source, finite-time, metadata and order-item validation is bounded.
- Purchase and renewal holds share the existing table with exclusive ownership;
  the ownership constraint and foreign key are validated.
- Durable receipts and narrowed privileges preserve native replay and access.
- Abandonment compensation releases purchase holds atomically, protects paid or
  uncertain orders and renewal orders, and uses its own receipt namespace.
  Dedicated promotion cancellation remains unbound.

The completed 158 focused files and 4568 passing cases remain retained evidence;
current-source parity and the remaining proofs are not certified. No SQL,
signature, runtime behavior, test expectation or control changes in this repair.

Self-retro: keep donor citations and unfinished adoption tracing in the private
maintainer packet; public task records retain only neutral outcomes and limits.

## Admission gate draft for maintainer read

The coordinator admitted the shared inventory-admission helper. The five-function
slot amendment belongs to the prior control change; this feature updates only
its whole-file/function pins. The helper is owner-only, with public and named
runtime/browser execution revoked, and no grants. Reserve, release and expiry
enter after input validation and before locking or writing. Unsupported isolation
refuses with 22023; occupied admission refuses with 55P03; lock waits are capped
at the lower of the existing timeout and 50 ms (zero becomes 50 ms), transaction
locally. Protected native calls retain the characterized persistence-error
mapping and never retry or fall back.

Expiry must become SECURITY DEFINER with the same pinned search path so the
restricted runtime can reach the owner-only helper. Keeping it invoker-rights
would fail with permission denied for the helper. Its purchase-only predicate,
finite clock, bounded batch and existing terminal transition remain unchanged;
no table grant or helper runtime grant is added. This security delta is included
in the pending read. Renewal stock writes must enter the same helper in the
following renewal change; that dependency is not implemented here.

Listing exposure remains deferred outside this bundle: native stock accounting
does not subtract retained listing exposure. The complete source mapping,
characterization pin and caller citations remain in the maintainer packet.
No native review, canonical verification or delivery is authorized in this run.

### Existing-suite stop on the admission draft

The four added restricted-runtime admission cases pass: source-pinned body and
owner-only ACL; all three entries refuse occupied admission without durable
writes; both unsupported isolation levels refuse through all three entries; and
0/25/75 ms caller settings cap correctly with a real blocked order lock and
transaction-local restoration. In-suite durations were 2/57/27/70 ms rounded.
These are not solo-timeout or non-UTC sweep results.

The full 32-case run reports 28 passes and four failures. Three existing cases
conflict with the new draft: the upgrade case pins expiry as invoker-rights;
the hold/release/expiry race expects every concurrent call to succeed; and the
cancel/reserve race accepts only its older order-invalid refusal, not the admitted
busy persistence refusal. Those existing expectations and implementation were
not repaired after the finding. A fourth failure was an accidental test-only
edit in the nullable-owner case; every pre-existing test body has been restored
byte-for-byte from HEAD, and the suite has not been rerun. This is not a green
existing-suite claim. Further transfer, handover, time sweeps, solo timing and API
proofs stop pending the maintainer ruling. No source/SQL repair or commit follows
this failure.

Self-retro: preserve existing test bodies exactly when appending new proofs;
never use a broad textual replacement to edit a similar new assertion.

The size probe also stopped before producing a pack: the first launch used a
loader that refuses TypeScript beneath node_modules; the one permitted recovery
then found the empty output directory left by that launch and refused EEXIST.
No third attempt is made. A new package delta is therefore unmeasured; the last
accepted measurement does not measure this draft. The read packet is blocked on
these proof gaps and does not certify readiness.

## Admission expectation resume and remaining module-boundary read

The supervisor accepted expiry's definer mode and aligning the three own test
expectations with admitted busy outcomes. Deterministic runtime transactions now
hold admission while competing calls refuse with no partial writes. The model
checks release-only state before completing refused operations serially; the
original stock, terminality and one-effect assertions remain byte-identical.
Only two original explicit assertions change (security mode and cancellation
refusal), plus the implicit all-success concurrency wait. All other 145 original
explicit assertions are retained exactly. A new no-write stock snapshot uses
the existing UTC reader for both observations, retaining every field and
microsecond; an initial mixed-session display mismatch is preserved as history.

G4 passes 32 cases in each of four time modes; destinations pass 24 in each.
Transfer passes 17 by default; each non-UTC/mixed run has 15 passes and the two
previously classified main timestamp observations, with no new failure. The
99-table standalone handover completes with one fenced uncertain operation and
zero cleanup failures. Seven affected native cases pass solo below 0.111 seconds;
the existing restart case measures 2.439 seconds with its existing 60-second
limit. Three own transfer cases measure 6.749/5.207/3.639 seconds, within their
existing measured 30-second limits. Four-bound catalogue130 and amended-slot1
pass against the scratch prior-control amendment; temporary test patches are
restored. The complete API68, five-project typecheck, ast-grep and both neutrality
checks pass in the tested phase.

Lint then found the new error mapping's cross-module import. Both the internal
path and commerce's public entry are refused: inventory declares no cross-module
value dependencies. The staged preview uses the public entry, but remains lint
blocked at its first line. The public-entry runtime probe confirms it is the
existing commerce error class; the earlier PostgreSQL proofs used the internal
path to that same class. No claim is made that all checks pass on the final draft.
Using the existing inventory persistence error would preserve semantic details
but change the class/name; accepting that mechanism or another adapter seam
requires a ruling. No boundary, checker, export or API signature was changed,
and no duplicate/lookalike error class was introduced.

Official pack against the destination-entry predecessor: +11764 packed,
+2911 code-gzip, +66764 unpacked and +5 files; absolute2453651 packed and1957669
code-gzip. SQL and its projection are included. This is +825 packed/+418 code
over the pre-gate measurement, explained by the admitted helper, error mapping
and owner documentation. No cap changes. The complete draft stays staged for the
maintainer packet; no DCO, native review, verify, push or PR runs.

Self-retro: inspect the module's dependency declaration before choosing an error
constructor, rather than assuming its public entry is an admitted dependency.

## Inventory-owned mapping and expiry access read

The staged mapping uses the existing InventoryPersistenceError in inventory's
own ports. There is no commerce import, new class, public export or declaration
change. Three unit cases compare the actual checkout start-failure projection
with its existing reference error: admission and lock contention leave compensation
unrequested; unsupported isolation retains the existing compensation candidate.
Messages and semantic code/reason details remain equal. No retry is added.

Final focused checks: lint PASS (zero errors, 33 unchanged warnings), import-map
123, package boundary 2,951, all nine inventory files 48, native PostgreSQL
33, all 68 API reports, and five typecheck projects PASS.
The real PostgreSQL ACL probe installs the frozen pre-admission expiry under a
temporary test name in a rolled-back migration transaction and compares raw ACL
and effective EXECUTE access for every installed role against the actual expiry.
Both are owned by the configured migration role; access is equal. The actual
restricted login is not superuser or bypass-RLS and direct helper execution
refuses with 42501. Expiry references are schema-qualified; its pinned search
path, purchase predicate, finite-time semantics and 1..1000 limit are retained.

The three aligned expectation groups retain 145 of 147 original explicit
assertions byte-for-byte; the two changed explicit expectations and the implicit
all-success expectation are shown beside their replacements in the maintainer
packet. Deterministic held admission makes competitors refuse without visible
partial state; stock and terminal results equal the successful serial subset.
Receipts stay one per key and replay does not write again. The cancellation race
now also proves a deterministic busy refusal, committed cancellation, one cancel
receipt, no failed-reserve receipt, and unchanged terminal rows on replay.

Forward SHA256: `86ef99f65945a78a48cafa2c81d3f2bfdea94fb536c908cb620864c31249775c`. Five created functions, no replacements; the
prior control must admit the helper before landing. The actual class slot and
all boundary/checker files remain unchanged. The exact feature pin and final
staged identities are in the maintainer packet.

Official Node v24.21.0 real pack, including SQL and manifest, against the exact
leaf: +11,758 B packed, +2,889 B code-gzip,
+66,735 B unpacked, +5 files. Absolute packed
2,453,645 B and code 1,957,647 B.
No budget changes. The full delta remains staged for the maintainer read; no
commit, native review, verify, push or PR. Earlier zone/transfer/handover results
remain historical evidence, not final-hash reruns in this bounded resume.

Self-retro: reuse the module's existing error and test its actual caller
projection; a cross-module constructor was unnecessary to preserve that result.


## In-flight compensation guard read

The cancellation routine now ports the reference adopter's root-first guard.
It locks the subscription root (when present), order, intents, simulator attempts,
observations and truth evidence before deciding. The root hint is rechecked under
the order lock; a changed aggregate refuses. A dispatched attempt returns
`cancelled: false` with `provider_attempt_in_flight` without any persisted write.
A terminal refused or expired attempt permits the existing cancel/release path;
captured or indeterminate attempt evidence keeps the existing `money_recorded`
refusal. The native active flag also remains true on terminal observations, so it
is not used as a proxy for in-flight state. No public type or signature changes.
The routine's successful cancel/release body and the admission call remain intact.

New restricted-runtime PostgreSQL proofs cover refusal snapshots, cancellation
following a failed attempt, all other terminal/uncertain outcomes, and both
concurrent begin/cancel winners. Blocking is observed on the actual order lock,
not inferred from call order. Existing cancel/release/late-capture/restart tests
are unchanged. A source-pinned characterization witness lives in the native test;
private provenance and the full rule/refusal mapping remain in the maintainer
packet. No managed SQL, OMS metadata, attempt store or G7 code changes.

Time classification is unchanged: stored timestamps remain VALUEs; the reserve
expiry is a PostgreSQL-built SQL-only identity, no TypeScript key. The new guard
introduces no clock, timestamp conversion or identity. The new lock-wait test's
wall clock bounds only its diagnostic poll, not a durable operation.

The new forward SHA256 is
`7b37352df5a100e224a9a33196b81a3fa31bdc7e24e0a76a6e583734946d755f`.
The feature pin keeps its approved order (helper fifth). Only cancellation's
function hash changes; the complete forward, packaged copy, manifests and
measured current inventories are regenerated. This delta is staged for the
maintainer read; no DCO commit or native review is authorized yet.

Self-retro: reconcile the current cancellation guard with its child attempt
state before treating a late-capture recovery test as complete cancellation proof.


Final guard-read evidence: real PostgreSQL native 40/40 in each of UTC,
Etc/GMT-9, Etc/GMT+5 and alternating UTC/Etc/GMT-9 sessions (160 cases).
Seven new cases also pass solo without coverage; body times are 9.820–72.385 ms,
with explicit 30,000 ms limits on the two concurrent cases. The unchanged old
33-case file remains an exact 71,777-byte prefix. Four-bound catalog 130/130,
full transfer 17/17 and the 99-table handover witness reach the qualified-target
ready outcome with one fenced uncertain operation. Five actual inventory
profiles install and replay with zero new writes. Current inventory literals are
measured; historical pins and chain/table counts stay unchanged.

Typecheck (five projects), lint (zero errors, 33 unchanged warnings), ast-grep,
all 68 API reports and both neutrality checks pass. Policy and docs-update report
11 obligations, of which two require refreshed scoped no-impact trailers for
the changed test/inventory digests in the eventual signed commit. Those exact
answers are prepared in the maintainer packet; policy is not claimed green
before that authorized commit. No contributor-policy text is changed.

Official Node v24.21.0 pack against the exact stack leaf: +12,056 B packed,
+2,889 B code-gzip, +69,151 B unpacked and +5 files. Absolute packed size is
2,453,943 B, code-gzip 1,957,647 B; no cap changes. Growth over the prior gate
packet is 298 B packed and zero code-gzip, due to the guard SQL and its public
explanation. Packaged SQL and generated manifest are included. The final
staged identities and exact patch are in the maintainer packet, awaiting read.
