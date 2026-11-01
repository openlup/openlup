# Native purchase holds

Status: owner read accepted for DCO, subject to the small later admission control.
The earlier payment-slot review disposition still awaits ordered integration
proof. This resume prepares a clean DCO-signed candidate; no native review,
submission or landing is authorized in this run.

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

Four new routines implement reserve batch, per-reservation release, expiry and
aggregate abandoned-order compensation.
Reserve, release and compensation are definers with `search_path = pg_catalog, pg_temp` to avoid
new runtime receipt-table writes; compensation also avoids a ledger UPDATE
grant. Reserve locks actual order items.
Expiry is invoker-rights because existing runtime permissions already suffice.
All new routines revoke PUBLIC before the exact conditional anon/authenticated
revokes and service_role execute grant. The new receipt table also has a bare PUBLIC revoke and separate conditional
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
then exact unchanged row JSON, unchanged reservation relacl and validated old/new
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
