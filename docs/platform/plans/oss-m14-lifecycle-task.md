# M14 C: application lifecycle task

Status: source-only local draft handoff (2026-10-27). Two native FULL FAIL
reports and all three material cards remain open at cycle 0/3. Repairs are prepared for a corrected draft checkpoint and remain unverified;
earlier working-tree proof is historical.
Development preview only.

## Receiving-session source-only repair, 2026-10-27

The receiving supervisor relayed the owner's latest explicit limit: source
corrections and static inspection only on this machine; no tests, verify,
builds, installs, lint or other gates, commits, push or external writes.
PR #401 remains the draft checkpoint. This limit supersedes the historical
delivery endpoint below for this run; it waives no proof required before later
submission. No independent reviewers were launched in this continuation.

The supervisor freshly fetched main in this receiving run and confirmed policy
pin `a03d920eec32bfb3d0de90b9a12535cc57f88d53`. The source checkpoint remains
`da3a47d7f32f303ddaa6160d93dd6066239e6716`, separately from the native reviewed
candidate `0334ee2592685c32d66947cd52922f0756f1236d`, tree
`7247132331d0feaac08466faa8698e6283607bcf`, review base
`f6f0b15c3422dd8e16aea7965b180fc584eb159c`. No rebase or main merge occurred.

Restored the exact four UTF-8 files from the
[historical FAIL handoff](https://github.com/openlup/openlup/pull/401#issuecomment-6449877511)
under `.context/scratch/agent-review/`, comparing SHA-256 before writing and
after reading the restored bytes:

| File | SHA-256 |
| --- | --- |
| session.json | `50052319808a48f87d43155cd17434f0778d93d32ba4d871a302c4e514682f81` |
| intent.json | `fadbf35f06bbc2bf7e782791b3769b487cbc922c4798e41e8d2f91280e360387` |
| r0-a.report.json | `bfebe5b337b325a4a6bb0a4e973511bb457d83828de54585ed99c4b0473680ef` |
| r0-b.report.json | `193efb2e36156498502386340b6c011f3b00e7bc7c4ea6e98406c66646b67832` |

This was data-integrity recovery, not native preparation, verification, finding
closure, a receipt or admission. Cycle 0/3, both FAIL reports, original authors
and actor exclusions remain unchanged. Open cards remain `CDR0-A-1`,
`CDR0-B-1` and `CDR0-B-2`. Actual new repair author is Codex subagent
`/root/m14_cd`, context `01a17e98-726c-7263-871e-44c8cd68410a`, supervised by
the receiving coordination context `01a17e97-d95d-7581-beb5-ab5ee9ad007c`.
Both are author/coordination exclusions for subsequent independent review,
alongside every historical exclusion. The resumed author must record changed
authors through the supported same-history continuation before counted review;
do not replace history or copy old verdicts to the repaired candidate.

Static cause analysis groups the two C cards into one mechanism: full-filename
aliases omit differently spelled absent parent directories with different leaf
names. The smallest repair extends the existing whole-input preflight's parent
loop with one normalized-prefix-to-exact-spelling map across both inventories.
Exact shared parents remain allowed; full-file aliases and file-parent
collisions retain their existing refusal. All of this precedes filesystem
mutation. D's fixed SELECT now binds its functions, cast types and equality
operators as well as relations to `pg_catalog`, covering ordinary calls, JSON
aggregation, parameter/identity casts, ANY predicates and membership joins.
`current_user`, `session_user` and COALESCE retain PostgreSQL keyword syntax.
No session-setting query, abstraction, dependency or second SQL statement was
added. The two canonical owner sections explain these precise boundaries.

Inspected the checkpoint's two C regression drafts: absent case/normalization
aliases with distinct leaf names must refuse before writes; one exact prefix
must still resume and replay. Inspected its actual-PostgreSQL regression draft:
a restricted genuine login with application-first search_path, shadow functions,
cast-type domains and equality operators must observe actual flags with zero
shadow calls. These cases remain unchanged and unexecuted; no extra case was
needed for the identified mechanisms. Local static review traced all prefix
checks across the union of both snapshots and all SQL symbol sites. This is
author inspection, not independent PASS or runtime proof.

Deferred to the authorized proving session: discriminating red/green regression
execution, required focused and full local checks, actual PostgreSQL and packed
consumer/falsifier proof, generated API/navigation and documentation-policy
checks, approved-input package remeasurement and any necessary bounded budget
read, DCO/commit, same-history candidate preparation with author exclusions,
two fresh full reviews closing the cards, native verification and any separately
authorized delivery. Existing exact caps are unchanged; changed source/docs
bytes have not been remeasured. Historical PASS counts do not verify this tree.

Self-retro: two C cards share one cause, so extending the existing prefix loop
avoids duplicate controls. D's prepared regression exposes type/operator lookup
as well as function lookup; binding every resolvable SQL symbol directly is
smaller than altering caller session state. Hash-checked recovery preserves
history without inventing a new candidate or consuming/resetting a cycle.

## Outcome and authority

The accepted first C slice is a conservative application-file upgrade primitive:
plan and apply explicit predecessor/candidate managed UTF-8 files in an existing
application outside the platform workspace, preserve adopter customizations,
refuse conflicts before writes, and resume interrupted application from exact
old/new bytes. Database evolution remains a separate owner operation.

The approved combined delivery also includes D's one read-only legacy PostgreSQL
role-prerequisite observer and its original refusal witnesses. This preserves D's
original finite outcome; it adds no install-readiness, role/DDL or qualified
installation support. Runtime drain remains separate.

Master M14 coordinates this finite programme; this lane coordinates implementation
and its own bounded Sol 6.1 agents. Human-authorized local implementation, tests
and signed commits are permitted, subject to the master's exact evidence/handoff.
The human's 2026-10-27 message `01a17c90-a079-7f02-b102-a9e35d770649`, read
directly in Master M14, extends this same M14 C2 endpoint through PR, ready,
actual source checks/native receipt/admission, queue/group checks and confirmed
merge. Earlier draft-only notes are historical. No release/npm/deployment,
provisioning, credential, provider activation, settings, live-store or scope
expansion follows. Actual head/review/receipt/expiry and predecessor-on-main
requirements remain binding; queue rebuild recovery has at most two retries.
Earlier work and shared resource capacity retain priority. C-to-master messaging
is separately awaiting exact-target permission after automatic review refused
the acknowledgment; use direct status/scratch readback, without another transport
or a duplicate permission request.

Worktree: `/private/tmp/openlup-m14-lifecycle`; branch:
`codex/oss-m14-lifecycle`. Initial code base was
`80d27906a6d4bc679c011871948e88d185bb1c63`. Under the master's explicit LIGHT
handoff it was fast-forwarded to B `7f564eef5ef08f3deff5abff786a88b54d2b4f76`
(tree `bf1a863cac038e0b30e9e1ffe078fa4c4c733951`). Backed-up hashes confirm the
two lifecycle production files, 35-case test and task record were unchanged by
that integration. B has DCO sign-off; no cryptographic signature claim is made.
Its two fresh full reviews and final proof are still pending, so this is a
preparation pin, not final predecessor admission.

The next preparation pin was the explicitly handed-off B repair
`0fd2eb8fc5f3890d96d701cf2ace82b440de91c7`, tree
`e1638578a2512232d54ad286ac500cb884342b11`, parent 7f. It was carried by
fast-forward after preserving all 20 owned WIP files and recovery stash
`bf2ecfe1dfccf96a211b92fe1888f6ebafa828db`; the pinned stash was applied without
conflicts and retained. Light comparisons confirm the C source/test hashes and
all other WIP were preserved, both overlapping owner/gate files contain the
exact incoming repair plus only C's existing additions, and B's authority/budget
notes and runtime/witness bytes are unchanged. This B repair is native cycle 1,
awaiting its own new two-full-review/final route; it grants no C review/proof.

Current preparation pin is the exact B R2 descendant
`f6f0b15c3422dd8e16aea7965b180fc584eb159c`, tree
`6e06e2b5d8fabde0115d7da219f832b63ab5a2c0`. The same reversible route preserved
all 20 C WIP files in `.context/scratch/first-c-before-b-r2/` and pinned recovery
stash `e10d20833e2acbcc707798897d80b94b6a2bdff2`. Stash application had no
conflicts. Light comparisons confirmed C's frozen hashes and all preparation,
and exact R2 locator, owner/lesson/history, authority and budget bytes alongside
only existing C additions. B cycle 2 of 3 is still awaiting new full reviews;
this is not stable B admission or a C execution/review grant.

Current instruction freshness pin is main
`a03d920eec32bfb3d0de90b9a12535cc57f88d53`, fetched/read on 2026-10-27
separately from the B source pin. Since the previous verified policy main
`80cb0e7063206a9fead36b4e6680c9a83fa3e108`, changed owners are CONTRIBUTING's
B proof/lesson, VERSIONING's exact B minimum and DOCUMENTATION's B ownership.
Those deltas are already present at f6; main and f6 trees both equal
`6e06e2b5d8fabde0115d7da219f832b63ab5a2c0`. AGENTS and AI-policy controls
have no delta. Process authority and required guards are retained.
The incoming set is 0.29.0, with its main docs-gzip cap 73,728 bytes. No rebase
or merge was performed solely for freshness. The eventual stable predecessor and
native review base must still be recorded separately. Current rules are the
[agent guide](../AGENT_GUIDE.md) and
[contribution guide](../../../CONTRIBUTING.md#instruction-freshness-and-handoffs).
The master's provisional draft order is A operations → B portability → C
appUpgrade → D qualification; each predecessor must stabilize before final
integration and counted review. D owns its isolated read-only legacy PostgreSQL
qualification source/test in its own worktree. C's index remains appUpgrade-only
until that later handoff; no competing installer is part of this slice.

## Smallest complete scope and acceptance

Owned source is `packages/platform/src/lifecycle/{appUpgrade,index}.ts`; owned
witnesses are `packages/platform/test/lifecycle/**`, collected by the existing
Node test project. The explicit 2026-10-27 light handoff delegates only this
candidate's serialized lifecycle export, gates/module graph/boundary, existing
consumer, owner-doc/publication/API/changenote integration. All incoming versions,
locks, baselines, caps, exports and A/B/marketing proofs remain unchanged.
Generated API/navigation await actual producers on the later C heavy turn;
do not handwrite them, DCO, prepare native review or count reviewers now.
The API belongs at the default isolated `@openlup/platform/lifecycle` subpath:
Node filesystem infrastructure has no new optional peer or distribution-lifecycle
requirement that would justify a separate package.

`AppVersionSnapshot` declares a version, caller-defined integer schema range and
finite managed-file contents. `planAppUpgrade` only reads; `applyAppUpgrade`
recomputes preflight rather than executing an old serialized plan. Both snapshots
must admit the caller-observed schema version. This proves range admission only,
not database compatibility or an observed migration/backfill result.

Required witnesses cover a real temporary application outside the repository;
preservation of unmanaged brand/policy and upstream-unchanged customized files;
create/replace/remove and replay; stale-plan and divergent-file refusal before
any writes; interruption/resume; byte-exact comparison; canonical roots,
traversal, normalized aliases, links and file-parent collisions. Apply requires
an exclusive maintenance window. Per-file rename provides a local atomic file
replacement, not an all-files transaction, hostile concurrent-writer protection,
power-loss durability or npm installation.

Simplicity pre-check: compare explicit old/current/new bytes using native fs
operations. Already-completed bytes provide resume state without a persistent
journal, lock, source-merging engine, scaffolding framework or new dependency.
Do not execute SQL, npm, deployment or arbitrary hooks from this API. Adopter
customizations in a changed managed file require human reconciliation, while an
upstream-unchanged file carries no authority to overwrite its customization.

## Remaining full-programme dependencies

The accepted first slice does not discharge inherited portable PostgreSQL
installation/preflight, managed/operator-provisioned roles, separate connection
purposes, actual restricted domain operations, installed two-version npm
consumption, database expand/contract and runtime/OCI/OIDC/S3 recipe obligations.
Docker/self-host, Neon and RDS/Aurora must share actual conformance evidence;
unobserved hosted providers and Netlify execution remain unproven. No accounts
or resources may be created through this lane.

The existing [migration runner](../../../packages/platform/src/migrations/postgresRunner.ts)
already owns exact catalogue/prefix validation, advisory locking, transactions
and replay. It accepts an explicit pool factory; separate migration ownership can
inject a direct one-connection pool and close it afterwards. The
[gateway](../../../packages/platform/src/data/postgresGateway.ts) has both generic
actor/service role transitions and capability-local role-free lanes. The native
catalogue creates no universal `service_role`.

Confirmed portability blockers, reported to Master M14:

- [Actor bootstrap](../../../db/platform/migrations/20260810180001_self_host_actor_auth.sql)
  unconditionally creates cluster-global `anon` and `authenticated` roles.
- [Acquisition foundation](../../../db/platform/migrations/20260816140000_acquisition_case_foundation.sql)
  requires SUPERUSER, creates two capability roles and checks exact membership;
  its documented migration/application login coupling prevents a claim of generic
  restricted-admin full installation with separate runtime credentials.

Immutable history must remain unchanged. A qualified compatible forward/control
or catalogue decision belongs to the programme owner; silently widening grants,
inventing service roles or omitting migrations is outside this slice. The
[bundle witness](../../../tests/postgres/bundleNative.test.ts) is the smallest
existing actual domain operation: EXECUTE alone fails; selected invoker grants
allow activation; neighboring deactivation remains denied. A future lifecycle
proof must use a real restricted login rather than owner access plus SET ROLE.

The proposed connection seam is explicit purpose-labelled runtime, direct
migration and optional read inputs, with verified TLS/local plaintext,
timeouts and pool limits. Keep pg PoolConfig in infrastructure and selected
effective-privilege probes finite; this is not a new permission broker or
transfer/recovery engine. This proposal is not a landed API.

## Execution and evidence

Read-only fit agents inspected existing migration/role and application tooling.
One bounded agent authored only the lifecycle files; coordinator owns integration.
Actual author contexts are coordinator `01a17945-72cc-71d3-afcf-a8f04fa8503f`
and source writer `01a17946-9893-7a51-a8ea-74d29b00d048`. Early source-only
review contexts were `01a1794e-5170-7b90-a8c6-49c436567681` and
`01a1794e-6954-7091-bdce-6845b359383f`; they are not counted native reports
and will not be reused as fresh final reviewers. Runtime source author
`01a179fb-1f32-7b33-b2e7-14834bad4de5` works only in the separate tests-only
runtime-drain tree and has not changed this first candidate.
The inherited full catalogue restrictions were discovered before changing an
installation path. No native review session or repair cycles have been consumed.

Pinned runtime is available at
`/opt/homebrew/Cellar/node@24/24.21.0_1/bin`: Node 24.21.0, npm 11.19.0.
Dependency installation was submitted to `openlup:m14:heavy` with a bounded
300-second wait and 600-second execution budget. It refused with exit 74 after
301 seconds: `queue_timeout`, `machine_overloaded` (observed host load 46.17,
limit 24). No installation started in that attempt. When host load fell to
17.66, a fresh bounded admission installed this tree's own 727 dependencies in
five seconds with `npm ci --ignore-scripts --no-audit --no-fund` (exit 0).
The cheap `npm run oss:published-tree -- --policy` ran and reported fresh
computed bindings and one unanswered `platform-substrate` documentation
obligation in the master-owned package README. Shared integration must settle
that obligation. Do not borrow another tree's
node_modules or bypass broker refusal. Freeze the final stack before two fresh
independent committed-candidate reviews and the required final verification.

Two independent cold Sol 6.1 source-only reviews inspected the uncommitted
source and witness. These were early feedback, not native PASS reports, and
consumed no native repair cycles. The filesystem review found C-E1: malformed
UTF-16 path keys could encode to one UTF-8 filename and overwrite a candidate
file. The direct repair applies UTF-8 round-trip validation to paths as well as
contents; a two-alias regression now requires refusal without tree mutations.
That regression passed in the focused run below. The I/O reviewer found no blocker under the
exclusive-maintenance boundary and confirmed that the SIGKILL witness requires
a fresh candidate build before execution. Ordinary permission bits are retained;
replacement does not promise ownership, ACL, xattr or special-bit preservation.

Working-tree proof on the pinned runtime, serialized through `openlup:m14:heavy`:

- `npm run pretest`: core, outbox and platform TypeScript builds passed.
- First focused Vitest run: 34/35 passed, with the symlink witness timing out.
  Diagnosis: the test's recursive string-only directory listing followed a
  symlink cycle. Replaced that helper with explicit lstat-based recursion; it
  records links without traversing them. No production change was needed.
- `npx --no -- vitest run --project=node packages/platform/test/lifecycle/appUpgrade.test.ts`:
  35/35 passed, 214 ms total / 104 ms test execution, including the actual
  process SIGKILL, caught I/O interruption, replay and C-E1 alias refusal.
- `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression`:
  exit 0. Its binary used runtime resolution because install scripts were
  deliberately disabled; this is not a product failure or test skip.

- `npm run lint`: exit 0, including prerequisite builds, file-wide-ignore
  checks, structural scan, eight structural rule-test groups and ESLint.
  ESLint reported 33 warnings outside this slice and no errors.

- `npm run oss:published-tree -- --typecheck`: exit 0 across app, node, API,
  MCP and tests projects; zero unresolved edges and zero consumer-side errors
  outside the signed debt.

Installed-consumer proof,
shared metadata/owner integration, signed commit, final native reviews and full
verification remain pending. These working-tree observations are not a final
committed-candidate verification stamp.
The preceding stack must include main's marketing change; measure cumulative
package headroom again on that actual integrated candidate. Earlier lane previews
are not certified budgets for the new predecessor.
The master's bounded current A–D allocation is `code.maxFiles: 2547` and
`root.maxFiles: 2601`. Its observed A/K3 pack had 2526 code / 2580 root files,
with all byte caps passing; the additional 21 are the frozen B4/C2/D1 production
TypeScript files counted as source, JS and declarations. This is a named current
module forecast, not future pack proof or capacity for further source/assets.
Byte, documentation and browser caps are unchanged. C edits no caps and adds no
production files beyond its two frozen files. Every actual integrated pack must
be rechecked; extra files or a byte crossing require a separate bounded read.

The incoming exact B R2 metadata carries code/root file caps 2574/2628 and a
code-gzip cap 1,650,631 bytes (R1 added 128 to the initial B minimum 1,650,493;
R2 adds exactly 10). These supersede the historical forecast above as
the actual preparation inputs; no C allowance or passing C measurement is
inferred. This light turn preserves every cap/baseline, version and lock byte.

Current light preparation adds the experimental Node-only `./lifecycle` rail
without optional peers/contracts, its explicit graph and authored publication
routes, existing boundary/type/refusal and cold-consumer operations/falsifier,
short package/owner guidance and disposable application recipe, and one own
change fragment. The original two production files and 35-case test stay
byte-identical. The installed proof is authored but unexecuted on B: it imports
the exact public export in a separate app, rejects a stale managed edit before
other writes, kills a child after a real replacement, resumes/replays and runs
the resulting app while retaining brand/theme. It proves file transitions using
one selected artifact, not an npm two-release upgrade or actual SQL matrix.

No install/build/lint/test/PG/full verify/common-resource waiter is authorized
until C's explicit heavy turn. E's current bounded execution and B's full proof
retain priority. If B changes, carry the required delta/history before final
proof. The separate runtime-drain tree remains tests-only and is excluded from
this first C candidate. Native history has no prepared session or consumed
repair cycles; early reports remain non-counting feedback.

Provisional-parent update: B7f's two fresh reviews returned one PASS and one
material Unicode metadata publication/readback-cap finding. B is repairing that
same task; no stable two-PASS/final proof is inferred. C's B7f integration remains
light preparation only. Carry the exact repaired B delta/history at the master's
next handoff before any final C proof, DCO or counted review. No C heavy turn
or common waiter was granted by this update.
The exact R1 repair is now present and preserves the public human authority
amendment. Its encoded descriptor ceiling is shared by publication/readback;
this is B's necessary repair, not a C source change or new C allowance. C still
waits for stable B two-PASS handoff and its explicit heavy GO before producers,
current package measurement, DCO or counted review.

## First C finite non-Docker producer turn, 2026-10-27

Master confirmed exact f6's two fresh full reports and native `reviewed` source
state; B's Docker/full evidence remains missing. One C turn was admitted with
no wait, tooling 2 CPU / 2048 MiB, 600-second maximum. The runtime witness's
public-import lint passed first, with no unit/PG rerun. Own C npm ci installed
727 dependencies in seven seconds; all three 0.29.0 prerequisite builds passed.
The native API producer generated lifecycle.api.md; all incoming API reports
remained byte-identical. Frozen source/test, versions, locks and caps stayed exact.

The actual docs producer updated SOURCE_MAP but policy refused the five newly
catalogued untracked paths as missing materialized inventory. Their bytes need
Git index admission, then a real producer/policy rerun; neither filesystem
presence nor a generated row establishes a passing inventory.

The native `measurePack`/`checkPackBudget` working-tree preview then stopped the
batch with three actual crossings: code gzip 1,656,024 > 1,650,631 (+5,393);
tarball 1,928,554 > 1,925,000 (+3,554); unpacked 8,980,625 > 8,970,000 (+10,625).
Code/root counts 2571/2625 and root docs gzip 64,796 passed their existing caps.
Browser measurements and all later C unit/boundary/type/policy/neutrality/lint,
cold/PG/full/native gates did not run. No cap was changed or extra headroom granted.
Archive SHA-256 is `11ccef19fcbdf737942ecb413506f16ad8073db7a61d23419d6e976b0a234982`;
the ignored existing producer-turn directory retains the actual archive, native
measurement JSON and log. The broker was empty after exit 1.

Propose only the three observed minima, with owner/fragment notes and actual
approved-input remeasurement before proof; cap bytes themselves can affect the
tarball. No rounding or future allocation is inferred. The existing compact
scratch packet carries the exact proposal. Execution had completed before the
master's medium-setting message arrived; do not rerun it to change attribution.
The next routine execution continuation uses Sol 6.1/medium when explicitly
granted. No DCO or counted C review has begun.

Self-retro so far: stage new authored publication paths before materialization;
the early native measurement exposed all three caps before broad tests. Old/new
byte recognition removed an unnecessary journal.
Early inspection exposed Unicode-normalization and malformed-string encoding
aliases; validate filesystem encoding as well as normalized path identity before
admitting multiple file targets. Completion evidence and the
terminal self-retro remain to be recorded here.

## C-P1 exact directory-entry ownership repair, 2026-10-27

Master authorized this necessary pre-native LIGHT repair at the same provisional
B parent `f6f0b15c3422dd8e16aea7965b180fc584eb159c`. The original source author
`01a17946-9893-7a51-a8ea-74d29b00d048` is the sole source writer for the bounded
repair in the existing reader and one discriminating real-filesystem case in the
existing test file. No index/export, control, classifier, ignore or runtime-tree
change is included. No execution, build, test, lint, API generation, pack, database,
DCO or review is authorized on this light turn. C native history remains zero;
no counter or review budget resets.

The coordinator's explicit script-file launch of
`/private/tmp/m14-c-path-case-probe.mjs` observed the actual red on built artifact
SHA-256 `6bbb79f978a838dd4eedf10fd8b3b671569bf2b980b0b0006ad1c0076c862b3f`:
on the case-insensitive filesystem, an unlisted `MANAGED.txt` with predecessor
bytes was unlinked through managed key `managed.txt`. This violates exact
scaffold ownership without concurrency. The earlier stdin broker launch executed
no probe; it is not red evidence. The ignored
`.context/scratch/c-p1-before-repair` baseline artifacts remain untouched.

The smallest repair checks the traversed parent directory's entries after a
successful lstat of each component and refuses any component without an exact
spelling match. An ENOENT remains absence on a case-sensitive store. This also
conservatively refuses normalization aliases resolved by the filesystem, while
retaining the existing Unicode, symlink, byte, replay and permission guards.
It adds no whole-app walk, registry, cache, production file or dependency.
One new case observes real leaf/parent case resolution, requires exact conflicts
and complete preservation where aliases resolve, permits the safe absent-path
no-op otherwise, and proves exact-spelled removal still works. The suite's prior
35 cases and generated API/pack observations remain historical; 36 cases are
now authored, with new red/green/build/measurement evidence pending the master's
next finite non-Docker turn. No PASS is claimed for this repair.

The previous size proposal is suspended. All caps remain unchanged; a fresh exact
measurement must precede the final API/budget/notes read. The coordinator still
owns direct execution registration for this already-approved test path in
`scripts/oss-publication-contract.ts` after the policy refusal; that control
change is outside this repair. Rethink lesson: matching bytes through a filesystem
alias does not establish ownership of the actual directory entry; validate its
exact spelling before assigning write or removal authority.

Inventory recovery history is separate: the Sol 6.1/medium worker staged exactly
the six approved new files and its one immediately admitted cheap producer then
exited 1 at the closed direct-execution inventory. Visibility was resolved, not
policy PASS. The necessary metadata fix registers exactly this existing test
path in `PUBLIC_EXECUTION_ENTRYPOINTS`, with owner explanation; the classifier,
other entries and caps are unchanged. No post-registration producer ran. Restage
the approved source/test/notes after this light C-P1 delta before the next
producer so the index and materialized candidate agree.

## C-P1 finite proof and replacement budget observation, 2026-10-27

The authorized Sol 6.1/medium non-Docker continuation ran against exact B R2
`f6f0b15c3422dd8e16aea7965b180fc584eb159c`. A fresh policy fetch on resume
confirms `origin/main` remains `80cb0e7063206a9fead36b4e6680c9a83fa3e108`;
this policy revision is separate from the code parent. Master has confirmed B's
native `reviewed` source; its Docker/full acceptance remains outstanding.

One fail-fast common-resource admission had zero wait, 2 CPU / 2048 MiB and a
600-second maximum. The native policy/docs producer passed five obligations
with zero unanswered, closing both prior inventory refusals. All three
prerequisite builds passed. The lifecycle selector passed 36/36 (116 ms test
execution). The unchanged explicit script-file probe on rebuilt artifact
SHA-256 `902379768688e3da30e6cdc0b40fcfdfb261cd11161697e40bffac9f0f990091`
observed alias resolution, preservation of the unlisted file and an
`AppUpgradeConflictError`. This closes the observed C-P1 regression for this
working tree. The native API updater left all incoming reports byte-identical.

The actual native pack measurement then stopped at three unchanged caps:
code gzip 1,656,258 > 1,650,631 (+5,627); tarball 1,928,766 > 1,925,000
(+3,766); unpacked 8,981,253 > 8,970,000 (+11,253). Code/root files 2571/2625
and docs gzip 64,796 bytes / 5 files fit the existing limits. These fresh
observations replace the suspended pre-repair proposal; they are not approved
cap changes. Archive SHA-256 is
`f29d4f9a62391353f63097dabd43a9653436c4ccca0859122126770524b28a1b`.
The existing ignored producer directory's `c-p1/` child retains the archive,
native measurements/findings, phase logs, probe JSON and pre/post input hashes.
All 97 frozen inputs were unchanged; exactly 23 approved paths were staged.

No caps, baseline, versions or locks changed. Only the three observed minima
are proposed for the applicable bounded owner read; gate-number edits can
change compressed bytes and require approved-input remeasurement. No rounding,
future allocation or release authority is inferred. The existing compact
scratch packet carries this current proposal and preserves the old observations
as history. No new plan, runner or registry was introduced.

The batch exited 1 at the pack findings and released the broker without a
waiter or retry. Browser measurement and broader boundary/type/neutrality/lint,
cold/PG/full proof remain unexecuted on this candidate. No Docker, DCO, native
prepare or counted review ran; C native history remains zero. The next heavy
turn requires the applicable budget read and explicit finite GO. The separate
runtime candidate remains excluded.

Self-retro for this stopped run: admit the approved new paths before the
materialized policy check; preserve exact filesystem entry ownership even when
bytes match through an alias. The four-line direct traversal repair retained
the required controls without a journal or registry. Stop-first measurement
avoided broad proof while three budgets still refuse the candidate.

## Bounded technical read and light budget application, 2026-10-27

Master M14 (`01a17909-94d4-7cc0-b40f-9a8782a0986f`) conveyed the delegated
technical API/runtime/size read PASS for the actual lifecycle API/source, C-P1
entry-spelling refusal, public export/experimental gate, 36-case and external
probe evidence, policy recovery and the exact measured archive. This records
the delegated read, not a personal human quote, DCO or final candidate review.
It authorizes only three exact minima in `release-gates.json`:
`pack.code.maxPackedBytes` 1,650,631 → 1,656,258 (+5,627),
`pack.maxPackedBytes` 1,925,000 → 1,928,766 (+3,766), and
`pack.maxUnpackedBytes` 8,970,000 → 8,981,253 (+11,253).
Those values are now applied, with concise same-change VERSIONING and existing
fragment notes. File/docs/browser caps, released baseline, versions, locks and
incoming exports are preserved. No additional source, abstraction, rounding or
future runtime/qualification allocation is included.

This is LIGHT preparation while the root-owned B package turn and E source gap
retain priority. Root reports Docker responsive after the human-authorized
graceful host restart; that recovery grants no C execution. Current source,
36-case/policy/API evidence is retained without an unchanged rerun. Freeze this
candidate and use the existing compact scratch packet for its computed identity
and remaining checks. Actual approved-input pack remeasurement and the remaining
boundary/type/neutrality/lint/installed-consumer proof await an exact finite turn;
metadata cap edits may themselves change packed size. Final stabilized technical
read before DCO, two fresh committed-candidate reviews, mandatory final proof and
native/delivery steps remain outstanding. C native history and cycles remain zero.

Self-retro: applying only the three observed minima preserves the budget control
without speculative headroom. Keep this delegated read separate from both the
earlier observations and the final stabilized candidate read.

## Approved combined C+D delivery shape, 2026-10-27

Master M14 amended delivery within the original approved C and D outcomes:
first C and D's one frozen read-only legacy PostgreSQL role qualifier will share
one candidate on exact B R2 `f6f0b15c3422dd8e16aea7965b180fc584eb159c`.
This consolidates full proof, CI and queue delivery without adding a programme
goal, authority, test obligation or review cycle. Both original acceptance sets
and exclusions remain binding. Runtime drain remains a separate candidate.

D's existing helper is limited to scope
`legacy-fresh-bootstrap-role-prerequisites` and `rolePrerequisitesMet`.
It observes selected legacy role prerequisites through one fixed parameterized
query; it does not certify install readiness or add role/DDL support. Carry its
source unchanged first, retaining its unit and actual PostgreSQL positive/refusal
evidence and source-author history. Necessary lifecycle exports, existing
boundary/installed-consumer checks, owner/catalogue integration and later actual
API generation use existing seams only. No new package, dependency or runner is
authorized. C-P1 and all 36 existing C cases are preserved.

Read-only inspection of D's existing task/source/tests is complete. Exact frozen
hashes and actual source-author IDs must arrive in Master's handoff and be checked
before source carry. The existing D task record will be carried and updated for
this delivery shape in this integration worktree; its author worktree remains
untouched. All actual C/D authors enter the eventual combined native intent and
are excluded from counted reviewers. Neither candidate has DCO, native history
or consumed repair cycles; all preliminary evidence and failed attempts survive.

The C-only three-cap read, archive and measurements above are now historical
and insufficient for combined-code admission. Existing cap values are not
automatically increased: measure the actual combined artifact and obtain the
applicable new bounded read, with no rounding or future headroom. The existing
compact packet tracks this amendment and supersedes its C-only frozen identity
as a combined-readiness claim. B's focused host discriminator retains the next
execution slot. No heavy producer, test or waiter is authorized before exact GO.

Self-retro: consolidating these already-approved lifecycle outcomes avoids a
separate verification/delivery round while retaining both acceptance sets and
one truthful artifact identity. A delivery-shape change does not extend the
C-only budget evidence to additional code.

## Checked D handoff and authored combined integration, 2026-10-27

Master supplied four untracked D files; D's HEAD
`80d27906a6d4bc679c011871948e88d185bb1c63` is not their byte identity.
Verified every SHA-256 and size before carry, and preserved read-only original
copies in the existing ignored scratch evidence. Original identities:

- Source `postgresInstallQualification.ts`: 6,230 bytes,
  `00940a42e48c3712e24a96459b3cf5a25bce4cee8c0d766c9a268f47cb296da0`.
- Package unit witness: 2,280 bytes,
  `8ed73e35e17b92ff7b1c1848c39b1a6b727c7673c1a78665fde93748ab0206c6`.
- Root PostgreSQL witness: 5,933 bytes,
  `6da0160f622c6109ab1fd4c662b654ef2740a2739dbffa5bcc49d91ae9fbcb47`.
- Existing D task record: 13,199 bytes,
  `d08ec4a55c00c05197b4c0b590c240960607eac4a28ce09ee6ae031e4f4a63ff`.

D source author is actual session `01a1794e-d18c-7200-a544-59abafd34d3a`.
Combined native intent must retain Master coordinator
`01a17909-94d4-7cc0-b40f-9a8782a0986f`, C integration coordinator
`01a17945-72cc-71d3-afcf-a8f04fa8503f`, C source author
`01a17946-9893-7a51-a8ea-74d29b00d048` and D source author as actual actors;
none may be a counted independent reviewer. D's advisory agents
`/root/install_control_fit`, `/root/roles_import_fit` and
`/root/ephemeral_installer_challenge` have no supplied provider-session IDs;
do not invent IDs or count their advice as native review. Earlier C source
reviews and the routine producer context remain preliminary and will not be
reused as fresh counted reviewers. No combined native session is prepared yet.

Carried D source and package unit witness byte-for-byte. After adding the
declared lifecycle exports, changed only the root PostgreSQL witness's known
preliminary deep import to `@openlup/platform/lifecycle`; all actual database
cases remain. D's original executed proof is six tests TOTAL across package
and real-PostgreSQL selectors, 5.12 seconds overall / 4.87 seconds in PostgreSQL,
on its original working source. It is neither six unit plus six database tests
nor integrated-candidate proof. Its initial Docker setup failure and one lint
error remain history. No DCO, native receipt, expiry or repair cycle existed.

Authored integration uses the existing lifecycle export/gate and boundary source
inventory. The existing installed consumer now invokes the finite query/report,
checks positive prerequisites, superuser refusal and redacted failure, and
compiles the public request/query/report types in both existing resolution
modes. A false-admission mutant must fail that consumer assertion. These
injected observations prove installed API behavior only; retained actual
PostgreSQL witnesses establish the separate database facts. Updated the existing
package/architecture/data/runtime/reference owners, exact publication rows and
documentation routing, plus the same fragment and C/D task records. No new
package, dependency, runner, DDL/control or qualified source was added, and no
historical data-import or runtime-drain behavior was introduced. No generated
API/navigation bytes were handwritten.

C's appUpgrade source, 36-case test and C-P1 fix remain exact; only lifecycle
index exports gain D. D source has no implementation change. All current cap
numbers, file/docs/browser limits, released baseline, versions, locks and
incoming exports are preserved. The C-only technical read and measurements
remain historical; actual combined API generation, inventory/policy, build,
focused and installed proof, package measurement/new bounded read and final
stabilized technical read await the explicit finite turn. Host recovery is not
an execution grant. No producer/test/Docker/native/PR operation ran in this light
integration. Runtime drain stays isolated with its own existing evidence.

Self-retro: hash-and-size verification before unchanged carry made the source
handoff reviewable despite untracked originals. Fixing the single known import
at the declared export seam preserves the real database witness without a rule
exception. Consolidation retains both original proof histories rather than
claiming either old tree verifies the new combined artifact.

## Actual combined non-Docker preparation/measurement, 2026-10-27

Master authorized one finite combined preparation turn while B's Docker route
was blocked. The existing Sol 6.1/medium routine executor used this tree's own
Node 24.21.0/npm 11.19.0 and process-lifetime `caffeinate -is`. One normal
`openlup:m14:heavy` tooling admission waited zero seconds at 2 CPU / 2048 MiB,
600-second maximum. No common waiter, dependency install or Docker call occurred.

In sequence, all three prerequisite builds passed; the actual native API
updater passed with all incoming reports except lifecycle byte-identical;
navigation/policy passed six obligations with zero unanswered; the exact two-file
node selector passed 39/39 (36 C plus three D unit cases, 219 ms test execution).
The existing external C-P1 probe was not rerun. D's actual PostgreSQL proof
retains its original six-total selector attribution; no integrated PG PASS is
claimed. Only the expected generated SOURCE_MAP and lifecycle API changed among
101 frozen inputs. All frozen source/test bytes remained exact.

The actual cumulative npm archive then refused three unchanged byte caps:

| Field | Current cap | Actual / proposed minimum | Delta |
| --- | ---: | ---: | ---: |
| pack.code.maxPackedBytes | 1656258 | 1659891 | +3633 |
| pack.maxPackedBytes | 1928766 | 1932480 | +3714 |
| pack.maxUnpackedBytes | 8981253 | 8995279 | +14026 |

Code files 2574/2574 and total files 2628/2628 meet their exact existing limits.
Docs gzip is 64,992/73,728 bytes and five/ten files. No browser measurement ran.
These are observed combined working-tree minima for the applicable technical
read, not approved caps or rounded allowance. The previous C-only read remains
historical. No caps, baseline, versions, locks or incoming exports changed.
Gate-number edits can change packed bytes and require actual approved-input
remeasurement. This proposal adds no later runtime or qualified-installation
headroom.

Combined lifecycle API SHA-256 is
`786e4874f6fca5a2037bf5010d5dc332315eb1a7b6e3005f6d8a666e11b12e13`;
built C JS remains
`902379768688e3da30e6cdc0b40fcfdfb261cd11161697e40bffac9f0f990091`;
built D JS is `74f4b3aada75e9d8d6edebf6ad9e62108c32e23e3c9e82b2852913ecd18bad4c`.
Actual archive SHA-256 is
`84a822e7fee9a74c0fb4eb49f889d1a9c14530eea720ab5129a7548fe4e42bf1`.
The producer's generated-output staged tree was
`e3cc2ee354747187a79f45f0850494f333c02381`, before these result-note updates.
The existing ignored producer evidence's `combined-c-d/` child preserves actual
commands/phase logs, 101 pre/post input hashes, built hashes, archive, entries
and native measurements/findings. The compact packet records the subsequent
readiness-tree identity separately; none is a signed candidate or native receipt.

The batch exited 1 at measured cap refusal without retry or cap edits; broker
locks/waiters and the matching caffeinate process were absent after completion.
No PG, cold-package/full, DCO, native or PR work ran. Remaining boundary/type/
neutrality/lint/browser/installed-consumer proof, actual PG/cold/full acceptance,
new bounded budget read, approved-input remeasurement and final stabilized read
before DCO retain their original gates. Source and combined native history are
unchanged; no cycles or expiry were reset. Runtime/E/F remain separate HOLD.

Self-retro for this stopped run: the combined selector added exactly the three
D unit cases without duplicating the unchanged external C-P1 probe. Actual
cumulative measurement exposed the added code while existing file caps still
hold exactly; no useful further simplification was found within this finite turn.

## Combined technical budget read and exact light edits, 2026-10-27

Master independently read the actual combined archive/measurements, generated
125-line lifecycle API, D's unchanged fixed parameterized read-only SELECT and
types, public export/consumer/falsifier/real-PG integration, policy six/zero and
39-unit PASS. This is the delegated combined technical API/budget read, not a
personal human quote, counted review, final pre-DCO read or full proof. D's
three actual PostgreSQL cases remain owed on the combined candidate.

Applied ONLY the three approved observed minima:
`pack.code.maxPackedBytes` 1,656,258 → 1,659,891 (+3,633),
`pack.maxPackedBytes` 1,928,766 → 1,932,480 (+3,714), and
`pack.maxUnpackedBytes` 8,981,253 → 8,995,279 (+14,026).
The cumulative increases against B's 1,650,631 / 1,925,000 / 8,970,000 values
are +9,260 / +7,480 / +25,279. Existing VERSIONING and fragment notes now clearly
record the combined decision; all earlier C-only reads and measurements stay
historical. D adds three packed files within the smallest adequate three-source-
file/one-existing-entry solution. No SDK, DDL, runner or abstraction is added.

Code/total file caps remain exactly 2574/2628; docs limits 73,728 bytes/ten files,
all browser caps, released 0.28.0 baseline, versions, locks and incoming exports
are unchanged. No future runtime/E/F or qualified-installation allowance,
rounding or invisible cap adjustment is included. Metadata edits require actual
approved-input remeasurement; prior measured bytes are not a post-edit PASS.
This light turn ran no producer/test/Docker, DCO, native or delivery command.
Current source/API/pack evidence and actual author exclusions are retained;
native histories/cycles remain zero. The existing compact packet records the
post-edit input/tree/diff identities and remaining proof. B retains the next
exact pgTAP→conditional-full slot; C has no heavy waiter or new execution GO.

Self-retro: a separate exact combined read prevents the prior C-only allocation
from silently funding additional code. Apply only measured minima and preserve
actual remeasurement as a gate, since editing the budget metadata affects bytes.

## Approved-input measurement PASS and stopped remaining proof, 2026-10-27

Master granted one finite proof turn, measurement first and remaining required
working-tree checks only after actual package PASS, stopping on the first failure.
Fresh policy fetch still resolves main to
`80cb0e7063206a9fead36b4e6680c9a83fa3e108`, separately from source parent f6.
Both sequential immediate common-marker admissions used the normal tooling
2 CPU / 2048 MiB profile and process-lifetime caffeinate. The remaining-proof
invocation actually specified `--execution-timeout 600`; its independent normal
resource metadata reported 900 seconds expected runtime. The installed watchdog
enforces the former; no test timeout, worker count, control or profile changed.

Approved-input native remeasurement PASS has zero findings. Actual code gzip
1,659,891 / tarball 1,932,480 / unpacked 8,995,279 bytes equal their exact approved
caps; code/total files 2574/2628 equal their caps; docs 64,992 bytes/five files
fit 73,728/ten. New actual archive SHA-256 is
`0d8012da1eaf1c728135c2bd5bed0fb4c92e4f67921ac4624abaf7a5010b89d7`.
All 8,212 frozen tracked/built input hashes stayed exact, including current
source/tests, combined API, gate metadata and built artifacts. The existing
producer evidence's `combined-c-d-approved-remeasurement/` child preserves
actual commands, archive/entries, native measurements and input comparisons.
This is working-tree artifact proof, not the later clean-commit cold/full gate.

Remaining-proof results, before any source/result-note edit:

| Phase | Result | Seconds |
| --- | --- | ---: |
| Focused AST | PASS | 2.233 |
| Package manifest-only | PASS, three packages/no findings | 0.204 |
| Documentation policy | PASS | 4.259 |
| Published-tree typecheck | PASS, no errors/unresolved edges | 24.520 |
| Public CI neutrality | PASS, zero increases | 5.392 |
| Native platform API check | PASS | 0.526 |
| Lint | FAIL, exit 2 | 6.856 |

Lint's three prerequisite builds, structural scan and all eight structural
rule-test groups passed. ESLint 10.8.0 then discovered this task's historical
`.context/scratch/first-c-before-b-r1/eslint.config.js` and failed ENOENT reading
its absent sibling `package.json`. R2 also contains a preserved executable
config. These are archival integration snapshots, not candidate configurations.
Do not weaken lint/AST ignores or controls. The smallest proposed recovery is
moving only those owned historical backup directories outside the candidate's
lint traversal, preserving exact bytes/hashes and mapping the original paths
in existing notes. No recovery or retry ran on this stopped turn.

Unexecuted after the first failure: native browser caps, package boundary
selector, combined 42-case selector (including D's three real PostgreSQL cases),
and actual-packed installed-consumer/falsifier harness. No Docker fixture began,
so no owned database cleanup was needed. Prior combined 39-unit and historical
D six-total proof attribution remain unchanged; do not claim integrated PG or
consumer PASS. The existing `combined-c-d-proof/` evidence retains phase commands,
logs/durations, 8,212-input comparison (no changes), archive preservation and
actual execution budget. Both broker/caffeinate instances released; no waiter,
retry, cap edit, DCO/native/full or delivery action occurred. C/D native history
and cycles remain zero. Source/API/caps are unchanged; only these existing result
notes and compact packet record the stopped run.

Self-retro: preserving executable backup configs inside the lint traversal cost
the 6.856-second lint attempt and blocked later proof. Archive task snapshots
outside the candidate tree while retaining their byte provenance; keep the
actual lint command and controls unchanged. Stop-first sequencing prevented a
partial proof run from appearing complete.

## Archival recovery, second stopped lint and recurring lesson, 2026-10-27

Master authorized moving only owned ignored historical directories containing
executable ESLint configs outside checkout traversal. Exact R1/R2 backup
directories were renamed to
`/private/tmp/openlup-m14-lifecycle-backups-01a17945/{first-c-before-b-r1,first-c-before-b-r2}`.
All 44 files and entry kinds/modes/links retained their byte/hash identities;
full old-to-new mappings and inventories are in existing ignored scheduling
notes. Original failed evidence remains immutable. No ignore/rule/config,
production/API/cap or other task's files/processes changed.

Root accepted `a709abbd3c41e0f7c0068b1d82f265e22dcd49c3` as the readiness tree
for the two prior result-note updates; c717 remains the original proof-input
history. The resumed exact lint admitted immediately under the same normal
profile/caffeinate and 600-second execution watchdog (separate expected metadata
900). It stopped with exit 1 after 37.354 seconds: builds/AST/eight rule-test
groups passed, but ESLint found the old private import in the immutable original
`.context/scratch/d-handoff-original/tests/postgres/m14InstallQualification.test.ts:4`.
The candidate test's public import remains correct. There was one error and
33 warnings. All 8,376 current tracked/all-package-dist hashes stayed exact;
the approved archive remained `0d8012da1eaf1c728135c2bd5bed0fb4c92e4f67921ac4624abaf7a5010b89d7`.
No browser/boundary/42-case real-PG/consumer stage ran or Docker fixture started.
Broker/caffeinate released; no retry or corrective edit ran. Actual evidence is
retained in the existing `combined-c-d-lint-recovery/` producer child.

The smallest proposed next environment recovery is moving only the four-file
owned original D handoff archive outside checkout traversal with hashes/mapping
preserved, rather than editing historical imports or weakening lint. It has not
run. Master also explicitly required the recurring M14 A/C lesson route after
this batch stopped: CONTRIBUTING now has one brief practical instruction in its
existing lint owner and one dated Review-lessons pointer to that owner. It covers
archival source/config copies, retains actual test-fixture semantics, and adds
no hook, guard, ignore, service or separate learning PR. This necessary same-
delivery instruction delta needs final policy/full proof and two fresh full
reviews with the final candidate; it creates no programme goal or native cycle.

Self-retro: two archival placements cost 44.210 seconds of failed lint attempts
combined. Preserve originals outside executable tool traversal; Git-ignore alone
does not bound configuration or source discovery. The documented lesson is now
promoted within its existing owner instead of leaving a repeated private rule.

## Regrouped recovery and all allocated working proof PASS, 2026-10-27

Before further repair, read and applied the mandatory existing Regroup procedure:
recorded both executed failures, their shared historical-source/config discovery
cause, mandatory lint owner, smaller whole-archive relocation alternative and
one next exact-lint discriminator/expected current-candidate result. This used
existing notes, not a second counter, cycle, review round or new authority.
Then relocated exactly the additionally authorized owned ignored historical
`d-handoff-original` (four files), `c-p1-before-repair` (six) and
`first-c-before-b` (five) beside R1/R2 under
`/private/tmp/openlup-m14-lifecycle-backups-01a17945/`, retaining the same names.
All bytes/SHA-256/kinds/modes/links/root modes compare equal before/after; full
old-to-new mappings and inventories remain in existing ignored scheduling notes.
No active producer/pack/extracted/runtime/current input or other task was moved.

One normal immediate tooling 2 CPU / 2048 MiB/caffeinate batch on frozen
`aef4363e21be3d0900436c602f7fd6628adad22b` passed every remaining stage:

| Stage | Actual result | Seconds |
| --- | --- | ---: |
| Exact lint | PASS, zero errors/33 warnings; builds/AST/eight rule groups PASS | 42.397 |
| Native browser caps | PASS, all 17 entries, no findings | 1.159 |
| Package boundary | PASS, 2609/2609 parameterized cases | 7.434 |
| Combined lifecycle/actual PostgreSQL | PASS, 42/42 across three files | 3.876 |
| Full current npm-packed consumer/falsifier harness | PASS, 89/89 | 37.706 |

The combined selector executes all 36 C cases, three D unit cases and three
actual PostgreSQL cases. Installed proof uses actual current npm-packed fixtures
with C's no-op apply and D's false-prerequisite-admission falsifiers; it is not
the later clean-commit full cold pipeline. No historical scratch source/config
remained in lint diagnostics. The 33 warnings are retained, not suppressed.
All 8,376 tracked/all-package-dist input hashes stayed exact during the batch,
including the already-approved recurring CONTRIBUTING instruction. Approved
archive `0d8012da1eaf1c728135c2bd5bed0fb4c92e4f67921ac4624abaf7a5010b89d7`
and source/API/cap identities remain exact; no passed measurement/cheap gate was
rerun. Evidence is the immutable existing `combined-c-d-regroup-proof/` child.
Total stage time was 92.572 seconds, within the actual 600-second watchdog;
normal expected-runtime metadata remains separately 900 seconds. Broker and
caffeinate released; Docker confirms no owned `m14-install-qualification-*`
container remains. No manual/foreign cleanup or power/tooling setting changed.

Master confirmed B PR400 merged on 2026-10-27 as main
`a03d920eec32bfb3d0de90b9a12535cc57f88d53`, with exact f6 as a parent and tree
`6e06e2b5d8fabde0115d7da219f832b63ab5a2c0`. The fresh fetch confirms f6 is
the current merge base and is on actual main. This predecessor-only landing
preserves source/proof without a catch-up merge/rebase or native cycle.

All allocated working-tree proof now passes, preserving both failed attempts,
their logs and the actual regroup/recovery lesson. Final stabilization changes
only these existing C/D evidence notes and the ignored compact packet. Required
remaining gates are Root's final stabilized API/notes/budget/recovery read before
DCO, signed candidate, two fresh independent FULL reviews (including simpler
solution/control retention), normal committed native/full/cold/coverage proof and
authorized PR/admission/queue/group/confirmed delivery. The final checks must
cover the recurring CONTRIBUTING lesson and current notes. Future full/pgTAP
invocations use the task-owned checksum-verified Supabase 2.98.2 and exact pinned
Node/npm PATH recorded in existing notes. No DCO, commit, native prepare/review,
full run, PR or external delivery occurred in this turn; C/D native cycles remain
zero. E owns the next resource slot; no additional heavy waiter is started here.
Runtime drain and the broader M14/E/F outcomes remain separate and incomplete.

Self-retro: whole owned archival-inventory relocation removed the common cause
after two partial discoveries, retaining 59 historical files' identities and all
candidate controls. The existing lint owner now carries the recurring M14 A/C
lesson. Once the allocated proof passed, no optional polish or extra review was
started; only required final-read readiness is handed off.


## Owner-authorized corrected draft checkpoint, 2026-10-27

After the source-only handoff preparation, the owner directly instructed this
receiving session to commit and push its corrections into the existing #401
draft instead of ending with a separate prompt. This supersedes the earlier
no-commit/no-push endpoint for this run. The actual grant covers DCO checkpoint
commits, ordinary dependency-stack integration and updating the existing draft.
The owner still forbids local tests and `verify` on this machine. No required
proof is waived for readiness, admission or delivery: this checkpoint is
unverified, with no PASS, receipt, ready transition, auto-merge or queue admission.
The receiving supervisor remains `01a17e97-d95d-7581-beb5-ab5ee9ad007c`; all
recorded authors, exclusions, findings and review budgets remain applicable.
Use ordinary Git hooks and signing; no bypass or copied proof stamp is allowed.
Generated metadata, regression execution, package measurements, independent
review and final verification remain owed on the author's proving machine.
