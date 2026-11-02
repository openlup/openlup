# Native OMS, returns and support store exports

Status: final DELTA API read pending; focused local proof complete;
development preview.
No row completion, installed-store qualification or delivery is claimed.

## Approved outcome and authority

G12 promotes existing PostgreSQL OMS control, reduced control-plane reads,
returns control and customer-support journey stores to public platform subpaths.
Rows: T03-01–06, T03-11–13, T03-47–50, T03-62; A67–70, A74, A85, A86, A88,
A99. Existing operation bodies, SQL, defaults, refusals and reference factory
identity must remain unchanged. Rich OMS projections remain named refusals.
Diagnostic history stays an independently injected support-facade port; no native
diagnostic-store export or qualification is claimed by this promotion.

This G12 worker implements under the stores supervisor and programme lead. Local
edits, DCO commits, submission and gated merge are within the approved programme,
subject to the stabilized API read, independent review, verification and lead's
landing slot. The current continuation is G12 only. Other store rows have their
own workers. No publication, tags, production, hosted resources, credentials,
settings, SQL changes, subscription/inventory/payment implementation, native
checkout or review/release-control changes are included. A behaviour repair is
not an unchanged-code promotion and needs the applicable lead decision.

Worktree: `oss-m19-g12`; branch: `codex/oss-m19-g12`.
Code base and freshly checked policy revision:
`bb0008481a11267ec6dbe3e7e531299777cddc19`.
The focused gate permits dependency, build/pack, lint, type and one-file/owned-DB
stages without another permission request. Canonical verification still waits
for a named landing slot. No commit, PR, native review or receipt exists.
Native review cycles consumed: zero. Preliminary failures below are retained.

## Matrix correction and current blocker

Before source edits, code inspection confirmed that the four source stores exist
but lack public package exports. Matrix 2 already corrected matrix 1: rich
T03-01/02 / A69/A70 are missing; diagnostic T03-50 is NEEDS-BINDING rather than
UNKNOWN. Reduced control-plane v1 was accepted as the intended existing scope.
That initial static inspection did not establish its native SQL viability.

The real `qualified-v2` run now disproves the reduced-list readiness claim.
`server/adapters/postgres/omsControlPlane.ts` at the base, and its unchanged moved
body, include `FROM public.commerce_payments pay` in the withdrawn-order guard.
The only native-chain mention is a comment in the channel-ingest migration
listing absent relations; no native SQL definition exists. The installed list
call fails with `OMS control-plane query failed`; the wrapper's SQLSTATE was not
printed by the test runner and is not claimed here. The operator resolver passed.
List/count success is missing, so T03-01 needs native repair rather than export
alone. T03-02's detail assertion was not reached in the failed case and remains
unverified by this witness. Do not claim that accepted reduced OMS reads work.

No SQL, compatibility table, altered grant, query fallback, weakened assertion or
native payment-truth substitution was added. The supervisor must decide whether
to authorize a native predicate repair with its own behavioural criteria, or
retain the stop. Do not narrow acceptance or infer the right payment truth here.

## Implemented source boundary

New entries: `commerce/server/postgres`, `account-support/postgres`,
`account-support/read-contracts`. The separate browser-safe codec entry preserves
the existing empty-runtime `account-support/contracts` boundary and the donor's
CSP-safe Zod configuration. The returns factory gains a type-only host reason
generic; existing SQL still decides which reasons it accepts.

The lead resolved the initial ownership stop before implementation. Source
rewrites outside the originally assigned adapters are listed explicitly:

- `server/adapters/postgres/{omsControl,omsControlPlane,returnsControl,customerSupportJourney}.ts`:
  thin public factory/type re-exports.
- `server/runtime/support/customerJourneyBinding.ts`: re-export the identical
  package inactive-operator constructor.
- `server/domains/support/customerRecoveryCommand.ts`: re-export the three
  identical package refusal constructors; execution bodies stay unchanged.
- `src/domains/clients/{portableContracts,portablePorts}.ts` and
  `src/domains/support/customer360Contracts.ts`: thin schema/type re-exports.
- `scripts/packages/platform-cold-consumer.ts`: exactly three additive entry
  classifications, with existing lines unchanged.
- `eslint.config.js`: additive isolated-subpath graph classifications; existing
  rows and rule logic unchanged. The native support entry selects the existing
  data lane; commerce selects its existing pricing-contract version constant.
- `packages/platform/test/packageBoundary.test.ts`: add only the three nested
  entries to its closed export inventory; existing assertions unchanged.

Store and schema behaviour suites are unchanged. The existing package lead-result
translator and helper bodies match the donor. Static comparisons confirm all four
store bodies and the three moved schema/port bodies are unchanged. New source/API
files have catalogue rows, consumer registrations and three generated snapshots.
The package README, platform recipe and changelog fragment describe actual limits.

## Executed evidence and failed attempts

Node 24.21.0, npm 11.19.0, gitleaks 8.30.1 are available. Focused admission initially
timed out after 541 seconds (host load 15.03); the required command was repeated
and admitted. Admission waits do not consume a review/repair budget.

- Owned `npm ci`: PASS. Lockfile unchanged; no audit repair attempted.
- `npm run pretest`: PASS, builds Core, Outbox and Platform.
- `npx --no -- ast-grep scan --error=no-suppress-all --error=unused-suppression`:
  PASS after install and after fixture edits. Before install it refused a missing
  local binary; `--no --` prevented a package download.
- `npm run oss:published-tree -- --typecheck`: PASS, zero unresolved edges and
  zero diagnostics, before the final import narrowing and fixture edits.
  The subsequent lint prerequisite build compiled the narrowed package imports;
  a final exact-tree root typecheck remains pending.
- `npm run lint`: PASS, zero errors and 33 warnings, before the fixture repair.
- Syntax, file-wide-ignore, donor-body, package-import confinement and whitespace
  checks: PASS. Protected implementation/migration paths are untouched.
- Policy/navigation was regenerated after catalogue registration. It computes
  bindings and reports seven pending no-impact records. Owner sections were
  read; ignored scratch retains proposed delta-bound commit trailers. They must
  be refreshed and committed after the mandatory pre-DCO API read. Policy is
  not PASS until then; no premature signed commit was created.
- First `m19StorePromotion.test.ts` run: 3/8 PASS, five cases hit the same fixture
  defect: autocommit order header/line inserts violated the deferred line-sum
  constraint. The fixture now uses the existing helper's transaction pattern.
  No SQL, privilege or assertion was relaxed.
- Second run: 7/8 PASS in 22.06 seconds, one failed reduced-list case. Installed
  declarations compiled in NodeNext and Bundler; CSP parsing, actual restricted
  runtime authority, holds/releases, unpaid cancel/external-refund marking,
  returns request/approve/reject, system-hold selection/release and support reads
  passed their success/refusal/replay assertions. The complete selected native
  chain and migration replay were checked. Owner sessions were used only for
  installation, fixture setup and durable-state inspection. Suite teardown
  removed the owned container. No hosted/provider qualification is claimed.

Logs and prepared reasons remain in this worktree's ignored `.context/scratch/`.
The latest database log is `g12-postgres-retry1.log`. At that stop the authored identity witness
and existing affected suites had not yet run; the database blocker stopped the
continuation before those stages. The independent continuation below supersedes
those pending items without changing the failing predicate result.

## Rethink, other pending gates and self-retro

Two API-generation observations retained an unrelated promotions enum-key order
delta (`all`/`archived`). Narrower commerce imports reduced snapshot closure but
did not remove that delta. The shared promotions snapshot was restored unchanged;
its generated patch is in scratch. Exact API check therefore fails at promotions.
The proposed discriminating step was an unchanged-base build/pack comparison,
then the smallest generated-artifact exception in the API read. Do not alter
runtime semantics, the compiler or comparison controls to force an old key order.
Lesson: declaration-order drift → inspect the emitted base and request the
smallest generated-artifact exception. The database blocker now takes precedence.

Execution defect: `packages:check` was misclassified as metadata-only and invoked
without a separate focused admission. Its default route packed Core/Outbox and
then refused uncommitted Platform (`dirty-tree`). It is not PASS and was not
repeated. Future packing remains gated. Lesson: inspect CLI option defaults before
classifying a command as a cheap read.

The first PostgreSQL evaluation exposed fixture setup; the second isolated an
actual native owner gap. The simpler next step is the explicit stop and report,
not an invented compatibility table or a weakened payment guard. Self-retro:
source existence → trace every queried relation and run through the real runtime
role before calling a matrix row export-ready.

At that blocked stop, the pending work included independent suites, exact-tree
checks and measurement. The continuation below completes those independent
items. Current remaining work is the predicate decision and missing native read
acceptance, the final API read/generated-only exception and policy commit records,
the committed identity witness, independent reviews and canonical delivery gates.
Acceptance is incomplete and no review/retry history is reset.

## Independent continuation while the predicate is open

The stores supervisor explicitly resumed independent work while the lead and
money owner decide the native predicate criteria. The moved predicate is frozen:
no SQL, compatibility table, grant, fixture substitute, weakened assertion or
readiness claim is authorized. The original failing test remains executable and
its full-suite failure above remains evidence. A selected independent-case run
will be identified as selected proof, never a full-suite PASS.

The coordinator's facade conditions require import-only equality (other deltas
listed for the read), committed dual-entrance constructor/schema identity proof,
unchanged green donor suites, all new exports in the pre-DCO API packet, and an
explicit inventory of touched reference files. The new identity witness checks
an actual packaged refusal through both the old constructor path and the built
package constructor. Installed-tarball proof additionally checks the native
subpath's thrown errors against the package's account/support constructors;
separately bundled constructor copies must fail this assertion. It must still be
committed after the API read; no condition is claimed fulfilled by staging alone.
The runtime/support and domain/support diffs go to the supervisor's stable packet.
Shared edits remain additive in nonoverlapping hunks. The API packet stays DRAFT
and states the open list/count predicate. No final read stop or canonical verify
is requested while the predicate decision is outstanding.

### Independent continuation results

Real base/candidate packs were built from the same pinned toolchain and measured:

| Measurement | Base | G12 candidate | Delta |
| --- | ---: | ---: | ---: |
| Packed bytes | 2,102,771 | 2,133,296 | +30,525 |
| Unpacked bytes | 9,809,502 | 9,939,230 | +129,728 |
| Files | 2,840 | 2,879 | +39 |

All current total/code/docs byte and file caps hold for this candidate alone;
no cap was changed or raised. This is a locally packed candidate, not registry
or release qualification. Existing emitted runtime files match the base byte for
byte. The only existing declaration difference is the promotions enum-key order,
confirming the earlier generated-artifact observation. The comparison and both
tarballs remain under `.context/scratch/g12-package-measurement/`; no extracted
archive source tree remains for lint traversal.

Fourteen separately admitted focused commands passed, with 2,927 passing cases:
new identity (2), OMS control (2), control-plane unit (2), returns (1), support
store (23), portable schemas/ports (1 each), Customer 360 schemas (6), recovery
commands (6), runtime binding (10), managed command errors (6), package boundary
(2,855), existing support reads (5), and selected installed/qualified cases (7).
The eleven donor/caller suites are byte-unchanged; the package-boundary suite's
only change remains the additive export inventory. The identity test uses actual
packaged errors against both old-path and built-package constructors and checks
all moved schema exports for object identity. The installed tarball additionally
passes four cross-subpath constructor checks under CSP restrictions.

The last PostgreSQL run deliberately selected the seven independent cases. Vitest
reports one case skipped because of that CLI name filter, not a source `.skip`.
The original full-suite failure is retained in `g12-postgres-retry1.log`; the
failing list case is still executable and unchanged. The selected PASS does not
establish T03-01/T03-02 native list/count/detail readiness or a full-suite PASS.
Owned containers were removed by normal teardown. Both declaration modes, real
restricted-role calls, success/refusal/replay and independent diagnostic-source
compatibility are covered at their stated boundaries.

Current-tree published typecheck passed with zero unresolved edges and zero
diagnostics; current-tree lint passed with zero errors and the same 33 warnings.
The unchanged predicate and source-body comparisons remain checked. Consumer
registrations remain present for all three new public entries. The identity
witness is executed and staged but not yet COMMITTED: the coordinator's committed
witness condition remains pending the final pre-DCO API read. No final read,
commit, native review or canonical verify was started during this continuation.

The API packet is DRAFT while the lead/money-stream predicate decision is open.
It includes the exact runtime/support and domain/support diffs for the supervisor
to send once stable, the type-only returns generic exception, the generated-only
promotions delta, and the pending policy trailers. Nothing there grants a query
repair or source receipt. Self-retro: admission waits dominated the subsecond unit
runs; checks were serialized and their selected/full-suite meanings kept separate,
without introducing another runner or changing the shared gate.

The private draft packet is prepared for the stores supervisor; it is not a final
read request. The selected test filter, pending committed-witness condition and
original failing PostgreSQL run remain explicit. The predicate still matches the
donor byte for byte after import relocation. No SQL, grant, compatibility relation,
fixture substitute, new readiness claim or final verify request was introduced.

Facade equality disclosure for the coordinator: the three existing package error
class declarations use one-line wrapper formatting, while their former root
declarations were multiline. The constructor bodies/messages are unchanged; this
wrapper-whitespace difference is disclosed alongside the type-only returns
generic rather than claiming full declaration-byte equality. The inactive
operator declaration and all actual moved store/schema bodies retain their stated
import-only/body equality. No production text was changed for this disclosure.

## Coordinator read and package-evidence correction

The coordinator recomputed the previous base, staged tree and diff, inspected all
moved bodies, and accepted the three entries, nine reference re-export paths,
type-only returns `Reason` generic, three error-wrapper formatting differences,
three ESLint graph rows and additive boundary-inventory line. Those decisions
carry to the final API read; they do not replace it or permit a commit now. The
single promotions `all`/`archived` declaration-key reorder is also accepted if it
persists. It still matched the built declarations, so exactly that one generated
hunk is now included; no promotions runtime or other snapshot content changed.

The new release-gate rows previously used repository-relative PostgreSQL paths
as package smoke evidence and stored an unused `consumerEvidence` list. That did
not meet the existing package-owned path validator. Each row now selects its own
small test under `packages/platform/test/`, using the compiled public entry for
rich-read refusals/return serialization, unavailable support authority, or strict
read-contract defaults. The unused duplicate key is removed. The real installed
PostgreSQL witness remains unchanged under `tests/postgres/`; consumer evidence
is derived from the existing package smoke field. No checker or budget is altered.

Native list/count qualification depends on the separate control-plane repair
and the money stream's G6: a verified capture on an already cancelled order
currently leaves no row. T03-01/T03-02 remain unclaimed until G12-p lands and this
G12 branch merges main with the authorized forced merge. Its repaired moved body
must remain byte-equal to that owner version. No predicate, migration, gateway,
grant, fixture or assertion was changed during this continuation.

### Real-driver array-to-jsonb audit

The audit traces every input bind in all four moved stores, not just the gateway
RPC helper. These stores use the supplied query executor or the role-free lane;
they do not call `PgGatewayClient.rpc`.

| Store / jsonb bind | Serialization and real restricted-role evidence |
| --- | --- |
| OMS control: `p_metadata` in create/release hold, cancel, mark-refunded, create-system-hold and delivered release | All pass the unchanged `parameter()` helper, which JSON-stringifies every non-null object, including arrays. Current real-driver cases use default objects or a fixed delivery-evidence object, not top-level arrays. No top-level metadata-array qualification is claimed. |
| Returns: `commerce_return_request_create.p_lines` | Always a mapped JavaScript array, explicitly JSON-stringified by the unchanged helper. The installed-tarball restricted-role witness passes one line as an array through create, replay, ownership refusal and conflicting-key refusal. Approve/reject have no jsonb input. |
| OMS control plane | No jsonb input bind. The returned SQL array of hold reasons is output, not an input parameter. List/count remains failed independently of encoding. |
| Customer-support journey: read-audit `query` column | The only jsonb write is `JSON.stringify(query)` of a constructed object. Its `customer_ids` bind is deliberately `text[]`, not jsonb. The current real-driver witness uses a human actor, so this optional machine-audit branch is not exercised. All read, recovery and lead-absorption routine input binds are scalar; no array-to-jsonb input exists there. |

No unencoded array-to-jsonb bind was found in these moved bodies, and the existing
real-driver return-array case passed. This does not assert that unexercised
metadata arrays or best-effort machine audits passed. The original full-suite
failure and selected-case evidence retain their earlier meanings.

### Correction-check execution

The requested staged-tree `npm run packages:check` was admitted by the focused
gate and executed. Core and Outbox packed successfully; Platform refused with the
existing `dirty-tree` finding because this candidate must remain staged and
uncommitted until the final API read. Log: `g12-packages-check-staged.log`. This is
not a package-check PASS; the command must run again on the clean committed tree
before requesting a verification slot. No check was bypassed and no temporary
commit or alternate checkout was created to avoid that refusal.

The three new package-owned smoke suites passed separately under focused
admission: commerce (2 tests), support (1), read contracts (1). Their logs are
`g12-smoke-commerce.log`, `g12-smoke-support.log` and
`g12-smoke-read-contracts.log`. The ordinary API snapshot check now passes with
the sole accepted promotions hunk. Ast-grep, donor-body preservation, smoke-path
validation and whitespace checks pass. The correction does not rerun or replace
the earlier full PostgreSQL failure. All production source, reference facades and
both PostgreSQL witnesses match the previously read staged tree byte for byte.

Against that earlier tree the complete correction delta has seven paths: the
release-gate file, three package tests, catalogue, this task record and the sole
promotions snapshot hunk. Final API read, committed identity witness, clean-tree
package check, policy commit records, independent review and named verification
slot remain pending. No commit or other worktree mutation was made. Self-retro:
validate package-owned evidence paths before the read, and use the existing
single evidence field instead of introducing a second stored list.

The corrected real tarball supersedes the earlier candidate measurement:
2,133,275 packed bytes, 9,938,931 unpacked bytes, 2,879 files. Against the same
base this is +30,504 packed bytes, +129,429 unpacked bytes and +39 files. Code gzip
is 1,836,328 bytes / 2,820 files; docs gzip is 58,722 bytes / 6 files. All existing
caps hold without a raise. Artifacts and metrics remain under
`.context/scratch/g12-package-measurement-corrected/`. This is a raw measured
candidate pack, not a package-check PASS, publication or registry qualification.
The pack gate timed out after 548 seconds on rate limit, then admitted the exact
retry after 305 seconds. No admission or package-check control was changed.

Current stop: HOLD awaiting G12-p on main and the supervisor's forced-merge
resumption. The private packet remains DRAFT with refreshed staged identities;
no final API read, DCO sign-off, commit, review or verify-slot request is made.


## Integration of the native control-plane repair

The supervisor resumed this uncommitted candidate after the control-plane repair
landed. Current base is `a2a0f2dd0d4388672039ec33cd2c62ea3af8e5b3`. No contribution
commit, PR, native session or reviewer exists; cycles remain zero. The previous
41-path binary staged patch was saved and SHA-256 identified before moving the
branch. Applying it in an isolated index over its original base reproduced the
previous staged tree exactly; no shared stash or other worktree was used.

Reapplication onto main conflicted in the publication catalogue and the root OMS
control-plane file. The catalogue preserves every main row and inserts only this
candidate's new rows. The root OMS file remains the accepted thin facade. Its
packaged implementation now copies main's repaired body exactly after imports,
including comments: 7,088 bytes, SHA-256
`1594559d62c5a357a35c0955957b7de357d1d73470d6268ee9e9afd23802894e`.
The withdrawn guard uses cancelled status, a marker, no renewal operation, no
settled intent and no captured/indeterminate truth event. No predicate or comment
wording was edited. The original source test files, including the repaired
native control-plane witness, are unchanged from this base.

The money-stream dependency remains: a verified capture after cancellation can
leave no stored money row. Native visibility is bounded by the recorded facts;
it does not establish that an order that took money can never be hidden. The
previous failed witness is retained as historical evidence; fresh results below
will identify proof of the repaired owner body without rewriting that history.

Shared-file integration preserves main's existing rows and order. The three
ESLint entries are appended at the end; the boundary inventory is the union of
main's entries and this candidate's three entries on its existing line. No
unlanded invoice entry is added. The package-owned smoke paths and removal of the
unused duplicate evidence key are retained. The only own test-setup repair
replaces registry specs with local tarballs for the locked driver/type dependency
closure; original SQL fixtures, privileges and assertions are unchanged. That
installed witness will run normally and with an empty offline npm cache.

Before the final delta packet: run the neutrality ratchet without a baseline
edit, package boundary and outcome-projection tests, every existing direct
importer test unchanged, the new identity/smoke witnesses, complete installed
restricted-role proof, ast-grep, published strict typecheck, lint and policy/docs
update. Re-measure a real base and candidate pack on the official toolchain.
A test failure stops this continuation. The next stop is the final delta API
read; there is still no authorization to commit in this continuation.


### Required-test stop after integration

The official toolchain build passed. Neutrality passed with zero increases.
Package boundary passed 2,891 tests, outcome projection passed 7, and the existing
MCP support-tools importer passed 13. The next unchanged existing suite,
`scripts/packages/eslint-import-map.test.ts`, failed: 121 passed, 2 failed.
Log: `.context/scratch/g12-resume/04-eslint-import-map.log`.

The first failure is its closed module-directory inventory: the declared graph
now includes the three accepted new submodules, while that test's inventory does
not. The second is its exact edge inventory for `account-support/postgres`:
actual type-only edges are empty after removing targets already used as values,
but the accepted graph row declares `account-support/contracts`. The script's
inventory maps the store's private contract imports to the parent account-support
module, already present as a value edge. Neither the existing test nor the graph
was changed to hide these findings. This is the first evaluation of this new
inventory gap; native review cycles remain zero.

The supervisor explicitly required a stop on an existing-test failure. The
remaining 23 direct-importer suites, extra support-read regression, new identity
and smoke tests, normal/cold-cache installed PostgreSQL runs, ast-grep, strict
typecheck, lint, policy/docs update and fresh base/candidate packs were therefore
not executed in this continuation. No final delta read is requested with missing
mandatory proof. The saved patch/reapplication evidence and repaired-body equality
remain available. No contribution commit or another worktree mutation exists.

Self-retro: the closed graph inventory and inferred edges must be exercised early
alongside the package boundary. The smaller next step is the supervisor's scoped
answer on those two inventory findings, retaining all unchanged refusal tests;
adding another graph or weakening the existing exact check would add no value.


### Authorized inventory repair and second staged integration

The supervisor authorized exactly two repairs to the inventory stop: add the
three new module names to the single closed expected-list line in
`scripts/packages/eslint-import-map.test.ts`, and remove the unused contracts
type permission from the new account-support PostgreSQL graph row. No other line
of that test or either other new graph row changes. Both repairs are new items
for the final delta API read, with no native cycle charged.

The next staged patch was saved and verified in an isolated index before moving
the branch to `38f60565d54fb7ec061f8e506b3c98a3c653a8bd`. Its SHA-256 is
`e838ee8eca890a0abbcc5fa08e3cb76c30e835db662c227fdcf6784785b853e0`.
Only the catalogue conflicted; the additive union preserves main's complete
existing rows and bytes. Other shared hunks reapplied cleanly. No shared stash,
contribution commit or other worktree was used. The repaired OMS body still
matches main exactly after imports, with the same 7,088-byte body and SHA-256
`1594559d62c5a357a35c0955957b7de357d1d73470d6268ee9e9afd23802894e`.
The next check is the required 123-case import-map suite. Any further existing-
test failure still stops this continuation; no other graph repair is authorized.


### Second inventory evaluation and regroup

The authorized rerun on `38f60565d54fb7ec061f8e506b3c98a3c653a8bd`
completed with 122 passed and 1 failed in the 123-case import-map suite. Log:
`.context/scratch/g12-resume/g11-eslint-import-map.log`. The closed module-list
comparison now passes; the exact inferred-edge test also passes, including both
other accepted new rows. The remaining failure is in the first test's target
loop, line 494: it allows only `contracts` or `server` suffixes and rejects the
already-declared `account-support/read-contracts` module target. The production
graph admits that named module; its existing test assumes a narrower shape.

Only the two explicitly authorized edits were made: one expected-list line and
the new support row's unused type edge. No other line of the import-map test or
other new graph row was changed. The supervisor's existing-test stop remains
binding. No later proof, fresh pack, API snapshot regeneration or final read
packet was executed; package checks remain reserved for the clean commit.

Regroup after two evaluations of the inventory gap: the first exposed the
missing closed names and unused permission; the second closed those findings
but exposed the target loop's top-level-entry assumption. The owner is the
module-graph test contract. A smaller candidate approach is to recognize an
exactly declared module target before applying the existing contracts/server
sub-entry assertions, preserving unknown-target refusals and exact-edge checks.
That requires the supervisor's scoped answer before another edit. The next
proposed discriminating step, if authorized, is the same 123-case suite with that
recognition; expected result is a green inventory while all prior refusal cases
remain active. Lesson: closed module discovery and target validation must share
the same declared-module meaning, rather than widening production permissions.
This rethink grants no control change, review cycle or waiver. No native review
has started; cycles and contribution commits remain zero.


## Coordinator-selected graph ownership and browser closure

The coordinator selected the measured precedent option. The three proposed
nested graph rows are removed. Existing `account-support` gains a public data
value edge; `commerce/server` gains a data type edge and a pricing/contracts
value edge, preserving other row order. The five corresponding import-map
expectations are updated without removing or skipping cases. No grammar helper
change or alternative version-constant import is applied.

The codec directory loses its independent empty-edge module fence and inherits
account-support's permissions. A new package-owned browser witness bundles its
actual public source entry with esbuild and accepts every input only when it is
under that codec source directory or inside the installed zod package. It admits
no other closure input. The entry's existing package smoke evidence adds this
witness. Existing contracts loader rules are unchanged; the new witness checks
the real browser bundle closure rather than claiming general loader analysis.
The canonical internal-boundaries section records this ownership and permission
choice. The final DELTA API read will list these new control/test/doc items.

Fetched main remains `38f60565d54fb7ec061f8e506b3c98a3c653a8bd`; no restage
was needed. The staged state before the ruling is preserved in scratch. Required
checks now resume from the failed import-map gate; any other existing-test
failure still stops. Nothing is committed, so review cycles remain zero.


### Completed proof after the ownership ruling

All 36 scheduled file runs passed, 3,411 cases with no skips; the separate new
browser-fence run passed one case. The fresh importer inventory contains 27
existing files. Those files match main byte for byte except the explicitly
approved import-map expectations and the existing one-line boundary-entry union.
No other existing case was modified, removed or skipped. Each file had focused
admission; PostgreSQL suites used their own fixture/container and normal teardown.

| File | Passed | Scope |
| --- | ---: | --- |
| `scripts/packages/eslint-import-map.test.ts` | 123 | normal |
| `packages/platform/test/packageBoundary.test.ts` | 2903 | normal |
| `scripts/generate-outcome-projection.test.ts` | 7 | normal |
| `mcp/support/tools.test.ts` | 13 | normal |
| `scripts/packages/package-size-policy.test.ts` | 49 | normal |
| `scripts/packages/platform-cold-consumer.test.ts` | 108 | normal |
| `scripts/packages/reference-delegation-consumer.test.ts` | 1 | normal |
| `server/adapters/postgres/customerSupportJourney.test.ts` | 23 | normal |
| `server/adapters/postgres/omsControl.test.ts` | 2 | normal |
| `server/adapters/postgres/omsControlPlane.test.ts` | 2 | normal |
| `server/adapters/postgres/returnsControl.test.ts` | 1 | normal |
| `server/adapters/supabase/support/customerSupportCommandResponses.test.ts` | 6 | normal |
| `server/domains/support/customerRecoveryCommand.test.ts` | 6 | normal |
| `server/runtime/public-reference/m12AccountReadBinding.test.ts` | 2 | normal |
| `server/runtime/public-reference/m12AccountSupportBinding.test.ts` | 17 | normal |
| `server/runtime/public-reference/m12OperatorRecoveryBinding.test.ts` | 6 | normal |
| `server/runtime/public-reference/m12SupportReadBinding.test.ts` | 45 | normal |
| `server/runtime/support/customerJourneyBinding.test.ts` | 10 | normal |
| `src/domains/clients/portableContracts.test.ts` | 1 | normal |
| `src/domains/clients/portablePorts.test.ts` | 1 | normal |
| `src/domains/support/customer360Contracts.test.ts` | 6 | normal |
| `tests/platform/catalog/m05Composition.test.ts` | 1 | normal |
| `tests/platform/channels/channelConsumer.test.ts` | 2 | normal |
| `tests/platform/inventory/inventoryConsumer.test.ts` | 2 | normal |
| `tests/postgres/commerceManagedRail.test.ts` | 26 | normal |
| `tests/postgres/nativeAccountReads.test.ts` | 8 | normal |
| `tests/postgres/omsControlPlaneNative.test.ts` | 2 | normal |
| `tests/postgres/partnerAcquisition.test.ts` | 10 | normal |
| `tests/postgres/accountSupportReads.test.ts` | 5 | normal |
| `packages/platform/test/account-support/browserSafety.test.ts` | 1 | normal |
| `packages/platform/test/commerce/nativePostgres.test.ts` | 2 | normal |
| `packages/platform/test/account-support/nativePostgres.test.ts` | 1 | normal |
| `packages/platform/test/account-support/readContracts.test.ts` | 1 | normal |
| `tests/postgres/m19StorePromotionIdentity.test.ts` | 2 | normal |
| `tests/postgres/m19StorePromotion.test.ts` | 8 | normal |
| `tests/postgres/m19StorePromotion.test.ts` | 8 | fresh empty npm cache, offline |

The new `readContractsBrowserSafety.test.ts` additionally passed. The actual
browser closure contains exactly four runtime codec files (the port-only types
are erased) and 95 zod inputs, 99 total, with no other input. Full input names are
in the owned `browser-inputs.json` artifact. The assertion was not widened.
The old empty-runtime contracts browser test also remains unchanged and green.

Both complete installed-tarball PostgreSQL runs passed 8/8: normal environment
and a freshly created empty npm cache with offline mode. Core, Platform, zod,
the driver and its locked dependency/type closure were installed from local
tarballs only, with no registry specs. Both declaration modes and CSP parsing,
restricted runtime role flags/DDL refusals, success/conflicting-command refusal
and durable replay passed. The real return-line array traversed the unchanged
JSON serialization helper. The original native-list failure remains historical;
the complete reduced list/count/detail calls now pass using the repaired main
body. Rich projections and missing native operator authority remain refusals.
The G6 capture-after-cancel recorded-fact limitation is unchanged.

Main advanced during proof to `e2461449849d3c6b0586a3c9043f550aa7ebabea`.
The saved ruling patch (SHA-256
`d51c8fe84b0f61ec445a6443ffbb4c9d2b4886ffa125a9754ba7f667b07fd55c`)
was proved to reproduce its staged tree before another uncommitted restage.
Reapplication was conflict-free. Stable patch IDs excluding this task record
were equal before/after: `732b4af14e66a986091bb07dd46bd082a34519b2`.
The complete affected package/runtime/source/test trees and migration manifest
are unchanged against the tested tree; upstream added the independent store
preview and its publication entries. The new policy/execution-surface additions
were read. No contribution commit or native cycle was created by the restage.

On this new base, neutrality passes with zero increases; ast-grep passes;
published strict typecheck reports zero unresolved edges and zero diagnostics;
lint passes with zero errors and the same 33 warnings. No baseline, suppression,
numeric cap, grammar helper, SQL, grant or provider implementation changed.
Clean committed package checking, DCO, full native review and the lead's final
verification slot remain after the final API read. No canonical verify ran.


### Fresh pack against the integrated main

Official-toolchain base/candidate packs were measured with the repository's
`measurePack` implementation, including its sorted gzip code/docs classes:

| Metric | Main | Candidate | Delta |
| --- | ---: | ---: | ---: |
| Packed bytes | 2,346,064 | 2,376,697 | +30,633 |
| Unpacked bytes | 11,081,441 | 11,211,069 | +129,628 |
| Files | 2,940 | 2,979 | +39 |
| Code-class gzip bytes | 1,882,746 | 1,908,883 | +26,137 |
| Docs-class gzip bytes | 60,612 | 61,370 | +758 |

Code files: 2,868; docs files: 6. All current caps hold, with no cap change.
Existing emitted runtime files match main byte for byte. The sole existing
`.d.ts` difference is the accepted promotions enum-member order. The clean base
API check passed. Tarballs, logs and metrics remain in the owned
`g12-option-a/package-measurement` scratch directory; expanded base/extraction
source trees were removed. These are locally packed candidate measurements,
not registry-version or release qualification. The clean committed
`packages:check` rerun remains after the API read and commit, as directed.

Self-retro: the coordinator-selected module ownership and a narrowly specified
browser bundle witness resolved the design finding without extending the graph
grammar. Full unchanged importer coverage found no additional regression; normal
and cold-cache installed proof now distinguish local-cache success from an
actual offline local-tarball install. No optional grammar or importer rewrite
was retained.


### Final read handoff

The exact API snapshot check passes. All three new API reports and all moved
sources except the repaired plane remain byte-equal to the coordinator-accepted
candidate. The promotions report retains exactly the accepted all/archived
member-order hunk; the clean main API check passed and emitted runtime files are
unchanged. Policy/docs navigation update ran on the would-be committed set. It
reports computed bindings OK and seven pending delta-bound no-impact trailers;
those fresh proposed reasons are in the final read packet. This is not a policy
PASS until the post-read commit contains the records. No commit was manufactured
to bypass the read-before-DCO ordering.

The exact current main was fetched again before the packet. The committed
identity-witness condition remains pending even though its staged test has passed.
The final packet is a DELTA to the accepted source read, not a repetition of its
complete API inventory. It covers the repaired owner body, package-owned evidence
and offline install setup, shared unions, approved enclosing-module permissions,
corresponding five expectation sites, the required browser closure test/evidence
and canonical documentation sentences. All new public exports remain as accepted.
No contribution commit, PR, reviewer, receipt, native cycle, canonical verify or
verify-slot request exists. The supervisor resumes after this final read.
