# M14 hosted RDS recipe receipt

Status: hosted WIP conformance passed; the required control read is accepted.
Authority tightening is locally verified and DCO committed; full native review and canonical
verification remain pending. No production qualification.
Audience: contributors evaluating the source-only PostgreSQL recipe.

## Outcome and authority

Produce `hostedRecipes["10R"]` with the common recipe runner on one synthetic
managed PostgreSQL 16 instance, from a private-network worker. The claim is
"hosted RDS PG16 recipe receipt (single synthetic instance)". The active
supervisor is the single writer in `codex/oss-m14-rds-receipt`. Code review base
and independently refreshed policy revision are both
`4fd84bfead64e11f76e0555117fe072d39807182` at task start.

The accountable maintainer's bounded programme grant permits implementation,
test-owned databases and roles on the assigned hosted resources, DCO commits as
Bart Roszkowski <dev@openlup.com>, submission, receipt and merge after required
gates. Hosted use is synthetic, in the approved region, within the existing
seven-day lifetime and USD 40 ceiling. Resource deletion, account/IAM/settings,
release dispatch, npm publication and production remain owner actions. The
hosted predecessors have landed; ready/queue delivery follows passing review and verification. Exact target identities
and access material remain external or in private scratch.

## Scope, acceptance and proof

Reuse the existing restricted 8C admission and two bootstrap modes, connection
witness, schema upgrade and backfill. Connect directly with CA and hostname
verification; prove wrong-host refusal. Report runtime pooling only as exercised
by the existing witness and state "no pooler provisioned". Execute phases
serially on one cluster with fresh-catalogue checks and test-owned cleanup
between phases. Record wall time, actions, interventions and final database/role
absence readback. Transfer and older-snapshot recovery on this target remain
PENDING, owner 10P; they depend on a separate provider-pair receipt. No production
qualification, SLO, complete programme, installed-package or stable-framework
claim follows.

Primary risks are selecting a used target, weakening provider/control-plane
admission, leaking bootstrap credentials and reporting PASS before cleanup.
The declaration must contain no hosted password: name a process environment
variable, pass only that variable into the isolated worker, and suppress raw
credential-bearing failures. Keep local three-cluster admission unchanged.
Provider identity, catalogue objects and monitoring-session exceptions must be
finite and explicitly reviewed, never broad provider-prefix bypasses.

Smallest adequate alternative: extend the existing runner and witnesses through
their current database inputs and 8C control-plane selection. No second runner,
installer, service, dependency or public listener is needed. Build one exact-tree
read packet for all hosted-fit controls before DCO. First run cheap policy,
inventory, neutrality, structural, redacted secret and focused refusal checks,
then strict published-tree typecheck and load-gated lint. Preserve unsigned WIP
refs while the read is pending. After acceptance, run from the hosted worker,
clean and read back absence, DCO, obtain two new fresh full reviews, run canonical
verification with release priority, then submit a neutral draft PR and establish
receipt readiness. While frozen, stop before ready/enqueue.

## Evidence and handoff

Baseline tracked inventory measured before new files: 6,699 files / 50,703,630
bytes. Changes are source tooling and documentation outside package tarball
inputs; no package cap increase is planned. `npm ci` passed with Node 24.21.0
and npm 11.19.0. The initial runner requires three system identifiers, inline
passwords and privileged cluster identity; these known hosted-fit gaps are the
batched read subject. No DCO, review cycle, hosted mutation or PR yet.

The password-free dry declaration passed. Missing environment, inline password
and split-cluster declarations refused before connection or receipt creation.
The first strict typecheck preceded the required package builds and reported
missing package outputs; the subsequent package build passed. Remaining strict
typecheck and lint wait behind the shared-host gate.

An unsigned WIP hosted discriminator was needed before the control read to
exercise the actual provider graph. The first installer-managed 91-unit witness
passed, including runtime/restore denials, connections and shadows. Teardown
then refused (42501) because the bootstrap did not own the test database. A
bounded recovery using the actual test owner dropped that database, but role
removal refused (2BP01) on PG16 membership-grant dependencies. Read-only
`pg_shdepend` inspection identified those grantor edges. Ordered group-before-
grantor removal then passed, with database and all nine roles absent.

Regroup after these two cleanup attempts: both exposed superuser teardown
assumptions, not a need for broader authority. The repair selects only the
observed test owner for database drop, resets role, then removes the six fixed
application groups before their test grantors. The next discriminator is a
fresh serial hosted run: three phases, per-phase absence and final freshness
must all pass. No force-disconnect, provider resource deletion or retry loop is
introduced. Native cycles consumed: zero; no DCO or review yet.

The second WIP run passed both 91-unit modes and removed all three phase
databases and 28 roles. Its restricted schema child timed out before reaching
the intended SQL lock. The next WIP added a barrier after restricted admission
and before the real backfill SQL; it progressed to previous-application teardown,
which refused (42501) because a restricted role creator cannot implicitly run
`DROP OWNED` for its temporary application role. That run also removed all three
phase databases and 29 roles through the outer cleanup.

Schema regroup: these two attempts exposed separate legacy-superuser fixture
assumptions. Keep the existing backfill, interruption and replay assertions;
synchronize after admission, then grant only SET on the temporary application
role to its trusted test creator for `DROP OWNED`/role removal. A fresh whole
runner execution must pass before this is evidence of a hosted recipe. The
released legacy witness remains unchanged in meaning; the restricted branch
explicitly disclaims a released restricted predecessor. The runner also scopes
temporary SQL/compiler files to its own worker directory and does not pass the
bootstrap password into schema subprocess environments. Earlier temporary SQL
directories used the witness default and were removed by its finally block.

The fourth WIP still refused `DROP OWNED` after the SET grant, while outer
cleanup again proved three database and 29 role removals. The cleanup regroup
distinguishes permission to select a role from actually executing as it: the
next change performs `SET ROLE` to the temporary application role for its own
grant removal, resets role, then drops it as the trusted creator. A focused
non-superuser PostgreSQL discriminator exercises the real cleanup helper and
preserves the refusal of the old creator-only command. This avoids granting
inheritance or a provider capability. No native cycle or retry grant is reset.

The fifth WIP removed grants after selecting the application role, but dropping
that role refused (2BP01) on the added membership's grant dependency; outer
cleanup again removed all resources. Simpler cleanup: reuse the already-open
previous-application login to remove its own grants, close it, then let its
trusted creator drop the role. This removes the extra membership grant and SET
window entirely. The focused discriminator covers that exact helper, the old
creator-only refusal, preserved creator identity and preserved table. A small
hosted cleanup discriminator precedes another whole-run attempt.

The isolated discriminator still refused role deletion (2BP01) after successful
self-cleanup without any added membership; its outer owner cleanup removed the
database and both roles. Stop whole-run attempts and inspect the live role's
shared dependencies and the refusal detail in the isolated fixture before the
next repair. The earlier attribution to the added SET membership was incomplete;
no hosted PASS is inferred and no authority or attempt history is reset.

The live dependency read showed the application role still held table privileges
after its own `DROP OWNED`; the new membership was not the underlying cause.
Final simplification: restricted schema phases leave their temporary login to
the existing outer teardown, which drops the whole test-owned database before
roles and verifies absence. The legacy external-schema path retains its original
grant/role cleanup. No extra role membership or generic privilege-cleanup engine
is needed. The isolated and local regression now exercise the exact outer
cleanup, including grant dependencies, rather than an unsupported creator-only
`DROP OWNED` assumption.

The final isolated RDS cleanup discriminator passed, including refusal of the
old creator-only command, owned database removal and both role absence checks.
The sixth whole-run WIP then produced `PASS_INITIAL_PHASES` and
`hostedRecipes["10R"].status = "PASS"` on PG16.15 from the private-network
worker. Its exact source commit is `caaa5123dfea36573e084b1c5219551bc6b97b83`,
tree `622ae365e14f3a5781118534741940dae0378fc4`. The private receipt is
`.context/scratch/hosted-rds-receipt/wip-receipt6.json`, SHA-256
`78f72ccaad3bf0211b83ca68ed0b40518de9072445b5a3b14f742a4a2d6afc8f`.
Both modes passed their fixed 91-unit inventories. The schema witness passed
the 77→91 restricted prefix, real backfill, both interruption points, resume,
replay, retained rows, subscription invariant and actual 0.23.0 application
read/replay. The prefix digest is
`6616c28521eb3c3d641c818d7db5de1b5ba12b67af530a1be2e4212e0d6b762d`;
this is not a released restricted installation lineage.

The successful runner measured 120.39 seconds, three phase launches, three
database creations/drops, 29 role drops and 23 freshness reads, with zero
in-run interventions or automatic retries. Earlier failed WIP runs and manual
recovery above are separate engineering effort, not hidden retries. Provisioning,
source transfer, dependency installation and builds are excluded from that
runner measurement. Direct TLS used the provider CA bundle with hostname
verification and wrong-host refusal. No pooler was provisioned. Transfer and
recovery remain PENDING, owner 10P. The claim remains "hosted RDS PG16 recipe
receipt (single synthetic instance)", not production qualification or an SLO.

Independent final readback found no test databases, roles, application groups or
sessions. No owned containers, networks, volumes, Node processes or temporary
worker directory remained. The password-free declaration and private source/
receipt evidence remain for the accepted-run continuation; shared tooling stays.
A private teardown checklist is in the same scratch directory. The VM ledger
records start, shared Node checksum and final namespace absence.

Pre-read proof passed: four focused PostgreSQL files, 22 tests in 68.39 seconds;
strict typecheck across five projects with zero unresolved edges or consumer
errors; lint with zero errors and 33 existing warnings; structural, policy,
inventory, neutrality and configured redacted secret checks. Publication has
two new catalogue rows, no exemptions or cap increase. The two load-gated
pre-read sequences waited at least 1,620 seconds in total. Only this task record
changes after the successful WIP; the control/code tree remains the tested one.
No DCO, native review cycle, push or PR exists. The next step is the single
batched control read, then the accepted VM run, DCO, two new full reviews and
canonical verification. The release freeze still blocks ready/queue actions.

Self-retro: fresh-worktree typecheck needs the documented package build first.
Superuser teardown assumptions → use the actual test owner and dependency
order; an owned-database phase needs no separate privilege-cleanup engine.
The existing witness seams remain adequate without another framework.

The control read accepted password-free input, RDS serial execution/incarnation,
exact freshness names, restricted-prefix scope and owned-database teardown.
It required narrowing the production admission exceptions: only the explicit
RDS serial-cluster selection and fixed stock roles may use them. The runner's
existing target/layout fields are now carried into that selection, and one
immutable stock-role constant serves admission and freshness. Other declared
roles still need elevated flags; predefined-role edges with a non-stock member
or grantor remain compared. The separate region repair is included: declared
AWS region syntax, synthetic test value and missing/invalid refusals.

This delta awaits its own exact-tree read before DCO. Strict typecheck, lint,
focused refusal/hosted-shape tests and cheap gates are the proof order. The
actual hosted path retains the same stock names and stock-to-stock provider
grants, so this scoping alone requires no new hosted run. Subsequent delivery
requires two new full reviews, both explicitly covering the production security
control, then canonical verification and a neutral draft PR. The release freeze
holds ready/queue; landing follows the preceding hosted identity and storage
parcels. Self-retro: preserve the original generic admission checks and bound a
provider exception with the existing selection and a shared fixed inventory.
Two scoped fixture attempts failed: default superuser grants recorded the
non-stock cluster root as grantor; explicit `GRANTED BY` then refused without
an upstream ADMIN edge. The remaining gap is the requested provider-graph
witness, owned by these tests. Regroup: emulate the actual stock-named cluster
root instead of adding membership exceptions or upstream grants. The next
discriminator must admit that stock graph and refuse an isolated edge from a
declared non-stock root. No native review cycle is used. Lesson: grantor identity
follows the actual cluster root → name the synthetic root like the provider.
The scoped candidate passed strict typecheck in all five projects, lint, and
all 29 focused tests across five files (72.56 seconds). This includes the four
new scoping refusals, both RDS-shaped installation/restore modes and unchanged
extra-field refusal codes outside the explicit RDS serial pair. Static
specialization of the inactive RDS additions reproduces the complete current
main admission source byte for byte. The successful hosted selection's exact
eight declared names equal the shared inventory, so its count and edge decisions
are preserved by scoping. No hosted rerun or native review cycle was used.

CD-M14-66 accepted tree `7137da95aa413a90eab44a32f3a2b1de82440b43`
and its recorded delta identity, with the pre-approved authority tightening.
The frozen authority inventory is now only `rds_superuser`; the eight stock
names remain the freshness inventory and predefined-role edge boundary.
Non-elevated membership only in `rds_password`, `rds_iam` or `rds_ad` refuses;
`rds_superuser` membership counts. The elevated-flag path is unchanged. The
hosted evidence still holds because the RDS master user is a member of
`rds_superuser`; no VM rerun is needed. Required proof order is strict
typecheck, lint, focused witnesses, cheap gates and redacted staged-tree scan,
then DCO, prepare and two new full reviews of the production security control.
Canonical verification and a neutral draft PR follow passing review; ready
and queue actions wait for the preceding hosted identity and storage parcels.
The tightening passed strict typecheck, lint (zero errors, 33 existing warnings)
and all 32 focused tests in five files (79.01 seconds). The shared heavy gate
timed out after 3,006 seconds, then admitted typecheck after another 722 seconds;
lint and focused tests were admitted separately and ran serially. No native
review cycle was used. Self-retro: stock provider names do not all convey
bootstrap authority → retain the shared stock inventory and count only the
singleton authority role alongside the unchanged elevated-flag path.

Native prepare refused source-review carry-over against refreshed main. The
forced main integration was conflict-free, with parents
`98cbc2c372a544cc862d2e5cdb730aea2571637a` and
`78f340db40ee6abcdaa97c7f01ccd2a857403b8f`. Its computed source tree before this
task note is `ef2cbe3f88c4d9240c366319e5fcc95dd6799843`. The stable patch-id,
excluding only this task record, is
`7aac8e0ba7daa3711f3c6b2520b696992a58ef03` both before integration against
`4fd84bfead64e11f76e0555117fe072d39807182` and afterwards against the refreshed
main parent. No manual resolution or owned-source change was needed. Main
supplies the stock PostgreSQL 17 canonical pgTAP lane; the recipe witness keeps
its PostgreSQL 16 target. The sensitive read and singleton tightening remain
the approved source scope; fresh full security-control reviews still follow.
The pre-merge-HEAD whitespace check reported four unchanged lines imported from
main's managed-compatibility fixture. Its staged blob equals main exactly;
the owned delta against the new review base passes the whitespace check.

The lead clarified the integration rules before review: zero-context patch-ids
cover adjacent-context drift, the catalogue is compared as parsed entries,
and the hosted-runner routing/redaction union is pre-approved. The earlier
unsigned OIDC merge remains preserved in its WIP ref and was aborted. Current
main includes both hosted predecessors; submission and queue delivery are now
authorized after the remaining gates. No new sensitive read is required.

Latest merge parents: `204ed0611216ad08f8a4558c2a694bf8a49bf089` and
`4c392262f40a1bce54562492e667d7586c4f6c66`. Computed source tree before this
task note: `e46d283fcc88bb088ed795714b59993f081141d8`. Zero-context patch-id before
and after, excluding this task record, parsed catalogue and approved runner
lines: `90f13a74a1988c180afaf31ba032fce96e39d9b5` = `90f13a74a1988c180afaf31ba032fce96e39d9b5`.
The runner raw zero-context ids are `88fe2eee518ec036fc09775b6f96bba0250cc63e`
and `cf7147f50a151d15f843f1cdea62c14893eb3497`; its delta outside the approved
worker routing, redacted source allowlist and final status selection is identical
(SHA-256 `8c011e82e5e72ab1fc3fec343b788da892c19e7fefad44693c16fb66e1619194`).
All added refusal predicates from both sides remain verbatim. Every other
non-catalogue source path has equal per-file zero-context patch-ids. Parsed
catalogue additions are exactly the RDS task record, RDS stock-role inventory
and RDS phase helper, all public-output; there are no removals or value changes.

Union hunks: (1) catalogue keeps complete OIDC, S3 and RDS record objects and
their separators; (2) conformance test imports and the RDS/S3 test blocks remain
verbatim, including the RDS block's blank separator; (3) runner imports keep
all existing target modules; (4) redacted refusal/source-file allowlists retain
all existing codes and file names, with the original SQLSTATE guard unchanged;
(5) isolated-worker environment routing selects RDS's named password and TMPDIR,
S3's null shared-profile paths, or the existing empty environment; (6) output
selection retains the existing S3, local, RDS and OIDC messages and conditions.
The shared target list/usage and one final success-status check are inherited
from main. No declaration refusal predicate was edited or removed. The required
cross-target declaration refusal matrix follows in a test-only commit before
review. Exact comparisons and resolved hunks are retained in private evidence.

The policy gate required the merged catalogue objects in path order. Sorting
the unchanged RDS/S3 record objects preserved the exact parsed-entry comparison;
no object value or allowance changed. This bookkeeping correction precedes
review and adds no source responsibility or approval obligation.

Full review identified two repair boundaries: the canonical prose confused the
eight stock roles with the singleton authority role, and RDS declarations still
accepted unused fields that could contain a password. The repair names declared
`rds_superuser` membership as the sole non-elevated authority path, keeping the
eight-role set for freshness and stock-edge normalization. It also rejects
undeclared RDS fields at both declaration and installation-entry levels; other
targets and all existing refusal predicates stay unchanged. Focused witnesses
exercise password-bearing and foreign fields at both levels and every phase,
then re-admit the canonical password-free declaration. The existing hosted
declaration generator uses exactly these fields, so the new refusal does not
change its admitted path or require another hosted run. The field-control
repair requires a read before sign-off and renewed full review afterwards.

Self-retro: the source tightened authority correctly before review, but the
canonical prose retained the earlier eight-role description. Checking each
security claim against its final predicate would have caught that drift earlier.
An exact field inventory closes the credential-bearing extras without a new
runner, configuration seam or general validation mechanism.

Repair checks: strict five-project `npm run oss:published-tree -- --typecheck`
passed first, then `npm run lint` passed with zero errors and the existing 33
warnings. The five focused admission, recipe, composition, schema-upgrade and
connected-restore suites passed all 40 tests in 79.56 seconds. Shared heavy-gate
admission preceded each stage. No hosted resource was touched by this repair.
