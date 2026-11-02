# Native account consent choices

Status: blocked by two failures in the unchanged existing native communications suite.
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

## Existing-suite compatibility check

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
