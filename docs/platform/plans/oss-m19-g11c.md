# Native account consent choices

SQL admission update, 6 November 2026: supported class data, exact approval pins
and SQL may land together under the [current admission rule](../DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).
Earlier requirements here for a separate class or pin approval before SQL are
historical; other scope, proof and owner gates remain unchanged.

Status: R0 handover and selected suites are green; final cheap checks and DCO merge handoff.
Admission remains blocked on the separately owned prior control. The supervisor
assigned the additive native bounce/complaint fan-out fix to this row so that the
new purpose and its suppression regression land together. DCO sign-off is now
authorized; native review and canonical verification remain supervisor-scheduled.

## Outcome, scope and authority

Provide complete actor-owned choices, grants and withdrawals for the independent
`marketing_newsletter` and `marketing_gifts_discounts` account purposes on the
qualified portable rail. Persist preference, evaluator state, provenance and
existing-outbox sync registration atomically; exact replay produces no duplicate
permission event or work and conflicting reuse refuses. Stores using this path
must retain their choices, history, replay receipts and suppression through
the existing connected native capture/restore boundary.

This task owns forward slot `20261101232000`, its real PostgreSQL tests, its own
API inventory lines, canonical owner documentation and publication catalogue
rows. It excludes saved address and billing collections (N5), managed-rail
changes, money/parcel objects, provider transport and publication. The stores
worker retains sync-store/contract purpose additions and account bindings; this
row owns only the assigned delivery suppression-list addition.

The assigned worktree is `oss-m19-g11c`, branch `codex/oss-m19-g11c`. The approved
bounded programme permits local implementation and, after applicable reads,
DCO commits and supervised submission in its accepted path list. The stream
supervisor controls review scheduling and landing; committed review waits for
the preceding SQL slot. Release, production, settings, credentials, cost and
admission/control changes have no grant here. The resumed grant permits the
local forward and selections without registry pins, and an unsigned WIP commit.
The resumed instruction requires the closed-class ACL shape and effective
no-direct-table-access proof. The latest lead ruling additionally assigns this
row the single additive purpose in postgresDeliveryReconciliation.ts and its
bounce/complaint regression. Stores retains postgresCommunicationSync.ts and
contracts/newsletter.ts. The coordinator accepted the withdrawal delta for DCO
after recomputing head 241d6c1d and tree db0f3d46. Prepare a clean DCO-signed
history and a package change fragment, preserving the accepted SQL bytes. Stop
before native review, canonical verify or submission; this slot lands last.

Code/review base and inspected public policy revision:
`bb0008481a11267ec6dbe3e7e531299777cddc19`. Policy freshness was read from
`origin/main`; the separate managed reference was inspected read-only at
`28d94e2f3b732ef864f348461de398b664df4e25`.

## Characterization before SQL

The public reference `server/adapters/supabase/customerAccountReadStore.ts`
checks collections by the supplied client identifier and preserves ordering:
addresses/orderer profiles default-first then updated-descending, account events
occurred-descending limited to 20. Those collections remain N5; none is absorbed
by this consent row. The managed consent adapter and nearest tests were then
read in the separate reference repository; no private source was copied.

- The adapter resolves the client owned by the authenticated user. Missing client
  or email returns null; database errors propagate. Reads never create contacts.
- Email is trimmed/lowercased. A missing contact or permission produces unknown,
  granted=false, and null source/reason/capture/update times. Both purposes are
  returned independently. The existing managed response uses
  `customer.communication_preferences.v1`; gifts is additive in that contract.
- A command touches the contact, links it to the client, then records newsletter
  first and gifts second, only for supplied toggles. Each true records granted;
  false records denied. Readback follows the writes. The managed adapter makes
  successive RPC calls; it does not itself prove cross-call atomicity or replay.
- Each permission event records source `customer_communication_preferences`,
  reason `customer_self_service_grant` or `customer_self_service_denial`, route
  `/api/bff/customers/communication-preferences`, clientId, actorType
  `customer_self_service`, captureMethod `customer_account`, and capture time.
  Copy versions are exactly `customer_account_marketing_newsletter.v1` and
  `customer_account_marketing_gifts_discounts.v1`.
- Managed `communication_record_permission_event` appends the event and folds
  ordinary account events into current permissions. It requests sync work.
  Its legacy outbox branch covers newsletter/launch only; modern gifts cohort
  and restriction machinery remains distinct. Gifts is never launch offer.
- Ordinary managed grants can replace a permission-row suppression; separate
  hard provider/manual restrictions still gate cohort membership. The native
  evaluator has only the consent state, with no parallel restriction ledger.
  Therefore native suppression must remain effective when recording an account
  grant or denial. Retain the requested choice separately from effective state;
  do not infer permission to clear a hard hold from a customer toggle. This is
  an explicit native acceptance requirement, not a claim of identical schemas.
- The existing portable newsletter setter (latest `20261030110000`) records its
  boolean/revision event and denies evaluator consent only for false, preserving
  existing denial/suppression. True does not grant or register sync. Leave that
  served routine and its callers unchanged. New complete routines are opt-in.

## Admission blocker and smallest adequate route

`isExpandOnlyPlatformForward` refuses each mandatory construct independently:
new SECURITY DEFINER function, authenticated EXECUTE grant, and DROP of the
sync-purpose CHECK. `assertReviewedPlatformForward` refuses the proposed path
because no current class names it. Appending it to portableCreationForwards is
also refused: the parser fixes that class to the existing five paths. These
were executed through the current Node entrypoints. The resumed supervisor
instruction makes this a landing blocker while permitting local SQL proof.

A hash-only pin is insufficient. The separate control owner must provide the
bounded admission class before this feature can land its SQL and pins;
see [Co-located SQL and approval pins](../DATA_AND_MIGRATIONS.md#co-located-sql-and-approval-pins).
Changing the admission script or weakening the routine/table boundary here is
outside authority. No direct grant or role-switch workaround is acceptable.
The smallest adequate route is an exact prior control for the forward, then
this feature; using invoker routines would violate the established ungranted
preference boundary rather than solve the requirement.

## Implementation and sufficient local evidence

The forward creates a single trusted sync-target table and an ungranted
permission-event ledger, two actor definer routines, and the gifts-purpose CHECK
expansion. It replaces no function. Full DTO, errors, configuration and
compatibility are documented by [the data owner](../DATA_AND_MIGRATIONS.md#complete-account-consent-choices).
The source reservation/inventory is recorded for the control owner; new objects
are disjoint from every money row. Existing preference/events remain ungranted.

`customerAccountConsents.test.ts` passed all five real PostgreSQL 16 profiles:
legacy, qualified bootstrap migrator, qualified separate migrator and both
non-superuser qualified-admin role modes. The complete current selections apply
through the real migration runner; replay applies no migration. Canonical
projection/role/ACL hashes are measured independently for all five shapes and
recorded in their existing manifest fields. No admission machinery was changed
or bypassed; the runtime runner is independent of source admission.

Four qualified profiles execute account calls through their restricted runtime
LOGIN and SET LOCAL ROLE authenticated. The legacy profile separately creates
an isolated NOINHERIT runtime LOGIN with authenticated membership. Tests assert
actual role and non-superuser state, no browser table DML, anonymous function
refusal, owned client and actor checks, invalid purpose/boolean/key/email,
missing target, both distinct purposes/copy versions, source/reason/time/route
attribution, concurrent exact replay, conflicting reuse, and no writes on read
or replay. A post-grant withdrawal stays denied after replay of the old grant.

A real CHECK fault at sync registration proves preference, evaluator, event and
outbox rollback together. Existing per-purpose suppression retains state and
evaluator timestamps on grant/withdraw, records the requested choice separately
and enqueues suppress. A concurrent provider-style suppression row lock defeats
a racing grant. Existing and new actor setters run concurrently without changing
the legacy setter's opt-in-only semantics. Its exact SQL body remains unchanged.
The existing sync worker consumes both purposes through the same outbox aggregate,
orders grant before withdrawal, ACKs once and finds no repeated work. An injected
marketing registry exercises the new purpose in the real evaluator. A fresh
runtime pool reads durable state after the command connections have returned.

No array or jsonb parameter is introduced by the two routine signatures. All
business calls use the real pg driver. Fixtures use the trusted administration
connection for clients, target configuration and fault/suppression plants; no
production code gains their authority. Provider network delivery, hosted
qualification and publication are not claimed.

The native delivery-observation adapter now adds marketing_gifts_discounts to
its existing hard-coded suppression loop, the only production TypeScript change.
The regression separately grants newsletter/gifts through the actor command and
plants an existing launch-offer grant, then proves all three evaluate allowed
before each bounce and complaint. It applies each hold twice through the actual
restricted-runtime delivery adapter, checks persisted suppression and evaluator
permission_suppressed for all three, then proves later account grants cannot
clear the hold. This closes the original material finding G11C-S1.

The callback binding maps provider events directly to applyObservation; polling
maps to applyPolledEvent, which delegates to the same method. Neither path has
another hard-coded purpose list. The separate newsletter-webhook permission
processor has its own legacy list but is not called by this native bounce path.
The evaluator uses the supplied purpose registry, so its legacy default list
does not omit gifts in this composition. No additional out-of-scope file is
required. No trigger, table workaround or managed adapter was changed.

## SQL risk assessment scope

No fiscal, renewal, dunning or parcel object is proposed; consent must not gate
those effects. Review the new definer routines with pinned search_path,
fully qualified objects, explicit PUBLIC/anon revokes, named authenticated/
service_role EXECUTE and no caller-controlled SQL. Keep new ledger/config tables ungranted
and RLS enabled. Bound idempotency to actor/client/input, serialize decisions
with existing refusal writers, and make permission/sync failure roll back the
whole command. Reuse the existing outbox's ordering, lease, retry ceiling and
terminal states; add no new drainer. No stale worker token is accepted by a new
finalizer because no finalizer is proposed. Freeze/snapshot concerns are limited
to actor/client/email/target consistency in the command transaction. No backfill
of grants is authorized. The role/refusal, rollback, concurrency and existing-worker witnesses above
supply local proof; independent native SQL review remains required.

## Local checks, package and remaining gates

Earlier author proof applied and replayed the complete migration selections on
all five profiles. The initial actor/atomicity/replay/worker suite passed; adding
the actual provider callback regression exposed the gifts fan-out omission.
After ACL conformance, legacy passed and the four qualified cases failed only
that retained assertion. The lead then assigned the additive repair here.
These were author proof attempts, not native repair cycles.

Current bounce/complaint proof and package measurements are recorded below. No source registry/control file, R0-owned package projection or numeric
budget is changed. Both ENABLE ROW LEVEL SECURITY statements remain; table bodies
and narrowing are conformed under the later amendment below.

Managed-rail check: the forward does not enter supabase/migrations or change any
managed routine/caller. The managed donor uses its separate contact permission/
event graph; native preference tables and new ledger/target are separate. The
one-word native delivery adapter addition is not imported by managed adapters.
Existing actor SQL bodies remain unchanged.

Remaining: stabilized public API/definer read before DCO, prior admission control
and pins, R0-owned package projection integration, supervised native reviews,
canonical verification and any permitted submission. Remaining estimate: one
working day plus externally scheduled control/review/landing. No live provider
work is included. No dispatched-attempt location, supersededByStableJourneyKey
or checkoutAbandoned is written. Native repair cycles used: zero.

Self-retro: per-purpose suppression tests missed the provider producer's fixed
purpose list. The actual callback-to-evaluator regression exposed it. The
smallest adequate repair adds one purpose to that producer and retains the
original failing witness, expanded to both provider holds and all three
marketing purposes. No new mechanism or automatic successor is introduced.

## Earlier ACL proof

The earlier author candidate used separate function PUBLIC revokes and three
conditional function privilege blocks. Its new tables relied on default owner-
only ACLs with RLS. The restricted runtime and authenticated roles had no direct
access, and actual SELECT/DELETE refused. The separate table-narrowing class
amendment below supersedes that privilege choice with explicit table revokes.
The generic reader's earlier rejections did not grant permission to change its
rules; current table-creation statements are checked directly after rewriting.

## Provider suppression repair proof

The rerun passed all five real-PG profiles in 19.87 seconds, with the current
complete selections applied and replayed. All four qualified cases prove bounce
and complaint suppression for newsletter, gifts and launch-offer through the
restricted runtime adapter, including true-before-hold, persisted state,
permission_suppressed, callback replay and later account grants. Earlier actor,
ACL, rollback, replay, worker and reconnect assertions remain green. Owned
containers and volumes were removed. Evidence: the task's ignored scratch log
postgres-bounce.log. The old enabled failure is repaired, not skipped.

Strict public typecheck passed with zero unresolved edges/consumer errors.
Full lint passed with zero errors and the same 33 existing warnings. Ast-grep
and whitespace checks passed. The source admission check remains an expected
blocker for this unpinned forward; no control fix or pin is attempted here.

A fresh pair of real npm packs compares a common canonical-manifest projection
on the base artifact and candidate. The candidate additionally includes this
row's SQL plus the native TypeScript/dist and package documentation change:
2,114,124 B / 2,842 files, a measured +3,398 B / +1 file. Both packs include
their respective canonical-manifest bytes, so this replaces the prior separate
SQL/manifest estimate with a direct compressed comparison. It is below the
6 KB soft target and changes no cap. R0-owned package projection files remain
untouched; final generated format and composite stream qualification are not
claimed. Raw paired measurements: pack-bounce-measurements.json in task scratch.

The stabilized candidate is preserved as an unsigned, non-DCO WIP commit for
the required maintainer read. Current commit/tree, policy/docs and WIP secret
scan evidence are in the external read packet to avoid a self-referential SHA.
No DCO, native review, canonical verify, push, PR, merge or release was run.
Focused admissions took 0–31 seconds per stage on this resume. No additional
process improvement was needed beyond the callback regression lesson above.

## New-table grammar and narrowing amendment

The resumed class decision requires grammar-compatible table checks and explicit
revokes on the two newly created tables. Nonblank identifiers use NOT(btrim(x)
= ''), lengths use BETWEEN and char_length, and copy versions use the accepted
literal IN list. The command refuses target control characters before effects;
fingerprints remain derived lowercase SHA-256 hex and copy versions remain
constructed from the closed purpose list. No input chooses either generated
value. Target control-free storage, fingerprint hex and exact purpose/version
pairing no longer have table-level guarantees for privileged direct DML. The
bounded command preserves those guarantees for its writes/use; direct owner
ledger edits can bypass the hex/pairing rules. No browser/runtime direct DML is
allowed. This is the specified boundary adjustment, not a behavior refactor.

Both CREATE TABLE statements and the index passed the actual unchanged reader
in reviewedCreationTable=true mode; the literal version IN check is accepted.
The ADD CHECK also passes; RLS enable and DROP CHECK require the class's named
exceptions rather than generic expand-only admission. Exact statement results
and reader digest are in task scratch table-grammar-final.log.

Each new table now revokes ALL FROM PUBLIC separately, followed by three
conditional table-only REVOKE blocks for anon, authenticated and service_role.
These are separate from the three function-only conditional blocks. Both RLS
enables remain, with no policies or table grants. No new object/signature,
existing-function replacement, money object or control-source edit is added.
The first five-profile run measured the expected constraint/ACL/routine catalogue
changes and refused the stale inventory hashes in all five cases. After updating
only those measured identities, the full suite passed all five profiles in
19.93 seconds. Both qualified-v2 layouts proved actual runtime/authenticated
SELECT/DELETE refusals and absent effective table/column privileges. All five
proved RLS on both tables and no table/column privileges for the existing anon,
authenticated and service_role roles; actor read/grant/withdraw still worked
through the restricted runtime and SET LOCAL ROLE authenticated. Target control-
character refusals roll back all choice effects. Both provider holds remain
suppressed across all three marketing purposes in the four qualified profiles.
Owned containers/volumes were removed. No fixture grants/default privileges,
role membership or new setup seam was added.

Fresh strict public typecheck passed with zero unresolved edges/consumer errors.
Full lint passed with zero errors and the same 33 existing warnings. Ast-grep
and whitespace checks passed. This resume kept the prior one-purpose delivery
adapter change unchanged and touched no stores-owned sync/contract file.

Self-retro: checking each actual CREATE TABLE in the reader's table mode before
refreshing the packet separated expression compatibility from the class's
explicit RLS/CHECK exceptions. Moving only the removed validation into the
bounded writer/use boundary preserves actor guarantees without new helpers or
triggers; its limits for privileged direct writes are explicit. Focused gate
waits included 62, 30, 122, 307 and 32 seconds. The stage selector was corrected
from a direct runner without npm's executable PATH to the existing npm test
command before final proof. No native repair cycle or control change resulted.

Final amended real paired pack: 2,114,174 B / 2,842 files, measured +3,448 B /
+1 file including this row's SQL and both sides' canonical-manifest bytes. This
supersedes the prior provider-fix pack figure; it remains below the 6 KB target.
R0 package projection sources are untouched; final generated format/composite
qualification is not claimed. Measurements: pack-tables-measurements.json in
task scratch. No cap changes. Current commit/tree and post-WIP policy, secret
scan and expected admission refusal are bound in the refreshed external read
packet; no DCO, native review, canonical verify or external delivery is performed.

## Consent store-transfer continuation

The lead expanded this same row to preserve the delivered native store-transfer
path. SQL remains byte-identical. Add only the two account tables to capture's
owned list and restore's explicit order beside communication data; the permission
ledger must follow its outbox parents. Existing customer_communication_preferences,
customer_communication_preference_events, communication_recipient_consents and
communication_native_sync_state are already in both lists. Outbox is compatible
capture data and restores before sync/event references. No other table is needed
for rows written by these actor routines.

Carry customer_account_consent_sync_targets over exactly as source configuration:
it has logical binding/provider names and an enabled flag, no credential or
endpoint. Existing queued sync work already retains those names; removing only
the target row would break continued commands without neutralizing queued work.
The existing transfer is into a pristine inactive target, with writers and
dispatchers excluded by the host. It neither activates a worker nor changes
provider credentials. Target configuration must start empty; a nonempty conflicting
target is not overwritten. Retargeting remains an explicit trusted operator act,
not a silent transfer translation.

The owner-read packet will name each added relation and its contents, including
personal data in the event ledger: actor/client IDs, recipient fingerprint,
source/reason/copy, route/client attribution, capture times and work identity.
Consent history is carried losslessly under the existing global row/byte limits;
limit exhaustion must refuse the whole capture, never trim history or suppressions.
Prove rows are produced by real actor routines, captured/restored into a clean
qualified database, then read/replayed with no duplicate/regrant and preserved
holds. Confirm row/byte limit refusal at the consent ledger and unchanged package
bytes with a fresh SQL-inclusive paired pack. Expected extra effort: 1–2 hours
plus focused-gate waits; no SQL/control/review/release scope is added.

The complete connected-store suite passed all nine real-PG cases in 56.53 s.
Five source permission events, preference/evaluator rows and sync work are
produced through actual actor routines under the restricted runtime and SET
LOCAL ROLE authenticated; provider suppression is produced by the actual native
bounce port. Full source/target censuses match after restore on a clean qualified
installation. Choices and all recorded attribution survive; key replay returns
original event/work IDs and current choices without data writes or regranting
withdrawn consent. Conflicting replay refuses, and a fresh held grant remains
suppressed and registers suppress work against the carried target. Transfer
replay is also exact. A preexisting different target is refused unchanged.

The personal-history cases hit both row and UTF-8 byte budgets specifically at
customer_account_consent_events, returning limit_exceeded with no partial
packet. Fingerprint, principal identity, fixed source and route/client attribution
remain in complete captured PostgreSQL row text. No personal-data filtering,
new archive policy, arbitrary per-table exclusion or increased limit is added.
The owner read covers this retention of linked consent history. SQL stays at
SHA-256 8708db594d9841ce190db04a0d6ee4761083f5ce1be32443f4e79432d322f1ae.

Fresh strict public typecheck passed with zero unresolved edges/consumer errors;
full lint passed with zero errors and the same 33 warnings. Ast-grep and whitespace
checks passed. A real paired pack, including row SQL and canonical-manifest
bytes, remains 2,114,174 B / 2,842 files (+3,448 B / +1 file cumulatively).
The root transfer increment is exactly 0 B / 0 files, and the projected tarball
hash equals the prior table-amendment artifact. No package source, R0 projection,
SQL, manifest or cap changed. Measurements: pack-transfer-measurements.json in
task scratch. The required domain/identity/operations transfer-set read joins
the public API/definer read in the same refreshed external packet before DCO.

Self-retro: the existing finite profile already covered all four old consent
relations and the outbox. Two additive list lines plus reuse of the existing
round-trip fixture were enough; no transfer engine, SQL or configuration
translation was needed. The tests explicitly demonstrate both history budgets
and retained-target continuity instead of assuming list membership proves
post-restore behavior. Added effort stayed within the 1–2 hour bound; remaining
estimate stays one working day plus external control/review/landing scheduling.
No native repair cycle, DCO, review, canonical verify or external delivery.

## Withdrawal independence repair

The maintainer read found that new withdrawals depended on downstream target and
email-shape gates, stranding the only gifts withdrawal route. This delta builds
on unsigned WIP 232ed66be4506601b0ff0417531562ee24efe570 (tree
119a18e9909eca8b6c1952813d724be7a806f544). Keep the same SQL object/signature list
and all privilege, RLS, CHECK, bounce and transfer choices accepted by the
coordinator under the preceding boundary read. Make event
work_id nullable and return workId null for locally committed choices without
registered sync work. Grants retain both refusals. Null stored email still
refuses; non-null odd text can receive a local denial.

Keep the existing normalized stored-text fingerprint even for an odd address;
never send it to a provider. An odd-email withdrawal also denies fingerprints
previously audited for the same actor/client/purpose, using the existing ledger.
This prevents correcting back to a known address from resurrecting its old grant.
Preserve suppression and its timestamps on every affected recipient. Record the
fingerprint set and deferral reason in existing JSON metadata; store no additional
raw email. A fresh valid address has an independent unknown/default-denied state,
not an inferred grant or silently retargeted event. Exact replay never reapplies
an old denial after email change or an explicit later grant.

Optional outbox/sync registration must not roll back a valid local withdrawal:
use a subtransaction and record no work if registration fails. Grants still fail
atomically. No provider call, auto retry/backfill, new table/function, registry
edit or package entry is introduced. Owner documentation provides a read query
for false requests with work_id NULL and makes the provider-unaware limit explicit.
Reference fields can identify people: hosts should use opaque references; no
erasure path exists for this ledger yet. The existing package subpath inventory
is unchanged, so the new-entry layout rule has no new entry to check.

The five-profile real-PG rerun passed in 20.47 s after the five independently
measured catalogue hashes were refreshed. Each profile proves disabled/absent
target withdrawals and odd non-null stored text, their exact replays with null
work ID, no optional work, current denial, preserved suppression and the exact
documented owner query. Odd cases include malformed, whitespace-normalized-empty,
control-containing and overlength values. Correcting back to an old account
address stays denied; a fresh address is unknown until explicitly granted, and
replaying the old denial does not undo that grant. A historical suppression keeps
its original fields through the odd withdrawal and correction. Optional work
CHECK failure leaves a local denied event with null work and no partial outbox;
the corresponding grant fault still rolls all effects back.

The connected-store suite also passed all nine real-PG cases in 54.14 s with a
source denial recorded while its target was disabled. Its null work ID and
choices survive full capture/restore and replay after the carried target is
enabled; no work is backfilled. Restore order and exact target carry/refusal
remain unchanged. Both new-table CREATE statements still pass the unchanged
reader's table mode; existing named exceptions, narrowing and bounce source are
unchanged. No function/table/index/trigger, package export/subpath or privilege
was added. The package-entry-layout rule is therefore a scoped no-impact item.

Strict public typecheck initially found four never[] inference errors in the
new receipt collections. Explicit receipt types repaired them without runtime
changes; the full check then passed with zero unresolved edges/consumer errors.
Lint passed with zero errors and the same 33 existing warnings; ast-grep and
whitespace passed. No CONTRIBUTING edit or package subpath was added; the scoped
configuration/test no-impact trailers explain the unchanged policy and entry
layout. The final proof is a local author run, not native review or qualification.

Self-retro: grant-only negative tests missed that the same prerequisite gates
stranded withdrawal. The new witnesses test false under each unavailable
prerequisite, exact null receipt replay, registration fault and subsequent email
correction. Reusing the existing ledger for known recipients avoided a new
address-history object while closing the reachable old-grant resurrection case.
Suppression and deterministic recipient ordering remain explicit. Repair cycles
used in native review: zero; this is the maintainer-read delta, not a new review
session or reset. Remaining estimate: one working day plus external scheduling.

Real paired pack including canonical SQL/manifest bytes: 2,114,540 B / 2,842
files, cumulative +3,814 B / +1 file; +366 B against the accepted transfer WIP.
The underlying package-only artifact hash is unchanged: no package source,
export/subpath, dependency, R0 projection or cap changed. This remains below the
6 KB soft target. Raw measurements: pack-withdrawal-measurements.json in task
scratch. Final R0 generated format/composite qualification is not claimed.
The new delta read binds this tree and builds explicitly on 232ed66b; no DCO,
native review, canonical verify, push, PR, merge or release was performed.

## DCO handoff after the accepted delta read

The coordinator accepted the preceding boundaries and the repaired withdrawal
semantics for DCO; the stream supervisor schedules the next native review.
Normal usable-address changes retain the documented per-address behavior.
The accepted forward remains byte-identical, SHA-256
`01acd691f9918af6025c975028e31028df02105d36b123dde41c29dc02bcecf6`.
The unpushed, unreviewed WIP history is consolidated into one contribution commit
with Bart Roszkowski's DCO sign-off, preserving the implementation and adding
only this handoff wording and the package change fragment. No native review,
canonical verification, push, admission pin or control change is included.
Cheap checks are rerun for this handoff; exact logs and final identities stay in
task scratch and the supervisor report. The existing five-profile and nine-case
transfer proofs remain applicable because production, SQL and tests did not change.
The prior real pack including SQL remains 2,114,540 B / 2,842 files, +3,814 B;
change fragments do not ship in npm. The admission class and every earlier
nonempty money slot must land before this last slot. Native repair cycles: zero.
Remaining estimate: one working day plus external scheduling.

Self-retro: no additional implementation change was needed after the accepted
read. Keep acceptance attribution with the coordinator and scheduling with the
stream supervisor; retain the exact accepted SQL identity across history cleanup.

## Existing-suite compatibility check — initial stopped run

The unchanged existing native communications suite is a delivery blocker:
`tests/postgres/communicationsNative.test.ts` ran all 20 cases, with 18 passing
and two failing. The poll/callback convergence and suppression case at line 109
expects three recipient-consent rows; the added gifts fan-out persists four.
This affects a send created through the existing delivery port without the new
account writer or an account permission event. The adverse-reinstall case at
line 270 drops/recreates the native tables using the older communications DDL.
That reconstructs the two-purpose sync CHECK after this forward widened it;
the current migration ledger prevents reapplying the forward and the catalogue
hash check refuses the resulting schema. Treat both as change regressions for
coordination; no source/SQL repair or assertion relaxation has been attempted.
The test batch stopped at this first failing existing file. No other existing
suite is claimed green from this run.

The account suite itself passed all five real-PostgreSQL profiles again in
19.81 s. Its actual catalogue projectors reproduced these current hashes:

- qualified-v2 bootstrap/restore (96 units):
  `ee0b5c7943dd2a29dc6d3acaec0cee3b95ee1c44366825bfc67fa63f6822c642`
- qualified-v2 separate migrator/restore (96 units):
  `b6bf509ec21985044d3fff75e2427d92a39d54d7e113e9951a578358fa4399bf`
- qualified-admin installer-managed (95 units):
  `bc0b06202c8c6cd2d9e1390814a26c7aab7f205800681f8e3b33637f0a26622c`
- qualified-admin operator-provisioned (95 units):
  `9239ca156012f142a7c98e3f44ba985110e9a1133c575df814277ed4e3d477fc`

Only the authorized current chain literals and four current hashes are updated
in the three qualification/restore test files and two proof companions. Historic
issued-prefix counts and inventory hashes remain untouched. Those three suites
have not yet run with the bump because the compatibility batch stopped. All
other selected test files are byte-identical to the signed candidate. The
forward remains SHA-256
`01acd691f9918af6025c975028e31028df02105d36b123dde41c29dc02bcecf6`.

The full selection (including proof children through their parent tests) is:

- `packages/platform/test/communications/nativeDelivery.test.ts` — not run; stopped at blocker.
- `scripts/customer-selfservice-recovery-schema.test.ts` — not run; stopped at blocker.
- `scripts/documentation-impact.test.ts` — not run; stopped at blocker.
- `scripts/packages/platform-cold-consumer.test.ts` — not run; stopped at blocker.
- `scripts/reviewed-batch-forward.test.ts` — not run; stopped at blocker.
- `server/adapters/postgres/communicationsLifecycle.test.ts` — not run; stopped at blocker.
- `server/adapters/postgres/customerCommunicationPreferences.test.ts` — not run; stopped at blocker.
- `server/adapters/supabase/communications/customerCommunicationPreferences.test.ts` — not run; stopped at blocker.
- `server/domains/communications/customerCommunicationPreferencesHandler.test.ts` — not run; stopped at blocker.
- `server/runtime/communications/a1ReferenceBinding.test.ts` — not run; stopped at blocker.
- `server/runtime/communications/communicationsLifecycleBinding.test.ts` — not run; stopped at blocker.
- `server/runtime/communications/communicationsSchema.test.ts` — not run; stopped at blocker.
- `tests/postgres/acquisitionEvidenceParity.test.ts` — not run; stopped at blocker.
- `tests/postgres/channelConnectedRestore.test.ts` — not run; stopped at blocker.
- `tests/postgres/commerceComposition.test.ts` — not run; stopped at blocker.
- `tests/postgres/communicationsNative.test.ts` — FAIL, 18/20 passed.
- `tests/postgres/connectedManagedRetained.test.ts` — not run; stopped at blocker.
- `tests/postgres/connectedStoreTransfer.test.ts` — not run; stopped at blocker.
- `tests/postgres/customerAccountConsents.test.ts` — PASS, five profiles.
- `tests/postgres/customerNewsletterWithdrawal.test.ts` — not run; stopped at blocker.
- `tests/postgres/m14ManagedCatchup.test.ts` — not run; stopped at blocker.
- `tests/postgres/m14QualifiedAdminComposition.test.ts` — not run; stopped at blocker.
- `tests/postgres/m14QualifiedComposition.test.ts` — not run; stopped at blocker.
- `tests/postgres/m14RestrictedConnectedRestore.test.ts` — not run; stopped at blocker.
- `tests/postgres/managedStorageTransfer.test.ts` — not run; stopped at blocker.

Selection used repository-wide module/export, table and routine references plus
adjacent composition bindings, and included script/schema checks conservatively.
The managed Storage proof is reached through managedStorageTransfer.test.ts;
the two qualified composition proofs run through their corresponding parents.

For older/retained stores, this change replaces no existing routine, migrates no
facts, requires no new companion row for the old preference or evaluator APIs,
and leaves normal address changes scoped per recipient. Capture/restore carries
empty or populated new tables once the current native schema is installed.
However, the bounce/complaint path deliberately also changes old sends that did
not use the new writer by adding gifts suppression; the unchanged suite exposes
that expansion. Recreating an earlier schema table is also affected by the new
CHECK. Remaining retained/managed/connected suites are pending, so no broad
compatibility conclusion is asserted. SQL/source, CHANGELOG and controls remain
unchanged; the existing package change fragment remains the note location.

Self-retro: running the existing suite caught two interactions missed by the
new focused proof. The first direct wrapper invocation lacked npm's executable
path and failed before collection; the corrected npm test invocation produced
the real failures above. Keep the failing assertions intact and obtain the
required decision/delta read before any source or SQL repair. No native review
or repair cycle started. Remaining estimate: one working day plus blocker and
external scheduling; the earlier real SQL-inclusive pack remains applicable.

## Existing-suite correction and completed batch

The resumed instruction authorized two corrections in the existing native
communications test after verifying the mechanisms. The complaint assertion
now checks purpose and state explicitly: gifts-and-discounts is added while
launch-offer, newsletter and tester-program suppression remain asserted. This
is the already accepted bounce/complaint behavior, including sends with no new
account-consent history; no production behavior is changed by this repair.

The adverse-reinstall fixture intentionally drops native tables and reads older
communications DDL. Its final restore now also reads exactly the two named
DROP/ADD purpose-CHECK statements from this consent forward and executes them
in file order, asserting that both were found. It copies no SQL literal and
runs no other part of the forward. The poison step needed no change and passed
unchanged. All poison-ACL refusals, the final empty migration replay and the
final snapshot-equals-before assertion remain unchanged. The full file passes
20/20 cases. The production migration runner applies only the pending ledger
suffix; the inspected direct historical-DDL consumer outside tests is an owned
disposable cold-consumer proof, not a production repair path. No production
old-DDL replay path was found in that trace.

All 23 remaining suites passed without edits in this run. The three chain-count
suites ran their previously authorized +1/current-inventory bumps, including
their two proof companions; no historic inventory pin changed. The qualified
admin modes both pass at 95 units; all four qualified-v2 shapes pass at 96.
Restricted connected restore passes all 15 cases. The current hashes measured
in the preceding section are validated by these real-PostgreSQL compositions.

The complete 25-file selection is green: 1,018 passed, zero skipped. This joins
24 resumed files (1,013 cases) with the prior five-profile account-consent run,
whose SQL, production source and test are unchanged. Current results:

| Suite | Passed | Skipped |
| --- | ---: | ---: |
| `packages/platform/test/communications/nativeDelivery.test.ts` | 2 | 0 |
| `scripts/customer-selfservice-recovery-schema.test.ts` | 3 | 0 |
| `scripts/documentation-impact.test.ts` | 101 | 0 |
| `scripts/packages/platform-cold-consumer.test.ts` | 108 | 0 |
| `scripts/reviewed-batch-forward.test.ts` | 691 | 0 |
| `server/adapters/postgres/communicationsLifecycle.test.ts` | 1 | 0 |
| `server/adapters/postgres/customerCommunicationPreferences.test.ts` | 1 | 0 |
| `server/adapters/supabase/communications/customerCommunicationPreferences.test.ts` | 2 | 0 |
| `server/domains/communications/customerCommunicationPreferencesHandler.test.ts` | 4 | 0 |
| `server/runtime/communications/a1ReferenceBinding.test.ts` | 5 | 0 |
| `server/runtime/communications/communicationsLifecycleBinding.test.ts` | 2 | 0 |
| `server/runtime/communications/communicationsSchema.test.ts` | 1 | 0 |
| `tests/postgres/acquisitionEvidenceParity.test.ts` | 11 | 0 |
| `tests/postgres/channelConnectedRestore.test.ts` | 1 | 0 |
| `tests/postgres/commerceComposition.test.ts` | 4 | 0 |
| `tests/postgres/communicationsNative.test.ts` | 20 | 0 |
| `tests/postgres/connectedManagedRetained.test.ts` | 16 | 0 |
| `tests/postgres/connectedStoreTransfer.test.ts` | 9 | 0 |
| `tests/postgres/customerAccountConsents.test.ts` | 5 | 0 |
| `tests/postgres/customerNewsletterWithdrawal.test.ts` | 8 | 0 |
| `tests/postgres/m14ManagedCatchup.test.ts` | 1 | 0 |
| `tests/postgres/m14QualifiedAdminComposition.test.ts` | 2 | 0 |
| `tests/postgres/m14QualifiedComposition.test.ts` | 4 | 0 |
| `tests/postgres/m14RestrictedConnectedRestore.test.ts` | 15 | 0 |
| `tests/postgres/managedStorageTransfer.test.ts` | 1 | 0 |

The resumed suites are checksum-identical to a21dd10a except for the two
explicitly authorized edits in communicationsNative.test.ts. Real-PG evidence
includes managed retained rows, interrupted managed catch-up, native connected
restore, Storage transfer, old newsletter withdrawals, acquisition and commerce
composition, and restricted qualified installations without a new account
permission ledger/target companion requirement on the existing served APIs.
The intentional four-purpose suppression on older sends is now explicit;
normal usable-address changes retain per-address behavior. These are the
finite existing fixture profiles, not all-adopter or hosted qualification.

The forward, manifest and production source remain byte-identical to the signed
candidate. No SQL object, function, privilege, RLS statement, CHECK definition,
package entry, control or CHANGELOG change is made. The existing package fragment
remains the change-note route. Last real paired pack including SQL is unchanged:
2,114,540 B / 2,842 files, +3,814 B / +1 file. These root test/record edits add no
package input. Final R0 projection/composite qualification waits for integration.
Exact logs/results are in task scratch existing-resume-*.log and
existing-all-results.json; current handoff identities and cheap-check results
are retained in the external packet/report. No native review, canonical verify,
push or PR has started. Native repair cycles used: zero. Remaining estimate:
one working day plus the class/earlier-slot scheduling; this row lands last.

Self-retro: existing-suite execution distinguished the required fourth-purpose
suppression from a historical-DDL reconstruction assumption. Reading the two
CHECK statements from the forward preserves the poison and snapshot witnesses
without a second drifting SQL copy, production replay or weakened assertions.

## R0 integration and real package measurement

The resumed instruction authorizes one fetch and merge of main, a DCO merge
commit, generated SQL projection, real inventory measurements, the two handover
literals and its complete witness, and selected-suite reruns. No rebase, control
pin/checker edit, native review or production/SQL repair is authorized.
Fetched and merged main 09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a into prior
6616dab5e147c94dae20d48d81fe6f33cd1ce8f2 with --no-ff --no-commit.
Manual additive conflict resolutions were required only in:

- config/openlup-publication-catalog.json: preserve the consent, conformance-kit
  and R0 task rows, then add the generated consent SQL carrier's own row.
- docs/platform/DATA_AND_MIGRATIONS.md: retain both the account-consent
  compatibility paragraph and main's complete-catalogue projection paragraph.

The README merged automatically. No generated value was hand-merged. Used the
README's checkPlatformMigrationProjection(process.cwd(), true) route to generate
packages/platform/sql/manifest.json and the new SQL carrier. Both canonical
and packaged consent SQL remain SHA-256
`01acd691f9918af6025c975028e31028df02105d36b123dde41c29dc02bcecf6`.
No canonical SQL, function/table list, runtime source or existing historic pin
was changed to resolve integration.

The account suite passed all five profiles on R0 (19.76 s), remeasuring the same
legacy, bootstrap, separate, admin-managed and admin-operator current inventories
recorded above. Current complete counts remain 96 qualified-v2 and 95
qualified-admin. The connectedNativeStoreTables export measures 84 entries.
The count is moved by customer_account_consent_events and
customer_account_consent_sync_targets. Only the handover witness's current
inventory literal (b6bf509ec21985044d3fff75e2427d92a39d54d7e113e9951a578358fa4399bf)
and table-count literal (84) changed; its guard message and all other code stay
unchanged. Historic chain inventories remain untouched.

The default handover witness completed its final assertions, exit zero, using
host Node24.21.0/npm11.19.0 and the already-local immutable Node24.21.0 image
sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20.
Outcome: LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION.
It published the 84-table canonical graph and private objects/tmp after source
retirement, recovered two accepted effects, retained one uncertain operation
fenced, and exercised ordinary target dispatch and replay. Cleanup failures: [].
The target's dispatch_not_safe_to_submit:uncertain result is the expected fenced
operation, not an assertion failure or redispatch. This is the finite local
fixture, not whole-store, hosted-provider or zero-RPO qualification. Evidence:
.context/scratch/oss-m14-connected-catchup/journey-nL1kKY/report.json and
.context/scratch/g11c/handover-r0.log.

Real paired packs use a pristine build from Git main 09cd599b and the actual
integrated workspace package, with Node24.21.0/npm11.19.0. Base: 2,318,731 B /
2,913 files; candidate: 2,322,353 B / 2,914 files. Row delta +3,622 B / +1 file,
192 B below the previous +3,814 B projection measurement. The actual packaged
consent SQL and generated manifest bytes were read back and matched. No growth
beyond the last reported row figure occurs. Reproduction and raw measurements:
.context/scratch/g11c/measure-r0-pack.py and pack-r0-measurements.json.
The selected-suite rerun and focused R0 projection/facade witnesses follow;
current results and eventual signed merge identity will be recorded below.

### Completed R0 suite rerun

All selected files passed on the integrated R0 tree, together with the two
focused projection/facade witnesses: 27 files, 1,022 tests, zero skipped.
Checksums confirm all original 25 selected files are unchanged from 6616dab5;
the handover source differs from main only in the two authorized literals.
The current measurements, unchanged from the earlier isolated run, are:

| Profile | Complete units | Current inventory SHA-256 |
| --- | ---: | --- |
| legacy | 92 | `8e2396953fbcae7a4c702d19df3121bfe4b64efed8078137d6aa3c379b830422` |
| qualified-v2 bootstrap/restore | 96 | `ee0b5c7943dd2a29dc6d3acaec0cee3b95ee1c44366825bfc67fa63f6822c642` |
| qualified-v2 separate/restore | 96 | `b6bf509ec21985044d3fff75e2427d92a39d54d7e113e9951a578358fa4399bf` |
| qualified-admin installer-managed | 95 | `bc0b06202c8c6cd2d9e1390814a26c7aab7f205800681f8e3b33637f0a26622c` |
| qualified-admin operator-provisioned | 95 | `9239ca156012f142a7c98e3f44ba985110e9a1133c575df814277ed4e3d477fc` |

| Suite | Passed | Skipped |
| --- | ---: | ---: |
| `packages/platform/test/communications/nativeDelivery.test.ts` | 2 | 0 |
| `scripts/customer-selfservice-recovery-schema.test.ts` | 3 | 0 |
| `scripts/documentation-impact.test.ts` | 101 | 0 |
| `scripts/packages/platform-cold-consumer.test.ts` | 108 | 0 |
| `scripts/packages/platform-migration-projection.test.ts` | 1 | 0 |
| `scripts/reviewed-batch-forward.test.ts` | 691 | 0 |
| `server/adapters/postgres/communicationsLifecycle.test.ts` | 1 | 0 |
| `server/adapters/postgres/customerCommunicationPreferences.test.ts` | 1 | 0 |
| `server/adapters/supabase/communications/customerCommunicationPreferences.test.ts` | 2 | 0 |
| `server/domains/communications/customerCommunicationPreferencesHandler.test.ts` | 4 | 0 |
| `server/runtime/communications/a1ReferenceBinding.test.ts` | 5 | 0 |
| `server/runtime/communications/communicationsLifecycleBinding.test.ts` | 2 | 0 |
| `server/runtime/communications/communicationsSchema.test.ts` | 1 | 0 |
| `tests/postgres/acquisitionEvidenceParity.test.ts` | 11 | 0 |
| `tests/postgres/channelConnectedRestore.test.ts` | 1 | 0 |
| `tests/postgres/commerceComposition.test.ts` | 4 | 0 |
| `tests/postgres/communicationsNative.test.ts` | 20 | 0 |
| `tests/postgres/connectedManagedRetained.test.ts` | 16 | 0 |
| `tests/postgres/connectedStoreTransfer.test.ts` | 9 | 0 |
| `tests/postgres/customerAccountConsents.test.ts` | 5 | 0 |
| `tests/postgres/customerNewsletterWithdrawal.test.ts` | 8 | 0 |
| `tests/postgres/m14ManagedCatchup.test.ts` | 1 | 0 |
| `tests/postgres/m14QualifiedAdminComposition.test.ts` | 2 | 0 |
| `tests/postgres/m14QualifiedComposition.test.ts` | 4 | 0 |
| `tests/postgres/m14RestrictedConnectedRestore.test.ts` | 15 | 0 |
| `tests/postgres/m19MigrationFacade.test.ts` | 3 | 0 |
| `tests/postgres/managedStorageTransfer.test.ts` | 1 | 0 |

The restricted connected restore suite passed all 15 cases; qualified-admin
passed both modes and qualified-v2 passed four shapes against the measured
current inventories. No historic inventory or prefix count was changed. No
source/SQL repair was needed. The canonical and packaged forward remain
byte-identical at 01acd691f9918af6025c975028e31028df02105d36b123dde41c29dc02bcecf6.
The package result remains +3,622 B versus exact main 09cd599b, including its
actual generated manifest and SQL carrier; root witness/test/record changes
add no package inputs. The main baseline pack was reproduced byte-for-byte in
size and file count, rather than borrowing the pre-R0 projection estimate.

Ast-grep passes. The row's diff against the incoming R0 base passes whitespace
checks; a comparison of the entire staged merge against the old parent reports
an existing blank EOF in R0's immutable q2 actor-auth SQL carrier. That asset is
unchanged from main and was not edited. All conflicts remain confined to the
two additive resolutions recorded above. Documentation policy refuses the
explicit incoming base until it becomes an ancestor of HEAD; scoped trailers
are refreshed immediately after the tested merge commit, without checker edits.
Final type/lint, DCO, policy/inventory and secret-scan results and signed identities
are kept in the external handoff packet/report. No native review, canonical
verify, push, PR or admission pin is introduced. Native repair cycles remain
zero. Remaining estimate: one working day plus class/earlier-slot scheduling.

Self-retro: generate package assets from their canonical owners and measure
against a pristine R0 build before spending time on the broad rerun. The real
row delta is 192 B below the prior projection estimate. Running the handover to
its final report proves the assertions beyond the two literal admission guards;
its one intentionally fenced uncertain operation is preserved, not redispatched.

During the long focused run, the shared origin/main ref advanced to
4c7afd2590dc6998e22464153fca70a92eecfeb2. Its current policy delta was inspected
read-only: the integration trailer route uses one tree-identical non-merge
commit with only a subject, documentation-impact trailers and DCO sign-off.
The merge stays pinned to the actually fetched 09cd599b R0 base; no second merge
or control-file edit is made. Comparisons and package measurements use that exact
pin, not the moving remote ref. No focused/mechanical native-review exemption
is claimed: no native review exists yet and both manual resolutions are recorded.

## Authorized continuation: retained renewal terms

The supervisor resumed this task for a local build of renewal delivery pricing,
retained delivery-two acquisition terms and graduation, the three lead-absorption
policy rows, and preservation of the existing consent API. This supersedes the
original exclusion of renewal money objects only for that bounded continuation.
Values are host configuration; real PSPs, promotion-code administration, prepaid,
refund creation, saved preferences and managed behavior remain excluded.

Integration is pinned to predecessor `4a14148b`; instruction freshness was checked
against main `7249a750addf64fea1da42fa87e77467794da09c`. The current integration
unions disjoint catalogue/documentation/transfer-fixture additions and regenerates
the package SQL projection. Five canonical PostgreSQL inventory measurements
are retained in local execution evidence; literal selection counts are 98 legacy,
102 qualified-v2 and 101 qualified-admin, with 111 connected transfer tables.
No historic inventory pin is changed.

The grant permits a DCO-signed predecessor merge and non-SQL commits. New SQL
and its co-located pins stay staged for the coordinator's read. The extra
retained-terms reader requires the preceding control change. No review, canonical
verification, push, PR, merge-queue action or publication is authorized in this run.
Final measurement uses the official toolchain against the pinned predecessor;
packed/code delta stops are 16,000/7,000 bytes. Full installation, uppercase UUID,
time-zone, replay, consent, transfer, handover and installed-consumer evidence
remain required before the delta-read packet can claim completion.

Integration rethink: the first generic registry union assumed strings instead of
path records; the subsequent text union let its closing marker span lines and
truncated trailing content. Lint detected the lost transfer fixture use. The
corrected route reconstructs the original three-way inputs, unions only bounded
conflict blocks and checks additions against both parents. The corrected delta
retains the predecessor's full transfer test and adds the consent fixture.
Lesson: generic conflict parsing -> preserve Git's complete three-way output and
match marker lines locally. This is local integration recovery, not native review.


## Build stopped at the measured size limit

The authorized predecessor merge is signed at `a371f6c57adb85f35a9e536a9daf1b8269b22128`.
The first full-row draft was packed with the official Node 24.21.0 / npm 11.19.0
toolchain against exact predecessor `4a14148b2150829ea05ebe2a3cc776152e37d951`.
The real packed delta is 16,277 bytes and the code-class delta is 10,788 bytes;
both exceed this continuation's 16,000 / 7,000 byte stop lines. Absolute packed
size is 2,497,056 bytes; code is 1,990,090 bytes; unpacked is 11,753,461 bytes;
there are 3,056 files. These measurements include source, rebuilt declarations
and JavaScript, packaged SQL, reports and the generated SQL manifest. They are
measurements of an unfinished draft, not a completed acceptance candidate.

Implementation stopped immediately at that measurement. New SQL and its
mechanical file/function bindings are staged for inspection; the inherited
class data is unchanged and still refuses admission. A scratch copy of the
preceding control's exact class passes the static function/forward check using
main's current helper. Inventory hashes still describe the pre-draft merged
schema and must be remeasured if continuation is authorized. New TypeScript and
characterization tests remain uncommitted and unproved. The latest workspace
package build passes; the prior complete API refresh predates the settlement
constructor addition and is stale. No new PostgreSQL, time-zone, transfer,
handover, cold-consumer, lint, policy or secret-scan completion is claimed for
this draft. The earlier merge checks are separate evidence. Native review
cycles used: zero. No native review, canonical verification, push or PR ran.

The source trace also missed the deferred order line-sum guard. The draft adds
an atomic settlement projection using existing item INSERT/DELETE and shipping
adjustment INSERT privileges; new retained snapshots require a supplied
transaction runner. That route still needs real-PostgreSQL rollback, replay,
charge and independent invoice allocation proof. It changes no guard function,
grant, dispatch ledger or schedule-advance SQL. No code writes
`supersededByStableJourneyKey` or `checkoutAbandoned` and no dispatched-attempt
location is added.

Self-retro: the first real full-row pack exposed code growth above the source
estimate before spending on the full proof matrix. The reference trace should
have included the deferred order constraint and transaction wiring as well as
the all-in intent amount. Continue only after the supervisor resolves the size
stop; do not infer a budget increase from this record.


## Resumed build: size decision and absorption classification blocker

The supervisor accepted the prior measured 16,277 / 10,788 byte packed/code delta
and set new per-row stop lines of 19,000 / 12,500 bytes against the same pinned V.
No cap change is assigned here. The inherited package code cap is 2,054,458 bytes;
the later programme value is separately coordinated. The earlier size stop is
resolved, and its evidence above is historical rather than an active limit.

The complete scanner/subscription run executed: 2,195 cases passed, 17 failed,
2 skipped; five files failed and one was skipped. Four affected scanner suites
encounter the anticipated inherited class-data refusal; the package-artifact
case also found that the new module was not yet tracked. Intent tracking is now
present; no rerun or waiver is claimed. Complete API reports were refreshed again
with the settlement constructor addition. Five real PostgreSQL schema inventories
were measured for the actual new SQL and the canonical/generated manifests and
three live test/handover hashes updated; historical inventory pins were retained.

The new installed-consumer restricted-runtime PostgreSQL suite executed ten cases
in the default zone with a fresh empty npm cache: five passed and five failed.
The three configured threshold boundaries charge exactly once and replay without
writes. The settlement case proves missing-transaction refusal, fault rollback,
replay and one shipping adjustment. Registration preserves a sub-millisecond
instant across opposite session zones and rejects changed facts. The graduation
case passed its cadence/line/price/anchor and third-charge assertions but failed
its final comparison of an unbound preclaim snapshot with the destination-bound
stored snapshot; the case remains failed and needs its witness corrected.

The mandatory absorption cases expose an owning-boundary gap: the full current
chain introduces `commerce_destinations.client_id` as a foreign key to clients,
but has no `client_absorption_policy` classification for that table. The existing
absorber deliberately rejects any unclassified referencing table before checking
the populated block tables, even for an otherwise empty lead. All four new
absorption cases therefore refuse naming commerce_destinations. The three exact
assigned policy rows are present and are not enough for this full-chain witness.

Implementation stops for an owner disposition and its exact prior class/data
approval. No fourth policy row, grant, routine replacement or other row's forward
was added. A retain disposition would avoid table DML; block or carry also needs
its bounded access implications assessed because destinations revoke direct
service access. This is source analysis, not an additional observed 42501. No new
qualified-runtime 42501 limit was encountered. Existing named limits retain their
scope; none is silently closed here. No review, canonical verification, push or
PR ran. Native repair cycles used: zero. Non-SQL work remains uncommitted and
SQL/pins remain staged; the full proof matrix remains pending this stop.

Self-retro: full-chain absorption must enumerate the live client foreign-key
census, including tables introduced earlier in the train, rather than assuming
that the three assigned policy rows close it. The refusal test found this before
any unapproved policy or privilege change. Preserve that fail-closed witness and
route the disposition to its owner instead of inventing one in a fixture.


## Resumed build: pending predecessor policy fixture and access limit

The supervisor assigned the missing destination classification to the predecessor
row. The real full-chain absorption case remains unchanged and expected red until
that row lands. Only the three populated block variants now insert the authorized
scratch block classification, labelled pending predecessor policy integration;
each removes only its own fixture row in finally. No fourth forward INSERT or
grant is introduced. The graduation mismatch was solely the test comparing an
unbound snapshot to the destination-bound stored one. It now verifies binding
and fingerprinting, then exact frozen replay, without changing production code.

The repeated default-zone installed-consumer suite ran all ten cases in 16.92 s:
six passed and four failed. Threshold boundaries, charge-once replay, projection
rollback/missing transaction/no double shipping, registration precision/conflicts
and graduation now pass. The empty-lead full-chain case retains the known missing
classification red. All three scratch-classified block cases expose an additional
pre-existing restricted-runtime boundary: the invoker absorber counts rows in
commerce_destinations, while the predecessor revokes ALL direct service-role
access to that table. PostgreSQL returns permission denied for commerce_destinations
before any assigned block refusal is reached. New qualification-limit name for
supervisor registration: F-QUALIFIED-ABSORPTION-DESTINATION-COUNT. No grant or
alternate fixture privilege is added; the owning boundary needs its own repair.

Complete API check, focused ast-grep and both neutrality checks pass in this
continuation. The UUID comparison audit identifies the single already-corrected
schedule spelling comparison; the restricted boundary matrix supplies uppercase
UUID witnesses. The named commit remains pending because the build stops at this
new access blocker. Source/forward SQL and its staged identities are unchanged.
No new final pack, strict typecheck, lint, full proof-matrix completion or DCO
commit is claimed. No review, canonical verification, push or PR. Native repair
cycles used: zero. Private packets preserve exact current identities and results.

Self-retro: an absorption classification and the permission needed to evaluate it
are one operational boundary. The authorized scratch classification demonstrated
that the earlier fail-closed missing-policy refusal had masked a second upstream
limit. Preserve both failures and route the bounded access repair to that owner;
do not turn the witness green with a grant or a different policy disposition.


## Resumed build: predecessor absorption ownership and lock-order stop

This section supersedes the preceding stopped status. The supervisor assigned
both the destination classification and its narrow count access to the same
predecessor repair. The earlier proposed independent qualification-limit name is
withdrawn. The four absorption cases are unchanged: one missing classification
and three restricted count permission failures. No grant, policy, fourth data
statement, skip or owner-executed absorption was introduced.

The default-zone matrix completed in 138.74 seconds: 226 passed, seven failed.
The catalog passed all 136 cases in both role modes; consents, original purchase
registration, retained-method compatibility, connected transfer, qualified
composition, restricted restore and released-schema upgrade passed their selected
suites. Four failures are the assigned upstream absorption reds. The other
failures are the concurrent sub-millisecond renewal deadlock, the new graduated
arrival assertion and the new paid-shipping transfer case. These are not waived.

A separate two-session restricted-runtime diagnostic completed in 16.68 seconds
and asserted exactly one SQLSTATE 40P01. Claim holds the subscription before
locking the renewal operation; prepare holds that operation before inserting a
cycle whose subscription foreign key needs the subscription lock. Both SQL
paths are inherited unchanged from the pinned predecessor. The original
concurrent renewal witness exposed the same deadlock. This is a new mandatory
proof blocker for the supervisor; no SQL replacement, grant, retry or lock-order
workaround is added here. The temporary diagnostic source is retained privately
and removed from the public test tree.

Paid shipping also makes commerce_order_adjustments nonempty. The finite
connected-store profile currently rejects that table. The binding transfer rule
already assigns additive coverage of a newly written existing table to this
row; that addition and its owner read remain pending. It is not a request to
expand unrelated transfer behavior. The graduated arrival assertion needs its
fixture/admission sequence checked; it is not established as a product defect.

All five strict typecheck projects passed in 32.94 seconds after correcting
fixture literal types. The package build and all 181 subscription unit cases
passed. The remaining two zones, solo timing proofs, final lint/scanners,
handover, cold consumer, final pack, zero-unanswered documentation policy and
DCO commits remain unfinished. The last complete API check predates this stop;
no final-candidate claim follows from it. No review, canonical verification,
push or pull request was started. Native repair cycles used: zero. The current
work and SQL bindings are staged for recovery, without a feature commit.

Self-retro: the required unchanged race witness found an inherited lock-order
problem that successful sequential money cases could not expose. A small
two-session diagnostic established the mechanism without adding retries or
changing SQL authority. Check the binding transfer rule before treating a newly
written existing relation as an authority gap; its additive owner-read route
already exists.

Scanner admission update: future full script scanner sets require the dedicated
scanner lane and the official toolchain first on PATH. The earlier full set was
run before that lane was required (2,195 passed, 17 failed, two skipped); its
observations stand, but it is not a final passing scanner proof. No full set was
running at this handoff, and no interrupted full set is counted as complete.




## Continuation: upstream race disposition and local proof repairs

The supervisor confirmed the inherited claim/prepare race and assigned its
repair through the lead. Its unchanged concurrent test joins the four upstream
absorption cases as a known red; no retry, lock change or SQL replacement is
authorized here. The private deterministic diagnostic remains evidence.

This row now adds commerce_order_adjustments to capture and restore, retaining
immutable shipping row identities after their orders. The relation's promotion
foreign key does not add promotion tables to this finite profile. The graph
count is 112; the same inventory and existing handover assertions remain. The
new graduated-arrival fixture now admits the following due cycle to establish
its outstanding parcel case before recording the actual arrival. Production
alignment logic and replacement confirmation remain unchanged. Proof is running.


## Continuation: completed local repairs and new proof boundaries

The additive adjustment capture/restore and graduated-arrival fixture now pass.
The latter opens the outstanding parcel case through renewal admission before
recording actual arrival; no production alignment routine changes. Default
selected PostgreSQL suites pass 249 cases with only the four upstream absorption
reds. The inherited concurrent replay race remains an unresolved known red even
when a particular run passes. No original replay test, retry or lock changes.

All 21 retained-renewal cases ran solo. The 17 business/refusal cases passed;
the four upstream absorption cases retain their assigned causes. The paid-
shipping retained transfer took 6.21 seconds solo. Additional consent, transfer,
composition and upgrade cases were measured alone. The adverse default-ACL
consent witness needed its canonical upgrade applied in its own setup; previously
it relied on the preceding upgrade case to create the tables. That fixture
repair preserves all existing refusal and catalogue assertions and passes solo.
Measured case bounds are explicit; no skip or assertion weakening is introduced.

The default retained offline consumer passed on a tarball byte-identical to the
official measured pack. Handover reached its existing readiness outcome with
one fenced uncertain operation in 101.92 seconds. Strict typecheck, complete
API, built exports, structural checks and both neutrality checks passed. Full
lint passed with zero errors; it is being repeated after the fixture/time-bound
changes. The measured package delta is 17,009 packed and 11,029 code bytes,
absolute 2,497,788 packed and 1,990,331 code. No cap was edited.

Mandatory scanner comparison is blocked by the shared scanner detector matching
an idle shell wrapper that contains the full scanner command while that wrapper
waits for scanner admission. Its first bounded wait timed out after 542 seconds;
the required retry followed. No full candidate or baseline scanner set started.
The durable detached predecessor scratch worktree and its own dependencies/build
are ready. The gate and the other process remain untouched.

The broad zoned run also exposes two unchanged connected-transfer assertions
that compare session-zone output with UTC text. The same typed instants retain
microseconds. The assertions and production transfer logic remain unchanged;
they need a supervisor disposition under the unchanged-existing-suite rule.
An extended GMT+9 cold run similarly reaches an unchanged bootstrap transfer
fixture's UTC wall-clock regex; default cold proof passes. No all-zone cold
consumer success is claimed. These observations are distinct from the five
already assigned upstream known reds.

The first broad zoned batch also overlapped writes to the shared installed
consumer directory despite the CLI worker limit. Its two install/import setup
failures are invalid proof attempts, not product findings. New renewal, consent
and catalogue zone proofs are rerunning as separate file invocations with the
existing explicit worker environment and fresh install caches. The finite build
remains staged without feature commits while required scanner and existing-
fixture evidence is unresolved. No review, verify, push or pull request.

Self-retro: use the documented worker environment and separate invocations for
fixtures sharing an install directory. A CLI worker flag alone did not serialize
these project workers. Solo proof also exposed the consent refusal's hidden
setup dependency; applying its actual canonical upgrade closes that dependency
without changing the security assertion. Do not bypass a blocked shared gate
or silently normalize a zoned proof back to UTC.

The separate file invocations now prove the new retained-renewal, original
renewal/purchase, consent and catalog paths under both nondefault zones, with
only the four assigned absorption reds. The original lock-order race test was
unchanged and happened to pass these invocations; its independent confirmed
defect remains unresolved. The two zoned connected-transfer assertion failures
also reproduce on the exact predecessor in the durable scratch baseline. They
are pre-existing presentation expectations, not a new shipping transfer loss.
Final lint again has zero errors, and the complete strict/API/export/neutrality
checks passed after the fixture repair. Project-configured gitleaks passed the
staged delta and the full retained WIP history; an earlier unconfigured
diagnostic had only historical synthetic-fixture hits and is not a project gate.
Required scanner admission and disposition of the unchanged zoned assertions
remain prerequisites to feature sign-off and the named UUID commit.

Final stopped state: the remaining GMT-5 composition, restore and upgrade
proofs pass. Its transfer suite has the same two UTC presentation failures as
GMT+9; both are reproduced on the predecessor. The full scanner request never
received admission over more than twenty minutes; its own pending request was
cancelled for this owner stop, without starting a partial set or changing the
shared gate/other process. Both required full scanner runs and their comparison
remain outstanding. All local code and fixture repairs are staged; the SQL
forward and co-located pins are intact. No new feature commit is made while
these mandatory proof boundaries remain unresolved.


## Build completion awaiting the SQL read

This section supersedes the preceding stopped statuses. The supervisor resolved
the scanner detector and assigned the unchanged zoned assertions to a main
follow-up. Both complete scanner sets ran after separate scanner admissions,
on the official runtime, against the same 58 top-level scanner files. Candidate
and exact predecessor each report 1,254 passing, 16 failing and one existing
skipped test. Every failure is the same qualified-admission class/data refusal;
all sixteen normalized failure messages match exactly. No new scanner failure
is caused by this row, and the trusted checker or class was not weakened.

The canonical UUID fix is committed separately as b8e0a235, with the standalone
restricted installed-runner witness. It settles once and replays without writes
under default, GMT+9 and GMT-5 sessions. The existing concurrent lock-order race
case remains byte-for-byte unchanged. This feature commit carries the retained
pricing/shipping, atomic graduation/projection, additive adjustment transfer,
consent preservation, API reports, documentation and measured test bounds.
The forward and its four co-located bindings remain staged for coordinator read.

All required local implementation checks have completed. Strict source checks,
complete API, built exports, structural checks, both neutrality checks, module
suites, restricted renewal/consent/catalog zone proofs, retained consumer and
handover retain their recorded results. Final lint has zero errors. Published
package bytes remain identical to the measured/cold-tested artifact: the delta
is 17,009 packed and 11,029 code bytes against the pinned predecessor. No cap
change is made here. Scoped documentation explanations are carried in the new
signed commit trailers; policy, range gitleaks and DCO are checked after signing.

Known reds remain four absorption cases owned by the predecessor repair (the
restricted count closer is qlock-3), and the renewal lock-order defect assigned
to the renewal owner. The pre-existing zone-rendering assertions are preserved
with their owning main commits in the private packet. The adverse-ACL fixture
now applies its real upgrade independently; all original refusal assertions
remain. No grant, policy, fourth absorption row, retry, lock change or skip.

Delivery authority remains local signed commits and a stabilized private SQL/API
read packet. No native review, canonical verify, push, pull request, merge,
publication or adopter switch is performed. Restack on the final frozen
predecessor and the complete first-review route remain later supervisor steps.
Native repair cycles used: zero. No OMS supersession/abandonment flag or new
dispatched-attempt home is added.

Self-retro: independent admission plus an exact baseline distinguished inherited
class/data refusals from new defects. The source-normalization bug needed one
comparison change and a real installed-runner witness; no UUID abstraction or
control change was necessary. Keep the measured published bytes fixed while
finishing evidence and local sign-off.


## Combined candidate after renewal integration

The current delivery combines native order notices, paid shipping, payment
recovery notices, retained renewal terms and account communication choices in
one candidate and draft pull request #534. The exact review and documentation
predecessor is `84f146305d99cf3f30831ab1cc6fb65de1ffe1ca`. The policy revision read for
this continuation is main `76d8a415a5bb96331e5f81832670138df17b2536`.

The assigned worktree now uses `codex/oss-m19-g8`. The authorized delivery covers
the signed predecessor merge, measured inventory and literal regeneration,
complete caller and pre-review checks, two fresh full reviews, exact-tree local
verification, draft fast-forward publication and the existing landing command.
The source behaviour, SQL statements and public API remain bound to their
accepted reads. A needed SQL, API or TypeScript change returns for the lead's
read. An open material review finding returns to the owner.

The integration keeps both renewal test sets byte-for-byte, the predecessor's
240-second qualified bounds and 40-second released-upgrade bound, and the
historic schema pins. Five current inventories were derived on PostgreSQL
through the canonical projectors. The merged installations contain 98 legacy,
102 qualified-v2 and 101 qualified-admin migration units. The transfer graph
contains 112 tables. Current-main class and co-location checks pass, including
all three native forwards and 17 recomputed function preimages.

The remaining acceptance before review is the complete gated scanner set,
caller sweep in three PostgreSQL session zones, composition, handover, catalog,
static and package checks, and the cumulative package checkpoint. The combined
packed delta must fit 32,500 bytes and the absolute code measure must leave at
least 10,000 bytes below 2,055,017 bytes. Native review, final verification and
landing follow only after that evidence is complete.

Self-retro. Preserving the selected migration order and recomputing the current
inventory keeps an integration from rewriting historic schema expectations.

## Combined candidate after native fulfillment-read integration

The current combined delivery is based on main `313eda258c8a8afa90e053623dea91922d1a2baa`, integrated by merge `dd9e7080295c0fb8a8678a641a99082a9a363029`. No stack pin applies to documentation, native review or verification from this point. The merge is the exact conflict-free Git merge-tree prediction; API regeneration adds no changes and the catalogue is the exact sorted union. The approved combined scope and remaining review and delivery gates continue to apply, including the explicit train-front check before landing.
