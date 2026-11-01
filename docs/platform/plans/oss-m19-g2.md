# Native purchase renewal attachment (G2)

Status: function-only ACL revision locally proved; the latest evidence is in
that section below, with earlier source anchors retained as history. Admission
prerequisite and stabilized read still block delivery. No DCO sign-off, native review, canonical verify, push or
release is claimed. The supervisor explicitly authorized local SQL/manifest work
and unsigned WIP commits while the prior control is decided separately.

Outcome and scope: qualified-v2 purchase activation leaves a durable attachment
duty, a bounded runtime writer creates renewal terms, term lines and real sandbox
method state, and public subscriptions exports provide a production frozen codec
and no-key renewal rail. This is G2 only: P15, R02, R03, R06, A50. G7, destination
production, stock-hold changes, price authoring, new payment-attempt storage and
real PSP/mandates remain excluded. The dedicated worktree is `oss-m19-g2`, branch
`codex/oss-m19-g2`, with forward slot `20261101223000`. The supervisor controls the
ordered delivery route; no publication, production, secret or settings grant is
used. The stabilized API/security read and normal signed review remain later
human/delivery gates. Local repair cycles consumed: zero native cycles.

## Design and acceptance

Purchase facts are explicit trusted host inputs, not a browser assertion that
money moved. Registration saves the complete facts on a declared order; accepted
facts are immutable on replay. Captured activation keeps its existing signature,
paid-order check and settlement fingerprint comparison. Its unchanged invoker
commit helper additionally captures an attachment obligation in the activation
transaction. Completion is a **separate durable obligation**, atomically creating
header, lines, initial method evidence/state and its completion marker. A failure
leaves service active, no partial renewal rows, and an enumerable pending duty.
The convenience wrapper requires independently committed executor queries rather
than an enclosing transaction. Missing facts require host resubmission; otherwise
another worker can complete from the database alone. There is no added scheduler.

`createNativeRenewalCodec` uses revision `native.purchase-renewal.v1`: sorted-key
JSON, array order retained, UTF-8 SHA-256 excluding only the fingerprint field.
The full nested port snapshots coexist with required flat native SQL fields.
The original retry/attempt counters are zero. Logical cycle correlation requires
an actual paid activation cycle and paid-cycle count matching the native counter;
incomplete history refuses freezing. Template identity comes from saved purchase
facts; native template version, cadence, lines, client, schedule, money and authorization come from durable
rows. Current method health is checked separately from frozen authorization.
No `_host` metadata persists. Database snapshots precede mutable current terms.

Sandbox success, decline and ambiguity reuse the existing prepared operation and
external ACK fence. Sandbox observations use reserved keys in the existing
outcome ledger; incumbent settlement still owns money/schedule/counter changes.
No new attempt record or provider connection exists. A fresh process observing
ambiguity never calls execute, even with a changed scenario configuration. A
matching late observation can complete that same operation. Wrong identity,
fingerprint, money or conflicting observation refuses.

Method health starts healthy only with saved sandbox method/evidence. The bounded
transition writer compares expected state and immutable event input; it supports
missing, pending, unchargeable and healthy states without changing service status.
A financial decline alone does not claim a method disappeared. G7 must exercise
actual unhealthy state, refused recovery authorization, a repair with fresh method
evidence, then authorized recovery; this run does not claim that joined repair.

## Sufficient executed evidence

`tests/postgres/subscriptionPurchaseRenewal.test.ts`: eight cases PASS using
real PostgreSQL 16 and public exports resolved from installed core/platform
**tarballs**, with restricted runtime login assuming its installed service group.
The test verifies that effective role is neither superuser nor BYPASSRLS. The
canonical selected SQL source and installer seams supply the chain; this is not
an npm-only installer qualification. No test grant or elevated business fallback
is used. Catalog and prices are explicit install-time seed fixtures. Client and
stock use production public writers; settings are not hand-written. Terms, term
lines and method state are produced only by G2 writers.

The cases discriminate changed/malformed/unsupported inputs, browser permissions,
concurrent materialization, writer loss, PostgreSQL lock-induced rollback with no
partial rows, completion in a fresh process, frozen-byte roundtrip and tampering,
a real database/container restart followed by fresh-process decoding, success,
decline/dunning, terminal replay limits, ambiguous fresh-process resume without
redispatch, and matching/conflicting late observation. Service remains active.

Strict `oss:published-tree -- --typecheck` PASS after fixing seven test-fixture
annotations; structural ast-grep PASS. Full lint PASS with 33 pre-existing
warnings and no errors; API declaration snapshots are refreshed and checked.
Documentation requires two scoped no-impact trailers for the manifest and source
routing; module/data owners are substantively updated. No full verification or native
review has run. All five selected manifest inventory shapes were measured on
fresh real databases through their actual migration session/profile: legacy,
qualified bootstrap/separate migrator, and both qualified-admin role modes.
Administrator measurements are schema evidence, not business qualification.

## SQL, controls and preservation

Forward: `db/platform/migrations/20261101223000_subscription_purchase_renewal.sql`.
New attachment and method-event tables; nullable method reference/evidence columns;
six bounded definer routines with `search_path=pg_catalog,pg_temp`; one invoker
sandbox-observation routine with the same pinned path; native activation-commit
replacement with identical header/attributes. Only function privileges are
changed: seven separate PUBLIC revokes, then one constant-string conditional ACL
block per role/verb (anon REVOKE, authenticated REVOKE, service_role GRANT).
Neither new table exposes any direct runtime/browser access, including reads. Existing term-line INSERT/DELETE grants stay because the
incumbent `subscription_command_apply` replaces that collection as an invoker.
No role, policy, trigger, explicit index, backfill or attempt table is added.

Risk assessment: no fiscal issue path is added; duties remain pending until
completion, rather than disappearing or resetting; completion and method events
are atomic and replay-compared; operation fingerprint/ACK and terminal fences
remain incumbent. Snapshot validation/correlation prevent invented cycle history.
The definer alternatives would require raw header/method/fact/event write grants;
all objects and input bounds are fixed and calls use qualified names. No payment,
dunning or parcel work runs inside attachment materialization. Failure never
changes subscription service state. The separate control must admit the exact
inventory; no control checker, class rule, existing approval or registry pin was
modified. Initial direct admission refusals remain in worktree scratch.

Managed check: no managed migration defines the changed native objects. The
separately owned adopter main uses the activation RPC in its direct-Postgres
adapter, and native renewal tables in its direct-Postgres adapters; no managed
migration/server caller was found. Its SQL copy and adapter are unchanged.
R0 has not landed at the inspected main; packaged SQL and migration descriptors
remain its ownership and were not edited here.

Known limits: successful public-run replay raises
`subscription_renewal_claim_not_due`; G7 owns that fix. Destination refs remain
null until G3/G7. Whole-day lateness extension is unqualified. The existing
checkout-compensation RPC refuses the runtime on `commerce_checkout_compensations`;
this unrelated grant gap is observed, not repaired. G5 quote/draft inputs and G6
capture/method/authorization facts remain labelled fixtures until the joined proof.
There is no real PSP, mandate, default runner or served managed-rail change.

OMS: no `supersededByStableJourneyKey` or `checkoutAbandoned` writer. Dispatch stays
on existing `subscription_renewal_operations.state/external_attempt_ref` and ACK
time; sandbox evidence is appended to existing `subscription_renewal_outcomes`
with `sandbox-observation:<operation-id>` keys. No new dispatch/attempt table.

Real `npm pack --ignore-scripts --json` comparison against the same base:
platform 2,102,771 → 2,117,302 B packed (+14,531 B), 2,840 → 2,849 files (+9),
9,809,502 → 9,865,453 B unpacked (+55,951 B). The soft 12 KB target is exceeded
by about 2.5 KB; no cap changes are proposed. This measures code/declarations and
package docs. R0 still owns the not-yet-added SQL/manifest package projection,
so its subsequent integration must account for that separately.

Remaining estimate after local proof: 0.5–1 working day for read, admission integration and
ordered review/delivery, excluding the separate control and adjacent-row waits.

Self-retro: the first run treated admission as a local-work stop; the supervisor
clarified the boundary. Behavioral proof then found due-row extras retained in a
frozen snapshot and seven test annotations, all repaired. The initial restart
fixture stopped container PID 1; the simpler proof restarts its owned container
with PGDATA outside tmpfs and refreshes the endpoint. Snapshot testing through
process-control tricks → restart the owning disposable container with retained
data. No native retry budget was spent or reset.

Focused resource waits: 183 seconds for the first admission; the final wait
timed out after 558 seconds and admitted after another 64 seconds. Scratch
measurement helpers initially added two lint errors and were corrected without
ignore changes. Inline fresh-process tests pass their inputs in a test environment
packet; no standalone executable or execution-control change was introduced.

The staged secret scan flagged a synthetic stock fixture request key; it was
replaced by an unmistakable fixture label without changing the scanner or an
allowlist. No WIP ref had been created at the time of that refusal.

Final local handoff: READY_FOR_REVIEW as an unsigned WIP, with admission blocked.
The implementation/proof anchor is `ac5f3821d12ca30da895778fe687130f9f629eac`,
tree `683364448f735440cf82f99d47ea4c22fc761712`. The final evidence-only task
summary changes no implementation, test, SQL, API or packaged bytes.
Publication/documentation policy PASS: three obligations, zero unanswered, with
both scoped trailers accepted. Targeted admission on that committed source
refused the forward as `non-expand-only forward differs from reviewed replacement
path or bytes`, the expected separate-control blocker. No pin or checker was
changed. Staged and WIP-commit gitleaks scans PASS. Full verify, DCO sign-off,
stabilized human read and native review remain unperformed by instruction.


## Function-only ACL revision

The supervisor requires function-only privileges under the closed forward class.
The prior local proof/pack and source anchor above are historical evidence. This
revision passes nine installed-tarball PostgreSQL cases, including actual runtime
and authenticated SELECT/INSERT/UPDATE/DELETE refusal on both new tables, all
seven effective table-privilege checks, and denial of both bounded readers to
authenticated. Existing money, replay, lock rollback and restart proofs stay green. It removes all
GRANT/REVOKE statements on the two new tables, retains their default owner-only
access, and adds bounded pending-duty and completed-snapshot-field readers.
Correlation instead reads existing activation rows, and method readback reads
existing method/term rows. The method-event ledger needs no runtime read at all.
Every new function has its own PUBLIC revoke; three trailing constant EXECUTE
blocks revoke anon/authenticated and grant service_role by the prescribed shape.
The replaced activation helper keeps its ACL. No signature outside G2 is touched.

Size review: the three new production modules produce the nine new package files
(source, emitted JavaScript and declarations per module). The codec schema/wire
translation, purchase writer/convenience wrapper, and durable sandbox rail drive
the old +14,531 packed bytes; documentation and existing-entry changes add the
rest. The activation convenience wrapper is a possible acceptance-preserving cut
if the host composes register, the unchanged activation RPC and completion with
the documented independent transaction/failure handling. It has not been cut;
its host-composition tradeoff and measured size are reported for a supervisor
decision. Required frozen validation, ambiguity fencing and durable writers are
not proposed cuts.

Current ACL revision checks: full lint PASS with 33 existing warnings; strict
published-tree typecheck PASS; API snapshots PASS without a public Node signature
change; structural scan PASS. Literal ACL-shape assessment PASS: seven PUBLIC
revokes, three exact constant-string role/verb blocks after them, zero table
privilege statements. Five fresh manifest inventories were remeasured with this
forward. No registry pin, admission rule, default privileges or role changed.

Current real pack: 2,117,288 B packed, 9,865,670 B unpacked, 2,849 files. Against
the same baseline: +14,517 B, +56,168 B unpacked and +9 files. Against the prior
G2 pack: -14 B packed, +217 B unpacked and no file-count change. SQL projection
still belongs to R0 and is excluded from these package totals.
The prior +9 files were source/JS/declarations for exactly three modules:
codec 23,574 unpacked bytes, sandbox rail 16,579, purchase writer 10,551; existing
README/context/entry/store changes added 5,247 bytes, totaling +55,951 unpacked.
Whole-tar gzip compression is not additive per file, so these are content costs,
not invented exact shares of the +14,531 packed-byte delta.
The convenience wrapper contains about 3,102 raw bytes across its three emitted
forms (836 B standalone gzip, an estimate rather than a pack saving). Removing
it would retain the bounded writers and unchanged activation RPC but require
host composition and the same failure/isolation proof. Consolidating the small
writer into the existing store could remove three packaging artifacts with
little byte saving. Neither cut is applied; no validation, fencing or durable
state is proposed for removal.

ACL-revision self-retro: the method-event ledger required no runtime read and
method/correlation reads already had existing owners. Expose only pending IDs
and the three consumed snapshot facts through fixed readers, rather than copying
a prior forward's table grants. One focused admission waited 122 seconds. Native
repair cycles remain zero; G7 was not started and no DCO sign-off is present.

## Table narrowing and measured size revision

The supervisor's newer narrowing direction supersedes the function-only ACL
revision above. Both new tables revoke all access from PUBLIC and conditionally
from anon, authenticated and service_role, covering installer default grants.
There is no table grant, RLS change or new function signature. Function ACLs and
the replaced activation helper's existing ACL remain unchanged. The existing
expand-only parser refuses explicit ON DELETE RESTRICT even though the CHECKs
pass. New foreign keys now use default, nondeferrable NO ACTION; referenced
parents remain protected without a control change. A separate
PostgreSQL database fixture creates the same table names under broad table
defaults, then executes the slot's exact table-narrowing tail and checks all seven
privileges plus actual restricted reads. The money-flow database still receives
only the production installation and its existing runtime capabilities.

Both size options were built and measured with real npm packs under pinned Node
24.21.0/npm 11.19.0. The scratch-only projection adds exactly this SQL file under
the existing sql/ package directory; R0's tracked package projection remains
untouched. Actual current pack: 2,117,330 B, 9,865,798 B unpacked, 2,849 files.
With SQL: 2,121,324 B, 9,887,451 B unpacked, 2,850 files. Against the original
2,102,771 B / 9,809,502 B / 2,840-file baseline, the inclusive G2 delta is
+18,553 packed B / +77,949 unpacked B / +10 files. SQL adds 3,994 packed B
and one file to the current code pack. This is a real scratch-projection pack,
not a claim that R0's packaged migration descriptors have landed.

Without the convenience wrapper: 2,116,457 B code-only / 2,120,374 B with SQL;
savings 873 B / 950 B, no file-count reduction. Consolidating the writer into
the existing store: 2,117,000 B code-only / 2,120,932 B with SQL; savings
330 B / 392 B and three fewer files. Neither meets the supervisor's 2 KB
threshold, so both experiments were reverted. Public host composition, the
convenience wrapper and all acceptance behavior remain intact. Reports and all
six tarballs are under .context/scratch/g2/size-narrowing/.

Ten installed-tarball PostgreSQL cases PASS (12.97 seconds), including default
grants, no direct access for the restricted runtime/authenticated, all existing
money refusal/replay/ambiguity/late outcome cases, frozen decoding and database
restart. Foreign keys are verified as nondeferrable NO ACTION. All five schema
inventories were remeasured on PostgreSQL and the local manifest refreshed.
The source-shape assessment passes both CREATE TABLE statements through the
unchanged expand-only parser and verifies two PUBLIC table revokes, three table
revoke blocks, seven function PUBLIC revokes and three function ACL blocks.

Self-retro: the size proposals saved less than 1 KB each in real packs, so
retaining the existing public composition is the justified simpler result. The
focused gate waited 127 seconds. A direct Node invocation of the existing
inventory helper could not resolve source .js imports; using the existing tsx
loader resolved it without changing production code or controls. No native
repair cycle was spent, G7 was not started and no DCO sign-off is present.

Final generated owner excerpts are included in these packs. Generate those
excerpts before size comparisons to avoid repeating the measurement for doc
bytes; they added 51 packed bytes to the earlier inclusive figure.

Final focused checks: full lint PASS (33 existing warnings, zero errors), strict
published-tree typecheck PASS (zero unresolved edges/consumer errors), API
snapshots PASS unchanged, structural scan PASS. The old no-impact configuration
digest became stale with this SQL revision; the new scoped trailer binds the
remeasured manifest delta. Generated owner excerpts are refreshed. The separate
admission control and stabilized security/API read remain outstanding; no
registry or review control was changed. Full verify and native review remain
unperformed under the supervisor's stop instruction.


## Connected transfer continuation

The supervisor adds the three G2 data-bearing tables to the finite native
capture/restore profile in this PR: subscription_renewal_attachments,
subscription_method_state_events and subscription_method_states. Only additive
entries in those root adapters are authorized. The SQL identity is frozen.
A real-PostgreSQL proof must capture writer-produced rows, restore a clean
installation and demonstrate renewal and pending-duty completion. The owner read
includes customer-linked reference contents and transfer limits. These are root
adapters; real pack comparison must prove zero additional package bytes.

The native codec and pending-duty writer also consume subscription_activations,
which the first real capture proved absent from the finite profile. It is now
an explicit fourth additive entry, necessary for G2 activation/renewal continuity;
it changes no SQL or function list. Its owner read is included in the same packet.
Stock can be
supplied after restore through the existing writer for this bounded row's proof;
whole-journey inventory continuity remains the joined transfer proof.

The connected-transfer suite now passes nine cases on actual PostgreSQL
(58.08 seconds): both new G2 tables, method state and activation lineage survive
whole-row capture/restore comparisons, exact restore replay preserves them,
a pending duty completes and replays through the restricted writer, changed
purchase facts refuse, and a restored completed subscription renews successfully
through the production codec and no-key rail. Closed new-table reads still refuse
under the restored runtime. Terms and term lines written by G2 also compare
exactly and supply that successful renewal. No schema failure on either new
table occurred. This continuation changes no SQL, manifest, grant or signature;
the forward SHA-256 remains
2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34.

The four owned entries are inserted additively; restore places method state after
subscriptions and activation/attachments/events after their order parents. The
existing retained-order fixture isolates the G2 obligation from G5's checkout
receipt profile: an initial full draft-writer attempt correctly refused unknown
commerce_order_draft_receipts. That table remains G5/joined-proof work. Every G2
attachment, method row and method event is produced by its real runtime writer.
Current stock is supplied after restore through the public stock writer; stock
history transfer remains joined-proof scope. The source includes an explicitly
synthetic delivered parcel, carried through transfer; runtime renewal uses the
existing alignment admission routine and retains the enforcing source policy.
No undelivered replacement is confirmed. G7's replay/repair work is untouched.

Transfer owner-read assessment: purchase_facts contains commercial lines/prices,
template/cadence/currency/stock source, authorization time, and authorization,
payer account, method, method-evidence and acquisition references. Method state
contains subscription linkage, health, narrow activation gap, time and nullable
method/evidence references. Event input stores expected/new health and the same
method/evidence references; host event keys may identify a customer as well.
Activation lineage includes customer/order/subscription IDs, state/times,
cadence, replay keys and a payment fingerprint. These are customer-linked
payment metadata. Sandbox channel and field shape/length are enforced; synthetic
or nonpersonal string contents are not. Identifying-looking example.invalid
values deliberately prove this boundary in the fixture. No new privacy-erasure
or credential-exclusion guarantee is claimed for arbitrary host references.
Transfer preserves exact rows under the existing owner-controlled snapshot and
retention/erasure limits; it does not redact replay or frozen-snapshot inputs.

The real-PostgreSQL refusal test independently exhausts row and byte budgets at
each of the four added tables, and an oversized method-state packet hits the
existing 10,000-row restore cap before any target data changes. Nested lines in
purchase_facts and event input survive through PostgreSQL JSON text: registration
binds JSON.stringify(facts), and transfer binds one row string to jsonb at a time.
No JavaScript array is passed directly to a jsonb argument.

Real npm pack after the root-only additions is identical to the prior pack:
2,117,330 packed B, 9,865,798 unpacked B, 2,849 files, SHA-1
5ec26fc37a96a5c455beb6fa0c1cb17f023f72c1. File lists and tarball hashes match;
this continuation adds zero bytes and zero files. SQL remains identical, so the
inclusive G2 delta stays +18,553 B and +10 files. The previous two cuts remain
reverted under the supervisor's 2 KB threshold.

Self-retro: starting with the full checkout writer exposed an unrelated profile
dependency; using the existing retained-order fixture isolates this row while
preserving real G2 writers. The activation table is a necessary additional
transfer dependency, not a schema change. The enforcing alignment policy caught
a missing test preflight and stayed enabled after correction. The cap test's
readback needed consistent row sorting; its refusal had worked. Focused
admission waited 30 seconds. This work stayed below the few-hours escalation
threshold; remaining estimate is still 0.5–1 working day for read, control
integration and ordered review/delivery, excluding waits. Native cycles remain
zero; no DCO, native review or G7 work was started.

Transfer continuation checks: full lint PASS (33 existing warnings, no errors),
strict published-tree typecheck PASS (zero unresolved edges and consumer errors),
structural scan PASS and staged secret scan PASS. No package API/type/source
changed. The test-only documentation-impact trailer binds this finite extension;
there is no test-harness, selection, gate-budget or verification-route change.


## Accepted read and second activation caller

The supervisor relayed the coordinator's accepted DCO read for source b8787880,
tree 60181dfb, base bb000848, with the SQL frozen at
2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34.
Conditions: prove the paid-gap caller under its actual composition role; state
identifying-reference, absent erasure-path and zero-shipping limits publicly;
retain G4 ownership of checkout compensation; check the existing entry layout;
keep native review and control edits out of this run. Additive transfer-owner
README lines are included in that authority. A later SQL-byte change needs a
new read; no such change is made.

Production-role trace: api/cron/payment-provider-reconciliation.ts selects
resolveSubscriptionActivationBinding for node-postgres and calls its adapter's
reconcilePaidActivationGaps. server/runtime/customers/subscriptionActivationBinding.ts
opens DATABASE_URL directly, without DataGateway.asService or SET ROLE. Thus this
qualified profile's caller is its unswitched runtime login, not an assumed
service_role current_user. The new real-PostgreSQL case uses that production
binding over g2_runtime, observing current_user=session_user=g2_runtime,
rolsuper=false, rolbypassrls=false and inherited service-role USAGE. That installed
membership admits the nested bounded capture function without a new grant.

The isolated second-caller proof PASS (12.40 seconds): a writer-created captured
paid order has a provisional gap; purchase facts are registered; the actual
binding reconciles one row, activating repaired=true; its durable attachment is
pending and completion writes exactly one terms row, line and healthy method
row. Completion replay and a second reconcile add nothing. No hand-written
activation/attachment/term/method row, role escalation or elevated business
fallback is used. The forward's bytes and ACL remain unchanged.

Public subscription-owner limits now explicitly require opaque references,
describe identifying strings and absent privacy-lifecycle erasure coverage, and
require renewal shippingAmountMinor=0. The transfer owner repeats the reference/
erasure boundary. The known compensation comment points to G4. No new subpath
was added: all G2 exports remain at subscriptions/index.ts behind the existing
./subscriptions export and closed packageBoundary entry; implementation files
are internal modules. No layout change or additional layout read is required.

This run will squash the never-pushed unsigned WIP chain into a clean DCO-signed
candidate under the supervisor's explicit grant, preserving prior read/source
anchors in this record and the stabilized packet. No native review is started.
G7 remains design-only; its pending size decision is unrelated to this closure.

Final closure evidence: full installed-tarball purchase-renewal suite PASS
(11 cases, 17.25 seconds); connected-transfer suite PASS (9 cases, 55.90 seconds);
package boundary suite PASS (including the existing nested entry inventory).
Full lint PASS with the same 33 warnings and no errors; strict typecheck PASS
with zero unresolved edges/consumer errors; API snapshots PASS unchanged;
structural and documentation policy checks PASS (five obligations, no unanswered
item). CONTRIBUTING.md is unchanged and retains the scoped tests no-impact
trailer rather than unrelated prose edits.

Real final npm pack remains byte-identical to the accepted code pack:
2,117,330 packed B, 9,865,798 unpacked B and 2,849 files, SHA-1
5ec26fc37a96a5c455beb6fa0c1cb17f023f72c1. The real scratch SQL-inclusive pack is
2,121,324 packed B, 9,887,451 unpacked B, 2,850 files: +18,553 packed B,
+77,949 unpacked B and +10 files against the original baseline. This closure adds
zero package bytes or files. SQL SHA remains the exact accepted value. No cut
was applied, no cap changed and R0's tracked SQL projection remains untouched.

Closure self-retro: the original proof omitted the second activation-commit
caller. Tracing the cron binding showed that its actual caller is the raw
runtime login, whose installed inherited group rights matter. The new fixture
proves that whole production call chain and the durable duty before sign-off,
without widening a grant. Resource admission was immediate. Remaining work is
0.5–1 working day for the ordered control integration, native review and final
verification/delivery, excluding waits; none is claimed complete here.
