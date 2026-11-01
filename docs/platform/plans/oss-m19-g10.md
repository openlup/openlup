# M19 G10: native fulfillment store promotion

Status: the refreshed public API read was accepted with the public constructor
rename and split proof imports described below. The affected focused checks and
installed-package proof pass. The candidate is ready for the authorized DCO
commit and two independent native reviews. Canonical verification and landing
still wait for the named slot.

## Outcome, scope and authority

The finite outcome for **G10-now**, this PR, is a packaged dispatch-preparation
binding and a captured fulfillment adapter passing
`runFulfillmentAdapterConformance`. **G10-reads** follows in a separate PR after
the address and inventory facts from the money stream are available. It supplies
`listCommerceFulfillmentOrders` and `getCommerceFulfillmentOrderDetail` then;
this PR preserves both existing `host_binding_required` refusals exactly.

| Matrix rows | Delivery | Reason |
| --- | --- | --- |
| P17, R08 | G10-now | Compose existing paid-handoff and locked dispatch preparation with captured dispatch. |
| P18, P19 | G10-now | Captured dispatch composes with existing shipment-spine label/tracking and observation persistence; it supplies no label generation or observation verification. |
| A89–A92 | G10-now | Existing packaged shipment-spine create/label/handoff/tracking operations remain unchanged and support captured adapter proof. |
| A97, A98 | G10-now | Existing packaged paid-fulfillment recovery reads and requeue remain unchanged; no new repair behavior. |
| T03-17, T03-18 | G10-reads | Full commerce projection requires address snapshots and reservation facts from G3/G4; no substitute empty projection is accepted. |

The approved class now includes **new native code where no implementation
exists**, as well as unchanged promotion for existing code. Missing existing
code alone is no longer a stop reason. The managed rail remains unchanged.
The worker operates only in its assigned G10 worktree and branch under the store
supervisor. In `server/**` and `src/**`, identity-preserving import rewrites
and the subsequently authorized constructor-only re-export facade are permitted.
The facade requires an unchanged moved implementation except imports, an eventual
committed identity witness against the built package and old runtime path,
unchanged original suites passing, public API reading before DCO, and every root
source path listed here. That direct grant supersedes the earlier open question;
implementation belongs under `packages/platform/src/fulfillment/**`.

SQL, grants and migrations belong exclusively to the money stream. This task may
read existing native tables and invoke existing native routines using the
restricted runtime role. Any missing routine, table or privilege must be recorded
here and in the supervisor SQL-needs packet; no fixture-only privilege escalation
may stand in for production authority. Finish independent non-SQL work first.
G10-reads specifically waits for G3 order/subscription destination facts and G4
inventory reservation facts. No SQL dependency is yet asserted for G10-now.

No other row, managed adapter behavior, subscription scheduling, real-provider
qualification, release dispatch, publication, production, credential, setting,
hosted resource or adopter mutation is in scope. No commit or DCO sign-off may
occur before the stabilized public API read is answered. After that, native
review and exact-tree verification precede authorized submission and queue
delivery in the supervisor's landing order.

The code base and freshly fetched policy pin are independently recorded as
`bb0008481a11267ec6dbe3e7e531299777cddc19`. No review candidate exists yet.

## Pre-edit matrix confirmation and retained history

The inspected source agrees with the matrix's native list/detail refusal and
unestablished complete dispatch-preparation binding; no matrix correction is
claimed.

- `packages/platform/src/fulfillment/nativeUnsupported.ts` returns the shared
  `host_binding_required` refusal for `listCommerceFulfillmentOrders` and
  `getCommerceFulfillmentOrderDetail`, without an executor.
- `packages/platform/src/fulfillment/contracts/read.ts` requires the commerce
  projection, including lines, address, payment, inventory and eligibility.
  The existing response builders accept host-supplied rows; they do not read
  native PostgreSQL or supply those facts.
- `server/adapters/supabase/commerceFulfillmentPort.ts` implements the two reads
  over managed `commerce_fulfillment_orders` and related tables. It is not an
  existing native implementation that can be exported without behavior change.
- `docs/platform/ARCHITECTURE_AND_EXTENSIONS.md`, under **Native parity
  boundaries**, explicitly states that commerce list/detail has no equivalent
  native commerce read and requires host callbacks. Scoped searches of native
  adapters, fulfillment package source and callers found no native implementation
  of these two methods.
- `server/runtime/public-reference/m08FulfillmentBinding.ts` already implements
  locked dispatch-context synchronization, with authoritative reader/edit
  callbacks and a host transaction lane. This is an existing promotion candidate,
  but exporting it cannot supply the absent native commerce reads.
- Shipment spine, paid handoff, observation persistence and paid recovery
  constructors already exist at `@openlup/platform/fulfillment`; their presence
  does not establish the missing list/detail projection or a passing captured
  adapter for this row.

The initial run stopped because no native reads existed. The lead explicitly
superseded that interpretation: new native implementation is authorized where
none exists. The later split defers those reads, retaining their current refusal
until G3/G4 land, without dropping them from programme acceptance.

## Acceptance, proof plan and current evidence

G10-now acceptance requires a
compiled public export exercised by an installed tarball consumer; consumer
evidence for each export in `release-gates.json`; real PostgreSQL success,
refusal and replay through the restricted runtime role on the `qualified-v2`
chain; unchanged existing suites passing; and a measured package delta.
Focused checks precede the stabilized API read, signed candidate and two
independent fresh-context reviews. Canonical verification waits for the
supervisor's named landing slot.

The initial run executed read-only Git/source inspection and fetched current main.
No tests, installation, builds, pack, lint, conformance, native review or final
verification ran. No package delta was measured; no package files changed.
No review cycles, retries or external delivery actions were consumed. The only
edits are this stopped-task record and its additive publication-catalog entry.
Existing canonical parity documentation remains accurate; no capability or
qualification claim changes.

Initial self-retro, corrected on resume: the absence check was useful evidence,
but the original stop interpretation was superseded by the lead. Apply the latest
explicit scope grant, and retain the approved read dependency as a separate PR
rather than treating missing code alone as a permanent blocker.

## Resumed execution

Before implementation, the task split and SQL boundary were recorded and a
private effort estimate supplied to the supervisor. At that earlier phase the
facade question was pending; the authorized-bridge section below records its
later resolution.

Placement: the existing platform distribution remains the owner. Native
preparation gets the `fulfillment/native` subpath because it composes fulfillment,
composition and data types; its declarations reach the existing optional database
peer, so cold-consumer classification is additive under adapter entries. No new
package, dependency or runtime is justified. The captured adapter stays at the
existing fulfillment entry and imports no provider SDK.

Before the facade grant, the would-be package implementation preserved the
existing dispatch-binding body with import-only substitutions, and the root
reference declaration remained untouched. Identity had not yet been established
at that stop. The later bridge/proof section supersedes that earlier state. The
qualified composition witness changes its binding import to the package and adds
captured-dispatch assertions; original assertions remain intact. The cold
consumer adds only this row's classification and installed proof lines. New
package tests cover default-off refusal and captured success/refusal/unknown,
command/evidence mismatch, replay and capture/result mutation isolation.

Machine admission: the first focused-stage wait timed out after 542 seconds while
an earlier verification waiter had priority. It was repeated as required; no
installation or heavy proof was run without admission. Static Node syntax and
Git whitespace checks passed. The authority question and machine wait are not
completed failed candidate evaluations and consume no native repair cycles.

The repeated focused wait admitted after 213 seconds. The first installation used
shell-default Node 24.22.2/npm 11.19.1 and is not counted as pinned proof. The
existing Node 24.21.0/npm 11.19.0 installation was selected explicitly before
continuing. Ast-grep passed; the pinned reinstall is awaiting a focused admission.

Regroup before further publication-policy repairs: initial catalog insertion was
unsorted, then the materialized inventory required staging, then the implicit
changelog-fragment carrier refused a redundant per-file row. The canonical
checker and changelog-fragment owner clarify one simpler route: insert only new
explicit paths at their existing sorted positions, preserve every prior entry,
stage the would-be tree, and let fragments use pattern admission. Inventory now
passes; remaining policy output asks for three scoped no-impact commit trailers.
Those trailers must wait for the API read because commits are currently forbidden.
Lesson: inventory preflight assumptions → use the canonical admission rules before
constructing the read candidate.

Focused test selection correction: the workspace test script prepends `test`, so
appending a single path accidentally selected the complete package suite. It ran
473 files: 471 passed, with 7,930 passing tests and two failures in exact public
export inventories. No implementation failure was reported. The new native
subpath and captured factory were added to their existing inventory expectations,
without relaxing boundaries or changing other expected exports. Subsequent
focused execution will invoke Vitest directly with one explicit file. This
unintended broad run is retained as history, not treated as final full proof.

Necessary inventory companions are
`packages/platform/test/packageBoundary.test.ts` and
`packages/platform/test/fulfillment/portFit.test.ts`. No assertion or refusal was
removed. No review cycles have been consumed; no commits or sign-off exist.

## G10-now working-tree proof

Pinned Node 24.21.0/npm 11.19.0 installation and `npm run pretest` passed.
The constructor body is byte-identical to the reference implementation
(SHA-256 `c6e539f83c41e7f444d6c24f0c814dbe42168464f2341ff65ac72ca0ac1f9096`);
this is computed evidence, not a maintainer quotation or function-identity proof.

- The repaired package-boundary file passed all 2,822 assertions.
- `tests/postgres/m14QualifiedComposition.test.ts` passed all four profiles on
  the complete `qualified-v2` chain. The packaged preparation/dispatch binding
  runs through the real non-superuser, non-bypass runtime login. Success,
  disabled/absent-binding refusals and repeated preparation/dispatch are checked;
  dispatch acceptance leaves the shipment `created`, with exactly the original
  mapped-command and acceptance keys. No grant, routine, migration or fixture
  privilege was added. The ordinary fixture reaper was disabled; only the owned
  containers were torn down.
- Real working-tree tarballs were installed outside the checkout, with no
  symlinks or inherited module-path environment. The existing cold-consumer
  isolation check and G10 runtime proof passed before optional peers were
  installed. Captured-adapter conformance, native preparation/default-off and
  unchanged commerce read refusals execute from installed bytes. A typed host
  consumer then passed strict NodeNext and Bundler compilation with pinned peers.
- The base tarball is 2,102,771 packed bytes / 9,809,502 unpacked bytes / 2,840
  files; this candidate is 2,109,275 / 9,835,906 / 2,846. Delta: **+6,504 packed
  bytes, +26,404 unpacked bytes, +6 files**. Existing total package limits remain
  unchanged. This is a preliminary working-tree pack, not a passing committed
  package gate or publication evidence.

G10-now has no SQL needs after the real restricted-role proof. G10-reads remains
separate and still waits for G3/G4. Native review has not started (zero cycles),
no commit or DCO sign-off exists, and canonical verification has not run.

Simplicity pre-check for the later reviews: reuse the existing binding body and
ports, add one offline captured dispatch implementation, and use existing cold
consumer/qualified fixtures. A new provider registry, transport, durable ledger,
SQL layer or general simulator framework is unnecessary for this outcome.

The first lint run found two import-boundary errors: the newly added nested
module graph row preceded its parent, whose later flat-config rules overrode it.
Only G10's added graph row was relocated immediately after `fulfillment`, matching
the existing parent-before-child pattern. No prior row, rule, ignore or graph edge
was changed. The existing 33 warnings outside this row were not repaired.

Final working-tree checks: the repaired fulfillment export inventory passed both
tests; `npm run lint` passed with zero errors and the 33 existing warnings;
`npm run oss:published-tree -- --typecheck` passed all five strict projects with
zero unresolved edges and zero additional consumer-side errors. Ast-grep and
Git whitespace checks passed. Policy was refreshed from `origin/main` before
handoff; it remains `bb0008481a11267ec6dbe3e7e531299777cddc19`, with no changed
instructions. The remaining documentation obligations will use scoped no-impact
trailers in the first authorized signed commit; this run cannot commit them
before the public API read. They remain binding for final policy verification.

Current delivery boundary: refresh and obtain the public API read after the
authorized identity bridge and unchanged preparation witnesses, then commit the
witness with the applicable no-impact trailers and DCO. Two fresh-context native
reviews and the supervisor's verification/landing slot still follow. No budget
increase, release or external mutation is requested.

Self-retro for this stop: select the pinned runtime before installation; invoke
single-file Vitest directly because the package script prepends a directory;
and place a new nested module graph row after its parent so flat-config override
order preserves its declared boundary. These corrections used existing controls
and added no runner, exception or successor work. Machine-admission delays and
preliminary failures are retained above; native repair cycles remain zero.

## Authorized identity bridge and array-binding audit

The supervisor supplied the coordinator's bounded facade authorization on resume:
constructor-only declarations may move behind identity-preserving re-exports,
with byte-equal moved implementation except imports, an eventual committed
identity witness, unchanged original suites passing, each public export read
before DCO and each touched root source path listed. No commit or sign-off is
allowed on this resume; the witness remains staged until the API read is answered.
This later direct grant supersedes the earlier open-question notes above.

The sole touched `server/**` or `src/**` path is
`server/runtime/public-reference/m08FulfillmentBinding.ts`. Its old blob was
`a900f5f5db36669385a5db35cfb3a4b8dc3a194e`; its complete replacement matches the
read packet's one-line export, SHA-256
`92a5811e8d3344ea380460208be29fc6daac7b02e01d012ea6276e9643ffc894`.
The old module had one exported symbol, the constructor. Its unexported
`Executor`/`Attribution` aliases are constructor-local support declarations
already moved intact into the package; no independent export/type API was
removed. The complete non-import implementation, including those aliases, was
compared byte-for-byte before replacement and is equal. No other implementation
difference is proposed. The new identity test compares the old runtime import,
public package entry and direct built-package module with `toBe`, so a separately
bundled constructor copy fails. It uses the public built entry for default-off
proof as well; comparing an independently loaded source TS module to built JS
would test a different module graph. The original root and PostgreSQL preparation
suites are unchanged.

Array-to-jsonb audit covers the promoted binding, captured adapter, wired native
dispatch store/ledger and the authoritative reader/edit callbacks exercised by
the existing and new proofs. The promoted writer's only jsonb value is an
explicitly serialized contact-revision object with scalar fields. Candidate
`lines` and capture collections remain in memory. Dispatch claim, mapped attempt,
finalize and acceptance serialize their projected evidence/results with
`JSON.stringify` before native SQL calls; any nested transcript-item arrays
therefore cross as JSON text, never as a raw JS-array parameter. Ledger operations
bind scalar fields only. The query parameter LIST is a JS array by protocol; it
is distinct from an individual value being an array for a jsonb slot.

Owned authoritative readers issue SELECTs and return candidate objects;
existing edit callbacks bind literal metadata objects, not top-level arrays.
The qualified-role assertion binds table names as a real `regclass[]` parameter,
not jsonb. No new code calls `PgGatewayClient.rpc`; the capability-local lane
passes the explicit query parameters to pg unchanged. Caller-provided arbitrary
edit callbacks still own their SQL encoding; no universal gateway fix or validation
of unrelated host code is claimed.

No in-scope raw JS-array-to-jsonb defect was found. The restricted-role test has
candidate `lines` arrays and an actual regclass-array bind, but it does NOT bind
a top-level JS array to a jsonb parameter, nor exercise an array-valued transcript
(the captured adapter emits minimal evidence). Those distinctions are retained
rather than claiming object-only fixtures prove the reported array defect class.
No gateway, routine, migration, grant or production behavior repair was made.

Bridge proof on this resume: `nativePreparation.test.ts` passed both tests
(default-off and strict constructor-object identity across the root runtime,
public native entry and direct built module). The unchanged
`server/runtime/public-reference/m08FulfillmentBinding.test.ts` passed its test,
and unchanged `tests/postgres/fulfillmentPreparationBinding.test.ts` passed both
bound/unbound cases through the facade, preserving advisory-before-row locking,
authoritative transaction identity, atomic edit/context commit and rollback,
redaction, and unbound no-write refusal. Git comparison confirms neither original
suite changed. The identity witness is staged, not committed: its committed
condition remains a delivery gate after the API read permits DCO.

Only the task record, non-shipping package test and root facade differ from the
previous read tree. The package manifest's `files` allowlist excludes tests and
root source; no shipped package source, dist input, manifest, release gate, SQL
asset or package document changed. The retained +6,504-byte package measurement
therefore remains applicable; no redundant pack was run. The prior qualified-v2
restricted-runtime proof targets the unchanged packaged implementation directly.
Read-only shared-file comparison found the existing G10 eslint addition at its
own parent-adjacent location, distinct from the other row's end-of-graph additions;
no overlapping shared change or new shared-file edit was needed on this resume.

The refreshed lint run rejected the originally proposed package-local witness's
root-server import. That witness passed at runtime but violated the existing
package-local boundary. The rule was preserved: `nativePreparation.test.ts`
keeps default-off and public-entry/direct-built identity checks, while the new
cross-boundary `tests/postgres/g10FulfillmentIdentity.test.ts` checks old root,
public native entry and direct built module identity. No original suite changed,
no suppression/dynamic-import evasion was added, and no lint rule was relaxed.
The new cross-boundary test has one additive catalog row; read-only comparison
of the other active store rows' shared catalog diffs found no overlapping hunk.
This changes test placement only and adds no production export or package bytes.
The prior passing three-path witness is retained as preliminary history; the
correctly placed witnesses must pass before refreshing the API packet.

The final split witness is minimal: the cross-boundary test compares root facade
to the public built-package entry; the package-local test compares that public
entry to its direct built module. Together they reject a root wrapper or a
separately bundled public-subpath copy while keeping each import in its owning
scope. The cross-boundary test needs no duplicate private-dist import.

Refreshed proof after respecting the package boundary: package-local native
preparation/default-off and built-entry identity passed both tests; the new
cross-boundary root/public-entry identity case passed; the original root
default-off case and both original PostgreSQL preparation/locking cases passed
unchanged through the facade. `npm run lint` passed (zero errors, the same 33
existing warnings), all five strict projects passed with zero unresolved edges
and zero additional consumer-side errors, and API snapshots plus ast-grep passed.
No source/API or measurement input changed after these passing checks.

The refreshed publication policy has seven obligations with five unanswered
no-impact trailers: the prior portability/repository/tooling obligations, the
unchanged reference-runtime behavior behind the facade, and the new identity
witness using the existing Node test root. Their exact scoped reasons/digests
are in the refreshed read packet. They cannot be committed before the API read;
policy remains a final delivery gate and is not claimed fully green here.

Current stop: the authorized bridge and identity witnesses are staged; public
API approval, DCO/committed identity proof, two independent native reviews and
canonical verification in the named slot remain pending. No commit, sign-off,
PR, push, merge or release occurred. Native repair cycles remain zero; no review
reports, admission receipt or expiry exist. The array audit found no in-scope
raw-array/jsonb defect and created no SQL/gateway repair request. G10-reads was
not started.

Self-retro for this resume: place cross-boundary identity assertions in the
existing root test collection and package/built assertions inside the package.
This preserves the actual boundary instead of weakening it or hiding an import.
The source body remained untouched, so earlier restricted-role/installed-package
proof and size evidence could be retained without a new mechanism or pack.


## Accepted API read and final constructor name

The coordinator accepted the refreshed staged API packet for DCO, with two
bounded edits: publish `createNativeFulfillmentBinding`, and retain the original
root constructor import for the pre-existing qualified-composition witness.
The new captured-dispatch witness alone imports the packaged name. The root
module re-exports that exact function as `createM08FulfillmentReferenceBinding`,
preserving its legacy name and function identity. The public declaration rename
is the sole declared non-import difference from the moved implementation; it is
explicitly instructed by the coordinator (the private decision reference is
retained in the supervisor's read packet). All other non-import bytes, including
the constructor body and private aliases, remain identical to the original.
This acceptance supersedes the earlier pending-read/no-commit status above.

The captured adapter, graph edge, catalog entry and five scoped no-impact
reasons were accepted unchanged. Their delta fingerprints are recomputed before
the first signed commit. The approved actors are the owner, coordinator, stores
supervisor and this G10 worker; the worker may now DCO-sign as
Bart Roszkowski <dev@openlup.com> and launch two fresh-context native reviewers.
This resume grants no final verification slot, landing, publication or release.
The identity assertions are included in that commit. G10-reads stays deferred.

The rename changes no SQL argument or callback wiring. The array-to-jsonb audit
above remains applicable: no new raw array is passed to jsonb, and the retained
restricted-role proof does not claim a top-level-array/jsonb or transcript-array
case. No gateway, SQL, grants, fixtures or managed behavior changed.


Final focused proof for the accepted rename uses Node 24.21.0/npm 11.19.0:

- Native package preparation/default-off and direct-built identity: 2 passed.
- Root alias/public built-package identity: 1 passed.
- Original root default-off suite: 1 passed; original PostgreSQL preparation
  and locking suite: 2 passed. Neither original test file changed.
- Qualified composition: all 4 profiles passed, retaining the existing root
  witness and adding captured dispatch through the packaged constructor.
- Lint: zero errors and the same 33 existing warnings. All five strict
  published-tree projects passed with zero unresolved edges and zero additional
  consumer errors. Ast-grep and API snapshots passed; the native API report
  differs from the accepted read tree only by the instructed declaration name.
- The isolated installed tarball proof passed captured conformance, default-off,
  exact preparation/replay and the unchanged read refusals without optional
  peers. Strict NodeNext and Bundler consumers passed with the existing pinned
  optional peers. No live provider or hosted qualification is asserted.

The remeasured base remains 2,102,771 packed / 9,809,502 unpacked bytes and 2,840
files. The renamed candidate is 2,109,277 packed / 9,835,921 unpacked bytes and
2,846 files: **+6,506 packed bytes, +26,419 unpacked bytes, +6 files**. Its
tarball SHA-256 is `49d655f9bacb5d346e383aa5ddc8bbb51f4a459ed27d5a6770298b311f695a1c`.
The prior +6,504-byte measurement is retained history, superseded by this pack.
There is no version, dependency or numeric-budget change.

Only the two coordinator-instructed edits and their corresponding API,
documentation, test and proof records differ from the accepted read tree. The
array audit remains unchanged and found no in-scope encoding defect. Five
no-impact trailer fingerprints were recomputed for the signed candidate. Native
review starts at cycle zero; its actual reports and expiry remain in the native
session and supervisor handoff so recording review results does not change the
reviewed tree. No canonical verification, PR, push or landing ran here.

Self-retro: the direct alias and two scoped identity assertions preserve the
existing constructor without a wrapper or duplicate body. Machine admission
dominated this resume (several waits of 60–275 seconds); focused proof itself
passed without source repairs. No further mechanism or optional cleanup is needed.
