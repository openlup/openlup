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

### Compatibility correction: legacy terms without method state

The supervisor resumed this row after the renewal promotion exposed a regression
in signed candidate 1a7660ce99de6507754e691c78c721993ec4e6df. Its existing
subscriptionComposition PostgreSQL fixture is correct and remains unchanged.
The purchase writer always materializes a method row with terms, but retained
and legacy terms can exist without one; connectedManagedRetained projects terms
without a method row. Requiring healthy on the nullable LEFT JOIN silently
refused those subscriptions. Preserve the prior authorization behavior when the
joined state is absent; only an explicitly stored non-healthy state refuses.
The existing NOT NULL state constraint allows healthy, method_missing,
mandate_not_chargeable_unattended and pending_activation. No SQL, permission,
projection, fixture or API-signature change is required.

The finite correction is one authorization predicate, a separate real-PostgreSQL
purchase-method refusal witness and the public owner clarification. The direct
supervisor instruction authorizes a DCO-signed correction atop the existing
signed head, followed by a delta read naming both heads. No native review,
control/pin change, merge, push or publication is authorized in this run. The
forward must remain SHA-256
2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34.

Proof plan: run the unchanged 20-case composition suite, all existing direct
importer suites for the original changed production modules, and all PostgreSQL
subscriptions/public-reference binding importers including their case-helper
entrypoints. Stop and report any additional existing-suite failure before
fixing it. The new installed-tarball restricted-role witness uses the production
purchase and method-transition writers for each explicit unhealthy state;
assert a paired healthy purchase row first, then refusal before any provider
execution while service stays active. No legacy test or fixture is rewritten.

Cause of missed proof: the original new-writer tests covered healthy and
unhealthy rows, but never the absence of a row on existing terms. The selected
checks omitted the existing composition suite and importer consumers. Treating
that suite as a fixture disposition was wrong; its unchanged legacy projection
is required compatibility evidence. This correction expands existing-consumer
verification instead of changing the fixture to fit the implementation.

Correction proof so far: unchanged subscriptionComposition passes 20/20 with its
legacy terms/no-method fixture (SHA-256
96afefdf582ddc4c26e7b369f502076daf2a1cac1536dfb15bc20217a4bb67b4).
The new installed-package method-health witness passes 3/3, covering every
explicit non-healthy state under the restricted service_role with no superuser
or BYPASSRLS and no new grant. Each purchase first has one paired healthy method
and terms row; its bounded transition then causes authorization refusal, zero
sandbox execute calls and an active subscription. Existing test sources are
hashed before/after execution and compared to the prior signed candidate.

Real correction pack: code 2,117,345 packed B / 9,865,854 unpacked B / 2,849 files
(SHA-1 518dfca5e80e382dfd483e3cd6a9578a2db99c67); real SQL-inclusive scratch
pack 2,121,331 packed B / 9,887,507 unpacked B / 2,850 files (SHA-1
2d0547e9b7b330dba702a8d23cba685cc906ed61). Against the signed candidate this is
+15 packed B for code and +7 packed B including SQL, +56 unpacked B and zero
files. Against the original programme baseline the full row is +18,560 packed
B / +78,005 unpacked B / +10 files including SQL. Only the source and generated
JavaScript predicate add package content; the new regression test, owner prose,
task record, catalog row and change fragment are not packaged. The existing
subscription entry layout and declarations remain unchanged. No SQL byte,
manifest, control or grant changed. The correction restores legacy authorization
behavior without affecting the separately owned managed SQL chain.

Correction run stopped on the next existing-suite failure, as directed.
Unchanged m14RestrictedConnectedRestore.test.ts reports 0/15: every case fails
at line 79 before migration status/apply or restore, because
`expect(1 + manifest.forward.length).toBe(94)` observes 95 with this branch's
additional forward. This is an observed migration-count assertion, not evidence
about the later restricted installation/restore behavior. No test, manifest,
SQL, grant or control was changed to clear it. The remaining original purchase
renewal and renewal-lifecycle suites were not run after this failure. The
correction remains staged and uncommitted atop 1a7660ce; no new signed head or
completed delta-read candidate exists.

Before stopping, 23 existing suites passed unchanged (including composition
20/20), one failed and two remain unrun; the separate new unhealthy-purchase
witness passed 3/3. Full lint, strict typecheck, API snapshots, structural scan
and package-boundary checks passed. Documentation checks identify only the
pending scoped test trailers; they are not claimed fully green without the
planned commit. Full per-file results and untouched-source hashes are retained
in .context/scratch/g2/compatibility/existing-results.json. The real pack and
unchanged SQL SHA above describe the current staged source.

Stop self-retro: the expanded importer sweep exposed a second missed existing
consumer gate. Preserve and report that assertion rather than editing another
fixture or treating the focused new proof as sufficient. No further repair,
DCO commit, native review or G7 work was started.

### Resume: mechanical chain-count disposition and retained-store witness

The supervisor authorized the literal selected-chain count bumps and any
measured current-inventory expectation updates in the three qualification suites
and their proof companions. This is the sole exception to unchanged existing
tests: count bump only, preserving every other behavioral assertion. The
qualified-admin chain is 95 units and qualified-v2 is 96; their issued-prefix
counts and digests stay frozen. Current inventory expectations are checked
against each real PostgreSQL catalog observer, not invented. Main is not merged
in this run; the later review integration handles the shared count conflicts.

The additional retained-store witness must capture/project the managed source,
restore terms without method state, and renew under a restricted runtime role.
Use labelled host fixtures for its incumbent legacy codec, destination admission
and external payment result: the retained projection deliberately blocks shipping
until a host supplies its binding, and its historical snapshots do not have the
new-purchase codec's activation lineage. These separate seams are not destination
or PSP qualification. No method row or replacement purchase terms may be added
to make this proof pass. No G7 worktree or SQL is changed here.

Resume proof closes the prior stop: restricted connected restore passes 15/15;
qualified-admin composition passes 2/2; qualified-v2 composition passes 4/4.
Count bump only: admin/restricted 94 to 95 and qualified-v2 95 to 96, including
the matching proof literals and count comment. Current inventory pins were also
refreshed under the explicit digest instruction; each full PostgreSQL catalog
observer confirms the exact current inventory. Issued-prefix counts/digests and
all other assertions are unchanged. The original purchase-renewal and renewal
lifecycle suites, previously unrun, now pass 11/11 and 66/66 unchanged. The full
existing-consumer set is 28 suites / 350 cases PASS, with no other existing test
source changed. Composition remains byte-identical and 20/20 PASS.

The new retained-method witness passes 1/1 on real PostgreSQL: captured managed
source rows are projected by mapManagedRetainedBusiness and restored into a
clean qualified-v2 target. Terms/lines come from that production projection,
not target-row fixtures. The target has no method-state row before or after
renewal. Its runtime is session_user=retained_runtime, current_user=service_role,
with rolsuper=false and rolbypassrls=false. The real store reads the carried
authorization; public renewal executes exactly one labelled external-result
fixture, commits success and advances September 29 to October 27 while service
stays active. The incumbent legacy codec/cycle correlation, payment evidence and
host destination admission are explicit test fixtures. The real mapper's
address-binding block is separately asserted and never removed from its rows.
This is no destination wiring, production legacy provider or real-mandate
qualification. New-purchase unhealthy-method refusal remains 3/3 through the
installed tarball and bounded writers, with no seeded healthy state.

Two initial new-fixture attempts correctly refused: its default price-list
start date did not cover the past-due cycle, and its unrelated synthetic welcome
email queue was outside the admitted retained cohort. Explicit source price
validity and the existing positive retained-fixture queue isolation close those
setup gaps; no existing fixture or transfer guard was relaxed. The final source
remains a genuine managed capture/project/connected restore path.

Closure self-retro: the consumer sweep and retained projection expose distinct
compatibility boundaries that a purchase-only proof missed. Keep literal chain
counts intentional and use actual PostgreSQL inventory observers for current
pins. Build retained fixtures as explicit admitted cohorts rather than relying
on time-sensitive defaults. No SQL, permission, production codec or attempt
store change was needed beyond the single missing-row authorization predicate.

Final working-tree checks PASS: full lint (33 existing warnings, no errors),
strict typecheck (zero unresolved edges/consumer errors), unchanged API snapshots,
structural scan and package-boundary witness (2,825 cases). All existing suite
sources are byte-identical to the prior signed candidate except the five
explicitly authorized count/current-pin files, verified by reversing only those
literal substitutions. The source correction remains exactly line 63 in
postgresRenewalStore. No main merge occurred; fetched origin/main is 09cd599b
and AGENTS/CONTRIBUTING have no instruction delta. The immutable forward still
has SHA-256 2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34.
Scoped no-impact trailers cover test-count/current-pin maintenance and the
unchanged transfer-capability guide; CONTRIBUTING remains untouched. Under the
supervisor's direct instruction this correction is committed DCO-signed atop
1a7660ce, then receives its source delta read. No native review, registry pin,
checker edit, canonical verify, push or publication is performed. Native repair
cycles used: zero. Code/proof work is complete; ordered review/verification still
needs the source read and remains estimated at 0.5–1 working day excluding waits.

### Resume: complete-catalogue integration

The supervisor explicitly authorizes merging current main with a merge commit,
without rebasing, then using the complete-catalogue owner's generator to package
this forward. The observed main is 09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a.
The sole textual conflict is the publication catalogue: preserve this row's task
entry and the two distinct incoming task entries additively. The migration
projection is regenerated by checkPlatformMigrationProjection(process.cwd(), true),
not by authoring generated values. Canonical and packaged forward bytes both keep
SHA-256 2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34.
Subscription source and canonical SQL are unchanged from the signed correction.
Build, declaration snapshots and structural checks pass. All five real PostgreSQL
observations keep the prior hashes and counts: legacy 92, qualified-v2 96 in both
restore shapes, qualified-admin 95 in both role modes. No expectation or historic
pin needs changing. The existing four-selection installed-chain witness passes
through the complete-catalogue factory, including the packaged tail's named
missing/tampered refusals, exact ledger and zero-unit rerun. The artifact is the
same SHA as the measured candidate pack. Paired real packs reproduce main at
2,318,731 bytes / 2,913 files and this tree at 2,337,045 / 2,923: 18,314 bytes and
10 files added, including generated manifest and exact SQL. Baseline compilation
uses an isolated archive's own dist; it never removes workspace dist while the
existing-suite sweep runs. The complete sweep passes 34 files / 3,214 cases: the prior 28 files / 350 cases,
three method-health cases, the retained-method case, projection drift regression,
three facade cases, ten runner cases and 2,846 package-boundary assertions.
All 28 existing files are byte-identical to eb97697c; no count or digest bump was
needed because the actual selected chains and catalogues are unchanged. The
subscription composition file stays unchanged and passes 20/20; the installed
purchase suite keeps all eleven cases, including the real paid-gap second
caller, restart and table-access refusals. The retained projection still restores
terms with no method row and renews through the restricted role. Strict typecheck
has zero unresolved edges and consumer errors. Full lint initially passed with
zero errors, but also scanned an extracted baseline copy and duplicated its
33 existing warnings. Preserve the original log, remove that generated extraction
(the source archive and real packs remain), and rerun on the intended tree.
Any necessary production-source or SQL repair stops for the supervisor. No
registry pin, checker edit or native review is authorized. The later renewal
stack is untouched until this integration is signed and measured.


Integration self-retro: keep source/archive baseline compilation in its own dist
so installed-module tests cannot observe a deleted workspace build. Remove the
extracted baseline after packing: the repository lint patterns also visit its
TypeScript. The exact archive, base commit and packed artifacts preserve the
measurement without duplicating the repository-wide scan. No rule ignore, source
repair, SQL edit, test assertion change or privilege workaround was needed.

The intended-tree lint rerun passes with zero errors and the same 33 existing
warnings after removing the extracted archive. All working-tree behavior and
artifact checks are complete. Documentation policy before the merge commit sees
incoming main as an uncommitted delta from the older fork; its inherited
obligations are re-evaluated against the real merged ancestry before final
sign-off. No policy rule or comparison mechanism is changed to avoid that check.
No subscription production source, canonical SQL, existing assertion or expected
catalogue value changed in this integration. No native review or external write.

## Test process configuration follow-up

The three fresh-process witnesses now receive the disposable database URL and
row identity as Node arguments. Child scripts import the argument vector from Node; execFile's
normal environment inheritance replaces the redundant explicit environment copy.
No assertion, production source, baseline entry or SQL byte changed. All 91
expect calls are identical, and the real PostgreSQL purchase suite passes 11/11,
including restart, ambiguity and paid-gap reconciliation. Full lint passes with
0 errors and 33 existing warnings. The neutrality component runs exactly as verify
does, with base `09cd599bfef6bff74f4431b0cf7a00ebf80f1e6a`: zero increases.
Raw and packaged purchase-forward SHA remains
`2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34`.
This explicitly authorized test-only correction needs no new owner read. Evidence:
`.context/scratch/g2/neutrality/`. Package inputs remain byte-identical.

Self-retro: test child configuration is still an environment boundary. Pass the
small witness inputs explicitly and run the actual neutrality ratchet before
signing; focused behavioral tests alone cannot detect this rule violation.


## Offline installed-consumer correction

The two installed subscription witnesses share the small test-only
`tests/helpers/installSubscriptionConsumer.ts` function. It packs the locked local
core/platform, zod and the thirteen-package PostgreSQL driver closure, then
installs only those tarballs with offline mode, lifecycle scripts disabled,
legacy peer resolution, optional dependencies omitted, and audit/funding disabled.
The explicit list keeps the helper small; offline resolution refuses a newly
required dependency. No additional package beyond that list was needed.
Previous consumer modules and lockfiles are removed before installation, and a
realpath guard rejects PostgreSQL driver resolution outside the consumer.

With separate fresh empty caches supplied from outside the tests, purchase
renewal passes 11/11 in 16.876 seconds and method-health compatibility passes
3/3 in 15.966 seconds (whole test-command time, excluding the resource gate).
Both consumer locks contain exactly sixteen local-file packages, and pg resolves
inside each scratch consumer. All 102 existing expect calls are unchanged.
Neutrality reports zero increases; lint and structural checks pass. The real
platform tarballs are byte-identical to the official-toolchain baseline at
2,338,713 B / 2,923 files. Raw SQL retains its recorded SHA-256. No production,
package manifest, package input, assertion, baseline or checker change.

Self-retro: an empty cache alone does not prove a cold consumer if its old modules
remain. Remove those artifacts and check local driver resolution. A launcher-only
PATH omission was corrected outside the tests before either suite executed.
Evidence: `.context/scratch/g2/offline-consumer/`.


## Ordered predecessor integration

The supervisor authorizes one merge of the signed sandbox-payment predecessor
`e334a1ca79d6dc993a4adb0e45c380a55dec94a5` onto signed `9ac09927`, followed by
focused unchanged-test proof and a signed evidence update. Native review remains
unstarted; repair cycles stay zero. The exact stack base is now
`OPENLUP_STACK_BASE=e334a1ca79d6dc993a4adb0e45c380a55dec94a5`.
No main merge, other-row merge, pin/control/baseline/budget edit, source rewrite,
external write, credentials or production action is authorized in this run.

Manual conflict unions preserve both rows in the publication catalog, canonical
migration manifest, generated SQL manifest, adapter README, capture table list,
transfer fixture, and qualified/admin composition expectations. The payment
forward precedes the purchase-renewal forward without reordering any historical
prefix. Capture has 88 unique tables, retaining both payment companions and
all four purchase-renewal/method/activation tables. Restore auto-merges both
rows, including the unchanged simulator cyclic-reference restoration sequence.
The transfer test retains both payment and renewal setup calls, cases and
assertions; one duplicate createPostgresPaymentTruthPort import is removed.

Necessary union maintenance changes only current count/hash literals in the
restricted restore test, qualified/admin tests and proof companions, released
schema proof, and the opt-in handover's inventory/table-count pair. All issued
pins, witness messages, assertions beyond those current literals, SQL bodies and
payment logic stay unchanged. The generator projects the merged canonical
manifest and byte-identical SQL assets into the package. No generated hash is
invented: all five current inventories were measured on fresh PostgreSQL.

| Profile | Units | Measured current inventory SHA-256 |
| --- | ---: | --- |
| legacy | 93 | bc2f2d8dd9d90e40e497b97c062c43d9fd9f467c211f5918c3cffd154b58fef4 |
| bootstrap | 97 | 70a6cf41fd0c24ecb642ef36b457411f9ab46b3d721982032bd77d8a8d05afca |
| separate | 97 | 7c51eda0ec825e993283ba7d73463cea8e84e097d28543755a2e6bb2b8044dc3 |
| admin-managed | 96 | a4644feaaeabd7f0629aa2000ac5f587141b15f0ca7fd88a01991ca113469b7b |
| admin-operator | 96 | 0ab6e7ae6125e765a757a9808ef93df81456ab032226e92222fd02e2b63f4899 |

Canonical and packaged forward hashes remain
`7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29`
and `2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34`.
Every other canonical, packaged and managed SQL file matches its parent bytes.
Focused test results and any integration blocker are recorded after execution.
Evidence: `.context/scratch/g2/g6-stack/`.

Self-retro: a qualified manifest is an issued ordered prefix, not a globally
sorted set. An initial scratch measurement rejected that ordering error; insert
the new payment slot immediately before the renewal slot and measure the actual
combined catalog instead of carrying either row's independent digest.


### Integration result: blocked on unchanged witness setup

The ordered union is DCO-signed at `b98cc9eb`. Lint passes with zero errors and
33 existing warnings; structural checks and staged secret scanning pass. All
five real PostgreSQL inventory measurements completed with the values above.
The transfer-test assertion multiset equals both parents minus their shared
base: no assertion was dropped or relaxed when preserving the two case sets.

The first unchanged regression suite,
`tests/postgres/connectedStoreTransfer.test.ts`, fails in beforeAll at
`renewalPurchase` line 75 with `wrong_attempt` (SQLSTATE 22023), before any test
body. Its sandbox captured-truth fixture has no simulator attempt/observation,
so the predecessor's unchanged `payment_simulator_assert_truth` guard refuses
it. Result: one failed suite, zero passed cases, thirteen skipped cases; command
time 7.786 seconds. The test file hash stayed unchanged during execution.
No fixture bypass, alternative settlement channel, fabricated attempt row or
payment logic change is made. A joined fixture using actual attempt/observation
writers needs a separate supervisor disposition; this union run stops here.

The remaining 211 inventoried suites, including the other conflicted composition
suites and each row's own money suites, were not run after that first failure.
The opt-in handover's current literals were united, but its effect assertions
were not executed in this blocked run. No combined qualification is claimed.

Verify's exact neutrality component, using the predecessor as comparison base,
also fails: the predecessor task record has ui-13 count 8 and ui-14 count 6
against the pinned zero allowances. That task record is byte-identical to the
predecessor. It and the baseline/scanner are left unchanged; this is an additional
inherited blocker, not a reason to widen a control. Documentation no-impact
trailers are refreshed only for the mechanical union's current source digests.
No native review, main merge, forward pin, external write or production action.

Self-retro: the ordered union exposes the precise earlier fixture boundary.
Keep the real sandbox truth guard and stop at its first incompatible witness;
carrying both green isolated-row reports does not prove the joined purchase path.


## Current payment predecessor and purchase-fixture integration

The supervisor authorizes merging payment predecessor
`1df6adde65ddaf88af87ebb36845ae757e506b34` into the prior signed stack at
`a5d012488379c5b79b5cebaf877c6974f103be53`. Signed merge `0e73aebd` retains the
mechanical result except for the publication catalog's disjoint additions,
which preserve every entry from both parents. No separate main merge or other
row merge was made. The current predecessor is that payment head; at review time
`OPENLUP_STACK_BASE` must be set to the payment row's final frozen head, after
its final control predecessor is accepted. This run starts no native review.

Three purchase fixtures now share the test-only `captureSandboxPurchase` helper:
connected-store transfer, purchase renewal and method-health compatibility.
It begins a simulator attempt, records a captured observation, then submits only
the intent, attempt and observation identities to verified ingress. Uncaptured
purchase fixtures remain uncaptured. Existing assertion and test-declaration
line sequences are unchanged. No production code, SQL, grant, control, baseline,
attempt storage or package input changes follow the merge. The helper's catalog
entry is additive. Ordinary renewal still uses the existing renewal outcome
ledger and settlement path; this does not qualify the later recovery join.

The initial stop in the qualified composition witness was an environment gap:
ignored package output predated the newly inherited fulfillment entry. On the
supervisor's diagnosis, rebuilding core and platform with the official Node
24.21.0 toolchain took 6.429 seconds and changed no tracked file. The previously
failing qualified composition suite then passed all four cases unchanged.

The complete 212-file importer and row regression sweep was rerun serially,
each file through its own focused admission, with fresh external npm caches.
All 212 files pass: 2,341 passed cases, zero failed cases and one existing
managed-local-database opt-in case skipped. No test file changed during its run.
Purchase renewal passes 11/11 in 23.012 seconds; method-health compatibility
passes 3/3 in 19.581 seconds; transfer passes 13/13 in 94.031 seconds. The
retained-store compatibility case passes, the unchanged subscription composition
suite passes 20/20, and payment cancellation/simulator coverage passes 15/15.
Qualified/admin composition, restricted restore, released-schema upgrade,
renewal lifecycle and every other file in the retained 212-file inventory pass.
The explicitly gated managed-local-database conformance case remains unverified;
no credentials or additional profile was enabled. The separate opt-in whole
handover witness was not rerun as part of this named importer sweep.

Lint passes with zero errors and 33 existing warnings (49.870 seconds), and
strict published-tree typecheck passes (34.855 seconds). Structural checks,
unchanged assertion/declaration sequences and staged secret scanning pass.
Documentation navigation regeneration changes no tracked output; scoped
no-impact trailers bind the unchanged ownership, transfer and test guidance.

The fixture/helper/catalog/task edits are DCO-signed after the focused checks.
No public API, production code, SQL, registry pin or review mechanism changes.
Review still waits for the final control predecessor and the supervisor's grant.

The exact verify neutrality component passes against the specified predecessor,
with zero increases. Both canonical and packaged SQL hashes remain unchanged:
`7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29`
and `2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34`.
The fixture edits introduce no packed files or production/package byte changes.
There is no new real pack measurement in this blocked run. Evidence lives in
`.context/scratch/g2/g6-current-stack/rebuilt/`.

Self-retro: the 212 test commands took 796.336 seconds; their recorded focused
admission waits totalled 6,649 seconds. Keep admission limits intact and
separate that queue cost from execution time. Validate that a newly merged
public entry has built output before
starting subprocess-based composition witnesses. A source resolver can hide a
missing generated entry that a fresh Node process correctly refuses. The new
helper's catalog row was initially inserted out of order; move only that new
row to its lexical position instead of reordering shared entries.


## Payment and purchase-renewal bundle

The owner decision CD-M19-112 joins G6 and G2 as one candidate and one PR,
implemented at the existing `oss-m19-g2` stack top on `codex/oss-m19-g2`.
Both task records remain. The supervisor authorizes merging only main,
binding the purchase-renewal feature pin, focused proof, a signed candidate and
one full native session with two fresh parallel reviewers and a fresh 0/3
budget. No `OPENLUP_STACK_BASE` applies: review covers the full combined diff
from main. Canonical verify, push, PR creation, production, credentials,
publication and external writes remain excluded in this run.

Main `a7ce403cef3b790c28418d786f153e50ac595084` merged mechanically as
`933d688e5a7a77d0f9d3bb8762295b66731ae72c`, tree
`809f736e99f03f6b56c7b37968b2c9b413c67704`. `git merge-tree --write-tree
 d698609ecdb92a88ce4b289789c2acbda9103aa1 a7ce403cef3b790c28418d786f153e50ac595084`
returned that exact tree. No hand resolution or other branch merge occurred.
The purchase-renewal pin is computed with `nativeStoreFunctionDefinitions`
and `sqlSha256` from `scripts/reviewed-platform-forward.ts`, after the existing
sandbox-payment pin. No class data or issued pin changes.

The accepted production/SQL deltas remain exact. Reproduce with
`python3 .context/scratch/g2/bundle/read_identity.py`: it takes
`git diff --no-ext-diff --unified=0 --no-renames <base> <read> -- <production paths>`,
keys every added/removed line by exact path, sign and content, preserves its
multiplicity and hashes sorted tuples. The original base is
`bb0008481a11267ec6dbe3e7e531299777cddc19`; read heads are
`eb97697cb5de2cff0047208a133024c12bc27e4e` for purchase renewal and
`1acac911a02b326f660dfc9b6e4bdb1aeb9d6626` for sandbox payments.
The actual combined production delta equals exactly those two accepted deltas
plus one merge-only blank separator at connectedStoreCapture.ts:22.
`git show b98cc9eb --cc -- server/adapters/postgres/connectedStoreCapture.ts`
identifies that empty separator with `++`; it belongs to neither row's own
accepted source delta. The script asserts this complete accounting before
subtracting the other row and that one exact separator. There is no general
whitespace normalization, ignored production path or unaccounted difference.

Equal accepted/current own +/- SHA-256 values:
- Purchase renewal: `1a2cefbf86eaea14b5775098c2436925a987a84d61877dffa8b0e2444ace65bd`.
- Sandbox payments: `db4fb97f016f789996e96648f45873f954763427e98d9a4ec5392bcbfa0eb693`.

Other post-read changes are test-only simulator purchase setup shared by three
callers, the offline installed-consumer helper, the missing-method compatibility
witness, mechanical current-chain counts/measured inventories, selected-chain
lookup in the hostile-default payment test, neutral task prose and documentation
impact trailers. The SQL package copies/manifest are the canonical projection
introduced by the packaging prerequisite; each copy retains its read SQL bytes.
Registry changes bind only the accepted forward/function identities. Owner
documentation and public API semantics are unchanged by this integration.

Both canonical/packaged forward SHA-256 values remain
`7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29` and
`2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34`.
Static native admission passes both slots. The real PostgreSQL catalog witness
passes 126/126 cases across service-role present and absent modes with both pins.
Core/platform rebuilt first with official Node 24.21.0, without tracked changes.

Real official pack against the main pin above: baseline 2,364,865 B packed,
1,899,251 B code gzip, 11,153,236 B unpacked, 2,955 files; candidate 2,394,059 B
packed, 1,916,125 B code gzip, 11,287,990 B unpacked, 2,972 files. Delta:
+29,194 B packed, +16,874 B code gzip, +134,754 B unpacked and +17 files.
The unpacked/file deltas exactly equal the two earlier row measures combined;
the shared test helpers are root-only and add no package bytes/files. Combined
compression saves 382 B against adding the two earlier packed deltas. No cap
change is required. Real tarballs and measurePack output are in bundle scratch.

Paths outside the original programme grant's list are the additive routing
entry in config/doc-routing.json, server/adapters/README.md (accepted additive
owner description), and the explicitly authorized test-only helpers
captureSandboxPurchase.ts and installSubscriptionConsumer.ts under tests/helpers.
All are retained additions with no control, budget, baseline or runtime change.
Full bundle proof, trusted-main registry preflight and native review follow on
this exact combined boundary; no readiness verdict is claimed before they pass.

Self-retro: account for each row independently on shared transfer files and
retain the exact merge-only separator separately. Comparing the union to either
row alone falsely treats the other row as a new production semantic. Keep the
byte inventory explicit; never hide a source difference with broad normalization.


### Bundle stopped: captured-observation timestamp precision

Status: BLOCKED before feature DCO and native review. Signed main merge remains
`933d688e5a7a77d0f9d3bb8762295b66731ae72c`; G2's computed feature pin and both
bundle records remain staged. No production, canonical/packaged SQL, class data,
check, baseline or budget was changed. No native session or counted review began;
review budget remains 0/3 and there is no counted PASS timestamp.

A new real-PostgreSQL counterexample exposes a valid-input failure in
`createPostgresSandboxPaymentSimulator`. Its restricted `micro_runtime` caller
is neither superuser nor BYPASSRLS. `beginAttempt` and `recordObservation`
accept `2026-10-30T12:00:00.123456Z`; bounded readback returns the exact stored
`2026-10-30T12:00:00.123456+00:00` captured observation. Verified ingress returns
503, the settlement intent remains `created`, and accepted truth rows remain
zero. The underlying error is `payment_simulator_evidence_mismatch`, SQLSTATE
22023. The timestamp is genuinely in the past; future-time clamping is irrelevant.

Mechanism: the simulator's `instant` helper uses JavaScript Date and drops
microseconds. The verifier applies it to `providerAuditPayload.sandboxObservation`
at line 49, so payment control supplies rounded `occurredAt` and `observedAt` to
`payment_truth_ingest_event`. The immutable-observation guard
`payment_simulator_assert_truth` correctly requires exact timestamp equality
and refuses. Repeating this ingress cannot settle that captured observation.
The accepted-event replay branch also projects the PostgreSQL timestamp through
Date and needs the same precision assessment. The source inspection and one
failing restricted-role counterexample demonstrate a wrong refusal of an
in-scope captured observation, independently of the passing catalog boundary.

Reproducer: after the normal focused admission, run
`node --import tsx .context/scratch/g2/bundle/micro-probe.ts` on official Node
24.21.0. Evidence: `micro-result.json`, `micro.log`, and `micro-repeat.gate.log`
in that directory. A transparent executor records the original PostgreSQL error
and stack without changing SQL, arguments or role. Attempt and observation rows
are produced only by their bounded production writers. Only the existing
client/order/line fixture setup uses the owner. The initial scratch run omitted
the fixture's order/line transaction and stopped on its deferred sum constraint;
that setup mistake was corrected before the counterexample above (3.878 seconds).
Both diagnostic containers and pools were cleaned.

A two-line proposed source patch is retained as
`timestamp-preservation.proposed.patch` in bundle scratch, **not applied or
qualified**. It preserves the server observation's original timestamp in the
raw audit evidence and the accepted replay's saved evidence timestamp. It does
not relax the SQL guard or create browser-supplied paid truth. A production fix
would no longer have the accepted read's +/- source identity, so this run stops
with the mechanism and proposal before changing those production bytes.

Completed unchanged regression proof: 220 files pass, 6,182 passed cases,
zero failed cases and one existing managed-database opt-in skip. That includes
all previous 212 files, packageBoundary 2,894 cases, documentation impact 101,
cold consumer 108, source preview, payment truth schema/allowance, domain truth
and managed-storage transfer. The reviewed-batch suite was deliberately
interrupted after this independent material finding; reviewed portable creation,
eslint-import-map and generate-outcome-projection did not start. Interrupted
work is not counted as a product failure. Its owned test processes exited and
an owner-PID-labelled container census found zero remaining containers.

Separate executable truth: catalog 126/126 across both service-role modes and
transfer 13/13 pass. Both static native approvals and the trusted-main reader's
co-located/native-store preflight pass on the staged working-tree data snapshot.
The real pack and accepted-read identity accounting above remain valid.
The new timestamp counterexample is 0 passed / 1 failed. Joined handover, Linux
glibc consumer, final cheap checks, final signed-head preflight and native review
were not run after this stop. No canonical verify, push or external delivery.

Self-retro: millisecond-only fixtures hid PostgreSQL's greater timestamp
precision. Preserve authoritative evidence in its original representation;
normalize timestamps only where the consumer contract permits that precision
loss. Add fresh and replay precision counterexamples when the repair is authorized.


### Pre-review precision repair and native identity blocker

The supervisor authorized in-bundle TypeScript precision repairs before native
review. The current signed head is ba5e5c2d18130e265cc5e2e30728b93038c059c4,
a mechanical, DCO-signed merge of main 21c057038b25db6bdf490496a341df5b2f1fdbcc.
Its tree is 650cc25b3d4270dc4b7141fbf9f17fca702030e5. The preserved feature pin
and both task records remain staged; the authorized repairs and regression tests
remain uncommitted. No native session began and no repair cycle was used.

The simulator regression uses a restricted non-superuser, non-BYPASSRLS role
and a captured observation at 2026-10-30T12:00:00.123456Z. Before the repair,
the focused test fails: ingress gives 503 instead of 200 (one failed case).
The two-line repair retains the observation string in the raw verified payload
and uses accepted source_evidence.observedAt on replay. It passes the same case
(one passed, zero failed; 4.406 seconds), including one settled intent, one truth
row, one dispatch, and unchanged truth row version and dispatch state on replay.
Only envelope metadata still uses Date; the values compared by the immutable
SQL assertion come from the preserved evidence string. SQL and contract types
are unchanged. This is an authorized pre-review restoration of the accepted
contract, not a new semantic or a native repair cycle.

The purchase/renewal regression goes through that repaired simulator ingress,
activation, the attachment writer, listDue and buildCycleSnapshots. Before the
renewal precision repair it fails with subscription_renewal_snapshot_not_found
(one failed case; 22.920 seconds). The captured observation settled, the caller
has neither elevated role flag, and activation produced an exact stored
next_cycle_at of 2026-09-29T12:00:00.123456Z. No schedule row was hand-written.
The pending TypeScript repair projects UTC ISO timestamps with microseconds,
keeps the existing .sssZ dialect when the final three digits are zero, and
reads renewal observation/evidence timestamps as text. The test then passes
snapshot schema/round-trip checks, exact scheduledAt and authorization time,
scheduledInstant consistency, and codec/policy identity equality.

It stops at the subsequent real claim with
subscription_renewal_claim_invalid_snapshot (one failed case; 19.296 seconds).
The existing subscription_renewal_identity(uuid,timestamptz), defined in
20260815120000_automatic_subscription_renewal.sql, formats the key timestamp
with SS.MS. subscription_claim_due_renewal compares its input key with that
function at line 408, so a key retaining .123456Z is refused in favor of .123Z.
The exact schedule is now preserved; the failure is the SQL identity dialect.
Changing that SQL is outside this TypeScript-only repair authorization, while
truncating both TypeScript keys would contradict the explicit instruction that
an identity-key timestamp retain the exact stored instant. Stop for a bounded
supervisor decision on that dialect; do not weaken the test or SQL guard.

Evidence is in .context/scratch/g2/bundle-repair/: fail-before.json,
g6-pass-after.json, g2-fail-before.json, g2-pass-after.json,
precision-repairs.patch and precision-stop.json. Commands use official Node
24.21.0, the focused gate with exit-3 retry, and scripts/run-vitest.mjs with the
respective sub-millisecond test filter. Core and platform rebuilt successfully
before each production version was exercised. No existing assertion changed.
The full repaired-tree suite sweep, real pack, signed-head registry preflight
and native review have not run after this blocker. Earlier proofs do not claim
coverage of this repaired tree. A complete charge/replay result is not claimed.

Both canonical and packaged forward bytes remain unchanged: simulator
7cbe956e51c16eb2f88ca0430e60a5a3bb9b67e4ebee10f9463723e776852b29;
purchase renewal
2105ad7893148dfe5556bdc5eb605df8d42bf679ac127bb789bcf3c42863fc34.
Class data and forward pins were not changed by either precision repair.

Self-retro: preserving a snapshot timestamp is necessary but not sufficient;
trace the native identity formatter before assuming an exact timestamp can
reach claim unchanged. The counterexample exposed the remaining contract
conflict before spending time on the full sweep or starting review.

### Native key dialect decision and precision continuation

The supervisor resolved the identity stop: retain the existing native SQL
millisecond identity label, using string truncation rather than Date or floating
point. A subscription's cycles are days apart. That label's millisecond spelling
is distinct from the exact stored instant used to locate/compare schedules.
No SQL change is authorized or needed for this decision. The codec and sandbox
policy now derive the same native label by cutting the UTC ISO fraction to
three digits. The regression compares both labels with PostgreSQL's own
subscription_renewal_identity for fractions .123456, .123999, .999999 and
.000000; the .999999 case explicitly keeps the original second.

All stored-time projections added by this repair use UTC ISO with six fraction
digits, including sandbox observation occurred_at and created_at. Snapshot
normalization retains the pre-existing .sssZ wire form for millisecond-aligned
instants. Full scheduledAt and authorization/evidence timestamps retain their
microseconds. scheduledInstant remains Date.parse(scheduledAt), as the public
schema requires. There is no lookup using that numeric value.

The repair-only production inventory is the simulator's two evidence lines,
codec string validation and key formatting, renewal-store UTC projections and
mandate readback, and sandbox-rail UTC evidence projections and key formatting.
No other production or SQL difference from the accepted reads is allowed.
Reproduce the line accounting with
`python3 .context/scratch/g2/bundle-repair/read_identity.py`; its artifact lists
the exact authorized +/- repair lines separately from each accepted own delta.
It also accounts for the one previously proved merge-only separator in capture.
The earlier blocked entries above remain historical attempts, not a current
readiness claim. The continued proofs and official pack must pass before DCO
and the full combined native review.


### Precise renewal passed; package growth stop before full proof

The identity decision is implemented without SQL changes. On the restricted
non-superuser/non-BYPASSRLS runtime, the purchase-to-renewal precision regression
now passes: the simulator capture settles, activation completes, one snapshot
is built with exact schedule/authorization time, the claim is acquired, one
charge succeeds, the outcome settles a paid cycle, and a second run creates no
second charge or cycle. The known terminal public-run replay refusal remains
for the later renewal row; this test does not claim that later repair.
Both TypeScript keys equal PostgreSQL subscription_renewal_identity for all
four requested fractions: .123456 -> .123Z, .123999 -> .123Z,
.999999 -> .999Z (no carry), and .000000 -> .000Z.

Focused regression results: simulator 1 failed before / 1 passed after
(4.406 seconds after); purchase renewal 1 failed before with
subscription_renewal_snapshot_not_found / 1 passed after (21.159 seconds).
The intermediate exact-key attempt failed at claim before the supervisor's
millisecond-label decision, as recorded above. Existing assertions are
unchanged. These filtered runs are not the complete existing-suite sweep.
Official core/platform rebuild passes. Neutrality against main 21c05703
passes: 6,964 text files, 57 binary files, zero increases. The accepted-read
source accounting passes after listing only the two authorized precision
repairs separately; no other production or SQL delta is present.

The real official-toolchain pack was deliberately checked before the long
sweep, because the binding growth rule requires an immediate stop on a row's
increase. Against main 21c057038b25db6bdf490496a341df5b2f1fdbcc:
baseline 2,364,865 B packed, 1,899,251 B code gzip, 11,153,236 B unpacked,
2,955 files; repaired candidate 2,394,606 B packed, 1,916,655 B code gzip,
11,288,853 B unpacked, 2,972 files. Delta: +29,741 B packed, +17,404 B code
gzip, +135,617 B unpacked, +17 files. This is +547 B packed, +530 B code
gzip and +863 B unpacked above the previous combined figure, with no new file.
The code class remains below 1,970,000 B; no cap was changed.

The explicit comparison stop is nevertheless hit: +135,617 unpacked exceeds
the earlier two-row sum of 134,754 by 863 B, which the root-only test helper
does not explain. All 863 B are the authorized precision repairs' source and
emitted JavaScript: simulator -98 B, codec +106 B, renewal store +516 B,
sandbox renewal rail +339 B. No declaration, SQL, manifest, dependency or
other package file changed. There is no unrelated package growth to remove.
Stop for the supervisor to disposition this measured repair increment before
DCO and the full proof/review. No budget, cap, baseline or checker is edited.

Evidence: .context/scratch/g2/bundle-repair/g2-identity-pass-after.json,
identity-pass-after-command.json, neutrality.log, read-production-identity.json,
pack/summary.json, pack/repair-growth.json, and precision-repairs.patch.
Real pack command: on official Node 24.21.0, after focused admission,
`python3 .context/scratch/g2/bundle-repair/pack.py`; it builds an archived
main source, packs both real packages and applies the official measurePack
classifier. It exits with the explicit unpacked-growth stop above.

No new commit or native session was created. The signed head/tree remain
ba5e5c2d18130e265cc5e2e30728b93038c059c4 /
650cc25b3d4270dc4b7141fbf9f17fca702030e5; feature edits remain pending.
Both forward SHA-256 values and main's class data are unchanged, and both
feature pins remain as preserved. The full repaired-tree sweep, catalog,
transfer, handover, Linux consumer, final cheap checks, signed-head preflight
and native review remain required; prior-tree results are not carried over.
Native cycles used: 0/3; no counted PASS or source-review expiry.
OMS: neither supersededByStableJourneyKey nor checkoutAbandoned is written.
The bundle's previously disclosed new dispatch location is
payment_simulator_attempts; the precision repair adds no dispatch location.

Self-retro: a real-engine identity comparison closes the representation
ambiguity without widening SQL. Measure an explicitly authorized repair before
spending the long proof run when its package increment is itself a hard stop.


### Accepted repair size and combined proof continuation

The supervisor accepted the precisely itemized +863 B unpacked repair increment,
with zero added files. It is not an owner or cap matter. The reference against
main 21c05703 is now +29,741 B packed, +17,404 B code gzip, +135,617 B unpacked
and +17 files; candidate code class 1,916,655 B. No cap/baseline changed.
Subsequent growth stops only beyond this reference without an authorized
change's own itemized bytes, or beyond the 1,970,000 B code-class cap.
No pack is repeated while package inputs remain unchanged. The complete
combined repaired-tree proofs now resume before DCO and native review.


### Complete proof anchor before integrating native-store promotion

The repaired tree passes the complete 224-file sweep: 6,454 cases passed,
zero failed, and one unchanged managed-database opt-in skip. Every suite file
kept its pre-run hash. The previous 212-file set contributes 2,343 passing
cases, including the two new precision regressions. Additional checks include
packageBoundary 2,894; documentation-impact 101; cold consumer 122; source
preview 718; reviewed batch forwards 106; reviewed portable creation 20;
eslint-import-map 123; generate-outcome-projection 7; payment-truth schema 3;
payment allowance 8; domain truth 8; managed storage transfer 1. Full file names
and individual results are in .context/scratch/g2/bundle-repair/sweep-results.json.
The unchanged subscriptionComposition suite passes 20/20.

The restricted-role purchase-renewal suite passes 12/12 (including the paid-gap
second caller and precise purchase-to-renewal regression); method compatibility
3/3; retained method compatibility 1/1; simulator/cancellation 16/16; populated
connected transfer 13/13. Catalog truth passes 126/126 across service-role
present/absent modes. Both static native admissions pass. The offline Linux
glibc consumer passes on Node24.21.0/glibc2.36 with network disabled, a fresh
empty cache, exactly 16 local tarballs, and pg resolved at
/consumer/node_modules/pg/lib/index.js. No additional dependency was needed.

The unchanged joined handover witness completes in 100.952 seconds with
LOCAL_QUALIFIED_TARGET_READY_WITH_ONE_FENCED_UNCERTAIN_OPERATION, two accepted
effects recovered, and one uncertain operation fenced. The selected chain has
97 units and 88 transfer tables, current inventory
7c51eda0ec825e993283ba7d73463cea8e84e097d28543755a2e6bb2b8044dc3.
Graph/filesystem publication and target continuation assertions execute;
cleanupFailures is empty. Its report is under
.context/scratch/oss-m14-connected-catchup/journey-EN9LSx/report.json.
These finite handover rows do not claim the separate whole-journey proof.

Official core/platform builds, ast-grep (including suppression checks), lint
(including all eight structural-rule groups), strict public-tree typecheck,
neutrality against 21c05703 (zero increases), and gitleaks git with --log-opts=--all
all pass. The policy check reports only the scoped tests no-impact record,
whose current digest and explanation are included in this commit; CONTRIBUTING
is unchanged. Policy must be checked again after that record is committed.
No navigation regeneration is requested. All 2,972 package files still match
the measured tarball byte for byte; the accepted +29,741/+17,404/+135,617 B,
+17-file measure therefore remains applicable to this proof anchor.

The source-line identity command is
`python3 .context/scratch/g2/bundle-repair/read_identity.py 21c057038b25db6bdf490496a341df5b2f1fdbcc`.
It rejects every production path outside the two accepted own deltas, lists
the authorized precision repair lines separately, and accounts for exactly
one merge-only separator from b98cc9eb. Accepted original own +/- hashes:
G2 1a2cefbf86eaea14b5775098c2436925a987a84d61877dffa8b0e2444ace65bd;
G6 db4fb97f016f789996e96648f45873f954763427e98d9a4ec5392bcbfa0eb693.
G2 accepted-own plus authorized repairs and candidate-own +/- hashes are
both 6f41615d74d256b40721467ef1a31c3e85184b1b1af2f82de8239a002e6c4d69;
repair-only +/- hash 0acd0db3adc3129d5a40ae0d0dc4fb07eae828d6e9ec3126c528d02c63837749.
G6 accepted-own plus authorized repairs and candidate-own +/- hashes are
both e15695de449804d893c9f2a2f379df13fbe334b2ab58fd24fad71f3f6c86f2d1;
repair-only +/- hash f9fe546686050c70bc061a583a71a3f2d607a091a02225033b3f664549045710.

The only production changes beyond the accepted reads are the explicitly
authorized simulator evidence preservation and renewal timestamp/key repairs.
Canonical/packaged SQL bytes, class data and the two pins are unchanged.
Managed payment/subscription adapter and reference-runtime suites above pass
unchanged; no managed migration or served composition was edited.

During proof, shared main advanced to 2d5547dcccb5d9e3c40bece5016382fbf9f6a670
(native store promotion). A dry merge reports only disjoint publication-catalog
additions, with architecture and package README merging automatically. The
proof anchor above remains for the 21c05703 tree; it is not a claim that the
future integration has been checked. The authorized catalog union, subsequent
integration checks and pack, trusted-main reader preflight and two fresh full
reviewers remain before READY_FOR_VERIFY. No native session has started, 0/3.

Self-retro: the complete sweep took substantial admission wait time; no suite
was weakened to shorten it. Separate executable-source proof from scheduling
and from a later main integration rather than silently carrying results over.


### Required pre-review native-store integration

The full repaired-source proof anchor is DCO-signed at
bd07308db5d579f7df5c7a8539d40d3a04df697d, tree
5fc12f0406933b7ed5394d5a0a08d20a6c20cfe9, on main 21c05703.
The required fresh fetch found main at
2d5547dcccb5d9e3c40bece5016382fbf9f6a670 (native store promotion).
The dry and actual merges conflict only in disjoint publication-catalog
additions: preserve the two simulator test paths before both native-store
promotion test paths in lexical order. Every base entry and both disjoint
addition sets are byte-for-value preserved, with no duplicates or key changes.
Architecture and package README merge automatically. No own production, SQL,
class-data or pin change is introduced by this union. The only manual edits
beyond the catalog resolution are this integration bookkeeping in both records.
This is the authorized registry union, not a claim of a conflict-free merge.
No prior native session exists; the first full review still starts at 0/3.
The merged tree requires its updated build, integration proof, real pack,
policy and trusted-main admission before review. The earlier anchor's tests
are retained as source proof and are not relabelled as this integration's run.
